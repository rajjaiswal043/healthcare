-- =============================================================================
-- CLINICAL DOCUMENTS — THE FIRST THING THAT LEAVES POSTGRES
--
-- FR-DIA-02, checkpoint 1 of docs/09-diagnostics-plan.md. X-rays, scanned lab
-- reports and PDFs, stored in S3 with a row here describing where they are.
--
-- Read section 1 of that plan before changing anything in this file. The short
-- version: every safety property row-level security gives us stops at the
-- bucket. S3 has no notion of a tenant. The isolation between one clinic's
-- images and another's is isolation WE write, and it rests on one rule —
--
--   the object key is derived from the session's tenant, never from a request.
--
-- A caller names a document id. We read the row under RLS, which is what proves
-- the document is theirs, and only then sign a URL for the key we found. There
-- is deliberately no endpoint anywhere that accepts a key.
-- =============================================================================

CREATE TABLE "clinical_document" (
  "id"        uuid PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,

  -- Where it is in the bucket. Always `tenants/{tenant_id}/patients/{patient_id}/{uuid}{ext}`.
  -- Stored rather than derived so a future move between buckets or prefixes is a
  -- data migration rather than a guess about how keys used to be built.
  "object_key"   text NOT NULL,
  -- What the clinic called it, sanitised. Shown in the UI; never used to build
  -- the key, because a filename is attacker-controlled and a key is not.
  "file_name"    varchar(255) NOT NULL,
  -- Sniffed from the bytes, never taken from the upload's declared type.
  "content_type" varchar(128) NOT NULL,
  "size_bytes"   integer NOT NULL,

  "uploaded_by_user_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT "clinical_document_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "clinical_document_patient_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT,
  CONSTRAINT "clinical_document_uploader_fkey"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,

  -- 25MB, matching the API. A row claiming more than the API would accept means
  -- something wrote here another way.
  CONSTRAINT "clinical_document_size_is_bounded"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400),

  -- The key must sit under this tenant's prefix. This is the isolation rule
  -- written down where it cannot be forgotten: even a bug in the service cannot
  -- record a document pointing at another clinic's folder.
  CONSTRAINT "clinical_document_key_is_tenant_scoped"
    CHECK ("object_key" LIKE 'tenants/' || "tenant_id"::text || '/%')
);

CREATE INDEX "clinical_document_patient_idx"
  ON "clinical_document" ("tenant_id", "patient_id", "created_at" DESC);

-- Two documents must never share a key: one overwriting the other in S3 would
-- silently replace a patient's imaging with somebody else's.
CREATE UNIQUE INDEX "clinical_document_object_key_key" ON "clinical_document" ("object_key");

ALTER TABLE "clinical_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinical_document"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON "clinical_document" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- NO UPDATE, NO DELETE, and the reason is not tidiness.
--
-- A result that turns out to be wrong is corrected by attaching another document
-- and saying so in the report — the same rule as an addendum on a signed
-- consultation. A row that could be edited is a record of what somebody last
-- decided rather than of what happened.
--
-- Note the honest limitation this creates: nothing here removes bytes from S3
-- either. A DPDP erasure request would need a process that does not exist yet.
-- Recorded in docs/09 section 8 rather than left to be discovered.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "clinical_document" FROM healthcloud_app;

COMMENT ON TABLE "clinical_document" IS
  'Clinical files in S3. object_key is built from the session tenant, never from a request. See docs/09-diagnostics-plan.md section 1.';

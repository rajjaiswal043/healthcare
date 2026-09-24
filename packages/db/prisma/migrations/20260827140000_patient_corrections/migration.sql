-- =============================================================================
-- CORRECTING A PATIENT, AND KEEPING WHAT IT SAID BEFORE
--
-- FR-P36-20 to FR-P36-22, from the orthopaedic clinic demo. Until now a patient
-- was read-only after registration: a mobile number mistyped at the front desk
-- could not be fixed, and the clinic lost the ability to contact that patient.
--
-- NOTE WHAT THIS TABLE IS. It holds patient data — old and new values of real
-- fields — outside the `patient` row. That is a deliberate exception to the rule
-- the audit trail follows, which is that `changed_fields` carries field NAMES
-- ONLY and never values, so that an audit log cannot become a second copy of the
-- thing it audits. Narveer chose on 27 Aug 2026 to keep previous values so that
-- "what did it say before" has an answer.
--
-- The consequence, recorded here rather than discovered later: **a DPDP erasure
-- request now has two places to reach in this database**, and a third in S3.
-- There is still no erasure process. See docs/09 section 8.
-- =============================================================================

CREATE TABLE "patient_correction" (
  "id"        uuid PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,

  -- The property name as the API knows it — `mobile`, `birthDate` — not the
  -- column name. This is read by people, and it is what the UI already labels.
  "field"     varchar(64) NOT NULL,
  -- Rendered to text. Null means the field was empty before, or is now.
  "old_value" text,
  "new_value" text,

  "corrected_by_user_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT "patient_correction_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "patient_correction_patient_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "patient_correction_user_fkey"
    FOREIGN KEY ("corrected_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,

  -- A correction that changed nothing is not a correction. Rows are written
  -- only where the value actually moved, and this says so.
  CONSTRAINT "patient_correction_actually_changed"
    CHECK ("old_value" IS DISTINCT FROM "new_value"),

  -- The two fields that are never correctable. Enforced here as well as in the
  -- API, because a field the UI does not show is not a field the server
  -- declines: the UHID is printed on the patient's card and quoted on paper, and
  -- ABHA is a government identifier that was verified at registration — changing
  -- it is a re-verification, not a typo fix.
  CONSTRAINT "patient_correction_never_identity"
    CHECK ("field" NOT IN ('uhid', 'abhaNumber', 'abhaAddress'))
);

CREATE INDEX "patient_correction_patient_idx"
  ON "patient_correction" ("tenant_id", "patient_id", "created_at" DESC);

ALTER TABLE "patient_correction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_correction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_correction"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON "patient_correction" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- No UPDATE, no DELETE.
--
-- The whole point of the table is that it says what the record used to claim. A
-- history that can be edited answers a different question from the one it was
-- built for.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "patient_correction" FROM healthcloud_app;

COMMENT ON TABLE "patient_correction" IS
  'Previous values of corrected patient fields. Holds patient data — same protections as the patient row. FR-P36-22.';

# Diagnostics — X-ray and pathology, with results on the patient record

FR-DIA-01 to FR-DIA-05, from the orthopaedic clinic demo on 26 Aug 2026:
_"need to add the xray and blood test department so they can attach the xray
against patient"_.

The largest piece of work on that list, and the first that needs infrastructure
outside Postgres.

---

## 0. Decisions taken

Narveer's, 26 Aug 2026:

| Decision          | Chosen                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Scope             | **The full chain** — orders, a department worklist, results            |
| File types        | Any image or PDF. Not DICOM — treated as ordinary files                |
| Storage           | **S3 in ap-south-1**, following the DropYard implementation            |
| Clinic isolation  | **One bucket, per-tenant key prefixes**. Not a bucket per clinic       |
| Who does the work | **A new `diagnostics` role**, not a permission added to existing roles |
| What they can see | **The full patient record, read-only** — see section 4                 |

---

## 1. The thing this has to get right

**A clinical image is the most sensitive thing this system will hold, and it is
the first thing that leaves Postgres.** Every safety property the database gives
us for free — row-level security, one connection role, policies that fail closed
— stops at the bucket boundary. S3 has no notion of a tenant. Whatever isolation
exists between one clinic's X-rays and another's is isolation **we write**.

So the whole design reduces to one rule: **the object key is derived from the
session's tenant, never from the request.** A caller cannot name a key. They name
a document id; we look it up under RLS, confirm it belongs to their tenant, and
only then sign a URL for the key we found. A request that could choose its own
key is a request that could read another clinic's films.

---

## 2. Following DropYard

Narveer asked for this to match the S3 work in
`Anthony/DropYard/dropyard_backend` — `src/lib/s3.ts` and `src/routes/uploads.ts`.
Two of his codebases should not disagree about how S3 works.

**Copied unchanged:** `@aws-sdk/client-s3`; the env var names `AWS_S3_BUCKET`,
`AWS_REGION`, `S3_PUBLIC_BASE_URL`; the shape of `getS3Config()`; the ambient
credential chain (`new S3Client({ region })` — env vars locally, instance role on
EC2); upload browser → API → S3 rather than direct-to-bucket;
`crypto.randomUUID()` object names; and `safeImageFileName`'s sanitising.

**Changed because the stack differs:** DropYard uses multer, which is
Express-only. Fastify needs `@fastify/multipart` for the same job. And PDFs are
accepted here, not only images.

**Changed deliberately, and this is the important one:**

> DropYard's `buildPublicUrl` returns `https://bucket.s3.region.amazonaws.com/key`
> with **no signature**, and there is no presigning anywhere in that codebase.
> Its bucket is public. For marketplace item photos that is correct — they are
> meant to be seen by anyone.
>
> **An X-ray is not an item photo.** A public URL means anybody holding the link
> can open a patient's imaging, indefinitely, with no login — and links leak
> through browser history, referrer headers and forwarded messages. Under the
> DPDP Act that is a reportable breach, and the clinic sign-in page carries a
> "DPDP-ready" claim.
>
> **So: `BlockPublicAccess` on, and every read served by a presigned GET valid
> for five minutes, issued only after the session has been checked against the
> document's tenant.** Same upload path as DropYard; a different read path. It is
> about thirty lines of difference.

---

## 3. Storage module

```ts
interface ClinicalDocumentStore {
  put(input: {
    tenantId: string;
    patientId: string;
    bytes: Buffer;
    contentType: string;
    fileName: string;
  }): Promise<{ objectKey: string; sizeBytes: number }>;
  signedUrl(objectKey: string, expiresInSeconds?: number): Promise<string>;
}
```

`S3ClinicalDocumentStore` in every environment except the test suite, which gets
an in-memory implementation. That is the second reason for the interface: the
integration suite must not need AWS credentials to run, and a test that talks to
a real bucket is a test that fails on a train.

**Object key:** `tenants/{tenantId}/patients/{patientId}/{uuid}{ext}`. The tenant
prefix is the isolation boundary. It is built from the session, never from input.

**Limits:** 25MB per file, 10 files per order. Content type sniffed from the
bytes, never trusted from the upload — the same rule as the clinic logo.

**Not encrypted by us.** SSE-S3 at the bucket handles encryption at rest;
application-level encryption would mean a key management story we do not have and
would break presigned reads.

---

## 4. The Diagnostics role

A fifth clinic role, `diagnostics`, displayed as **Diagnostics** — covering X-ray,
pathology and whatever the clinic adds later, filtered by department rather than
split into a role per machine.

New permissions:

| Permission          | Held by                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `diagnostic:order`  | Doctor, administrator                                             |
| `diagnostic:read`   | Everyone clinical — doctor, nurse, front desk, diagnostics, owner |
| `diagnostic:result` | Diagnostics, administrator                                        |

**What Diagnostics can see: the full patient record, read-only.** Narveer's
decision. It is the same view a nurse gets — history, diagnoses, previous visits
— rather than only the order in front of them.

Recorded here with the trade-off, because it will be asked about: a radiographer's
job is to position a patient and upload a file, and the narrower option would
have shown them the name, age, UHID and the test requested and nothing else.
Full-record access means this role can open any patient's consultation notes.
The argument for it is that a technician who cannot see the history cannot spot
that the wrong film was requested, and in a small clinic the same person often
does several jobs. **If a hospital ever asks why the X-ray technician can read
clinical notes, this paragraph is the answer, and narrowing it later is a
permission change rather than a rewrite.**

### The part that is easy to miss

New clinics get roles from `SYSTEM_ROLES` at onboarding, automatically.
**Existing clinics do not** — Ortho Clinic and Sunrise already have their five
`role` rows written. A backfill migration has to insert the new role into every
existing tenant.

**That migration writes to a tenant table, so it must walk the tenants and
`set_config('app.tenant_id', ...)` inside the loop.** FORCE RLS applies to the
migration's own role; a plain `INSERT INTO role` will match nothing, report
success and leave every clinic without the role. This happened on 26 Aug 2026
with a practitioner-name migration and is written up in `docs/03-resume-here.md`.

Also needs updating: the platform onboarding screen hardcodes four roles for seat
limits, and `seed:auth` must be re-run locally after rebuilding the db package.

---

## 5. Data model

```prisma
model DiagnosticOrder {
  id            String @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId      String @map("tenant_id") @db.Uuid
  /// The visit that raised it. The order belongs to a visit, not to a day.
  appointmentId String @map("appointment_id") @db.Uuid
  patientId     String @map("patient_id") @db.Uuid
  /// Which diagnostic department is expected to do it.
  departmentId  String @map("department_id") @db.Uuid
  orderedByUserId String @map("ordered_by_user_id") @db.Uuid

  /// "X-ray left knee, AP and lateral". Free text on purpose — a coded catalogue
  /// of studies is a project, and a clinic that cannot type what it wants will
  /// write it on paper instead.
  description   String @db.VarChar(300)
  status        DiagnosticOrderStatus @default(PENDING)

  /// The short report typed when the result is attached. One per order.
  resultNote    String? @map("result_note") @db.VarChar(2000)
  completedAt   DateTime? @map("completed_at") @db.Timestamptz(6)
  completedByUserId String? @map("completed_by_user_id") @db.Uuid

  documents     ClinicalDocument[]
}

model ClinicalDocument {
  id        String @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId  String @map("tenant_id") @db.Uuid
  patientId String @map("patient_id") @db.Uuid
  diagnosticOrderId String? @map("diagnostic_order_id") @db.Uuid

  /// Where it is in S3. Built from the session's tenant, never from a request.
  objectKey   String @map("object_key") @db.Text
  fileName    String @map("file_name") @db.VarChar(255)
  contentType String @map("content_type") @db.VarChar(128)
  sizeBytes   Int    @map("size_bytes")
  uploadedByUserId String @map("uploaded_by_user_id") @db.Uuid
}
```

Both tables get FORCE RLS, tenant policies and grants, and both go into the
`rls:check` coverage list.

**No `updatedAt` on `ClinicalDocument`, and no delete.** A result that was wrong
is corrected by attaching a further document and saying so in the report note —
the same reasoning as an addendum on a signed consultation. `REVOKE DELETE` makes
that structural rather than a convention. **The S3 object outlives the row
either way**, which is worth stating plainly: there is no route in this design
that removes bytes from the bucket.

---

## 6. Build, in four checkpoints

Each one is demonstrable, so this is not a month with nothing to look at.

**1 — Storage. BUILT, 26 Aug 2026.** `ClinicalDocumentStore` with the S3 adapter
and an in-memory double, the `clinical_document` table under FORCE RLS and
insert-only (`REVOKE UPDATE, DELETE`), `document:read` / `document:write`
permissions with a backfill for existing clinics, multipart upload capped at
25MB, type decided by magic bytes against a strict allow-list, presigned reads
at five minutes, and every read audited. 15 integration tests; `pnpm verify`
exits 0 at 246 API tests.

Two things worth recording from building it:

- **`CLINICAL_STORAGE_DRIVER`** picks the store. `memory` is how the suite runs
  with no AWS credentials; `loadEnv` refuses to start with it under
  `NODE_ENV=production`, because that driver loses every file on restart. Made a
  named setting rather than a `NODE_ENV === 'test'` branch, which this codebase
  deliberately avoids elsewhere.
- **The seed and the migration disagreed, and a test caught it.** `document:read`
  was granted to front desk and owner in the backfill migration but not added to
  `SYSTEM_ROLES`, so new clinics would have been missing what existing ones had.
  Exactly the drift `docs/03-resume-here.md` warns about, found because a test
  asserted a front-desk read rather than assuming it.

**2 — Departments and orders. BUILT, 27 Aug 2026.** `department.is_diagnostic`
(no slots, absent from booking, settable at clinic setup), the `diagnostic_order`
table under FORCE RLS and never deletable, the three permissions, the
`diagnostics` role, and backfills putting all of it into clinics that already
existed. Endpoints: raise an order, the department worklist, orders on a visit,
cancel. Diagnostics added to the platform seat-limit screen. 12 integration
tests; `pnpm verify` exits 0 at 258 API tests.

The separation worth remembering: **`diagnostics` holds `diagnostic:result` and
deliberately not `diagnostic:order`.** A department does not order its own work,
and a test asserts that directly — if the role ever gains it, a technician could
raise and then fulfil their own request and nothing else would notice.

**3 — Worklist and results. API BUILT, 27 Aug 2026.** Attach a file to an order,
complete it with a report, read one order with everything on it. 11 more tests;
**Screens built the same day.** `/diagnostics` is the department worklist —
filter by department, To do / Done, open an order, attach a file, write the
report, mark it done. `DiagnosticOrdersPanel` sits in the consultation under the
prescription note: the doctor requests a test there and reads the result in the
same place, because splitting the two would land the answer somewhere other than
where the question was asked.

Three decisions worth keeping:

- **Attaching is addressed by ORDER, not by patient.** The order names the
  patient, so a technician cannot file one person's film against another's
  request. There is no patient field on that endpoint at all.
- **Attaching does not complete the order.** A study is often several images, and
  an order that completed on the first would leave the rest arriving against
  something already finished. Completing is its own call.
- **An order cannot be completed with neither a file nor a report.** That would
  tell the doctor the test happened and nothing about what it found — worse than
  a pending order, which is at least visibly unfinished.

The tests run as a real Diagnostics user created through the API, not as the
administrator. An administrator holds every permission and would have passed
them whatever the guards said.

**4 — Results in the consultation. BUILT, 27 Aug 2026**, together with FR-P36-23
from docs/08, because they are the same panel: `GET
/encounters/:id/previous-visits` returns the last three SIGNED visits with
diagnoses, medicines WITH THEIR DOSE, vitals and completed tests including their
files. `PreviousVisitsPanel` sits above the vitals in the consultation with the
most recent visit already expanded.

Three decisions:

- **Signed visits only.** A half-written draft is somebody's unfinished thinking,
  and showing it in a later consultation presents it as a record.
- **Addressed by encounter, not by patient.** The server decides which visits
  count as previous; a client passing a patient and a date could ask for visits
  after this one, which is not a question with an answer.
- **Three, not twenty.** This is a panel inside a consultation. A doctor who
  needs the fourth visit back wants the patient's full record, not a longer box.

**That completes docs/09.** What is NOT built and was never in it: FR-P36-24,
carrying the previous visit's medicines into today's prescription in one click.
It is small now that this panel exists, and it is the reason doctors want the
previous visit on screen at all.

---

## 7. What has to happen in AWS

Narveer's, not mine:

1. Bucket in `ap-south-1`, **Block all public access ON**
2. Default encryption SSE-S3
3. IAM policy with `s3:PutObject` and `s3:GetObject` on `arn:aws:s3:::<bucket>/*`
   — attached to the EC2 instance role in production, an access key for local dev
4. No CORS needed for v1, since uploads go through the API rather than direct to
   the bucket

Local `.env`: `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`.

**The API must still boot without any of it.** A clinic not using diagnostics
should not be blocked by missing AWS config; the storage service fails with a
clear message when it is actually called, in the same spirit as DropYard's
`getS3Config()` throwing.

---

## 8. Risks

- **The bucket is outside RLS.** Every other read in this system is protected by
  the database. This one is protected by our code, and that is a genuine step
  down in guarantee. Mitigated by deriving keys from the session and never from
  input, and by asserting it in the cross-tenant suite.
- **Presigned URLs escape.** Five minutes is short but not zero; a URL pasted into
  a chat within that window works for whoever holds it. Acceptable, and worth
  knowing rather than discovering.
- **Bytes are never deleted.** No route removes an S3 object. A patient
  exercising erasure rights under DPDP would need a process we have not built.
  **This will have to be faced before the first such request, not after.**
- **25MB × 50 films a day is ~60GB a year per clinic.** Around USD 1.50/month in
  ap-south-1. Not a cost risk; a backup and lifecycle question.

---

## 9. Testing

- The in-memory store means the suite needs no AWS credentials.
- Cross-tenant: a document belonging to clinic A is unreachable with clinic B's
  session, asserted at the API rather than by inspecting keys.
- A key from outside the caller's tenant prefix is refused even when named
  directly.
- A file over 25MB is refused before it is read into memory.
- Content type comes from the bytes: a PDF renamed `.jpg` is stored as a PDF.
- The role backfill actually inserted rows in every existing tenant — asserted by
  counting, because the RLS trap makes "the migration ran" and "the migration did
  something" different claims.

-- =============================================================================
-- A MEMBER OF STAFF CAN BELONG TO A DEPARTMENT
--
-- For the diagnostics role, which is the one this is for: the person who works
-- the X-ray room is not the person who works pathology, and until now nothing
-- recorded which was which. Their worklist showed every department's tests and
-- they filtered it by hand, every time.
--
-- ON `app_user`, NOT ON `practitioner`. A technician is a login with a role,
-- not a clinician: `xray@clinic.com` holds `diagnostics` and has no
-- practitioner row at all, which is why the `practitioner.department_id` that
-- the previous migration dropped could never have served this. That column was
-- about doctors and booking; this one is about who works in which room.
--
-- NULLABLE, and it has to be. Every other role — front desk, finance, the
-- administrator — has no department and should not be made to invent one. The
-- rule that diagnostics staff need one is enforced where the roles are known,
-- in `UsersService`, rather than by a NOT NULL that every other role would
-- fail.
--
-- ON DELETE SET NULL: a department is retired rather than deleted, so this
-- should almost never fire. If one ever is deleted, a technician who loses
-- their room should still be able to sign in — their work does not vanish with
-- the room, and an administrator can reassign them.
-- =============================================================================

ALTER TABLE "app_user"
  ADD COLUMN "department_id" uuid;

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_department_fkey"
  FOREIGN KEY ("department_id") REFERENCES "department" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Answers "who works in this department", which is what the department screen
-- asks for every row it draws.
CREATE INDEX "app_user_department_idx" ON "app_user" ("tenant_id", "department_id");

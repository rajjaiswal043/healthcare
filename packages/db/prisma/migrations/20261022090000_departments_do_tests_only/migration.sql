-- =============================================================================
-- A DEPARTMENT IS A PLACE THAT DOES TESTS
--
-- It used to be two things wearing one name: "the first step of booking" and
-- "where a test is performed", told apart by a boolean. The booking half never
-- earned its keep — nobody books an appointment with radiology, and the clinical
-- departments a clinic ended up with (General Medicine, Paediatrics, ENT) came
-- from a seed, were filtered against by a chip row above four doctors, and
-- duplicated the `specialty` already on the practitioner.
--
-- So the booking half goes, and what is left is the half that was always doing
-- the work: X-ray, Pathology, Physiotherapy — somewhere a patient is sent, that
-- a priced test belongs to, and that a diagnostic order is addressed to.
--
-- THREE COLUMNS GO, AND NOTHING THAT IS READ TODAY DEPENDS ON THEM:
--
--   department.is_diagnostic   — true for every department a clinic has any use
--                                for, and a flag that is always true is not a
--                                flag. "Does this department do tests" is now
--                                answered by `is_active`: a department that
--                                should not take orders is retired, which is
--                                the same decision expressed once.
--
--   practitioner.department_id — `specialty` says it already, and said it
--                                better: the finance desk was reading
--                                `specialty ?? department.name` long before
--                                this migration.
--
--   appointment.department_id  — only ever set by the booking screen's
--                                department filter, which is gone. Nothing
--                                read it back.
--
-- WHAT STAYS: `service.department_id` (which department performs this test) and
-- `diagnostic_order.department_id` (where this patient was sent). Those are the
-- load-bearing links and are untouched.
--
-- Dropping a column drops its foreign key and its indexes with it; both of
-- these columns are nullable and neither is part of a composite index, so there
-- is nothing to rebuild afterwards.
--
-- EXISTING CLINICAL DEPARTMENTS ARE LEFT ALONE, deliberately. After this
-- migration they are ordinary departments that happen to have no priced tests —
-- an administrator retires them from Settings → Departments, where the row
-- shows exactly how many tests and orders would be stranded. Deciding that for
-- them in a migration would be guessing at data this file cannot see.
-- =============================================================================

ALTER TABLE "appointment" DROP COLUMN "department_id";

ALTER TABLE "practitioner" DROP COLUMN "department_id";

ALTER TABLE "department" DROP COLUMN "is_diagnostic";

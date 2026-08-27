-- =============================================================================
-- THE HONORIFIC BELONGS TO THE NAME
--
-- `practitioner.prefix` held "Dr" separately from `full_name`, and the console
-- rendered `{prefix} {fullName}` everywhere a doctor appeared. It also DEFAULTED
-- to 'Dr' when nothing was supplied, which was the actual bug: an administrator
-- adding "Dr. Vivek Swarnkar" got a stored prefix of 'Dr' as well, and every
-- screen then read "Dr Dr. Vivek Swarnkar".
--
-- Narveer's decision on 26 Aug 2026: the clinic types the honorific into the
-- name, because they are the ones who know whether somebody is Dr, Ms or
-- neither, and a system-supplied "Dr" is wrong for a physiotherapist and
-- presumptuous for everyone.
--
-- So the prefix is folded into the name it belonged to and the column stops
-- being read. Folding rather than dropping matters: doctors already in the
-- database have prefix='Dr' and full_name='Vivek Swarnkar', and simply ceasing
-- to render the prefix would have quietly demoted every one of them.
-- =============================================================================

-- Only where the name does not already begin with it, so a row that was entered
-- as "Dr. Vivek Swarnkar" WITH a prefix of 'Dr' is left with one, not three.
-- The comparison strips the trailing full stop, since "Dr" and "Dr." are the
-- same honorific typed by two different people.
UPDATE practitioner
   SET full_name = btrim(prefix) || ' ' || full_name
 WHERE prefix IS NOT NULL
   AND btrim(prefix) <> ''
   AND lower(full_name) NOT LIKE lower(rtrim(btrim(prefix), '.')) || '%';

UPDATE practitioner SET prefix = NULL WHERE prefix IS NOT NULL;

COMMENT ON COLUMN "practitioner"."prefix" IS
  'RETAINED BUT UNUSED since 26 Aug 2026. The honorific lives in full_name, typed by the clinic. Kept rather than dropped so the fold above is reversible; do not read it.';

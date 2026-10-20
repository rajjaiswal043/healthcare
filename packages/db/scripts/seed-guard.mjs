/**
 * The one rule that keeps a seed off a real clinic's database.
 *
 * EVERY SEED IN THIS FOLDER IS DESTRUCTIVE. `seed-scheduling` deletes every
 * appointment, invoice, payment, receipt, encounter and practitioner for each
 * tenant before writing its own; `seed-auth` overwrites staff passwords with a
 * demo one. They are development tooling that happens to live in a shipped
 * repository, one `pnpm --filter` away from a production connection string.
 *
 * The guard they all used to carry was `url.pathname.includes('healthcloud')`,
 * which matches `healthcloud_prod` perfectly well. It only ever caught pointing
 * at some unrelated database; it never protected the one that matters.
 *
 * So: an ALLOWLIST BY SUFFIX, not a denylist. A database called
 * `healthcloud_dev` or `healthcloud_test` is obviously disposable and anything
 * else is assumed precious — because the failure modes are not symmetrical. A
 * refusal costs somebody ten seconds; the other mistake costs a clinic its
 * records, and there are no backups to go back to.
 *
 * The override exists because seeding a demo or staging box is a real need, and
 * a guard with no way past it gets deleted by the first person it inconveniences.
 * It has to name the database exactly, so it cannot be left in an environment
 * and quietly apply to the next one.
 */

/** Databases a seed may overwrite without being asked twice. */
const DISPOSABLE = ['_dev', '_test', '_local', '_demo'];

const OVERRIDE = 'SEED_ALLOW_DATABASE';

/**
 * Refuse to run unless this connection string points somewhere disposable.
 *
 * Exits the process rather than throwing: a seed that carried on after this
 * would be a seed whose guard was advisory.
 */
export function requireSeedableDatabase(url, scriptName) {
  if (!url) {
    console.error(`${scriptName}: MIGRATION_DATABASE_URL is not set.`);
    process.exit(1);
  }

  let name;
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    console.error(`${scriptName}: MIGRATION_DATABASE_URL is not a valid connection string.`);
    process.exit(1);
  }

  if (!name) {
    console.error(`${scriptName}: MIGRATION_DATABASE_URL names no database.`);
    process.exit(1);
  }

  if (DISPOSABLE.some((suffix) => name.endsWith(suffix))) return name;

  if (process.env[OVERRIDE] === name) {
    console.warn(`\n⚠  ${scriptName} is writing to "${name}" because ${OVERRIDE} names it.`);
    console.warn('   This DELETES existing clinic data. Stop now if that is not what you meant.\n');
    return name;
  }

  console.error(
    `\n${scriptName} refuses to run against "${name}".\n\n` +
      `  Seeds are destructive — they delete appointments, invoices, payments,\n` +
      `  receipts and staff passwords before writing demo data.\n\n` +
      `  They run without asking only on a database ending in ` +
      `${DISPOSABLE.join(', ')}.\n` +
      `  If you genuinely mean this one, set ${OVERRIDE}=${name}.\n`,
  );
  process.exit(1);
}

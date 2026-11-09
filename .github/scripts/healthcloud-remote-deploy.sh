#!/usr/bin/env bash
# One deployment engine for the GitHub production environment, independent of host identity.
set -Eeuo pipefail
umask 077
[[ $(id -un) == ubuntu ]] || { echo 'STOP: expected ubuntu'; exit 1; }
[[ $# == 6 ]] || { echo 'Usage: healthcloud-remote-deploy.sh SHA EXPECTED_HOSTNAME ARCHIVE_SHA256 WEB_BASE_URL API_BASE_URL NEXT_PUBLIC_API_BASE_URL'; exit 1; }
SHA=$1 EXPECTED_HOSTNAME=$2 EXPECTED_DIGEST=$3
EXPECTED_WEB_BASE_URL=$4 EXPECTED_API_BASE_URL=$5 EXPECTED_NEXT_PUBLIC_API_BASE_URL=$6
[[ $SHA =~ ^[0-9a-f]{40}$ && $EXPECTED_HOSTNAME =~ ^[A-Za-z0-9.-]+$ && $EXPECTED_DIGEST =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ $(hostname) == "$EXPECTED_HOSTNAME" ]] || { echo 'STOP: destination hostname mismatch'; exit 1; }
ROOT="$HOME/healthcloud-prod-deploy"; TARGET=/var/www/healthcloud
ARCHIVE="$ROOT/release-$SHA.tgz"; RELEASE="$ROOT/releases/$SHA"
RUN="$ROOT/recovery/$(date -u +%Y%m%dT%H%M%SZ)-$SHA"; ACTIVE="$ROOT/active-recovery"
mkdir -p "$ROOT" "$ROOT/releases" "$ROOT/recovery"
exec 9>"$ROOT/deployment.lock"; flock -n 9 || { echo 'STOP: concurrent deployment'; exit 1; }
[[ ! -e "$ACTIVE" ]] || { echo 'STOP: unresolved recovery marker; no changes made'; exit 1; }
[[ -f "$ARCHIVE" && -f "$TARGET/.env" ]] || { echo 'STOP: missing release or application .env'; exit 1; }
# Verify destination runtime configuration before creating a recovery marker or stopping services.
# Do not modify .env; do not expose credentials in logs.
(
  set -a
  source "$TARGET/.env"
  set +a
  [[ "${WEB_BASE_URL:-}" == "$EXPECTED_WEB_BASE_URL" ]] || { echo 'STOP: Server WEB_BASE_URL differs from approved GitHub Environment'; exit 1; }
  [[ "${API_BASE_URL:-}" == "$EXPECTED_API_BASE_URL" ]] || { echo 'STOP: Server API_BASE_URL differs from approved GitHub Environment'; exit 1; }
  [[ "${NEXT_PUBLIC_API_BASE_URL:-}" == "$EXPECTED_NEXT_PUBLIC_API_BASE_URL" ]] || { echo 'STOP: Server NEXT_PUBLIC_API_BASE_URL differs from approved GitHub Environment'; exit 1; }
)
echo 'PASS: Server runtime URLs match approved GitHub Environment; .env unchanged' 
[[ $(sha256sum "$ARCHIVE" | cut -d' ' -f1) == "$EXPECTED_DIGEST" ]] || { echo 'STOP: release digest mismatch'; exit 1; }
command -v node >/dev/null && command -v pnpm >/dev/null && command -v pm2 >/dev/null || { echo 'STOP: Node/pnpm/PM2 missing'; exit 1; }
[[ $(node -v) == v24.19.0 && $(pnpm -v) == 11.20.0 ]] || { echo 'STOP: unexpected runtime versions'; exit 1; }
sudo -n true
mkdir -p "$RUN" "$RELEASE"
LOG="$RUN/deploy.log"; exec > >(tee -a "$LOG") 2>&1
state=prepare; maintenance=0; backup_complete=0; recovered=0; had_previous=0; nginx_was_active=0; db_mutated=0
[[ -f "$TARGET/apps/api/dist/src/main.js" ]] && had_previous=1
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
health() { curl -fsS --max-time 5 http://127.0.0.1:3001/api/v1/health/live >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null; }
wait_health() {
  local i
  for i in $(seq 1 30); do if health; then return 0; fi; sleep 2; done
  return 1
}
# Reconnection guard: monitoring is repeated until backup and migration complete.
# Independent clients must still be disabled externally for full writer isolation.
assert_no_db_clients() {
  local db count
  for db in healthcloud healthcloud_shadow; do
    count=$(sudo -n -u postgres psql -XAt -v ON_ERROR_STOP=1 -d postgres -v db="$db" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();
SQL
)
    [[ $count == 0 ]] || { log "STOP: $db has $count external database connections"; return 1; }
  done
}
start_apps() {
  set -a; source "$TARGET/.env"; set +a
  if pm2 describe healthcloud-api >/dev/null 2>&1; then pm2 restart healthcloud-api --update-env
  else (cd "$TARGET/apps/api" && pm2 start dist/src/main.js --name healthcloud-api --cwd "$TARGET/apps/api"); fi
  if pm2 describe healthcloud-web >/dev/null 2>&1; then pm2 restart healthcloud-web --update-env
  else pm2 start "$TARGET/apps/web/scripts/next-with-dist.mjs" --name healthcloud-web --interpreter "$(command -v node)" --cwd "$TARGET/apps/web"; fi
}
stop_apps() {
  pm2 stop healthcloud-api >/dev/null 2>&1 || true
  pm2 stop healthcloud-web >/dev/null 2>&1 || true
}
# Restore uses the original pg_dump ACLs; never use --no-acl here.
restore_db() {
  local db=$1
  sudo -n -u postgres dropdb --if-exists --force "$db"
  sudo -n -u postgres createdb -O healthcloud_owner "$db"
  sudo -n -u postgres pg_restore --exit-on-error --no-owner --role=healthcloud_owner -d "$db" < "$RUN/$db.dump"
}
rollback() {
  log 'ROLLBACK: keeping external traffic stopped'
  stop_apps
  local ok=1
  if [[ $db_mutated == 1 ]]; then
    for db in healthcloud healthcloud_shadow; do restore_db "$db" || ok=0; done
  fi
  if [[ $had_previous == 1 ]]; then
    rsync -a --delete --exclude=.env --exclude=.data --exclude=node_modules --exclude=.git "$RUN/application/" "$TARGET/" || ok=0
    (cd "$TARGET" && pnpm install --frozen-lockfile --prod=false) || ok=0
    start_apps || ok=0
    wait_health || ok=0
  else
    # No prior release: leave Nginx stopped; do not serve a broken installation.
    pm2 delete healthcloud-api >/dev/null 2>&1 || true
    pm2 delete healthcloud-web >/dev/null 2>&1 || true
  fi
  if [[ $ok == 1 ]]; then
    if [[ $nginx_was_active == 1 && $had_previous == 1 ]]; then sudo -n systemctl start nginx || ok=0; fi
  fi
  if [[ $ok == 1 ]]; then recovered=1; rm -f "$ACTIVE"; log 'ROLLBACK COMPLETE';
  else
    sudo -n systemctl stop nginx || true
    log 'ROLLBACK FAILED: nginx remains stopped; recovery marker retained'
  fi
}
on_exit() {
  local rc=$?; trap - EXIT
  if ((rc != 0)); then
    log "FAILED stage=$state exit=$rc"
    pm2 jlist > "$RUN/pm2-status.json" 2>&1 || true
    if [[ $maintenance == 1 && $backup_complete == 1 ]]; then rollback || true
    elif [[ $maintenance == 1 ]]; then
      # No DB mutation has occurred. Reopen only after previous release health succeeds.
      if [[ $had_previous == 1 ]]; then
        if start_apps && wait_health && { [[ $nginx_was_active == 0 ]] || sudo -n systemctl start nginx; }; then
          recovered=1; rm -f "$ACTIVE"
        fi
      fi
    else
      # Failure before downtime: clear only our own recovery marker.
      rm -f "$ACTIVE"
    fi
    if [[ $recovered != 1 && $maintenance == 1 ]]; then sudo -n systemctl stop nginx || true; fi
    printf 'stage=%s\nexit=%s\nrecovered=%s\n' "$state" "$rc" "$recovered" > "$RUN/summary.txt"
    log "Diagnostics: $RUN"
  fi
  exit "$rc"
}
trap on_exit EXIT
# Prepare dependencies before downtime.
# Reject archive traversal and unexpected top-level paths before extraction.
python3 - "$ARCHIVE" <<'PYARCHIVE'
import sys,tarfile,pathlib
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path=pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk() or member.isdev():
            raise SystemExit('STOP: unsafe release archive member')
PYARCHIVE
tar -xzf "$ARCHIVE" -C "$RELEASE"
[[ -f "$RELEASE/apps/api/dist/src/main.js" && -d "$RELEASE/apps/web/.next-build" && -f "$RELEASE/pnpm-lock.yaml" ]] || { echo 'STOP: incomplete release'; exit 1; }
(cd "$RELEASE" && pnpm install --frozen-lockfile --prod=false)
node --check "$RELEASE/apps/api/dist/src/main.js"
node --check "$RELEASE/apps/web/scripts/next-with-dist.mjs"
# Validate database credentials without printing them.
set -a; source "$TARGET/.env"; set +a
[[ -n ${DATABASE_URL:-} && -n ${MIGRATION_DATABASE_URL:-} && -n ${SHADOW_DATABASE_URL:-} ]] || { echo 'STOP: database URLs missing'; exit 1; }
node - <<'JS'
for (const k of ['DATABASE_URL','MIGRATION_DATABASE_URL','SHADOW_DATABASE_URL']) {
  const u=new URL(process.env[k]);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw Error(`${k} must be local`);
}
if (new URL(process.env.DATABASE_URL).username !== 'healthcloud_app' ||
    new URL(process.env.MIGRATION_DATABASE_URL).username !== 'healthcloud_owner') throw Error('Unexpected DB roles');
if (new URL(process.env.SHADOW_DATABASE_URL).pathname !== '/healthcloud_shadow') throw Error('Unexpected shadow database');
JS
state=maintenance
printf 'sha=%s\nrecovery=%s\n' "$SHA" "$RUN" > "$ROOT/.active-recovery.tmp"
mv "$ROOT/.active-recovery.tmp" "$ACTIVE"
# Stop Nginx first: no new external requests while backups and migrations run.
if sudo -n systemctl is-active --quiet nginx; then nginx_was_active=1; fi
maintenance=1
sudo -n systemctl stop nginx
stop_apps
# Fail closed if other non-postgres DB sessions remain. Never back up a moving database.
for db in healthcloud healthcloud_shadow; do
  sudo -n -u postgres psql -v ON_ERROR_STOP=1 -d postgres -v db="$db" -At <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'db' AND usename IN ('healthcloud_app','healthcloud_owner') AND pid <> pg_backend_pid();
SQL
  remaining=$(sudo -n -u postgres psql -At -d postgres -v db="$db" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();
SQL
)
  [[ $remaining == 0 ]] || { echo "STOP: $db has active connections after isolation"; exit 1; }
done
assert_no_db_clients
state=backup
mkdir -p "$RUN/application"
if [[ $had_previous == 1 ]]; then rsync -a --exclude=.env --exclude=node_modules --exclude=.git "$TARGET/" "$RUN/application/"; fi
for db in healthcloud healthcloud_shadow; do
  sudo -n -u postgres pg_dump -Fc "$db" > "$RUN/$db.dump"
  [[ -s "$RUN/$db.dump" ]] && sudo -n -u postgres pg_restore --list < "$RUN/$db.dump" >/dev/null
done
backup_complete=1
assert_no_db_clients
state=migrate
# A migration can partially apply before returning a nonzero status.
db_mutated=1
(cd "$RELEASE" && pnpm --filter @healthcloud/db migrate:deploy)
assert_no_db_clients
state=activate
rsync -a --delete --exclude=.env --exclude=.data --exclude=node_modules --exclude=.git "$RELEASE/" "$TARGET/"
(cd "$TARGET" && pnpm install --frozen-lockfile --prod=false)
start_apps
state=health
wait_health || { echo 'STOP: health checks failed'; exit 1; }
state=reopen
if [[ $nginx_was_active == 1 ]]; then sudo -n systemctl start nginx; fi
# Confirm traffic has been reopened before recording success.
if [[ $nginx_was_active == 1 ]]; then
  reopened=0
  for i in $(seq 1 15); do if curl -fsS --max-time 8 http://127.0.0.1/api/v1/health/live >/dev/null; then reopened=1; break; fi; sleep 2; done
  [[ $reopened == 1 ]] || { echo 'STOP: post-reopen API health failed'; exit 1; }
fi
pm2 save
rm -f "$ACTIVE"
trap - EXIT
log "SUCCESS sha=$SHA recovery=$RUN"

# ADR-016 — Quality gates run locally as `pnpm verify` on a pre-push hook, not in CI

**Status:** Accepted (6 Aug 2026)
**Deciders:** Narveer
**Covers:** ADR-018 (git and deployment ownership)

## Context

Both source checklists ask for a CI pipeline — lint, typecheck, test, build, deploy only if green — and for pull-request review on a protected `main`.

Narveer has stated that **he pushes code to git and deploys from `main` himself**, and will say if he wants that automated later. Claude produces code, migrations, artifacts and runbooks, and does not run `git` or deploy.

That makes parts of the checklist's assumed workflow inapplicable as written: there is no pull request to gate, and no runner in the loop. The underlying goal — _nothing broken reaches the remote or production_ — still applies completely.

## Decision

**One command, `pnpm verify`, containing every gate, wired to a `pre-push` git hook.**

```
pnpm verify
  ├─ lint            eslint + prettier check
  ├─ typecheck       tsc --noEmit, strict, all packages
  ├─ test            unit + integration (against healthcloud_test)
  ├─ build           all apps and packages
  ├─ migrate:check   no drift between schema and migrations
  ├─ rls:check       every tenant-scoped table has tenant_id + an RLS policy
  └─ audit           npm audit
```

Supporting decisions:

- **A GitHub Actions workflow is committed but disabled.** It runs the identical `pnpm verify`. Enabling it is a one-line change, so moving to CI later is configuration, not a rewrite.
- **Claude never runs `git` or deploys.** Deliverables stop at files, migrations, build artifacts and runbooks.
- Deployment is documented in `docs/runbooks/deploy.md` for a human to execute.

## The honest tradeoff

**A local gate can be bypassed. `git push --no-verify` is one flag, and there's no server-side check to catch it.** A CI gate on a protected branch cannot be bypassed that way. This is a genuine reduction in enforcement strength, not a neutral relocation, and it should be recorded as such rather than glossed.

Three things make it acceptable here:

1. There is **one person pushing**. The failure mode a protected branch prevents — a colleague merging something red — doesn't currently exist.
2. `verify` is kept **fast**, because a slow gate is a bypassed gate. If it creeps past roughly two minutes, that's a defect to fix, not a reason to skip it.
3. The **escalation path is pre-built**. The day a second engineer joins, or the day something red reaches `main`, enabling the committed workflow restores full enforcement immediately.

## Alternatives considered

**Full CI/CD as the checklists specify.** Strongest enforcement. Deferred at Narveer's explicit request, not rejected on merit — hence the workflow file shipping disabled rather than absent.

**No gate at all, rely on discipline.** Rejected. The receipts principle both checklists are built on — _"you don't argue the app is well-built; you point at the receipts"_ — requires the checks to actually run.

**Server-side git hooks.** Rejected: requires infrastructure that doesn't exist and doesn't work with hosted GitHub.

## Consequences

**Good**

- Every checklist gate genuinely runs, on every push, from day one.
- No CI minutes, no runner configuration, no cloud dependency during Phase 1.
- Fast feedback — failures surface locally where they're fixed, not minutes later in a log.

**Costs, accepted**

- Bypassable, as set out above.
- Gates run on one machine, so an environment-specific pass is possible — something that only bites once a second machine or a Linux deploy target exists. The disabled CI workflow is the mitigation when that day comes.
- No pull-request review step. With a solo builder and a human reviewing generated code before pushing, the review exists; it just isn't mechanised.

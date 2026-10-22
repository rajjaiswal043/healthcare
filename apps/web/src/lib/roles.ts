/**
 * Who somebody is here, as the console decides it.
 *
 * ROLES RATHER THAN PERMISSIONS. Diagnostics holds `patient:read` and
 * `appointment:read` like everybody else, so permissions cannot answer "what
 * does this person actually do here" — and that is the question deciding which
 * board they land on and how much chrome it carries.
 *
 * One module because the answer is asked in two places that must agree: the
 * home page, choosing which board to render, and the board itself, deciding
 * whether to show filters that only make sense to somebody covering the whole
 * clinic. Two copies of this rule is how a technician ends up on the worklist
 * with an administrator's controls.
 */
export function worksOneDepartment(roles: Array<{ key: string }> | undefined): boolean {
  if (!roles || roles.length === 0) return false;

  /**
   * THE TEST IS "ONLY", AND THAT MATTERS. A login that holds diagnostics AND
   * the front desk — the ordinary arrangement in a small clinic where one
   * person does both — is not somebody who works one room: they need the
   * patient board and the whole-clinic view. Only a login that does nothing
   * else gets the narrower screen.
   */
  return roles.every((r) => r.key === 'diagnostics');
}

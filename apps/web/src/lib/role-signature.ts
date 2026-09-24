/**
 * Which persona the console is wearing.
 *
 * The colours themselves live in globals.css as `[data-role]` custom properties;
 * this file decides only WHICH role is showing and what it is called on screen.
 * Keeping the values in CSS means a component asks for `var(--role)` and stays
 * ignorant of personas entirely.
 */

/**
 * Precedence when someone holds more than one role.
 *
 * Highest privilege wins, because that is what the session can actually do: a
 * user who is both a doctor and an administrator can pair a screen and waive a
 * charge, and the chrome should say the more consequential thing. Ordered, not
 * alphabetical — the order IS the decision.
 */
const PRECEDENCE = ['administrator', 'owner', 'doctor', 'nurse', 'front_desk'] as const;

export type RoleKey = (typeof PRECEDENCE)[number];

/** Only these have a signature. Anything else falls back to the house teal. */
const KNOWN = new Set<string>(PRECEDENCE);

export interface RoleSignature {
  /** Goes on `data-role`, which is what selects the colours. */
  key: RoleKey | null;
  /** What the identity chip says. Never omitted — colour alone cannot carry five categories. */
  label: string;
}

/**
 * Resolve the signature from the roles on the session.
 *
 * Falls back rather than throwing: a tenant that renames or adds a role should
 * get an unthemed console, not a broken one.
 */
export function roleSignature(
  roles: Array<{ key: string; name: string }> | undefined,
): RoleSignature {
  if (!roles || roles.length === 0) return { key: null, label: 'Signed in' };

  const winner = PRECEDENCE.find((key) => roles.some((r) => r.key === key));

  if (!winner) {
    // An unrecognised role still has a name worth showing — the colour is what
    // we withhold, not the label.
    return { key: null, label: roles[0]?.name ?? 'Signed in' };
  }

  return {
    key: winner,
    // The tenant's own wording for the role, so a clinic that renames
    // "Front desk" to "Reception" sees Reception.
    label: roles.find((r) => r.key === winner)?.name ?? winner,
  };
}

/** Initials for the avatar. Two letters, from the first and last word of a name. */
export function initialsOf(fullName: string | undefined): string {
  if (!fullName) return '··';

  const words = fullName
    .replace(/^(Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const first = words[0];
  const last = words[words.length - 1];

  if (!first) return '··';
  if (!last || words.length === 1) return first.slice(0, 2).toUpperCase();

  // charAt over [0] on purpose: it returns a string rather than string |
  // undefined, so this needs no cast to satisfy noUncheckedIndexedAccess.
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** Only for KNOWN keys — used by the identity chip when it needs the colour inline. */
export function isRoleKey(value: string | null): value is RoleKey {
  return value !== null && KNOWN.has(value);
}

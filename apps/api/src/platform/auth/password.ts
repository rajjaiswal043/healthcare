import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// promisify picks the 3-argument overload, so the options-taking form has to be
// typed explicitly.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt.
 *
 * WHY SCRYPT and not argon2id or bcrypt:
 *
 *   - It is memory-hard and a current OWASP-acceptable password KDF, so the
 *     security properties are sound.
 *   - It is in Node's standard library. Every alternative means a native
 *     dependency — a build toolchain on Windows, prebuilt binaries to trust, and
 *     one more package in the supply chain of a system holding patient data.
 *     For a password hash, that trade is not worth it.
 *
 * argon2id would be marginally preferable on paper. If we ever add it, the
 * encoded format below carries its algorithm and parameters, so old hashes stay
 * verifiable and get upgraded on next successful login.
 */

// OWASP-aligned: N=2^16, r=8, p=1 → roughly 64 MB and ~100ms per hash.
// Deliberately slow. If login feels sluggish under load, add a worker — do not
// lower these.
const N = 65536;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt's memory use is roughly 128 * N * r bytes; Node's default maxmem
// (32 MB) is below what these parameters need, so it must be raised explicitly
// or the call fails.
const MAX_MEM = 128 * N * R * 2;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verify a password.
 *
 * Always performs the full derivation, even for a malformed stored hash, so
 * that timing does not distinguish "no such user" from "wrong password".
 * Comparison is constant-time.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Burn equivalent time rather than returning early — an early return here
    // leaks account existence through response latency.
    await hashPassword(plain);
    return false;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');

  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    await hashPassword(plain);
    return false;
  }

  const derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

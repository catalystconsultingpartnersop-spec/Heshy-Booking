// Client passwords.
//
// Stored as a scrypt hash with a per-client salt — never the password itself, so a copy of the
// data record doesn't hand anyone a working password. scrypt is deliberately slow and
// memory-hard, which is what makes guessing a stolen hash impractical; it ships with Node, so
// there is no dependency to keep up to date.
//
// Verification is constant-time: comparing with === leaks how much of a hash matched.

import { scrypt as _scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(_scrypt);

const KEYLEN = 64;
const COST = 16384;          // 2^14 — about 100ms, slow for an attacker, unnoticeable to a person
const BLOCK_SIZE = 8;
const PARALLEL = 1;

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 200;

/** Why a password isn't acceptable, or null if it is. */
export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < MIN_LENGTH) return `Please use at least ${MIN_LENGTH} characters.`;
  if (s.length > MAX_LENGTH) return 'That password is too long.';
  if (!s.trim()) return 'Please choose a password.';
  // Deliberately no symbol/number/capital rules: they push people toward "Password1!" and make
  // longer, better passwords feel disallowed. Length is what actually matters.
  const tooCommon = ['password', '12345678', 'qwertyui', 'letmein1', 'iloveyou', '11111111'];
  if (tooCommon.includes(s.toLowerCase())) return 'That password is too easy to guess — please pick another.';
  return null;
}

/** Produces a self-describing string: scrypt$<cost>$<salt>$<hash>. */
export async function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(pw), salt, KEYLEN, { N: COST, r: BLOCK_SIZE, p: PARALLEL });
  return `scrypt$${COST}$${salt}$${derived.toString('hex')}`;
}

/** True only for the right password. Never throws on a malformed or missing stored value. */
export async function verifyPassword(pw, stored) {
  try {
    if (!stored || typeof stored !== 'string') return false;
    const [scheme, cost, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !cost || !salt || !hash) return false;
    const derived = await scrypt(String(pw), salt, hash.length / 2, { N: Number(cost), r: BLOCK_SIZE, p: PARALLEL });
    const a = Buffer.from(hash, 'hex');
    return a.length === derived.length && timingSafeEqual(a, derived);
  } catch (e) {
    return false;
  }
}

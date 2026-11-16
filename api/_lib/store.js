// Safe access to the one record that holds the whole business.
//
// Almost everything lives in a single KV entry called app-data, and every endpoint used to read
// it, change its own corner, and write the whole thing back. Two of those overlapping loses one
// of them completely: a client booking while Heshy has Manage open could erase his edits, or his
// save could erase their booking. Nothing warned anyone; the record simply came back missing
// something.
//
// Two protections, because there are two different failures:
//
//   mutate()  takes a short lock so concurrent writers run one at a time, each reading the
//             record fresh after the one before it has finished. This is what stops writes
//             silently overwriting each other.
//
//   version   increments on every write. Manage sends back the version it loaded, so a tab left
//             open for an hour is told its view is stale instead of flattening newer data with
//             what it remembers.
//
// A lock is not free, so it is deliberately short-lived and always released, including when the
// work inside throws. If a function holding the lock dies outright, the lock expires by itself.

import { kv } from '@vercel/kv';
import { randomBytes } from 'crypto';

const KEY = 'app-data';
const LOCK_KEY = 'app-data-lock';
const LOCK_TTL_SECONDS = 15;   // far longer than any of these writes takes
const MAX_WAIT_MS = 6000;      // give up rather than leave a client hanging forever

export class StaleDataError extends Error {
  constructor(current) {
    super('This page is out of date — it was loaded before someone else saved a change.');
    this.name = 'StaleDataError';
    this.current = current;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function acquireLock() {
  const holder = randomBytes(12).toString('hex');
  const deadline = Date.now() + MAX_WAIT_MS;
  let delay = 25;
  for (;;) {
    // NX means "only if nobody holds it". EX means it frees itself if we die.
    const got = await kv.set(LOCK_KEY, holder, { nx: true, ex: LOCK_TTL_SECONDS });
    if (got) return holder;
    if (Date.now() >= deadline) return null;
    await sleep(delay + Math.floor(Math.random() * 25)); // jitter, so waiters don't retry in step
    delay = Math.min(delay * 2, 400);
  }
}

async function releaseLock(holder) {
  try {
    // Only release our own lock: if ours already expired and someone else took it, deleting
    // would hand a third writer a lock two people think they hold.
    const current = await kv.get(LOCK_KEY);
    if (current === holder) await kv.del(LOCK_KEY);
  } catch (e) { /* the lock expires by itself; never fail the request over this */ }
}

export async function readData() {
  return (await kv.get(KEY)) || null;
}

/**
 * Run a change against the record, with nobody else writing at the same time.
 *
 * @param {(data:object)=>any} fn  receives the record, freshly read inside the lock. Mutate it.
 *   Return SKIP_WRITE to finish without saving; anything else is passed back to the caller.
 * @param {object} [opts]
 * @param {number} [opts.expectVersion]  reject if the record has moved on since this version
 * @param {object} [opts.fallback]  used when the record does not exist yet
 */
export const SKIP_WRITE = Symbol('skip-write');

export async function mutate(fn, opts = {}) {
  const holder = await acquireLock();
  // Busy is rare and brief. Going ahead unlocked would reintroduce exactly the bug this exists
  // to prevent, so the caller is told to retry instead.
  if (!holder) {
    const err = new Error('The system was briefly busy saving something else. Please try again.');
    err.code = 'LOCK_TIMEOUT';
    throw err;
  }
  try {
    const data = (await kv.get(KEY)) || opts.fallback || null;
    if (!data) {
      const err = new Error('No data found');
      err.code = 'NO_DATA';
      throw err;
    }
    if (opts.expectVersion != null && (data.version || 0) !== opts.expectVersion) {
      throw new StaleDataError(data);
    }
    const result = await fn(data);
    if (result === SKIP_WRITE) return result;
    data.version = (data.version || 0) + 1;
    data.updatedAt = Date.now();
    await kv.set(KEY, data);
    return result;
  } finally {
    await releaseLock(holder);
  }
}

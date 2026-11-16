// Snapshots of the business record, so a bad save is something you undo rather than something
// you live with.
//
// Everything is one mutable record. Until now there was no export, no history and no way back:
// if a save went wrong, or something deleted more than it should have, the previous state was
// simply gone. There is no point validating saves if a mistake that gets through is permanent.
//
// Snapshots live in their own KV entries, never inside app-data, so a bad write to the record
// can't take its own history with it.

import { kv } from '@vercel/kv';
import { randomBytes } from 'crypto';

const INDEX_KEY = 'backup-index';
const PREFIX = 'backup:';
const MAX_KEEP = 20;
const RETAIN_DAYS = 45;

// The timestamp alone is not unique: two snapshots taken in the same millisecond would share an
// id and the second would overwrite the first, silently shortening the history.
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');

/**
 * Take a snapshot. Never throws: a backup that fails must not take the actual work down with it.
 * @param {object} data   the record to snapshot
 * @param {string} reason why ('daily', 'before-restore', 'manual')
 */
export async function takeBackup(data, reason = 'manual') {
  try {
    if (!data || typeof data !== 'object') return null;
    const id = stamp() + '-' + reason;
    const entry = {
      id,
      at: Date.now(),
      reason,
      version: data.version || 0,
      counts: {
        clients: (data.clients || []).length,
        bookings: (data.bookings || []).length,
        coupons: (data.settings?.coupons || []).length
      }
    };
    await kv.set(PREFIX + id, data, { ex: 60 * 60 * 24 * RETAIN_DAYS });

    const index = (await kv.get(INDEX_KEY)) || [];
    index.unshift(entry);
    // Keep the newest few; drop the rest, and their payloads with them.
    const dropped = index.slice(MAX_KEEP);
    const kept = index.slice(0, MAX_KEEP);
    await kv.set(INDEX_KEY, kept);
    for (const d of dropped) { try { await kv.del(PREFIX + d.id); } catch (e) { /* it expires anyway */ } }
    return entry;
  } catch (e) {
    console.error('Backup failed:', e);
    return null;
  }
}

/** What snapshots exist, newest first. Sizes and counts only — not the data itself. */
export async function listBackups() {
  try {
    const index = (await kv.get(INDEX_KEY)) || [];
    return index;
  } catch (e) {
    console.error('Could not read the backup index:', e);
    return [];
  }
}

/** The full contents of one snapshot, for restoring or downloading. */
export async function readBackup(id) {
  if (!id || typeof id !== 'string') return null;
  // Only ids that appear in the index — never an arbitrary key from the caller.
  const index = await listBackups();
  if (!index.some(e => e.id === id)) return null;
  try { return (await kv.get(PREFIX + id)) || null; } catch (e) { return null; }
}

/** True when the newest snapshot is older than the given number of hours (or there is none). */
export async function isDueForBackup(hours = 20) {
  const index = await listBackups();
  if (!index.length) return true;
  return (Date.now() - (index[0].at || 0)) > hours * 60 * 60 * 1000;
}

// Where uploaded files live, and how hard they are to find.
//
// Working Genius reports and session audio were uploaded to paths built from a timestamp and
// the original filename — "wg-pdfs/1756412345678-rivka_report.pdf". Those are guessable: a
// filename plus a timestamp inside a known window is a small search space, and anyone who ever
// saw one URL learned the whole naming scheme.
//
// Vercel Blob on this plan serves files publicly, so the path IS the credential. The fix is to
// make the path genuinely unguessable — 32 hex characters of real randomness, which is not
// something anyone searches their way to — and to rotate every file that was stored under the
// old scheme, deleting the original so any link that leaked stops working.
//
// The app holds the storage credential at runtime, so it does all of this itself.

import { put, del } from '@vercel/blob';
import { randomBytes } from 'crypto';

const secret = () => randomBytes(16).toString('hex');
const safeName = n => String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

/** True for a path produced by the old timestamp-plus-filename scheme. */
export function isLegacyPath(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:')) return true;          // still inline in the record
  if (!/blob\.vercel-storage\.com/.test(url)) return false;
  // New paths carry a 32-hex segment; old ones never do.
  return !/\/[0-9a-f]{32}\//.test(url);
}

/** Store a file under a path nobody can guess. */
export async function storeFile(kind, name, buffer, contentType) {
  const blob = await put(`${kind}/${secret()}/${safeName(name)}`, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false
  });
  if (!blob || !blob.url) throw new Error('Storage did not return a url.');
  return blob.url;
}

/** Remove a stored file. Never throws: a failed delete must not fail the work around it. */
export async function removeFile(url) {
  if (!url || typeof url !== 'string' || !/blob\.vercel-storage\.com/.test(url)) return false;
  try { await del(url); return true; } catch (e) { console.error('Could not delete blob:', e); return false; }
}

/**
 * Move one file to an unguessable path and delete the original.
 * Returns the new url, or null if it could not be moved — in which case the caller must leave
 * the existing value exactly as it was rather than losing the only copy.
 */
export async function rotateFile(kind, name, url) {
  try {
    if (!url) return null;
    let buffer, contentType;
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      contentType = (url.slice(5, comma).split(';')[0]) || 'application/octet-stream';
      buffer = Buffer.from(url.slice(comma + 1), 'base64');
    } else {
      const res = await fetch(url);
      if (!res.ok) return null;
      contentType = res.headers.get('content-type') || 'application/octet-stream';
      buffer = Buffer.from(await res.arrayBuffer());
    }
    if (!buffer || !buffer.length) return null;
    const next = await storeFile(kind, name, buffer, contentType);
    if (!next) return null;
    // Only now is it safe to remove the original.
    if (!url.startsWith('data:')) await removeFile(url);
    return next;
  } catch (e) {
    console.error('Could not rotate file:', e);
    return null;
  }
}

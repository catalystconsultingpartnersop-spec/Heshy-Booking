// The smaller hardening items: ids that can't collide, a cleanup tool that can't destroy the
// only copy of something, and portal sessions that actually end.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const booking = readFileSync(new URL('../api/create-booking.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../api/admin-data.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../api/portal-lookup.js', import.meta.url), 'utf8');

// --- ids -------------------------------------------------------------------------------------
check('booking ids come from a real random source', /return randomUUID\(\);/.test(booking));
check('...imported properly', /import \{ randomUUID \} from 'crypto'/.test(booking));
check('no 8-character Math.random id remains on the server',
      !/Math\.random\(\)\.toString\(36\)\.slice\(2, ?10\)/.test(booking));
check('the page uses randomUUID where available', /crypto\.randomUUID\(\)/.test(html));
check('...with a real-randomness fallback, not Math.random', /crypto\.getRandomValues/.test(html));

// Prove the browser generator actually produces unique, long ids.
const uidSrc = (html.match(/function uid\(\)\{[\s\S]*?\n\}/) || [])[0];
check('the page id generator was found', !!uidSrc);
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  'const crypto = globalThis.crypto;\n' + uidSrc + '\nexport { uid };').toString('base64'));
const ids = new Set();
for (let i = 0; i < 20000; i++) ids.add(mod.uid());
check('20,000 generated ids are all different', ids.size === 20000, `${ids.size} unique`);
check('...and long enough to stay that way', [...ids][0].length >= 32, String([...ids][0].length));

// --- the PDF cleanup tool ------------------------------------------------------------------------
check('a failed move leaves the original alone', /the original has been left untouched/.test(admin));
check('...and no longer clears it', !/target\.wgPdfData = '';/.test(admin));
check('...and says it did not succeed', /ok: false, migrated/.test(admin));
check('a storage result with no url counts as a failure', /Storage did not return a url/.test(admin));

// --- portal sessions ----------------------------------------------------------------------------------
check('portal sessions are no longer 60 days', !/ex: 60 \* 60 \* 24 \* 60/.test(portal));
check('...they are 14', /PORTAL_SESSION_SECONDS = 60 \* 60 \* 24 \* 14/.test(portal));
check('there is a real logout on the server', /action === 'logout'/.test(portal));
check('...which deletes the session rather than ignoring it', /kv\.del\('portal-session:' \+ t\)/.test(portal));
check('the page calls it when a client logs out', /action:'logout', token: dying/.test(html));
check('...and still clears local state even if that call fails', /\.catch\(\(\)=>\{\}\)/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

// public/assessment.js is generated from api/_lib/assessment.js. If someone edits one and not
// the other, the page and the server start asking different questions or scoring them
// differently — and nobody would notice until a client's result was wrong.
import { readFileSync } from 'node:fs';
import { generate } from '../tools/gen-assessment-browser.mjs';
import * as server from '../api/_lib/assessment.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const onDisk = readFileSync(new URL('../public/assessment.js', import.meta.url), 'utf8');
check('the browser copy is in step with the server source', onDisk === generate(),
      'run: node tools/gen-assessment-browser.mjs');

// Load the browser copy exactly as a browser would, and compare behaviour against the server.
const win = {};
new Function('window', onDisk)(win);
const B = win.ASSESSMENT;
check('the browser copy exposes an ASSESSMENT object', !!B);

check('same questions, in the same order', JSON.stringify(B.ITEMS) === JSON.stringify(server.ITEMS));
check('same question bank', JSON.stringify(B.QUESTIONS) === JSON.stringify(server.QUESTIONS));
check('same angles and answer wording', JSON.stringify(B.LENSES) === JSON.stringify(server.LENSES));
check('same trait wording', JSON.stringify(B.TRAITS) === JSON.stringify(server.TRAITS));
check('same result wording', JSON.stringify(B.TYPES) === JSON.stringify(server.TYPES));

// Score the same answers both sides, many different ways, and demand identical results.
let s = 987654321;
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
let compared = 0, drift = 0;
for (let i = 0; i < 300; i++) {
  const items = {};
  for (const q of server.ITEMS) items[q.id] = 1 + Math.floor(rnd() * 5);
  const ans = { items, extra: [] };
  // Walk the backups on BOTH sides in lockstep; a difference would mean the page asks a
  // question the server wouldn't accept.
  for (let k = 0; k <= server.MAX_EXTRA; k++) {
    const qs = server.nextExtra(ans), qb = B.nextExtra(ans);
    if (qs !== qb) { drift++; if (failures.length < 4) failures.push(`backup ${k} differs: server ${qs} browser ${qb}`); break; }
    if (!qs) break;
    ans.extra.push(qs); ans.items[qs] = 1 + Math.floor(rnd() * 5);
  }
  compared++;
  if (!server.validAnswers(ans)) { drift++; if (failures.length < 6) failures.push('server rejected answers the page would send'); }
  const rs = server.score(ans), rb = B.score(ans);
  if (rs.letters !== rb.letters || rs.clear !== rb.clear || JSON.stringify(rs.scores) !== JSON.stringify(rb.scores)) {
    drift++;
    if (failures.length < 6) failures.push(`scoring differs: server ${rs.letters} browser ${rb.letters}`);
  }
  if (JSON.stringify(server.profileOf(rs.letters)) !== JSON.stringify(B.profileOf(rb.letters))) {
    drift++;
    if (failures.length < 8) failures.push(`profile differs for ${rs.letters}`);
  }
}
check(`${compared} full assessments scored identically on both sides`, drift === 0, `${drift} differences`);
console.log(`ran ${compared} complete assessments through both copies`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

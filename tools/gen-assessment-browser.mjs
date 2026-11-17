// public/assessment.js is generated from api/_lib/assessment.js so the browser and the server
// run the identical questions and the identical scoring. Nothing here is hand-maintained.
//
//   node tools/gen-assessment-browser.mjs          write the browser copy
//   node tools/gen-assessment-browser.mjs --check  fail if it is out of date
//
// tests/assessment-copy.test.mjs runs the check, so the two can never quietly drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'api/_lib/assessment.js');
const TARGET = join(root, 'public/assessment.js');

const EXPOSED = ['LETTERS', 'TRAITS', 'LENSES', 'QUESTIONS', 'ITEMS', 'MAX_EXTRA', 'TOTAL_MAX', 'TYPES', 'questionById', 'closeCall',
                 'baseComplete', 'validAnswers', 'nextExtra', 'score',
                 'parseLetters', 'profileOf'];

export function generate() {
  const src = readFileSync(SOURCE, 'utf8').replace(/^export (const|function) /gm, '$1 ');
  return [
    '// GENERATED FILE - DO NOT EDIT.',
    '// Built from api/_lib/assessment.js by tools/gen-assessment-browser.mjs so the page and the',
    '// server ask the same questions and score them the same way. Edit the source, then run:',
    '//   node tools/gen-assessment-browser.mjs',
    '(function(){',
    src,
    'window.ASSESSMENT = { ' + EXPOSED.join(', ') + ' };',
    '})();',
    ''
  ].join('\n');
}

const expected = generate();
if (process.argv.includes('--check')) {
  let actual = null;
  try { actual = readFileSync(TARGET, 'utf8'); } catch (e) { /* missing */ }
  if (actual !== expected) {
    console.error('public/assessment.js is out of date. Run: node tools/gen-assessment-browser.mjs');
    process.exit(1);
  }
  console.log('public/assessment.js is up to date');
} else if (process.argv[1] && process.argv[1].endsWith('gen-assessment-browser.mjs')) {
  writeFileSync(TARGET, expected);
  console.log('wrote public/assessment.js (' + expected.length + ' bytes)');
}

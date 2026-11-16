// The assessment was ported from The Candidate Collection. These check that the port is
// faithful (same questions, same scoring) and that a result can't be faked by the browser.
import * as a from '../api/_lib/assessment.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// --- shape of the questionnaire -----------------------------------------------------------------
check('24 rating statements', a.ITEMS.length === 24, String(a.ITEMS.length));
check('9 forced choices', a.PAIRS.length === 9, String(a.PAIRS.length));
check('up to 10 follow-ups', a.MAX_EXTRA === 10);
check('43 questions in all', a.ITEMS.length + a.PAIRS.length + a.MAX_EXTRA === 43);
check('each kind of work is asked about four times',
      a.LETTERS.every(k => a.ITEMS.filter(q => q.key === k).length === 4),
      JSON.stringify(a.LETTERS.map(k => k + ':' + a.ITEMS.filter(q => q.key === k).length)));
check('each kind of work appears three times in the forced choices',
      a.LETTERS.every(k => a.PAIRS.filter(p => p.a === k || p.b === k).length === 3));
check('every question has a unique id', new Set(a.ITEMS.map(q => q.id)).size === 24);
check('no statement is blank', a.ITEMS.every(q => q.text.trim().length > 5));
check('six short phrasings for each kind of work',
      a.LETTERS.every(k => a.SNIPPETS[k]?.length === 6));
check('every top-two combination has result wording', Object.keys(a.TYPES).length === 15);
check('every trait has a label', a.LETTERS.every(k => a.TRAITS[k]?.label));

// --- scoring --------------------------------------------------------------------------------
function answersFavouring(best, worst) {
  const items = {};
  for (const q of a.ITEMS) items[q.id] = q.key === best ? 5 : q.key === worst ? 1 : 3;
  const pairs = {};
  for (const p of a.PAIRS) pairs[p.id] = (p.a === best || p.b === worst) ? p.a : p.b;
  return { items, pairs, extra: [] };
}
for (const [best, worst] of [['W','T'], ['T','W'], ['I','E'], ['G','D'], ['E','I'], ['D','G']]) {
  const r = a.score(answersFavouring(best, worst));
  check(`someone who loves ${best} ranks it first`, r.order[0] === best, r.letters);
  check(`someone who hates ${worst} ranks it last`, r.order[5] === worst, r.letters);
}

// Someone who loves everything still gets a real answer — scores are measured against their own
// average, not an absolute scale. This is the detail that makes the thing work.
const loveAll = { items: Object.fromEntries(a.ITEMS.map(q => [q.id, q.key === 'D' ? 5 : 4])), pairs: {}, extra: [] };
// Choose D wherever it's offered, so the ratings and the choices agree.
for (const p of a.PAIRS) loveAll.pairs[p.id] = (p.b === 'D' ? p.b : p.a);
const r = a.score(loveAll);
check('someone who rates everything highly still gets a ranked result',
      r.order.length === 6 && new Set(r.order).size === 6, r.letters);
check('...and the one they rated highest comes out on top', r.order[0] === 'D', r.letters);

// Ratings alone must still separate people, even with the forced choices pulling the other way.
const ratingsOnly = { items: Object.fromEntries(a.ITEMS.map(q => [q.id, q.key === 'E' ? 5 : 2])), pairs: {}, extra: [] };
for (const p of a.PAIRS) ratingsOnly.pairs[p.id] = (p.a === 'E' ? p.b : p.a); // never pick E
const ro = a.score(ratingsOnly);
check('strong ratings still register even when every choice went the other way',
      ro.order.indexOf('E') <= 2, ro.letters);

const flat = { items: Object.fromEntries(a.ITEMS.map(q => [q.id, 3])), pairs: {}, extra: [] };
for (const p of a.PAIRS) flat.pairs[p.id] = p.a;
const flatResult = a.score(flat);
check('completely flat ratings still return all six letters', flatResult.letters.length === 6);
check('...and report whether the result settled', typeof flatResult.clear === 'boolean');

const r2 = a.score(answersFavouring('W', 'T'));
check('scores are 0-100', a.LETTERS.every(k => r2.scores[k] >= 0 && r2.scores[k] <= 100), JSON.stringify(r2.scores));
check('the letters string matches the order', r2.letters === r2.order.join(''));
check('scoring is deterministic', a.score(answersFavouring('W','T')).letters === r2.letters);

// --- the adaptive follow-ups ------------------------------------------------------------------
const close = { items: Object.fromEntries(a.ITEMS.map(q => [q.id, 3])), pairs: {}, extra: [] };
for (const p of a.PAIRS) close.pairs[p.id] = p.a;
let nx = a.nextExtra(close);
check('a close result produces a follow-up question', !!nx);
check('...comparing two different kinds of work', nx && nx.a !== nx.b);
check('...using real phrasings', nx && a.SNIPPETS[nx.a][nx.ai] && a.SNIPPETS[nx.b][nx.bi]);

// Walk all ten follow-ups through and make sure it terminates and stays valid.
const walk = { items: close.items, pairs: close.pairs, extra: [] };
let steps = 0;
while (steps < 20) {
  const q = a.nextExtra(walk);
  if (!q) break;
  walk.extra.push({ a: q.a, ai: q.ai, b: q.b, bi: q.bi, pick: q.a });
  steps++;
}
check('the follow-ups stop after ten', steps === 10, String(steps));
check('no eleventh follow-up is offered', a.nextExtra(walk) === null);
check('the answers it collected are valid', a.validExtra(walk.extra));
check('a completed run scores cleanly', a.score(walk).letters.length === 6);

// --- what the server will and won't accept -----------------------------------------------------
const good = answersFavouring('W', 'T');
check('a complete set of answers is accepted', a.validAnswers(good));
check('missing a rating is rejected', !a.validAnswers({ ...good, items: { ...good.items, q1: undefined } }));
check('a rating outside 1-5 is rejected', !a.validAnswers({ ...good, items: { ...good.items, q1: 9 } }));
check('a missing forced choice is rejected', !a.validAnswers({ ...good, pairs: { ...good.pairs, p1: undefined } }));
check('a forced choice naming a letter that was not offered is rejected',
      !a.validAnswers({ ...good, pairs: { ...good.pairs, p1: 'Z' } }));
check('nothing at all is rejected', !a.validAnswers(null) && !a.validAnswers({}) && !a.validAnswers('WIDGET'));
check('more than ten follow-ups is rejected',
      !a.validExtra(Array.from({ length: 11 }, () => ({ a:'W', ai:0, b:'T', bi:0, pick:'W' }))));
check('a follow-up picking a third letter is rejected',
      !a.validExtra([{ a:'W', ai:0, b:'T', bi:0, pick:'D' }]));
check('a follow-up comparing a letter with itself is rejected',
      !a.validExtra([{ a:'W', ai:0, b:'W', bi:1, pick:'W' }]));
check('an out-of-range phrasing index is rejected',
      !a.validExtra([{ a:'W', ai:99, b:'T', bi:0, pick:'W' }]));

// --- existing Working Genius letters carry across ------------------------------------------------
check('plain letters parse', a.parseLetters('GTDEIW').join('') === 'GTDEIW');
check('lowercase parses', a.parseLetters('gtdeiw').join('') === 'GTDEIW');
check('slashes and spaces are ignored', a.parseLetters('GT/DE/IW').join('') === 'GTDEIW');
check('spaces are ignored', a.parseLetters('GT DE IW').join('') === 'GTDEIW');
check('full Working Genius names parse',
      a.parseLetters('Galvanizing, Tenacity, Discernment, Enablement, Invention, Wonder').join('') === 'GTDEIW');
check('duplicate letters are dropped', a.parseLetters('WWIDGET').join('') === 'WIDGET');
check('stray characters are dropped', a.parseLetters('W-I-D-G-E-T!').join('') === 'WIDGET');
check('nothing in, nothing out', a.parseLetters('').length === 0 && a.parseLetters(null).length === 0);

// Heshy's own result, which he gives as WDGE/IT.
const his = a.profileOf('WDGEIT');
check('his own result reads as two strengths', his.primary.join('') === 'WD');
check('...two he can do well', his.secondary.join('') === 'GE');
check('...two that wear him down', his.draining.join('') === 'IT');
check('...and names the combination', his.type?.name === 'Strategic thinker', his.type?.name);

check('order within the top two does not change the name',
      a.profileOf('DWGEIT').type?.name === a.profileOf('WDGEIT').type?.name);
check('every top-two pair resolves to a named type',
      a.LETTERS.every(x => a.LETTERS.every(y => x === y || !!a.profileOf(x + y + a.LETTERS.filter(z => z!==x && z!==y).join('')).type)));
check('a partial result is marked incomplete', a.profileOf('WD').complete === false);
check('a full result is marked complete', a.profileOf('WDGEIT').complete === true);
check('an empty result has no type', a.profileOf('').type === null);

// A scored run always produces a displayable profile.
const scored = a.score(answersFavouring('G', 'W'));
const prof = a.profileOf(scored.letters);
check('a freshly scored run produces a complete profile', prof.complete && !!prof.type, scored.letters);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

// The assessment was ported from The Candidate Collection. These check that the port is
// faithful (same questions, same scoring) and that a result can't be faked by the browser.
import * as a from '../api/_lib/assessment.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// --- shape of the questionnaire -----------------------------------------------------------------
check('30 main questions', a.ITEMS.length === 30, String(a.ITEMS.length));
check('60 questions in the bank (a backup for each)', a.QUESTIONS.length === 60);
check('up to 13 backups', a.MAX_EXTRA === 13);
check('43 questions at most', a.TOTAL_MAX === 43);
check('five angles', a.LENSES.length === 5);
check('every angle has five answers', a.LENSES.every(l => l.scale.length === 5));
check('each kind of work is asked from all five angles',
      a.LETTERS.every(k => new Set(a.ITEMS.filter(q => q.key === k).map(q => q.lens)).size === 5));
check('the same kind of work is never asked twice in a row',
      a.ITEMS.every((q, i) => i === 0 || a.ITEMS[i - 1].key !== q.key));
check('every question has a unique id', new Set(a.QUESTIONS.map(q => q.id)).size === 60);
check('no question is blank', a.QUESTIONS.every(q => q.text.trim().length > 5));
check('no either/or questions left', !('PAIRS' in a) && !('SNIPPETS' in a));
check('every top-two combination has result wording', Object.keys(a.TYPES).length === 15);
check('every trait has a label', a.LETTERS.every(k => a.TRAITS[k]?.label));

// Answers the main 30, then keeps answering backups the same way until the assessment stops.
function run(rate) {
  const ans = { items: {}, extra: [] };
  for (const q of a.ITEMS) ans.items[q.id] = rate(q);
  let id;
  while ((id = a.nextExtra(ans))) { ans.extra.push(id); ans.items[id] = rate(a.questionById(id)); }
  return ans;
}
const favouring = (best, worst) => run(q => q.key === best ? 5 : q.key === worst ? 1 : 3);

// --- scoring --------------------------------------------------------------------------------
for (const [best, worst] of [['W','T'], ['T','W'], ['I','E'], ['G','D'], ['E','I'], ['D','G']]) {
  const r = a.score(favouring(best, worst));
  check(`someone who loves ${best} ranks it first`, r.order[0] === best, r.letters);
  check(`someone who hates ${worst} ranks it last`, r.order[5] === worst, r.letters);
}
const loveAll = run(q => q.key === 'D' ? 5 : 4);
const r = a.score(loveAll);
check('someone who rates everything highly still gets a ranked result', new Set(r.order).size === 6, r.letters);
check('...and the one they rated highest comes out on top', r.order[0] === 'D', r.letters);

const clear = run(q => ({ W: 5, D: 5, G: 3, E: 3, I: 1, T: 1 })[q.key]);
check('a clear-cut person needs no backups', clear.extra.length === 0, String(clear.extra.length));
check('...and gets the right result', a.score(clear).letters.slice(0, 2).split('').sort().join('') === 'DW' && a.score(clear).clear);

const flat = run(() => 3);
check('completely flat answers still return all six letters', a.score(flat).letters.length === 6);
check('...use every backup', flat.extra.length === 13, String(flat.extra.length));
check('...and are reported as a close call', a.score(flat).clear === false && !!a.closeCall(flat));
check('backups never repeat', new Set(flat.extra).size === flat.extra.length);
check('backups are real backup questions', flat.extra.every(id => a.questionById(id)?.backup));

const r2 = a.score(favouring('W', 'T'));
check('scores are 0-100', a.LETTERS.every(k => r2.scores[k] >= 0 && r2.scores[k] <= 100), JSON.stringify(r2.scores));
check('the letters string matches the order', r2.letters === r2.order.join(''));
check('scoring is deterministic', a.score(favouring('W','T')).letters === r2.letters);
check('no more than 43 questions ever', [flat, clear, loveAll].every(x => a.ITEMS.length + x.extra.length <= 43));

// --- what the server will and won't accept -----------------------------------------------------
const good = flat;
check('a complete set of answers is accepted', a.validAnswers(good) && a.validAnswers(clear));
check('missing a main answer is rejected', !a.validAnswers({ ...good, items: { ...good.items, [a.ITEMS[0].id]: undefined } }));
check('an answer outside 1-5 is rejected', !a.validAnswers({ ...good, items: { ...good.items, [a.ITEMS[0].id]: 9 } }));
check('stopping before the backups are done is rejected', !a.validAnswers({ ...good, extra: good.extra.slice(0, 3) }));
check('backups in the wrong order are rejected', !a.validAnswers({ ...good, extra: [...good.extra].reverse() }));
check('an unanswered backup is rejected', !a.validAnswers({ ...good, items: { ...good.items, [good.extra[0]]: undefined } }));
check('made-up backups are rejected', !a.validAnswers({ ...clear, extra: ['day.W1'], items: { ...clear.items, 'day.W1': 5 } }));
check('nothing at all is rejected', !a.validAnswers(null) && !a.validAnswers({}) && !a.validAnswers('WIDGET'));

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
const scored = a.score(favouring('G', 'W'));
const prof = a.profileOf(scored.letters);
check('a freshly scored run produces a complete profile', prof.complete && !!prof.type, scored.letters);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

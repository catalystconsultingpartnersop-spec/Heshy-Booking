// GENERATED FILE - DO NOT EDIT.
// Built from api/_lib/assessment.js by tools/gen-assessment-browser.mjs so the page and the
// server ask the same questions and score them the same way. Edit the source, then run:
//   node tools/gen-assessment-browser.mjs
(function(){
// Heshy's own strengths assessment, brought over from The Candidate Collection.
//
// Six kinds of work (the letters W I D G E T). The result is two that come naturally, two they
// can do well, and two that wear them down. 43 questions: 24 ratings (four different ways of
// asking about each kind of work), 9 "which would you rather", then 10 more chosen one at a
// time to settle whatever is still too close to call.
//
// The questions, the scoring and the wording are all Heshy's. This replaces Working Genius
// across the booking app.
//
// The server re-scores from the raw answers rather than trusting a result computed in the
// browser, so what gets stored on a client record is always what their answers actually say.

const LETTERS = ['W', 'I', 'D', 'G', 'E', 'T'];

const TRAITS = {
  W: { label: 'Big-picture thinking', short: 'Sees the bigger picture and asks the questions that matter' },
  I: { label: 'Fresh ideas',          short: 'Comes up with new ways to solve problems' },
  D: { label: 'Sound judgment',       short: 'Has good instincts about what will and won’t work' },
  G: { label: 'Getting people moving',short: 'Rallies people and gets things started' },
  E: { label: 'Supporting the team',  short: 'Notices what others need and helps them succeed' },
  T: { label: 'Finishing the job',    short: 'Drives work over the finish line' }
};

// Part 1: how much energy each kind of work gives them. Four angles on each.
const RAW = [
  ['W', 'Stepping back to ask whether we’re even doing the right thing'],
  ['I', 'Coming up with a brand-new idea or solution'],
  ['D', 'Hearing an idea and sensing right away whether it will work'],
  ['G', 'Getting people excited about a new plan'],
  ['E', 'Jumping in when someone asks for a hand'],
  ['T', 'Pushing a project across the finish line'],
  ['I', 'Being handed a problem nobody has solved yet'],
  ['T', 'Taking care of the last details so it’s fully done'],

  ['D', 'Giving honest feedback that makes someone’s plan better'],
  ['W', 'Having quiet time to think about where things are heading'],
  ['E', 'Helping make someone else’s plan a success'],
  ['G', 'Getting a stuck project moving again'],
  ['T', 'Sticking with a task until it’s complete, even when it gets boring'],
  ['I', 'Brainstorming lots of different ways to do something'],
  ['W', 'Wondering why something is done the way it is'],
  ['D', 'Spotting what’s off in a plan before it goes wrong'],

  ['G', 'Rallying a group when energy is low'],
  ['E', 'Noticing what a teammate needs and taking care of it'],
  ['W', 'Noticing a need or an opportunity before anyone else sees it'],
  ['T', 'Checking off a to-do list, one item at a time'],
  ['I', 'Starting from a blank page'],
  ['D', 'Being the one people ask, “What do you think of this?”'],
  ['E', 'Being the person everyone can count on to help'],
  ['G', 'Pushing people to stop talking and start doing']
];
const ITEMS = RAW.map(([key, text], i) => ({ id: 'q' + (i + 1), key, text }));

// Three choices, not five. The values stay 1 / 3 / 5 rather than 1 / 2 / 3 so the scoring keeps
// the same spread it was calibrated against — only the number of buttons changes, not the maths.
const SCALE = [
  { v: 1, label: 'Drains me' },
  { v: 3, label: 'It’s okay' },
  { v: 5, label: 'Love it' }
];

// Part 2: forced choices. Each kind of work comes up three times.
const PAIRS_RAW = [
  ['W', 'Thinking about where the business should go next', 'D', 'Judging which of three plans is best'],
  ['I', 'Coming up with ideas', 'T', 'Getting things finished'],
  ['G', 'Leading the charge on something new', 'E', 'Supporting the team behind the scenes'],
  ['W', 'Reflecting on how things could be better', 'T', 'Finishing a project down to the last detail'],
  ['I', 'Inventing a new way to solve a problem', 'D', 'Deciding which solution is the right one'],
  ['G', 'Kicking off a project', 'T', 'Wrapping up a project'],
  ['D', 'Giving advice on a big decision', 'E', 'Pitching in wherever help is needed'],
  ['W', 'Pondering a big question', 'G', 'Getting people fired up to act'],
  ['I', 'Designing something new', 'E', 'Helping a coworker get their work done']
];
const PAIRS = PAIRS_RAW.map(([a, at, b, bt], i) => ({ id: 'p' + (i + 1), a, at, b, bt }));

// Part 3: short ways of saying each kind of work, for the follow-up choices.
const SNIPPETS = {
  W: ['Thinking through the big questions', 'Asking why we do it this way', 'Imagining where things could go',
      'Taking time to reflect before acting', 'Spotting a need nobody has noticed', 'Questioning whether we have the right goal'],
  I: ['Coming up with a new idea', 'Inventing a fresh solution', 'Starting something from scratch',
      'Brainstorming ten ways to do it', 'Designing something original', 'Finding a creative way around a problem'],
  D: ['Judging which idea will work', 'Giving honest feedback on a plan', 'Trusting my gut on a decision',
      'Spotting the flaw in a plan', 'Weighing the options and picking the best', 'Being asked for my opinion'],
  G: ['Getting people excited to start', 'Rallying the team', 'Kicking off something new',
      'Convincing people to take action', 'Getting a stalled project moving', 'Recruiting people to help'],
  E: ['Helping someone with their task', 'Supporting the team behind the scenes', 'Saying yes when someone needs a hand',
      'Making someone else’s plan work', 'Taking care of what people need', 'Being there when the team needs me'],
  T: ['Finishing what we started', 'Handling the final details', 'Making sure everything is done right',
      'Pushing through to the deadline', 'Crossing tasks off the list', 'Seeing a project all the way through']
};

const MAX_EXTRA = 10;
const CLEAR = 0.15; // a gap this big between two kinds of work is a settled answer

const isLetter = x => typeof x === 'string' && LETTERS.includes(x);

function baseComplete(a) {
  return ITEMS.every(q => a.items?.[q.id] >= 1 && a.items[q.id] <= 5)
      && PAIRS.every(p => a.pairs?.[p.id] === p.a || a.pairs?.[p.id] === p.b);
}

function validExtra(extra) {
  return Array.isArray(extra) && extra.length <= MAX_EXTRA && extra.every(e =>
    e && isLetter(e.a) && isLetter(e.b) && e.a !== e.b && (e.pick === e.a || e.pick === e.b) &&
    Number.isInteger(e.ai) && Number.isInteger(e.bi) && e.ai >= 0 && e.ai < 6 && e.bi >= 0 && e.bi < 6);
}

/** Everything the server needs before it will store a result. */
function validAnswers(a) {
  return !!a && typeof a === 'object' && baseComplete(a) && validExtra(a.extra || []);
}

// Mostly from how they rated each kind of work (against their own average, so someone who loves
// everything still gets a real answer), the rest from what they picked when they had to choose.
function raw(a) {
  const all = ITEMS.map(q => a.items[q.id] ?? 3);
  const avg = all.reduce((x, y) => x + y, 0) / all.length;
  const wins = {}, seen = {};
  const choices = [...PAIRS.map(p => ({ a: p.a, b: p.b, pick: a.pairs[p.id] })), ...(a.extra || [])];
  for (const c of choices) {
    if (!c.pick) continue;
    seen[c.a] = (seen[c.a] ?? 0) + 1;
    seen[c.b] = (seen[c.b] ?? 0) + 1;
    wins[c.pick] = (wins[c.pick] ?? 0) + 1;
  }
  const out = {};
  for (const k of LETTERS) {
    const mine = ITEMS.filter(q => q.key === k).map(q => a.items[q.id] ?? 3);
    const rating = Math.max(-1, Math.min(1, (mine.reduce((x, y) => x + y, 0) / mine.length - avg) / 2));
    const choice = seen[k] ? ((wins[k] ?? 0) / seen[k] - 0.5) * 2 : 0;
    out[k] = 0.6 * rating + 0.4 * choice;
  }
  return out;
}

function ranked(a) {
  const r = raw(a);
  return { r, order: [...LETTERS].sort((x, y) => r[y] - r[x]) };
}

// The two dividing lines that matter: strengths vs middle, middle vs drains.
function unsettled(a) {
  const { r, order } = ranked(a);
  const out = [];
  for (const cut of [2, 4]) {
    for (const hi of order.slice(0, cut)) for (const lo of order.slice(cut)) out.push({ a: hi, b: lo, gap: r[hi] - r[lo] });
  }
  return out.sort((x, y) => x.gap - y.gap);
}

/** The next follow-up question: always the closest call still open. Null once all ten are done. */
function nextExtra(a) {
  if ((a.extra || []).length >= MAX_EXTRA) return null;
  const extra = a.extra || [];
  const asked = (x, y) => extra.filter(e => (e.a === x && e.b === y) || (e.a === y && e.b === x)).length;
  const close = unsettled(a);
  const open = close.filter(c => c.gap < CLEAR);
  const pool = open.length ? open : close.slice(0, 3);
  // The closest call, but don't keep asking the same two over and over.
  const pick = [...pool].sort((x, y) => x.gap + asked(x.a, x.b) * 0.08 - (y.gap + asked(y.a, y.b) * 0.08))[0];
  const used = k => extra.flatMap(e => (e.a === k ? [e.ai] : e.b === k ? [e.bi] : []));
  const fresh = k => {
    const u = used(k);
    for (let i = 0; i < 6; i++) if (!u.includes(i)) return i;
    return extra.length % 6;
  };
  const [x, y] = extra.length % 2 ? [pick.b, pick.a] : [pick.a, pick.b];
  return { a: x, ai: fresh(x), b: y, bi: fresh(y) };
}

function score(a) {
  const { r, order } = ranked(a);
  const scores = {};
  for (const k of LETTERS) scores[k] = Math.round((r[k] + 1) * 50);
  return { v: 2, order, letters: order.join(''), scores, clear: !unsettled(a).some(c => c.gap < CLEAR) };
}

// --- How the result reads ---------------------------------------------------------------------
// One entry for each possible top-two combination.
const TYPES = {
  WI: { name: 'Innovator', line: 'Full of big questions and fresh ideas; at their best at the start of something new.',
        wiredFor: ['asking “what if?”', 'dreaming up new approaches', 'starting from a blank page'] },
  WD: { name: 'Strategic thinker', line: 'Reflective and wise; gives careful, well-reasoned advice and notices what others miss.',
        wiredFor: ['thinking things through', 'giving wise counsel', 'spotting what others miss'] },
  WG: { name: 'Inspiring leader', line: 'Curious and energetic; gets people excited about where things could go.',
        wiredFor: ['big-picture enthusiasm', 'getting people excited about ideas', 'opening new doors'] },
  WE: { name: 'Caring team player', line: 'Quietly tuned in to what people need; steady, loyal and thoughtful.',
        wiredFor: ['thoughtful support', 'anticipating what people need', 'being the steady presence'] },
  WT: { name: 'Thorough executor', line: 'Thorough and dependable, with real depth behind the work.',
        wiredFor: ['careful, thorough work', 'steady reliability', 'getting it right the first time'] },
  ID: { name: 'Problem solver', line: 'Comes up with ideas and has the instinct to pick the ones that will actually work.',
        wiredFor: ['solving real problems', 'practical creativity', 'knowing which idea will work'] },
  IG: { name: 'Creative spark', line: 'Dreams up new ideas and gets everyone else excited about them.',
        wiredFor: ['selling new ideas', 'infectious enthusiasm', 'turning a concept into buy-in'] },
  IE: { name: 'Solutions builder', line: 'Designs solutions around what people actually need, and adapts as those needs change.',
        wiredFor: ['designing around people’s needs', 'flexible problem-solving', 'adapting on the fly'] },
  IT: { name: 'Systems builder', line: 'Invents a better way of doing things, then builds it properly so it lasts.',
        wiredFor: ['building systems that last', 'precise planning', 'turning ideas into working processes'] },
  DE: { name: 'Trusted right hand', line: 'Reads people and situations well and gives exactly the help that’s needed.',
        wiredFor: ['reading people', 'the right help at the right time', 'being a trusted sounding board'] },
  DG: { name: 'Decisive leader', line: 'Sizes up a situation quickly, makes the call, and gets people moving on it.',
        wiredFor: ['quick, confident decisions', 'rallying people around a plan', 'taking charge in the moment'] },
  DT: { name: 'Gets it done right', line: 'Makes good calls and sees them through to completion, with practical urgency.',
        wiredFor: ['good calls made quickly', 'focused execution', 'practical urgency'] },
  GE: { name: 'Team motivator', line: 'Encourages and lifts people; brings momentum and a positive mood to any team.',
        wiredFor: ['lifting team spirit', 'encouraging others', 'building relationships'] },
  GT: { name: 'Driver', line: 'Pushes forward, pitches in personally, and makes sure deadlines are met.',
        wiredFor: ['driving deadlines', 'holding people accountable', 'rolling up their sleeves'] },
  ET: { name: 'Reliable go-to person', line: 'Responsive and committed; steps up when something is needed and follows through every time.',
        wiredFor: ['dependable follow-through', 'stepping up when needed', 'keeping every commitment'] }
};

const NAME_TO_LETTER = { wonder:'W', invention:'I', discernment:'D', galvanizing:'G', enablement:'E', tenacity:'T' };

/**
 * Reads a stored six-letter result. Accepts "GTDEIW", "GT/DE/IW", "GT DE IW" and full names —
 * which is what lets the Working Genius letters already on client records carry straight over
 * without anyone retaking anything.
 */
function parseLetters(rawValue) {
  if (!rawValue) return [];
  const words = String(rawValue).toLowerCase().match(/[a-z]+/g) || [];
  const fromNames = words.map(w => NAME_TO_LETTER[w]).filter(Boolean);
  const letters = fromNames.length ? fromNames : String(rawValue).toUpperCase().replace(/[^WIDGET]/g, '').split('');
  const seen = new Set();
  return letters.filter(l => (seen.has(l) ? false : (seen.add(l), true)));
}

function typeKey(a, b) {
  return [a, b].sort((x, y) => LETTERS.indexOf(x) - LETTERS.indexOf(y)).join('');
}

/** The shape the page and Manage both display. */
function profileOf(rawValue) {
  const l = parseLetters(rawValue);
  const primary = l.slice(0, 2);
  const secondary = l.slice(2, 4);
  const draining = l.length === 6 ? l.slice(4, 6) : [];
  const type = primary.length === 2 ? (TYPES[typeKey(primary[0], primary[1])] || null) : null;
  return { letters: l.join(''), primary, secondary, draining, type, complete: l.length === 6 };
}

window.ASSESSMENT = { LETTERS, TRAITS, ITEMS, SCALE, PAIRS, SNIPPETS, MAX_EXTRA, TYPES, baseComplete, validExtra, validAnswers, nextExtra, score, parseLetters, profileOf };
})();

// Heshy's own strengths assessment. Also used by The Candidate Collection.
//
// Six kinds of work (the letters W I D G E T). The result is two that come naturally, two they
// can do well, and two that wear them down.
//
// The server re-scores from the raw answers rather than trusting a result computed in the
// browser, so what gets stored on a client record is always what their answers actually say.

export const LETTERS = ['W', 'I', 'D', 'G', 'E', 'T'];

export const TRAITS = {
  W: { label: 'Big-picture thinking', short: 'Sees the bigger picture and asks the questions that matter' },
  I: { label: 'Fresh ideas',          short: 'Comes up with new ways to solve problems' },
  D: { label: 'Sound judgment',       short: 'Has good instincts about what will and won’t work' },
  G: { label: 'Getting people moving',short: 'Rallies people and gets things started' },
  E: { label: 'Supporting the team',  short: 'Notices what others need and helps them succeed' },
  T: { label: 'Finishing the job',    short: 'Drives work over the finish line' }
};

// ---- The questions ------------------------------------------------------------------------------
// Version 3. Every question is answered on the same kind of five-step scale; there are no
// either/or choices. The same question is asked from five angles: how the work makes you feel,
// how you see yourself, how others see you, what you actually find yourself doing, and what a
// whole day of it would be like. That last angle is the honesty check: everyone likes helping,
// fewer want a whole day of it.
//
// 30 main questions (one per angle for each of the six kinds of work). When two kinds of work
// come out too close to call, up to 13 backup questions are asked about just those two, so 43 at
// most. Someone with a clear result finishes in about 34.
//
// The same questions and scoring live in the booking app (api/_lib/assessment.js) and in The
// Candidate Collection (src/lib/assessment.ts). Change one, change both.

export const LENSES = [
  { id: 'energy', part: 'Your energy', intro: 'First, how different kinds of work make you feel. Think about your best days, not just your current job.', prompt: 'How does doing this make you feel?', scale: ['Drains me', 'Not really me', 'It’s okay', 'I enjoy it', 'Love it'] },
  { id: 'self', part: 'How you see yourself', intro: 'Now, how true each statement is of you. Be honest, not modest and not generous.', prompt: 'How true is this of you?', scale: ['Not me at all', 'A little', 'Somewhat', 'Mostly', 'That’s me'] },
  { id: 'others', part: 'How others see you', intro: 'Picture the people who know you best: family, friends, coworkers. What would they say?', prompt: 'People who know you well would say you…', scale: ['No way', 'Rarely', 'Sometimes', 'Often', 'Definitely'] },
  { id: 'life', part: 'What you actually do', intro: 'Not what you think you should do. What you really find yourself doing.', prompt: 'How often do you find yourself…', scale: ['Never', 'Rarely', 'Sometimes', 'Often', 'All the time'] },
  { id: 'day', part: 'A whole day of it', intro: 'Last angle. Imagine a whole workday made of just one thing.', prompt: 'If your whole workday was this, it would be…', scale: ['Exhausting', 'Draining', 'Fine', 'A good day', 'A great day'] }
];

// [main question, backup question] for each angle and kind of work.
const BANK = {
  energy: {
    W: ['Thinking about why things are done the way they are', 'Imagining where things could be in a few years'],
    I: ['Coming up with a brand-new idea or solution', 'Figuring out a new way when the old way isn’t working'],
    D: ['Hearing an idea and giving your honest take on it', 'Weighing a few options and helping choose the best one'],
    G: ['Getting people excited about a new plan', 'Getting a group moving when nobody’s taking the lead'],
    E: ['Helping someone else get their work done', 'Hearing “can you give me a hand?” and jumping in'],
    T: ['Taking care of the final details so something is fully done', 'Working through a to-do list until it’s empty']
  },
  self: {
    W: ['I’m always wondering if there’s a better way, even when things are working.', 'I enjoy questions that don’t have an easy answer.'],
    I: ['I have more ideas than I could ever use.', 'Starting from a blank page excites me.'],
    D: ['I can usually tell right away whether an idea will work.', 'My gut about people and plans is usually right.'],
    G: ['When a group is stuck, I’m the one who gets it going.', 'I like being the one who kicks things off.'],
    E: ['I’m happiest when someone tells me what they need and I can take care of it.', 'I get real satisfaction from making someone else’s plan work.'],
    T: ['I can’t rest until a task is completely finished.', 'Loose ends bother me until they’re tied up.']
  },
  others: {
    W: ['always ask “why?”', 'are a deep thinker'],
    I: ['are full of creative ideas', 'always have another idea'],
    D: ['give great advice', 'have good instincts about people and plans'],
    G: ['bring energy into a room and get people moving', 'can get people on board with a plan'],
    E: ['are the first to offer help', 'make other people’s work easier'],
    T: ['always follow through', 'are the one who makes sure things actually get finished']
  },
  life: {
    W: ['wondering about the bigger picture in the middle of a task', 'asking “why do we do it this way?”'],
    I: ['coming up with ideas nobody asked for', 'working out your own solution before anyone hands you one'],
    D: ['being asked “what do you think?”', 'catching the weak spot in a plan before it goes wrong'],
    G: ['rallying people, even when you’re not in charge', 'being the one who says “let’s go, let’s do this”'],
    E: ['putting your own work aside to help someone', 'noticing what someone needs before they ask'],
    T: ['going back to tie up loose ends others left behind', 'staying on a task until it’s completely done']
  },
  day: {
    W: ['Thinking, reading and reflecting on where things are going', 'Talking through big questions with no deadline'],
    I: ['Brainstorming and designing something from scratch', 'Sketching out new plans, ideas or designs'],
    D: ['Reviewing other people’s plans and giving feedback', 'Being the person everyone runs their decisions by'],
    G: ['Getting people fired up and moving on something new', 'Pitching a plan and getting people to sign on'],
    E: ['Taking care of whatever the people around you need', 'Helping teammates with their tasks'],
    T: ['Wrapping up projects down to the last detail', 'Checking task after task off the list']
  }
};

// The order inside each part, so the same kind of work never comes up twice in a row.
const ORDERS = [['I','E','W','T','G','D'], ['G','D','T','W','E','I'], ['E','W','G','I','D','T'], ['I','T','D','E','W','G'], ['D','G','E','W','T','I']];

const LETTER_LIST = ['W', 'I', 'D', 'G', 'E', 'T'];
export const QUESTIONS = [];
LENSES.forEach((lens, li) => {
  for (const key of LETTER_LIST) {
    BANK[lens.id][key].forEach((text, v) => QUESTIONS.push({ id: lens.id + '.' + key + v, lens: li, key, text, backup: v === 1 }));
  }
});
const BY_ID = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
export const ITEMS = LENSES.flatMap((lens, li) => ORDERS[li].map(key => BY_ID[lens.id + '.' + key + '0']));
export const MAX_EXTRA = 13;
export const TOTAL_MAX = ITEMS.length + MAX_EXTRA;
const SETTLED = 1.0; // how far apart two kinds of work must be (in measured uncertainty) to call it
const BACKUP_LENS_ORDER = [4, 0, 1, 3, 2]; // backups ask the whole-day angle first: the hardest to over-rate

export function questionById(id) { return BY_ID[id] || null; }
const okRating = v => Number.isInteger(v) && v >= 1 && v <= 5;

export function baseComplete(a) {
  return !!a && typeof a === 'object' && !!a.items && ITEMS.every(q => okRating(a.items[q.id]));
}

// Each answer is compared to how the person answers within that same angle, so a generous or a
// strict rater still gets a true picture. Then each kind of work gets its average and how sure
// we are of it.
function stats(a) {
  const asked = ITEMS.concat((a.extra || []).map(id => BY_ID[id]).filter(Boolean)).filter(q => okRating(a.items[q.id]));
  const lensAvg = LENSES.map((_, li) => {
    const xs = asked.filter(q => q.lens === li).map(q => a.items[q.id]);
    return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 3;
  });
  const st = {};
  for (const k of LETTER_LIST) {
    const xs = asked.filter(q => q.key === k).map(q => a.items[q.id] - lensAvg[q.lens]);
    const n = xs.length || 1;
    const m = xs.reduce((x, y) => x + y, 0) / n;
    const v = xs.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, xs.length - 1);
    st[k] = { m, se: Math.sqrt(Math.max(v, 0.5) / n) };
  }
  const order = [...LETTER_LIST].sort((x, y) => (st[y].m - st[x].m) || (LETTER_LIST.indexOf(x) - LETTER_LIST.indexOf(y)));
  // Every pair that sits on opposite sides of a dividing line (strengths | middle | drains),
  // closest first.
  const pairs = [];
  for (const cut of [2, 4]) {
    for (const hi of order.slice(cut - 2, cut)) for (const lo of order.slice(cut, cut + 2)) {
      pairs.push({ z: (st[hi].m - st[lo].m) / Math.hypot(st[hi].se, st[lo].se), a: hi, b: lo });
    }
  }
  pairs.sort((x, y) => x.z - y.z);
  const worst = pairs[0];
  return { st, order, worst, pairs };
}

// The next backup question, or null when the result is settled (or all 13 are used). Always
// about one of the two kinds of work that are closest across a dividing line.
export function nextExtra(a) {
  const extra = a.extra || [];
  if (extra.length >= MAX_EXTRA) return null;
  const { st, pairs } = stats(a);
  const pick = k => {
    const used = extra.map(id => BY_ID[id]).filter(q => q && q.key === k).map(q => q.lens);
    const li = BACKUP_LENS_ORDER.find(l => !used.includes(l));
    return li === undefined ? null : LENSES[li].id + '.' + k + '1';
  };
  for (const p of pairs) {
    if (p.z >= SETTLED) break;
    const first = st[p.a].se >= st[p.b].se ? p.a : p.b;
    const second = first === p.a ? p.b : p.a;
    const id = pick(first) || pick(second);
    if (id) return id;
  }
  return null;
}

/** Everything the server needs before it will store a result. The backups are replayed, so a
 *  browser can't skip ahead or pick its own questions. */
export function validAnswers(a) {
  if (!baseComplete(a) || !Array.isArray(a.extra || []) || (a.extra || []).length > MAX_EXTRA) return false;
  const extra = a.extra || [];
  for (let i = 0; i < extra.length; i++) {
    if (nextExtra({ items: a.items, extra: extra.slice(0, i) }) !== extra[i]) return false;
    if (!okRating(a.items[extra[i]])) return false;
  }
  return nextExtra({ items: a.items, extra }) === null;
}

export function score(a) {
  const { st, order, worst } = stats(a);
  const scores = {};
  for (const k of LETTER_LIST) scores[k] = Math.max(0, Math.min(100, Math.round(50 + st[k].m * 25)));
  return { v: 3, order, letters: order.join(''), scores, clear: worst.z >= SETTLED, asked: ITEMS.length + (a.extra || []).length };
}

/** The pair that was too close to call, if any, for the results page. */
export function closeCall(a) {
  const { worst } = stats(a);
  return worst.z >= SETTLED ? null : [worst.a, worst.b];
}

// --- How the result reads ---------------------------------------------------------------------
// One entry for each possible top-two combination.
export const TYPES = {
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
export function parseLetters(rawValue) {
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
export function profileOf(rawValue) {
  const l = parseLetters(rawValue);
  const primary = l.slice(0, 2);
  const secondary = l.slice(2, 4);
  const draining = l.length === 6 ? l.slice(4, 6) : [];
  const type = primary.length === 2 ? (TYPES[typeKey(primary[0], primary[1])] || null) : null;
  return { letters: l.join(''), primary, secondary, draining, type, complete: l.length === 6 };
}

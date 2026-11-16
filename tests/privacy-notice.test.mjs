// Clients are told that sessions can be recorded, before they book and before it happens.
// Nothing in the booking flow used to mention it at all.
import { readFileSync } from 'node:fs';
import { bookingConfirmationEmail } from '../api/_lib/email.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');

// --- the booking page ---------------------------------------------------------------------
check('the booking form mentions recording before they book', /sometimes recorded/i.test(html));
check('...says they will be told first', /tell you first/i.test(html));
check('...says they can refuse', /you can say no/i.test(html));
check('...and links to the privacy page', /href="\/privacy\.html"/.test(html));

// --- before anything is recorded ---------------------------------------------------------------
check('starting a recording asks whether the client agreed',
      /async function startRecording[\s\S]{0,400}?confirm\('Has the client been told/.test(html));
check('...and stops if not', /confirm\('Has the client been told[\s\S]{0,200}?\)\) return;/.test(html));

// --- the confirmation email ----------------------------------------------------------------------
const mail = bookingConfirmationEmail(
  { date: '2026-12-01', time: '11:00', durationMin: 60, type: 'virtual', clientName: 'Rivka Stern', meetLink: 'https://meet.google.com/abc' },
  { hourlyRate: 500 });
check('the confirmation email mentions recording', /recorded/i.test(mail.html));
check('...says they can say no', /say no/i.test(mail.html));
check('...and links to the privacy page', /privacy\.html/.test(mail.html));

// --- the privacy page itself ------------------------------------------------------------------------
check('the privacy page exists and names recording up front', /Sessions may be recorded/i.test(privacy));
check('it says who can see recordings', /Only Heshy has access/i.test(privacy));
check('it names the services involved', /Stripe/.test(privacy) && /Google/.test(privacy) && /Vercel/.test(privacy));
check('it says information is not sold', /(isn.t|never) sold/i.test(privacy));
check('it says how long things are kept', /How long it is kept/i.test(privacy));
check('it tells people how to get a recording deleted', /deleted/i.test(privacy));
check('it gives a real contact address', /heshy@catalystconsultingnyc\.com/.test(privacy));
check('it carries the business name', /Catalyst Consulting Partners LLC/.test(privacy));
check('it is a complete standalone page', /^<!doctype html>/i.test(privacy.trim()) && /<\/html>/i.test(privacy));
check('it declares a viewport so it works on a phone', /name="viewport"/.test(privacy));
check('it has a real title', /<title>[^<]{10,}<\/title>/.test(privacy));
check('it links back to booking', /href="\/"/.test(privacy));
check('it sets its colours explicitly rather than inheriting', /--ink:/.test(privacy) && /background:var\(--bg\)/.test(privacy));

// It must not promise something the app doesn't do.
check('it does not claim recordings are encrypted end to end', !/end-to-end/i.test(privacy));
check('it does not promise a deletion deadline the app cannot keep', !/within \d+ (days|hours)/i.test(privacy));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

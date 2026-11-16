// The client-facing details: page identity, Eastern-time labelling, keyboard access, and
// telling the truth when something behind the scenes fails.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const booking = readFileSync(new URL('../api/create-booking.js', import.meta.url), 'utf8');

// --- page identity ----------------------------------------------------------------------------
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
check('the page has a real title, not just "Heshy"', title.length > 10 && title !== 'Heshy', title);
check('...naming what the page is for', /book/i.test(title), title);
check('there is a description for search and link previews', /<meta name="description" content="[^"]{30,}"/.test(html));
check('there is a favicon', /<link rel="icon"/.test(html));
check('there is a canonical url', /<link rel="canonical"/.test(html));
check('there is link-preview metadata', /og:title/.test(html) && /og:description/.test(html));
check('indexing is an explicit decision', /<meta name="robots"/.test(html));

// --- Eastern time -------------------------------------------------------------------------------
check('the page works out whether the viewer is already in Eastern time', /VIEWER_IN_ET/.test(html));
check('...by comparing their actual timezone', /resolvedOptions\(\)\.timeZone === 'America\/New_York'/.test(html));
check('...and falls back safely if that is unavailable', /catch\(e\)\{ return false; \}/.test(html));
check('times carry the zone where it matters', (html.match(/etSuffix\(\)/g) || []).length >= 3,
      String((html.match(/etSuffix\(\)/g) || []).length));
check('a New York client is not told something they already know',
      /VIEWER_IN_ET \? '' : ' ET'/.test(html));

// --- next steps on the confirmation screen ----------------------------------------------------------
check('the confirmation offers add-to-calendar', /calendarAddLink\(/.test(html));
check('...built from the real session time', /etToUtcC\(date, time\)/.test(html));
check('...and links to the portal to cancel', /View or cancel this session/.test(html));
check('...and says what to do about moving it', /Need to move it/.test(html));

// --- honesty when the email fails ---------------------------------------------------------------------
check('the server reports whether the confirmation actually sent', /confirmationSent/.test(booking));
check('...takes it from the send result rather than assuming', /confirmationSent = await sendEmail/.test(booking));
check('...records a failure in the problem log', /Confirmation email did not send/.test(booking));
check('the page stops claiming an email is on its way when it is not',
      /confirmationSent === false[\s\S]{0,160}couldn/.test(html));
check('...while making clear the booking itself is safe', /your booking is safe/i.test(html));

// --- keyboard --------------------------------------------------------------------------------------------
check('the booking controls are given button semantics', /setAttribute\('role','button'\)/.test(html));
check('...and can be reached by tabbing', /setAttribute\('tabindex','0'\)/.test(html));
check('...and report whether they are selected', /aria-pressed/.test(html));
check('Enter activates a control', /ev\.key === 'Enter'/.test(html));
check('Space activates a control too', /ev\.key === ' '/.test(html));
check('...without also scrolling the page', /ev\.preventDefault\(\)/.test(html));
check('there is a visible focus ring', /\[role="button"\]:focus-visible/.test(html));
check('...for links, buttons and inputs as well', /a:focus-visible, button:focus-visible/.test(html));
check('it runs after every render, so new controls are covered too',
      /attachHandlers\(\);\s*\n\s*makeControlsFocusable\(\);/.test(html));

// The selectors have to match the real markup. An earlier version named classes that don't
// exist on this page, so nothing was focusable and the whole thing silently did nothing.
check('it targets the real format and duration buttons', /\.type-btn/.test(html));
check('it targets the real calendar day cells', /\.cal-cell-sm\[data-day\]/.test(html));
check('it targets the real time slots', /\.time-cell\[data-start-time\]/.test(html));
for (const cls of ['type-btn', 'cal-cell-sm', 'time-cell', 'qci-card']) {
  check(`"${cls}" is a class the page actually renders`, new RegExp(`class="[^"]*${cls}`).test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

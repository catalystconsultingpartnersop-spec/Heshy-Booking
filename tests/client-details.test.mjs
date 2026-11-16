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

// --- the booking-flow review fixes -------------------------------------------------------------
// 1. The chosen day's times must come before "Show more dates", with the day named.
const stepOne = html.slice(html.indexOf('renderClientCalendar(candidateDates)'), html.indexOf('id="toStep2"'));
check('times are rendered before the show-more nav',
      stepOne.indexOf('time-grid') < stepOne.indexOf('renderCalendarNav()'));
check('the calendar no longer carries the nav itself',
      !/cal-grid-sm[\s\S]{0,300}?Show more dates/.test(html));
check('the times are labelled with the day', /slot-day-label/.test(html) && /fmtDate\(selectedDay\)/.test(html));

// 2. The ET mark belongs on the time buttons, and only for people outside Eastern.
check('time buttons carry an ET mark', /VIEWER_IN_ET \? '' : '<span class="tz">ET<\/span>'/.test(html));
check('...styled small and quiet', /\.time-cell \.tz\{[\s\S]{0,120}font-size:9\.5px/.test(html));

// 5. Quick Check-in starts collapsed.
check('Quick Check-in starts as a line, not a card', /qciExpanded = false/.test(html));
check('...with a link that opens it', /id="qciShow"/.test(html));
check('...which is still shown expanded once chosen', /qciExpanded \|\| selectedDuration===15/.test(html));
check('...and collapses again when switching away from online', /if\(t !== 'virtual'\) qciExpanded = false/.test(html));

// 7. The details form says how long it is.
check('the details form sets expectations', /two short questions follow/.test(html));
check('...and greets returning clients differently', /Welcome back/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }


// The pay page must never be re-rendered while the Stripe card field is mounted.
//
// This caught a live bug that made paying by link impossible. submitPayment() called render()
// before confirming, which rebuilt the page and destroyed the iframe the client had typed their
// card into; mountPayCard() then put a fresh EMPTY field in its place and repointed `payCard` at
// it, so Stripe was handed the empty one. A real client reported "I tried paying through the
// link but it's not working" — this is what he hit, and it would have hit every client.
//
// A browser test proved it (the old code sent Stripe a card value of ""), but Playwright isn't
// part of this suite, so what is guarded here is the shape that produced it: no render() between
// the client filling the field and the charge being confirmed.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail = '') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

function body(fnName) {
  const start = html.indexOf(`async function ${fnName}(`) >= 0
    ? html.indexOf(`async function ${fnName}(`)
    : html.indexOf(`function ${fnName}(`);
  if (start < 0) return null;
  // Walk braces from the first one after the signature.
  let i = html.indexOf('{', start), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return null;
}

const submit = body('submitPayment');
check('submitPayment() still exists', !!submit);

if (submit) {
  // Everything up to the confirm call runs while the client's card field is mounted.
  const confirmAt = submit.indexOf('confirmCardPayment');
  check('submitPayment confirms the payment', confirmAt > 0);

  const beforeConfirm = submit.slice(0, confirmAt);
  check('no render() before the card is confirmed',
        !/\brender\s*\(\s*\)/.test(beforeConfirm),
        'A render() here destroys the card field the client typed into.');
  check('no remount before the card is confirmed',
        !/\bmountPayCard\s*\(\s*\)/.test(beforeConfirm),
        'Remounting replaces payCard with a fresh, empty field.');

  // The failure paths are the subtle ones: an error that re-rendered would wipe the card and
  // leave the client unable to try again without retyping into a field that no longer works.
  const afterConfirm = submit.slice(confirmAt);
  const errorBranch = afterConfirm.slice(0, afterConfirm.indexOf('pay-confirm') > 0 ? afterConfirm.indexOf('pay-confirm') : afterConfirm.length);
  check('a declined payment does not re-render the page',
        !/\brender\s*\(\s*\)/.test(errorBranch),
        'The client must be able to correct the card and press Pay again.');

  // Re-rendering once the payment is done is correct: the field is finished with.
  check('the success path does re-render, to show the thank-you',
        /payStage\s*=\s*'done'[\s\S]*render\s*\(\s*\)/.test(submit));

  check('busy state is written into the DOM, not rendered', /setPayBusy\s*\(/.test(submit));
  check('errors are written into the DOM, not rendered', /showPayError\s*\(/.test(submit));
}

// showPayError needs somewhere to write that is always present in the markup.
check('the pay page has a permanent error line', html.includes('id="pay-error"'));

const setBusy = body('setPayBusy');
check('setPayBusy() exists', !!setBusy);
if (setBusy) {
  check('setPayBusy touches the button directly', /getElementById\(['"]pay-submit['"]\)/.test(setBusy));
  check('setPayBusy does not render', !/\brender\s*\(\s*\)/.test(setBusy));
}

const showErr = body('showPayError');
check('showPayError() exists', !!showErr);
if (showErr) {
  check('showPayError writes into #pay-error', /getElementById\(['"]pay-error['"]\)/.test(showErr));
  check('showPayError does not render', !/\brender\s*\(\s*\)/.test(showErr));
}

// The same trap exists in the portal's card form, which also mounts a Stripe field and is
// exactly where a client goes after a decline.
const portalAddr = body('portalCardAddrComplete');
check('the portal address check exists', !!portalAddr);
const mapAt = html.indexOf('const pAddrMap');
const bindings = mapAt < 0 ? '' : html.slice(mapAt, html.indexOf('});', html.indexOf('forEach', mapAt)) + 3);
check('the portal address fields are bound', mapAt > 0);
check('typing a portal billing address does not re-render',
      mapAt > 0 && !/\brender\s*\(\s*\)/.test(bindings),
      'Would tear the portal card field off its mount mid-entry.\n    ' + bindings.slice(0, 200));

// The portal's "update card" form has the same shape and the same trap. It matters just as
// much: the decline email sends clients here to replace the card that just failed.
const savePortal = body('savePortalCard');
check('savePortalCard() still exists', !!savePortal);
if (savePortal) {
  const at = savePortal.indexOf('confirmCardSetup');
  check('savePortalCard confirms the card', at > 0);
  const before = savePortal.slice(0, at);
  check('no render() before the new card is confirmed',
        !/\brender\s*\(\s*\)/.test(before),
        'Would hand Stripe a fresh empty field instead of the one the client filled in.');
  const after = savePortal.slice(at);
  const errBranch = after.slice(0, after.indexOf('confirm-card-update') > 0 ? after.indexOf('confirm-card-update') : after.length);
  check('a rejected card does not re-render the page', !/\brender\s*\(\s*\)/.test(errBranch));
  check('the success path re-renders', /portalShowCardForm = false[\s\S]*render\s*\(\s*\)/.test(savePortal));
  check('portal busy state is written into the DOM', /setPortalCardSaving\s*\(/.test(savePortal));
  check('portal errors are written into the DOM', /showPortalCardError\s*\(/.test(savePortal));
}

const setPortalBusy = body('setPortalCardSaving');
check('setPortalCardSaving() exists', !!setPortalBusy);
if (setPortalBusy) check('setPortalCardSaving does not render', !/\brender\s*\(\s*\)/.test(setPortalBusy));

const showPortalErr = body('showPortalCardError');
check('showPortalCardError() exists', !!showPortalErr);
if (showPortalErr) check('showPortalCardError does not render', !/\brender\s*\(\s*\)/.test(showPortalErr));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }

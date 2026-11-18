// Stripe intents the browser confirms. Two jobs live here because Vercel's Hobby plan allows
// twelve serverless functions and this app is at twelve:
//
//   (no action)  — a SetupIntent, to save a card while booking
//   pay-*        — a pay link, where a client pays an amount owed themselves
//
// They are kept strictly apart below: the pay actions are checked and answered inside their own
// block, which returns in every case, so neither path can fall through into the other.
import { kv } from '@vercel/kv';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { logError } from './_lib/errorlog.js';
import { stripe, resolveCustomer, issueSetupToken, defaultCardFor } from './_lib/stripecustomer.js';
import { limited, checkBookingFields } from './_lib/limits.js';
import { readPayToken, revokePayToken, payableFor } from './_lib/paylink.js';
import { sendEmail, receiptEmail } from './_lib/email.js';

/**
 * What the pay page should show. Deliberately tells the client the state of their own session
 * rather than erroring: a link sent a fortnight ago may well be opened after the thing was
 * already paid, and "this link is invalid" would be both unhelpful and alarming.
 */
async function handlePayInfo(req, res) {
  const bookingId = await readPayToken(req.body?.token);
  if (!bookingId) return res.status(404).json({ state: 'unknown' });

  const data = await kv.get('app-data');
  const p = payableFor(data, bookingId);
  res.status(200).json({
    state: p.state,
    amount: p.amount,
    minutes: p.minutes,
    date: p.booking?.date,
    name: (p.booking?.clientName || '').split(' ')[0],
    // Shown so a client can tell which session they are paying for.
    durationMin: p.booking?.durationMin,
    type: p.booking?.type
  });
}

/**
 * Creates the PaymentIntent the client confirms in their browser.
 *
 * `off_session` is deliberately absent: the whole point is that the cardholder IS present, so
 * Stripe may run 3-D Secure and the bank gets to see them approve it. That is what clears the
 * declines this link exists for.
 */
async function handlePayIntent(req, res) {
  if (await limited(req, res, 'pay-intent', 20, 3600)) return;
  const bookingId = await readPayToken(req.body?.token);
  if (!bookingId) return res.status(404).json({ error: 'This payment link is no longer valid.' });

  const data = await kv.get('app-data');
  const p = payableFor(data, bookingId);
  // The amount is computed here, never taken from the browser, so a link cannot be edited into
  // a different price.
  if (p.state !== 'owed') return res.status(400).json({ error: 'There is nothing to pay on this session.', state: p.state });

  const booking = p.booking;
  const customerId = booking.stripeCustomerId;
  const intent = await stripe.paymentIntents.create({
    amount: p.cents,
    currency: 'usd',
    ...(customerId ? { customer: customerId } : {}),
    // Keep the card for next time, since this client is usually a returning one.
    setup_future_usage: customerId ? 'off_session' : undefined,
    receipt_email: booking.clientEmail,
    description: `Clarity session, ${p.minutes} min, ${booking.date}`,
    metadata: { bookingId: booking.id },
    automatic_payment_methods: { enabled: true }
  }, {
    // One intent per booking per amount: reloading the page cannot start a second payment for
    // the same session.
    idempotencyKey: `paylink-${booking.id}-${p.cents}`
  });

  res.status(200).json({
    clientSecret: intent.client_secret,
    amount: p.amount,
    // Offered so the saved card can be pre-selected; the client may still use another.
    savedCard: customerId ? await defaultCardFor(customerId).catch(() => null) : null
  });
}

/**
 * Records a payment the client just made. The browser says it succeeded, which is not good
 * enough — the intent is re-read from Stripe here and only a genuinely succeeded one, for this
 * booking, marks the session charged. The webhook does the same thing independently, so a
 * client who closes the tab mid-redirect is still recorded.
 */
async function handlePayConfirm(req, res) {
  const bookingId = await readPayToken(req.body?.token);
  if (!bookingId) return res.status(404).json({ error: 'This payment link is no longer valid.' });
  const { paymentIntentId } = req.body || {};
  if (!paymentIntentId) return res.status(400).json({ error: 'Missing payment reference.' });

  const intent = await stripe.paymentIntents.retrieve(String(paymentIntentId));
  if (!intent || intent.status !== 'succeeded') {
    return res.status(400).json({ error: 'That payment has not completed.' });
  }
  // A valid intent for somebody else's booking must not settle this one.
  if (intent.metadata?.bookingId !== bookingId) {
    return res.status(400).json({ error: 'That payment does not match this session.' });
  }

  let already = false;
  await mutate(data => {
    const b = (data.bookings || []).find(x => x.id === bookingId);
    if (!b) return SKIP_WRITE;
    if (b.status === 'charged') { already = true; return SKIP_WRITE; }
    b.status = 'charged';
    b.amount = intent.amount / 100;
    b.stripePaymentIntentId = intent.id;
    b.paidByClient = true;
    b.paidAt = Date.now();
    delete b.lastDeclineCode;
  });

  if (!already) {
    await revokePayToken(req.body.token, bookingId);
    try {
      const data = await kv.get('app-data');
      const b = (data.bookings || []).find(x => x.id === bookingId);
      if (b?.clientEmail) {
        const receipt = receiptEmail(b);
        await sendEmail({ to: b.clientEmail, subject: receipt.subject, html: receipt.html });
      }
      // Heshy wanted collections to look after themselves, but he should still know money
      // arrived without him pressing anything.
      await sendEmail({
        to: 'heshy@catalystconsultingnyc.com',
        subject: `Paid — $${(intent.amount / 100).toFixed(2)} from ${b?.clientName || 'a client'}`,
        html: `<p style="font-family:Arial,sans-serif;font-size:14px;">${b?.clientName || 'A client'} paid $${(intent.amount / 100).toFixed(2)} for the ${b?.date} session using the payment link. Nothing further needed.</p>`
      });
    } catch (e) { /* email is best-effort; the payment is already recorded */ }
  }

  res.status(200).json({ ok: true, amount: intent.amount / 100 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // --- Pay links -------------------------------------------------------------------------
    // Handled first and returned from in every branch, so a request carrying a pay action can
    // never continue into the SetupIntent path below.
    const action = req.body?.action;
    if (action === 'pay-info') return await handlePayInfo(req, res);
    if (action === 'pay-intent') return await handlePayIntent(req, res);
    if (action === 'pay-confirm') return await handlePayConfirm(req, res);

    // --- Saving a card while booking --------------------------------------------------------
    // Every call here can create a Stripe customer, so it is the most expensive public endpoint
    // to leave open.
    if (await limited(req, res, 'setup-intent', 15, 3600)) return;
    const { name, email, phone } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const tooBig = checkBookingFields({ name, email, phone });
    if (tooBig) return res.status(400).json({ error: tooBig });

    // The customer is resolved here, from the email, against our own client records — a
    // returning client reuses the customer they already have instead of collecting a new one
    // per booking. The browser no longer sends a customer id and no longer receives one back:
    // it gets a token that only create-booking can redeem, and only for this same email.
    const data = (await kv.get('app-data')) || { clients: [] };
    const { customer } = await resolveCustomer(data, { name, email, phone });

    // `usage: 'off_session'` states outright that this card is being kept for charges Heshy runs
    // later, when the client isn't present. It is what the card is actually for, and saying so
    // is free.
    //
    // Forcing 3-D Secure here — payment_method_options: { card: { request_three_d_secure: 'any' } }
    // — was considered and deliberately left off. It would make the bank verify the cardholder at
    // booking, so later charges reference an authenticated mandate. But US issuers rarely require
    // it, almost no US site asks for it, and it costs every client an extra step at the moment
    // they are trying to book. The do_not_honor declines that prompted it turned out to be a
    // first-time-merchant fraud flag the cardholder cleared himself, on top of a pay page that
    // couldn't take a payment at all. Fix the real faults first. If declines continue once clients
    // can actually pay, add that one line.
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session'
    });
    const setupToken = await issueSetupToken(customer.id, email);

    res.status(200).json({ clientSecret: setupIntent.client_secret, setupToken });
  } catch (err) {
    console.error('Server error:', err);
    await logError('create-setup-intent', err, { method: req.method, action: req.body?.action, email: req.body?.email });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

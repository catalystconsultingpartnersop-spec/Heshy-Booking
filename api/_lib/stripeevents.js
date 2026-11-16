// The Stripe events worth reacting to. Kept here rather than in the route file so that
// registering the webhook doesn't require one serverless function to import another.
//
// Charges are confirmed synchronously, so these are the things that happen *after* a payment:
// money given back, money contested, or a payment that only failed later.
export const EVENTS = [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'payment_intent.payment_failed'
];

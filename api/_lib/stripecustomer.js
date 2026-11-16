// One Stripe customer per person, resolved on the server.
//
// Previously every booking created a brand-new Stripe customer and then pointed the client
// record at the newest one. A client who booked four times had four customer records, each
// holding whichever card they typed that day, and older bookings still pointed at older
// customers. Charging picked "the first card Stripe happened to return" for that booking's
// customer, so two sessions for the same person could hit two different cards, and "update my
// card" could never mean "use this card from now on".
//
// The browser also used to hand the server a customer id and the server believed it. Nothing
// proved the person sending it owned that customer. Now the browser never sends one: the
// server looks the client up by email, and the booking flow carries a short-lived token that
// this module issues and redeems.

import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { randomToken } from './auth.js';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const normalizeEmail = e => String(e || '').trim().toLowerCase();

/** The client record for an email, if we already know them. */
export function findClientByEmail(data, email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  return (data?.clients || []).find(c => normalizeEmail(c.email) === target) || null;
}

/**
 * The Stripe customer to use for this person: theirs if they have one that still exists,
 * otherwise a new one. Never trusts an id supplied by the caller's browser.
 */
export async function resolveCustomer(data, { name, email, phone }) {
  const existing = findClientByEmail(data, email);
  if (existing?.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(existing.stripeCustomerId);
      if (customer && !customer.deleted) return { customer, reused: true };
    } catch (e) {
      // Deleted in the Stripe dashboard, or from a different account — fall through and make a
      // new one rather than failing the booking.
    }
  }
  const customer = await stripe.customers.create({
    name: name || existing?.name || undefined,
    email: normalizeEmail(email) || undefined,
    phone: phone || existing?.phone || undefined
  });
  return { customer, reused: false };
}

// --- Binding a card entry to the booking that follows it ------------------------------------
// The card is saved before the booking is written, so the two steps have to be tied together
// without letting the browser name the customer. create-setup-intent issues this token;
// create-booking redeems it and checks the email matches the one being booked.

const TOKEN_TTL_SECONDS = 60 * 60 * 2;

export async function issueSetupToken(customerId, email) {
  const token = randomToken();
  await kv.set('setup-token:' + token, { customerId, email: normalizeEmail(email) }, { ex: TOKEN_TTL_SECONDS });
  return token;
}

/** Returns the customer id only if this token was issued for this email. */
export async function redeemSetupToken(token, email) {
  if (!token) return null;
  const record = await kv.get('setup-token:' + token);
  if (!record || !record.customerId) return null;
  if (record.email !== normalizeEmail(email)) return null;
  return record.customerId;
}

/**
 * The card to charge: the customer's default if one is set, otherwise the most recently added.
 * Charging `data[0]` meant "whatever Stripe listed first", which is not a choice anyone made.
 */
export async function defaultCardFor(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer && !customer.deleted) {
    const preferred = customer.invoice_settings?.default_payment_method;
    if (preferred) return typeof preferred === 'string' ? preferred : preferred.id;
  }
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (!methods.data.length) return null;
  const newest = methods.data.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0];
  return newest.id;
}

/** Makes a card the customer's default, so later charges use it without guessing. */
export async function setDefaultCard(customerId, paymentMethodId) {
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId }
  });
}

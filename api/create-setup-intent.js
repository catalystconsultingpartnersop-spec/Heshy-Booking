import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { name, email, phone, customerId } = req.body;
    let customer;
    if (customerId) {
      // Reusing an existing customer — e.g. a returning client updating their card from the
      // portal, rather than a brand new booking.
      customer = await stripe.customers.retrieve(customerId);
      if (!customer || customer.deleted) return res.status(400).json({ error: 'That customer no longer exists.' });
    } else {
      if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
      customer = await stripe.customers.create({ name, email, phone });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card']
    });

    res.status(200).json({
      clientSecret: setupIntent.client_secret,
      customerId: customer.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

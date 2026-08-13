# Heshy — Booking App

## What's in this folder
- `public/index.html` — the whole app (booking page + Manage page)
- `api/` — the three small server functions that talk to Stripe and save your data
- `package.json` — tells Vercel what to install

## Before you upload: one line to edit
Open `public/index.html`, find this line near the top of the `<script>` section:

```
const STRIPE_PUBLISHABLE_KEY = 'PASTE_YOUR_PUBLISHABLE_KEY_HERE';
```

Replace the placeholder with your Stripe **Publishable key** (starts with `pk_test_` while testing). This one is safe to put directly in the code — it's not secret.

## Deploy steps
1. Go to github.com, create a new repository (name it `heshy-booking`), and upload all these files by dragging them into the "Add file → Upload files" screen.
2. Go to vercel.com, click "Add New Project," and pick the `heshy-booking` repository you just created.
3. Before clicking Deploy, add two environment variables (Vercel will show a place for this):
   - `STRIPE_SECRET_KEY` → your Stripe secret key (`sk_test_...` for now)
4. In the Vercel project, go to Storage → Create Database → KV, and connect it to this project. This is what saves your slots, bookings, and settings permanently.
5. Click Deploy.

That's it — Vercel gives you a live link when it's done. That's the link you send to clients.

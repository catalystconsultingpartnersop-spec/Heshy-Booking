# Heshy Booking Repository Overview

## Purpose

Heshy Booking is a single-provider scheduling and client-management app for paid clarity sessions. Clients can book virtual or in-person sessions, save a card for later charging, use coupons, and manage upcoming sessions through a portal. The admin can manage availability, clients, bookings, billing, notes, recordings, and integrations.

The production timezone is `America/New_York`. Dates and times in the data model are local wall-clock strings such as `2026-08-30` and `11:00`; server-side comparisons that represent real instants must use the existing DST-aware Eastern-to-UTC conversion.

## Architecture

- `public/index.html` contains the entire primary frontend: styles, booking flow, client portal, admin UI, and browser-side state. There is no frontend framework or build step.
- `public/fix.html` is an authenticated maintenance page that migrates old base64 Working Genius PDFs from KV into Vercel Blob.
- `api/*.js` are Vercel Node serverless functions using default-exported request handlers.
- `api/_lib/auth.js` owns secure token generation and admin-token verification.
- `api/_lib/email.js` owns Resend delivery and all email templates.
- `vercel.json` invokes `/api/admin-data` daily at `12:00` UTC for the admin digest and next-day reminders.
- The browser loads Stripe.js, Google Fonts, and Jewish holiday data from Hebcal directly from their public CDNs/APIs.

The frontend uses hash routes: the default booking flow, `#portal`, `#manage`, and admin client routes such as `#manage/client/<id>`.

## Persistence

Most domain data is stored as one JSON object under the Vercel KV key `app-data`. Its evolving shape includes:

- `bookings`: scheduled, cancelled, and charged sessions, Stripe and Calendar IDs, notes, recording timing, prices, and coupon results.
- `clients`: contact details, Stripe customer ID, intake data, Working Genius data, referral source, and blocked status.
- `availability`: recurring rules keyed by `virtual` and `in-person`.
- `overrides`: one-off availability windows, optionally with an in-person address.
- `blockedDates`: unavailable dates by session type.
- `settings`: rates, durations, lead/cancellation times, locations, meeting details, intake questions, billing mode, and coupons.
- `slots`: materialized legacy slots maintained by `generate-slots`; the current booking UI computes availability from rules, overrides, bookings, blocked dates, and Calendar busy ranges.

Other KV keys are deliberately separate:

- `admin-session:<token>` stores authenticated admin sessions without a server-side expiry. The browser keeps the token in `sessionStorage`, but closing the tab does not delete the KV record.
- `portal-session:<token>` maps a portal session to a client for 60 days.
- `admin-fail` and `portal-fail:<email>` implement 15-minute login lockouts.
- `google-refresh-token` stores the Google OAuth refresh token.
- `oauth-state:<nonce>` stores a single-use OAuth state for 10 minutes.
- `recording-chunks:<bookingId>` tracks Vercel Blob audio chunks until transcription completes.

Important: several handlers read, mutate, and replace the complete `app-data` object. These writes are not transactional. Preserve unknown fields, re-read fresh data before important writes, and avoid splitting domain state across competing copies.

## Main Flows

### Booking

1. The browser loads availability from `/api/public-state`, Google busy periods from `/api/free-busy`, and Jewish holiday dates from Hebcal.
2. It checks whether the email belongs to an existing or blocked client with `/api/check-client` and optionally validates a coupon through `/api/create-booking?action=check-coupon`.
3. `/api/create-setup-intent` creates or reuses a Stripe customer and collects a card with Stripe Elements. The card is saved for off-session charging; booking does not charge it.
4. `/api/create-booking` validates required fields, offered duration, lead time, availability, conflicts, Calendar busy time, blocked status, and coupon eligibility again on the server.
5. Booking creation optionally uploads a Working Genius PDF, creates a Google Calendar event and Meet link, updates the client and booking records, consumes the coupon, and sends confirmation/admin emails.

Calendar, Blob upload, and email work is generally best-effort so integration failures do not block a valid booking. Recurring availability, overrides, blocked dates, booking conflicts, lead time, and client restrictions are checked by `/api/create-booking`. Jewish holiday exclusion is currently browser-only, so it can be bypassed by a direct request and must not be treated as an authoritative server rule.

### Admin

The admin logs in through `/api/admin-data` using `ADMIN_PASSWORD`. The returned token is kept in browser `sessionStorage` and sent as `X-Admin-Token`. Authenticated GET returns all app data; a general authenticated POST replaces `app-data`, while action posts handle cancellation, rescheduling, PDF migration/upload, and recording finalization. Admin rescheduling currently accepts the requested date and time without checking availability, conflicts, lead time, or whether the date has passed.

`/api/charge-booking` performs an authenticated off-session Stripe charge. It rejects cancelled or already charged bookings, calculates a fallback from actual or reserved minutes and the hourly rate, caps unusually large charges, uses a Stripe idempotency key, updates the booking, and emails a receipt. The admin UI calculates minimum-billing and coupon-adjusted amounts and submits the result as an override; the endpoint does not independently apply `billingMode`, coupon discounts, or complimentary status. It also accepts an authenticated nonnegative amount override, including zero, within its ceiling.

Virtual-session notes and duration come from Google Meet, Calendar, Drive, and Gemini through `/api/fetch-gemini-notes`. In-person audio is uploaded in chunks through `/api/admin-data`, transcribed with OpenAI Whisper, and summarized with `gpt-4o-mini`. Existing confirmed durations and notes are preserved or extended rather than silently reduced.

### Client Portal

`/api/portal-lookup` requires email plus normalized phone for login. Its token is kept in browser `localStorage` for up to 60 days. The portal shows uncharged upcoming sessions and charged history, allows card replacement through a new SetupIntent, and permits cancellation only before the configured cutoff. Ownership and cutoff checks are repeated server-side.

## API Map

- `/api/admin-data`: admin login, full data read/write, cron digest/reminders, cancellation, rescheduling, uploads, PDF cleanup, and recording processing.
- `/api/charge-booking`: authenticated final Stripe charge and receipt.
- `/api/check-client`: public existence/blocked check by email; returns no client details.
- `/api/create-booking`: coupon lookup and authoritative booking creation.
- `/api/create-setup-intent`: public Stripe customer creation/reuse and card SetupIntent creation; it is not rate-limited or authenticated.
- `/api/fetch-gemini-notes`: authenticated Meet duration and Gemini notes retrieval.
- `/api/free-busy`: public, range-limited Google Calendar busy lookup.
- `/api/generate-slots`: unauthenticated POST that mutates `app-data` by generating eight weeks of legacy materialized slots; it is not called by the current frontend.
- `/api/google-auth-url`: authenticated start of Google OAuth with one-time state.
- `/api/google-callback`: validates OAuth state, stores the refresh token, and redirects to Manage.
- `/api/portal-lookup`: portal login/session, card update, and client cancellation.
- `/api/public-state`: future availability data with no client PII. It returns complete future overrides, availability rules, and the global location, so configured exact addresses are visible in the network response even though the UI displays only the general area before booking.

## Services and Configuration

Required or feature-specific environment variables:

- `STRIPE_SECRET_KEY`: Stripe server API access.
- `ADMIN_PASSWORD`: Manage login password.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Calendar, Meet, and Drive OAuth.
- `RESEND_API_KEY`: transactional email delivery.
- `OPENAI_API_KEY`: Whisper transcription and generated summaries.
- `CRON_SECRET`: authenticates the Vercel cron request.
- `SITE_URL`: base URL used in email links; defaults to `https://heshy-booking.vercel.app`.
- Vercel KV and Blob integrations must be connected so their SDK credentials are injected.

The Stripe publishable key is currently hardcoded near the start of the script in `public/index.html`. Email sender and owner addresses are constants in `api/_lib/email.js`.

Google OAuth needs Calendar, read-only Drive, and read-only Meet-space scopes. The redirect URI must match the deployed `/api/google-callback` URL and the Google Cloud OAuth configuration.

The booking calendar depends on Hebcal responses to hide configured Jewish holidays. If that browser request fails, the holiday set stays empty and those dates are shown according to normal availability rules.

## Security and Data Rules

- New public bookings repeat availability, duration, coupon, and blocked-client checks on the server. Preserve those checks when changing the browser flow.
- Do not assume every browser rule is server-enforced: Jewish holiday exclusion, admin reschedule availability, billing mode, coupon-adjusted charge amounts, and complimentary-charge handling currently rely partly or entirely on the admin/client UI.
- Use cryptographically secure tokens from `api/_lib/auth.js`; do not use `Math.random()` for credentials or sessions.
- Keep client PII and private location details out of public responses. `/api/public-state` currently exposes configured address fields and should be treated accordingly until its response is narrowed.
- Escape user-controlled values before adding them to HTML email templates.
- Preserve `cancelled` separately from billing `status`; cancellation must not erase charge history.
- Preserve the highest confirmed actual duration when combining timers, recordings, and Meet records.
- In-person location precedence is date override, recurring rule address, then global setting.
- Working Genius PDFs and recording chunks are stored with public Vercel Blob URLs. Treat changes to upload exposure and retention as security-sensitive.
- `public/fix.html` is not lossless on migration failure: if uploading an embedded PDF to Blob throws, the cleanup action clears that client's old PDF value and saves the change. Back up `app-data` before using it.

## Development and Verification

Install dependencies with `npm install`. There are no package scripts, automated tests, lint rules, or build configuration. Run the app locally with Vercel CLI, typically `npx vercel dev`, because opening the HTML alone does not provide the API or storage integrations.

Validation is currently manual. Exercise the relevant browser flow and API branch, including failure cases and both mobile and desktop layouts for frontend changes. Use test Stripe credentials and verify KV mutations, Calendar behavior, emails, and Blob uploads when touching those integrations.

The entire `ai-memory` directory is ignored by Git. This overview is local workspace context unless the ignore policy changes, so repository collaborators and deployments do not receive it.

## Change Guidance

- Keep changes small: `public/index.html` is large and couples all frontend modes.
- Update both frontend display logic and the authoritative server check when changing a business rule.
- Keep public-state fields synchronized with what the booking UI needs, without exposing full bookings or clients.
- When the booking schema changes, check admin views, portal summaries, emails, charging, Calendar operations, notes, and cancellation paths.
- Use the existing best-effort policy for optional integrations unless the business requirement explicitly makes an integration mandatory.
- Do not rely on the README's endpoint count or setup list; it predates most current features.

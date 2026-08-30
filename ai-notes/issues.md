# Heshy Booking Issue Register

Reviewed against the repository on August 30, 2026. This is a static code review; it does not prove how production data or third-party accounts are currently configured.

## How to Read This Document

The findings are deliberately split into two tracks:

- **Current practical issues** can affect Heshy or clients during ordinary use today. Fix these based on workflow impact.
- **Robustness and security hardening issues** usually require unusual timing, deliberate abuse, a leaked credential, larger usage, or an outside-service failure. They still matter, but should not outrank a broken everyday workflow merely because their worst case sounds severe.

Priority meanings:

- **P0:** Fix first. A core workflow is broken, money or confidential information is at immediate risk, or normal scheduling can be wrong.
- **P1:** Fix soon. The issue can produce incorrect records, missed communication, billing mistakes, or recurring operational work.
- **P2:** Important cleanup. The issue has a narrower trigger or a reasonable manual workaround.

## Current Practical Issues

### P0: Client Card Updates Are Broken

**What happens:** The portal tells clients they can replace a saved card, but the information needed to begin that update is not returned to the browser. The request therefore reaches Stripe without the existing customer reference and fails. Even after fixing that first mismatch, the follow-up code tries to attach a card that a successful Stripe setup may already have attached.

**Impact:** A client with an expired or declined card cannot reliably fix it through the portal. Heshy must handle the problem manually.

**Evidence:** [portal-lookup.js](../api/portal-lookup.js#L43-L63), [index.html](../public/index.html#L2208-L2220), [create-setup-intent.js](../api/create-setup-intent.js#L8-L25)

**Recommended fix:** Make the portal's authenticated server request look up the Stripe customer itself. Complete the SetupIntent against that customer, then treat its successful payment method as attached. Define whether the replacement should apply to all uncharged bookings for that client and update those records consistently.

### P0: Google Calendar Conflicts Are Compared in the Wrong Time Frame

**What happens:** The final booking check measures Google events as minutes after UTC midnight, then compares them with Eastern wall-clock minutes. During daylight saving time, an 11:00 AM Eastern event can be treated like 3:00 PM.

The browser also interprets appointment strings in the viewer's local timezone. A client outside Eastern Time can therefore see different conflict behavior.

**Impact:** A time that conflicts with Heshy's Google Calendar may still be accepted, while a different time may be blocked incorrectly.

**Evidence:** [create-booking.js](../api/create-booking.js#L179-L199), [index.html](../public/index.html#L696-L700), [index.html](../public/index.html#L747-L749)

**Recommended fix:** Convert both the requested session and every busy interval to real UTC instants using `America/New_York`, then compare instants rather than minute offsets. Use the same shared conversion on the browser and server, with tests for winter, summer, and daylight-saving transitions.

### P0: Private Locations and the Reusable Meet Link Are Public

**What happens:** The visible page shows only the general area, but the public availability response contains complete weekly rules, one-time openings, and the default location. Those records include full addresses and entry instructions. The response also includes the globally configured Meet link, if one is set.

**Impact:** Anyone can inspect the booking page's network response and read locations or obtain a reusable meeting link that is meant to be disclosed only after confirmation.

**Evidence:** [public-state.js](../api/public-state.js#L26-L41), [index.html](../public/index.html#L1384-L1385)

**Recommended fix:** Return only date, time, format, and general area from the public endpoint. Resolve and return the full address or relevant meeting link only after a successful booking or through an authenticated portal response.

### P0: Sensitive Files Use Public, Non-Expiring Links

**What happens:** Working Genius reports and session audio are uploaded as public files. Anyone who obtains a link can open it without signing in. Finalizing a recording deletes only the temporary file list, not the uploaded audio files.

**Impact:** Assessment reports and private session conversations can remain exposed indefinitely after a link leak, browser-history leak, or accidental sharing.

**Evidence:** [create-booking.js](../api/create-booking.js#L211-L218), [admin-data.js](../api/admin-data.js#L67-L80), [admin-data.js](../api/admin-data.js#L97-L143)

**Recommended fix:** Store private files, serve them through authenticated downloads or short-lived signed links, and delete recording chunks after successful transcription or after a defined retention period.

### P1: Admin Rescheduling Accepts Invalid or Conflicting Times

**What happens:** Rescheduling checks only that a date and time were supplied. It does not verify that the time is in the future, within availability, outside the notice period, free from another booking, or free on Google Calendar. It also ignores an unsuccessful Calendar update.

**Impact:** Heshy can accidentally create a past booking, a double booking, or a mismatch between the app and Google Calendar.

**Evidence:** [admin-data.js](../api/admin-data.js#L338-L378)

**Recommended fix:** Reuse the same availability and Eastern-time checks as new bookings, excluding the booking being moved. Confirm the Calendar response and show a warning when app and Calendar records differ.

### P1: Minimum Billing Undercharges Sessions That Run Long

**What happens:** In “Full booked length” mode, the Manage screen always starts from the reserved length. It does not choose the greater of reserved time and actual time, even though the client-facing text says longer sessions are billed for actual time.

**Impact:** A 90-minute session booked for 60 minutes can default to a 60-minute charge.

**Evidence:** [index.html](../public/index.html#L1410-L1413), [index.html](../public/index.html#L1726-L1729)

**Recommended fix:** In minimum mode, calculate billable minutes as the greater of booked and actual minutes. Put the calculation in the charge endpoint as well as the display.

### P1: Discounted and Complimentary Charges Rely on Manual Care

**What happens:** Coupon discounts and complimentary status affect the suggested amount in Manage, but the charge endpoint does not apply or verify them. Editing the hours recalculates the amount at full price and does not reapply a coupon. A complimentary booking still displays the normal charge controls.

**Impact:** Heshy can accidentally overcharge a discounted or free session.

**Evidence:** [index.html](../public/index.html#L1734-L1753), [index.html](../public/index.html#L2397-L2403), [charge-booking.js](../api/charge-booking.js#L24-L37)

**Recommended fix:** Calculate the default amount from saved booking terms on the server. Clearly separate an intentional admin override from the normal amount, and replace charge controls with a zero-dollar completion action for complimentary sessions.

### P1: A Coupon Can Disappear During Final Booking Without Stopping the Booking

**What happens:** The coupon is checked while the client types and checked again when saving. If it is invalid, removed, already used, or exhausted at the final check, the booking still succeeds at full price without requiring the client to confirm that change.

**Impact:** A client can reasonably believe a discount was applied and later be billed the full amount.

**Evidence:** [create-booking.js](../api/create-booking.js#L284-L300)

**Recommended fix:** If a non-empty coupon fails the final check, reject the booking with the reason and let the client remove the code or explicitly accept full price.

### P1: Reminder Delivery Is Recorded Even When Sending Fails

**What happens:** The email helper logs failures but reports success to its caller. The daily job then marks the reminder as sent. A failed reminder will not be retried. A booking that was already reminded and is later rescheduled also keeps its old reminder flag.

**Impact:** Clients can miss reminders with no visible warning to Heshy.

**Evidence:** [email.js](../api/_lib/email.js#L11-L32), [admin-data.js](../api/admin-data.js#L243-L251), [admin-data.js](../api/admin-data.js#L372-L378)

**Recommended fix:** Make email delivery return a confirmed success or throw. Record delivery time only after success, expose failures in Manage, and clear or recalculate the reminder state when rescheduling.

### P1: Repeat Bookings Fragment Stripe Customer Records

**What happens:** Every normal booking creates a new Stripe customer, including bookings from an existing client. The client profile is changed to point at the newest customer, while older bookings continue to point at older customers. Charging selects the first card returned for that booking's customer rather than the configured default card.

**Impact:** One person can have many Stripe customer records and different sessions can charge different saved cards. Card replacement cannot reliably mean “use this card for my upcoming sessions.”

**Evidence:** [index.html](../public/index.html#L857-L880), [create-setup-intent.js](../api/create-setup-intent.js#L8-L18), [charge-booking.js](../api/charge-booking.js#L41-L53)

**Recommended fix:** Resolve returning clients on the server and reuse one Stripe customer. Charge its default payment method, and define a migration for existing split customer records.

### P1: Session Statuses Produce Incorrect Dashboard and Portal Lists

**What happens:** The portal calls every non-cancelled, uncharged booking “Upcoming,” even when its date has passed. The Needs Billing count includes only past bookings still marked “scheduled.” Pressing “Mark complete” changes the status to “completed,” which removes the session from Needs Billing but leaves it under Upcoming in the portal.

**Impact:** Heshy can lose track of unpaid work, and clients can see past sessions in the wrong section.

**Evidence:** [portal-lookup.js](../api/portal-lookup.js#L43-L63), [index.html](../public/index.html#L1164), [index.html](../public/index.html#L1820-L1848)

**Recommended fix:** Define separate scheduling and payment states, or derive lists from date, cancellation, and payment status independently. Add a dedicated “completed but unpaid” category.

### P1: Quick Check-In Restrictions Are Not Reliably Applied

**What happens:** Quick Check-in is described as a 15-minute online option for returning clients. The server accepts 15 minutes for any client and either format. On the page, selecting Quick Check-in and then switching to in-person leaves 15 minutes selected, making the unsupported combination reachable without bypassing the UI.

**Impact:** New clients or in-person clients can create sessions that do not match the stated service.

**Evidence:** [create-booking.js](../api/create-booking.js#L165-L173), [index.html](../public/index.html#L797-L798), [index.html](../public/index.html#L1325-L1368)

**Recommended fix:** Reset 15 minutes when the format changes and enforce “virtual plus existing client” during the final booking check.

### P1: Online and In-Person Appointments Can Overlap

**What happens:** Saved bookings block only another booking of the same format. Google Calendar normally provides the cross-format block, but that protection disappears when Calendar is disconnected or its check fails.

**Impact:** Heshy can be booked online and in person at the same time.

**Evidence:** [create-booking.js](../api/create-booking.js#L94-L104)

**Recommended fix:** Treat every active booking as a conflict unless overlapping formats are an explicit business rule.

### P1: Email Whitespace Can Split One Client Into Multiple Identities

**What happens:** Booking-time email matching ignores capitalization but does not consistently remove leading or trailing spaces. Portal login does remove spaces from what the client types, then compares it with the stored value. An address saved with a space can create a duplicate profile or become impossible to match in the portal.

**Impact:** Client history, cards, intake answers, and bookings can split across profiles.

**Evidence:** [check-client.js](../api/check-client.js#L3-L9), [create-booking.js](../api/create-booking.js#L203-L204), [portal-lookup.js](../api/portal-lookup.js#L67-L81)

**Recommended fix:** Normalize email once with trim and lowercase before every lookup and write. Migrate duplicates carefully.

### P2: Optional-Service Failures Are Hidden After Booking

**What happens:** Calendar creation, PDF upload, and email delivery can fail while the booking response still says success. The client sees a generic statement that confirmation is on its way even when delivery failed.

**Impact:** A booking can have no Meet link, Calendar event, PDF, or confirmation email, with no visible follow-up task.

**Evidence:** [create-booking.js](../api/create-booking.js#L176-L251), [create-booking.js](../api/create-booking.js#L315-L324), [index.html](../public/index.html#L1447-L1460)

**Recommended fix:** Return integration results separately from booking success. Show a clear warning and create an admin follow-up item without undoing the valid booking.

### P2: Recording Finalization Can Miss Audio

**What happens:** Audio uploads are started without checking their HTTP result. On stop, the page waits a fixed 1.5 seconds and then finalizes, even if the last upload is still running. Uploaded Blob files are not deleted afterward.

**Impact:** The end of a session can be missing from the transcript, failed uploads are hard to diagnose, and private audio accumulates.

**Evidence:** [index.html](../public/index.html#L988-L1001), [index.html](../public/index.html#L1072-L1105), [admin-data.js](../api/admin-data.js#L97-L143)

**Recommended fix:** Track and await every upload promise, reject failed uploads visibly, finalize only after all chunks are confirmed, and delete source chunks according to a retention policy.

### P2: The PDF Cleanup Tool Can Destroy the Only Copy

**What happens:** If moving an older embedded PDF to Blob storage fails, the cleanup action clears the original PDF value and saves the client record anyway.

**Impact:** A temporary storage failure can permanently remove a client's report.

**Evidence:** [admin-data.js](../api/admin-data.js#L257-L275), [fix.html](../public/fix.html#L20-L55)

**Recommended fix:** Keep the original value unless upload and verification both succeed. Require a backup before bulk cleanup.

## Robustness and Security Hardening

These findings are real weaknesses, but their usual trigger is deliberate abuse, leaked access, simultaneous requests, unusual input, or future growth rather than Heshy's normal single-admin workflow.

### High Robustness: The Browser Can Choose the Stripe Customer

**Risk:** Both payment setup and final booking accept a Stripe customer ID supplied by the browser. The server does not prove that the requester owns that customer or that the ID came from the SetupIntent used for this booking.

Knowing a `cus_...` ID does not reveal card details or grant direct charging authority. However, a caller with a leaked customer ID can attach a new card to that customer, associate a booking with it, or create a path for Heshy to charge the wrong customer's saved card later.

**Evidence:** [create-setup-intent.js](../api/create-setup-intent.js#L6-L25), [create-booking.js](../api/create-booking.js#L145-L149), [create-booking.js](../api/create-booking.js#L270-L305)

**Recommended fix:** Make the server resolve or create the Stripe customer from an authenticated internal client record. Bind each SetupIntent to a short-lived internal booking attempt and derive the final customer ID server-side. Never treat a submitted customer ID as proof of ownership.

### High Robustness: Whole-Record Saves Can Lose Concurrent Changes

**Risk:** Most information is read and rewritten as one large record. Two bookings, a booking and an admin save, or two recording uploads can read the same old version and overwrite each other's changes. Coupon use limits have the same race.

**Evidence:** [admin-data.js](../api/admin-data.js#L431-L436), [create-booking.js](../api/create-booking.js#L257-L315), [generate-slots.js](../api/generate-slots.js#L10-L55)

**Recommended fix:** Split independently owned data into separate records and use transactions, atomic counters, or version checks for bookings and coupons.

### High Robustness: Public Endpoints Have No Abuse Limits

**Risk:** Anyone can repeatedly create Stripe customers and SetupIntents, probe coupons and client existence, request Calendar busy ranges, or submit booking attempts. This can create clutter, consume quotas, and raise service costs.

**Evidence:** [create-setup-intent.js](../api/create-setup-intent.js), [check-client.js](../api/check-client.js), [free-busy.js](../api/free-busy.js), [create-booking.js](../api/create-booking.js#L128-L143)

**Recommended fix:** Add per-IP and per-identity rate limits, bot protection on expensive actions, and monitoring for abnormal volume.

### High Robustness: A Legacy Public Endpoint Can Rewrite Shared Data

**Risk:** `/api/generate-slots` is unauthenticated and performs a read-modify-write of the shared record. The current page does not use these legacy slots, but calling the endpoint can race with a real booking or admin save.

**Evidence:** [generate-slots.js](../api/generate-slots.js#L7-L59)

**Recommended fix:** Remove the endpoint if obsolete. Otherwise require admin or cron authentication and move legacy slots out of the shared record.

### High Robustness: Admin Access Tokens Never Expire

**Risk:** Admin tokens are valid indefinitely in storage. Closing the tab removes the browser's copy but not the server record. A token obtained through logs, malware, browser recovery, or another leak keeps full access.

**Evidence:** [admin-data.js](../api/admin-data.js#L390-L406), [auth.js](../api/_lib/auth.js#L3-L8)

**Recommended fix:** Add an 8- or 12-hour expiry, rotate tokens on login, and add server-side logout and revocation.

### High Robustness: Inputs and Uploads Have No Server Limits

**Risk:** Names, phones, intake answers, notes, full state saves, PDFs, and recording chunks have no meaningful size limits. PDF uploads trust their claimed type without checking that the content is actually a PDF.

**Evidence:** [create-booking.js](../api/create-booking.js#L145-L218), [admin-data.js](../api/admin-data.js#L67-L80), [admin-data.js](../api/admin-data.js#L279-L291)

**Recommended fix:** Set request and field limits, reject oversized decoded files before allocating memory, verify PDF signatures, and define accepted recording formats.

### High Robustness: Full Admin Saves Have No Schema Validation

**Risk:** The server accepts any authenticated JSON object as the complete business record. A stale page, malformed request, browser bug, or stolen token can erase required fields or save invalid rates, dates, durations, and structures.

**Evidence:** [admin-data.js](../api/admin-data.js#L431-L436)

**Recommended fix:** Validate every write against an explicit schema and use narrow actions instead of replacing the entire record.

### Medium Robustness: Public Calendar and Client Probes Leak Patterns

**Risk:** The free/busy endpoint returns exact busy intervals for up to 180 days, and the client check confirms whether a supplied email belongs to a client and whether it is blocked. Neither requires authentication.

**Impact if abused:** A targeted person can map Heshy's schedule or test a list of client email addresses.

**Evidence:** [free-busy.js](../api/free-busy.js#L21-L47), [check-client.js](../api/check-client.js#L3-L9)

**Recommended fix:** Return only computed bookable slots, not raw busy intervals. Fold the new-client decision into booking without exposing account status.

### Medium Robustness: Portal Login Uses Personal Information as a Password

**Risk:** A client signs in with an email address and phone number. Phone numbers identify people, but they are often available from websites, signatures, directories, shared contacts, or data brokers. The per-email attempt limit slows guessing but does not protect a client whose details are already known.

**Impact if abused:** Someone with both values can view appointment dates, payment history, and session recaps, and can cancel an eligible future appointment.

**Evidence:** [portal-lookup.js](../api/portal-lookup.js#L67-L92), [portal-lookup.js](../api/portal-lookup.js#L130-L167)

**Recommended fix:** Use a short-lived email magic link or one-time code. Keep the resulting session server-side and send only a secure, HttpOnly, SameSite cookie to the browser.

### Medium Robustness: Portal Sessions Are Long-Lived and Not Revoked on Logout

**Risk:** A portal token lasts 60 days and is kept in browser storage. Logout deletes only the browser copy, not the server token. The session-resume request also places the token in the URL.

**Impact if exposed:** Someone using a shared device, copied URL, proxy log, or leaked browser storage can view client session information.

**Evidence:** [portal-lookup.js](../api/portal-lookup.js#L90-L106), [index.html](../public/index.html#L1226-L1238)

**Recommended fix:** Shorten session lifetime, use POST for session resume, revoke on logout, and consider an inactivity timeout.

### Medium Robustness: Anyone Can Temporarily Lock Out the Administrator

**Risk:** Six failed password attempts set one global lockout for the only administrator. An unauthenticated caller can repeat this every 15 minutes and prevent legitimate login.

**Evidence:** [admin-data.js](../api/admin-data.js#L390-L406)

**Recommended fix:** Combine account-level backoff with an IP or request-fingerprint limit, alert on repeated failures, and add a recovery path. Do not let one anonymous source control the complete account lockout.

### Medium Robustness: Date, Time, Contact, and Coupon Values Are Weakly Validated

**Risk:** The server relies heavily on string shape and browser controls. Malformed dates, times, emails, phones, discount percentages, or unusually long text can enter storage or cause request failures. Coupon percentages can exceed 100 or be negative through a direct admin save.

**Evidence:** [create-booking.js](../api/create-booking.js#L145-L173), [admin-data.js](../api/admin-data.js#L431-L436)

**Recommended fix:** Parse and validate real calendar dates and 24-hour times, normalize contact fields, bound discounts, and reject invalid or excessive values.

### Medium Robustness: Failed or Abandoned Recordings Have No Cleanup Policy

**Risk:** Recording manifests have no expiry, and uploaded chunks are not removed when transcription fails, is abandoned, or succeeds.

**Evidence:** [admin-data.js](../api/admin-data.js#L67-L80), [admin-data.js](../api/admin-data.js#L97-L185)

**Recommended fix:** Add expiry to temporary records and a scheduled cleanup for old audio files.

### Medium Robustness: Browser Security Policy Is Not Defined

**Risk:** The page executes third-party Stripe code and loads external fonts and holiday data without a Content Security Policy or explicit security headers. A future HTML-injection mistake would have a larger impact because inline scripts and broad external access are unrestricted.

**Evidence:** [index.html](../public/index.html#L7-L8), [index.html](../public/index.html#L335), [vercel.json](../vercel.json)

**Recommended fix:** Add security headers in Vercel configuration, starting with a tested Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy`, and appropriate permissions policy.

### Low Robustness: Short Random IDs Can Collide

**Risk:** Booking, client, rule, and override IDs use short `Math.random()` values without checking uniqueness. A collision is unlikely at current scale but can make records ambiguous.

**Evidence:** [create-booking.js](../api/create-booking.js#L108-L110), [index.html](../public/index.html#L492)

**Recommended fix:** Use `crypto.randomUUID()` for persistent identifiers. Keep the existing cryptographically secure generator for login tokens.

### Low Robustness: OAuth and Google API Failures Are Weakly Reported

**Risk:** The initial Google-connect URL contains the admin token, refresh-token calls do not consistently check HTTP status, and several Calendar writes ignore unsuccessful responses.

**Evidence:** [google-auth-url.js](../api/google-auth-url.js#L4-L17), [google-callback.js](../api/google-callback.js#L14-L32), [admin-data.js](../api/admin-data.js#L355-L369)

**Recommended fix:** Use a short-lived one-time handoff before leaving Manage, centralize Google token refresh with response checks, and surface Calendar synchronization status.

## Product Experience, Accessibility, and Trust

These are verified page issues unless explicitly marked as a recommended test. They matter to professionalism, informed booking, accessibility, and client trust, but do not all have the same urgency as scheduling, billing, or privacy defects.

### P1: Recording and Privacy Disclosures Are Not Visible

**What happens:** The booking flow collects identity, contact, intake, payment, and optional assessment-document information, but it provides no visible privacy-policy link. The product can also record and transcribe sessions without a documented consent or retention notice in the client experience.

**Impact:** Clients cannot easily learn how their information, documents, audio, or transcripts are stored and used. Recording without an appropriate consent process can also create legal and contractual risk that depends on participant locations and business policy.

**Evidence:** [index.html](../public/index.html#L1394-L1441), [index.html](../public/index.html#L1019-L1105)

**Recommended fix:** Publish a reviewed privacy policy and place a clear link near the booking form. Before any recording, obtain explicit participant consent and state the purpose, access rules, retention period, and deletion process.

### P2: Timezone and Next Steps Are Not Clear Enough

**What happens:** Appointment times are displayed without saying that they are Eastern Time. The confirmation screen shows the booking details and join/location information, but it has no calendar-add action, portal link, cancellation path, or rescheduling guidance. It also says an email is on its way without knowing whether delivery succeeded.

**Impact:** Clients outside Eastern Time can misread the appointment, and every client has fewer immediate recovery options if they need to save, review, cancel, or change it.

**Evidence:** [index.html](../public/index.html#L1319-L1463)

**Recommended fix:** Label displayed times as Eastern Time throughout the flow. Keep Eastern Time as the business timezone unless product requirements change. Add calendar, portal, and policy actions to confirmation, and report email delivery honestly.

### P2: Page Identity and Sharing Metadata Are Incomplete

**What happens:** The document title is only “Heshy.” The page has no description, canonical URL, indexing decision, Open Graph metadata, social-card metadata, or favicon declaration.

**Impact:** Browser tabs, bookmarks, search results, and shared links can look unfinished or ambiguous.

**Evidence:** [index.html](../public/index.html#L1-L9)

**Recommended fix:** Use a descriptive branded title such as “Book a Clarity Session | Catalyst Consulting NYC.” Add a description and favicon, then intentionally choose either canonical/indexable metadata or `noindex`. Add social metadata if clients commonly share the booking link.

### P2: Major Booking Controls Are Not Keyboard-Native

**What happens:** Format, duration, Quick Check-in, calendar days, and time slots are clickable `div` elements rather than buttons, radios, or other native form controls. They have no keyboard focus or semantic selected state. Several labels are also not programmatically connected to their inputs.

**Impact:** Keyboard and screen-reader users may be unable to complete a booking or understand the selected option.

**Evidence:** [index.html](../public/index.html#L1323-L1390), [index.html](../public/index.html#L1415-L1440)

**Recommended fix:** Use native buttons, radio groups, labels, and fieldsets where possible. Add visible focus, selected-state semantics, error announcements, and a keyboard and screen-reader test of the complete flow.

### Recommended Live-Site Checks, Not Confirmed Defects

- Test narrow mobile layouts for clipping, horizontal scrolling, input-keyboard obstruction, touch target size, and obscured actions.
- Inspect production response headers, redirects, caching, CORS behavior, TLS, source maps, and staging or backup-file exposure. Repository configuration proves that the app does not explicitly define these headers, but the hosting platform may add some of them.
- Measure live loading and interaction performance before classifying it as a problem. The source does not include the heavy chat, animation, analytics, or marketing bundles warned about in the external review.
- Test the complete calendar with keyboard-only navigation and a screen reader rather than assuming source inspection catches every accessibility failure.

## Engineering and Operational Gaps

### No Automated Tests or Continuous Checks

There are no unit, integration, browser, lint, or CI checks. High-risk rules involving money, timezones, cancellation, coupons, and privacy can regress without warning.

**Recommended first tests:** Eastern-time Calendar conflicts, booking races, rescheduling validation, Quick Check-in eligibility, coupon exhaustion, free-session charging, minimum billing overruns, portal card replacement, reminders, and client status lists.

### No Dependency Lockfile

The repository has no `package-lock.json`. Installs are not reproducible, and `npm audit` cannot run: it exits with `ENOLOCK` and requests a lockfile.

**Recommended fix:** Generate and commit a lockfile, then run dependency auditing in CI. This review does not claim that current packages are vulnerable because the audit could not be completed.

### No Explicit Backup, Migration, or Recovery Process

Business data is stored in one mutable record, and maintenance code can alter or remove files. There is no documented versioning, backup, restore, or schema-migration workflow.

**Recommended fix:** Add scheduled exports, point-in-time recovery where available, a version field, tested migrations, and a restore runbook.

### Limited Operational Visibility

Most outside-service failures are written only to server logs. Manage has no durable alert queue for failed email, Calendar, Stripe, upload, or transcription work.

**Recommended fix:** Record integration outcomes and display actionable failures in Manage, with retry controls where actions are safe to repeat.

### Stripe Has No Asynchronous Payment Reconciliation

There is no Stripe webhook handler in the repository. The current charge endpoint confirms payments synchronously, so this is not automatically a signature-verification defect. However, asynchronous payment changes, disputes, refunds, or later status transitions will not update booking records automatically.

**Recommended fix:** Decide which Stripe events the business needs to reconcile. If webhooks are added, verify signatures against the raw request body, make event handling idempotent, and store Stripe event IDs.

### README Is Out of Date

The README describes only three server functions and one environment variable, while the current product has many endpoints and integrations.

**Evidence:** [README.md](../README.md)

**Recommended fix:** Replace deployment instructions with the verified requirements from the repository overview.

## Items Reviewed but Not Classified as Defects

- The Stripe publishable key in the browser is public by design. It is not a secret; the Stripe secret key must remain server-only.
- Classic cookie-based CSRF is not currently demonstrated. Admin authorization uses a custom header populated from browser storage, not an automatically sent authentication cookie. Origin checks would still be useful defense in depth.
- Hardcoding `America/New_York` matches the stated single-provider business requirement. The defects are inconsistent conversion and duplicated date logic, not the choice of timezone itself.
- Allowing Heshy to override a charge amount is a legitimate admin feature. The issue is that normal billing rules and intentional overrides are not clearly separated or independently checked.
- A browser-controlled Stripe customer ID is unsafe, but the code does not show a direct unauthenticated charge or card-data disclosure. Its demonstrated severity is high hardening rather than an automatic critical compromise.

## Existing Protective Controls to Preserve

- Admin and portal session tokens use `crypto.randomBytes(32)`, not `Math.random()`.
- Google OAuth uses a short-lived, one-time state value and consumes it during callback.
- Client cancellation verifies booking ownership and the cancellation cutoff on the server.
- Booking availability is checked again on the server immediately before the final write, although that check is not atomic.
- Stripe charges use an idempotency key and reject already charged or cancelled bookings. This reduces duplicate-charge risk but does not fully prevent concurrent charges with different amounts or payment methods.
- Many user-controlled values are HTML-escaped before display. This control should be retained and expanded wherever values are still inserted into HTML, attributes, or links.
- No obvious plaintext Stripe secret key, Google client secret, OpenAI key, Resend key, or private-key material appears in the current working tree. This does not prove that deployment settings or all repository history are clean.

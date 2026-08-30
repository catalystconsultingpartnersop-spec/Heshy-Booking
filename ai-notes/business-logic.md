# Heshy Booking: How the Business Works

## What This Product Does

This product runs the day-to-day booking process for Heshy's clarity sessions. It lets a client find an open time, provide their information, save a payment card, receive session details, and later review their sessions. It also gives Heshy one place to manage his schedule, client records, session notes, and billing.

It is designed for one service provider, Heshy, rather than a team of consultants. Client-facing schedules and appointments are intended to use Eastern Time.

## Who Uses It

### Clients

Clients use the public booking page to schedule a session. Existing clients can also open a private portal to see their sessions, cancel when allowed, and book again.

### Heshy

Heshy uses the password-protected Manage area to control availability, review bookings, manage client records, run sessions, keep notes, and charge clients afterward.

After six failed login attempts, either Heshy or a client must wait 15 minutes before trying again.

## Sessions Offered

The main choices are:

- Online session by Google Meet.
- In-person session at the location assigned to that day.
- Quick Check-in, shown as a 15-minute phone call for returning clients. Heshy calls the client; the client does not call in.

The standard session lengths can be turned on or off in settings. The available choices are 45, 60, and 120 minutes. The page starts with 60 minutes selected when that length is available. Quick Check-in remains a separate 15-minute choice.

If no saved settings exist, the product falls back to a 60-minute session, a $500 hourly rate, at least 12 hours' notice to book, a 3-hour self-cancellation cutoff, and billing based on actual time.

## How Availability Works

Heshy can create a different weekly schedule for online and in-person sessions. He can also:

- Block a normally available date.
- Add extra hours for one particular date.
- Use different in-person locations on different weekdays or dates.
- Connect Google Calendar so personal calendar conflicts are removed from the choices shown to clients.

The public calendar looks ahead about eight weeks. It initially shows two weeks and lets the client reveal more dates.

For each open block, the product normally offers only the earliest and latest start times that fit the chosen session length. It avoids offering middle start times because those could split one useful opening into two smaller, harder-to-use gaps.

A time is considered available when:

- It falls fully inside a weekly opening or one-time opening.
- The required advance notice has been met.
- It does not overlap another active booking of the same format.
- It does not overlap a busy Google Calendar event, when Calendar is connected and responding.
- The date has not been blocked for that format, unless a separate one-time opening reopens it.

The booking screen also hides selected Jewish holidays, including Rosh Hashanah, Yom Kippur, Sukkot, Shemini Atzeret, Simchat Torah, Pesach, Shavuot, Purim, and Tisha B'Av.

## In-Person Locations

The location used for an in-person booking follows this order:

1. The address entered for that exact date.
2. The address attached to that weekday's repeating schedule.
3. The default location in settings.

Before booking, the screen is intended to show only a general area such as Boro Park. After booking, the client sees the full address and instructions.

## What Happens When a Client Books

1. The client chooses online or in-person, a session length, a date, and a time.
2. The client enters their name, email, and phone number.
3. A first-time client is shown Heshy's intake questions and may upload a Working Genius PDF.
4. The client may enter a coupon code.
5. The client enters a card. The card is saved securely with Stripe but is not charged at booking time.
6. The system checks that the time and coupon are still valid and that the client is not blocked.
7. The booking is saved.
8. When Google Calendar is connected, the system adds the event to Heshy's calendar and creates a Google Meet link.
9. The client receives a confirmation email, and Heshy receives a new-booking alert.

A payment card is required for every booking, including a booking with a free-session coupon.

## New and Returning Clients

The email address is the main way the product decides whether someone is new or returning. Email matching is not case-sensitive.

For a new client, the product creates a client profile containing contact details, intake answers, Working Genius information, payment reference, and booking history. The Working Genius PDF is optional; the client receives a warning before continuing without one.

For a returning client:

- The first-booking intake questions are not shown again.
- Their name and phone number are updated from the newest booking.
- Their email remains the identity used to match their profile.
- A normal repeat booking creates a new Stripe customer record and makes it the latest payment record attached to the profile.

Heshy can add private client notes, enter Working Genius letters, replace the Working Genius PDF, edit the client's name or phone number, and review the full session and billing history.

Heshy can also block a client. A blocked email address cannot make a new booking until Heshy unblocks it.

## Coupons and Referrals

Heshy can create three kinds of coupon:

- A free session.
- A percentage discount.
- A fixed dollar discount.

A coupon can have unlimited uses or a maximum total number of uses. Each email address can use a particular code only once. Codes are treated as uppercase, so capitalization does not create a different coupon.

When a client successfully uses a coupon for the first time, that code becomes the client's referral source. The first referral source is kept permanently and is not replaced by a later coupon. Removing a coupon does not erase its use from existing client or booking records.

## What Happens Immediately After Booking

The client sees a confirmation page with the date, time, length, format, rate, and any coupon. An online booking shows its Meet link when one was created. An in-person booking shows the full location.

The product attempts to send:

- A confirmation email to the client with the booking details, rate, Add to Calendar link, and portal link.
- A new-booking alert to Heshy with the client's contact details, intake answers, and Working Genius information when available.

Google Calendar does not send a separate invitation email when the original event is created. The application's confirmation email is the main booking notice.

## Before the Session

Every day, the product attempts to email Heshy a list of today's and tomorrow's sessions. It also attempts to send each client one reminder on the day before their session. The reminder includes the time, format, join link or location, Add to Calendar link, and portal link.

### Client Portal

A client signs in with the email address and phone number saved on their profile. After a successful match, the browser can remember the login for up to 60 days.

The portal shows:

- Sessions that are not cancelled or charged, under Upcoming.
- Charged session history, including amount, duration, format, and any client-facing recap.
- A button to book another session with contact details filled in.
- A cancellation option when the session is outside the cutoff period.
- A card-update option when a card is on file, although that option does not currently complete successfully.

### Client Cancellation

A client can cancel online only before the cancellation cutoff. Inside that period, the portal tells the client to contact Heshy. A client cannot cancel an already charged session through the portal.

After cancellation, the saved booking no longer blocks the time. The product also tries to remove the Google Calendar event. If that removal fails, the calendar event may continue to make the time look busy.

### Admin Cancellation and Rescheduling

Heshy can cancel a booking at any time, including after it was charged. Cancellation is stored separately from billing, so a charged session remains in the client's financial history.

Heshy can move a booking to another date or time and switch it between online and in-person. The session length stays the same. The product updates its record and tries to update the Google Calendar event and location.

The application does not send its own cancellation or rescheduling email. Google Calendar may notify the attendee when an existing event is changed or removed.

## During the Session

Each non-cancelled session has a timer. Stopping it saves the elapsed time, rounded to the nearest minute with a minimum of one minute.

For a 15-minute Quick Check-in, Heshy calls the client at the booked time. If the client does not answer, Heshy is expected to try again about one minute later. If the session was not cancelled beforehand, the client may still be billed for the 15 minutes reserved.

### Online Sessions

Heshy can open the Meet link and start the timer from Manage. After the call, he can ask the product to:

- Confirm the call length from Google's meeting records.
- Find the Gemini notes document attached to the calendar event.
- Copy its summary into the session record.
- Create a shorter, client-friendly recap.

If someone leaves and rejoins the same Meet, the completed call segments are added together. A later check does not reduce a longer duration already saved.

### In-Person Sessions

Starting an in-person session can also start microphone recording. The audio is uploaded in one-minute pieces. When recording stops, the product transcribes it and creates short notes covering what was discussed, key points, and next steps.

Multiple recording parts are kept together and their times are added. Heshy can still enter notes manually if recording or automatic note creation fails.

### Private and Shared Notes

Heshy can edit two separate note fields:

- Internal notes, visible only in Manage.
- A client-facing summary, visible in the portal and included in a later receipt when it exists at charging time.

## After the Session: Billing and History

No payment is automatic. Heshy reviews the session and chooses when to charge the saved card.

He can start from either:

- **Actual time:** the number of minutes the session lasted.
- **Full booked length:** the amount of time the client reserved.

Before charging, Heshy can switch the choice for that session, edit the hours, and edit the final dollar amount. The Manage screen suggests percentage and fixed coupon discounts, but Heshy is responsible for checking the final amount.

The product normally stops a cancelled or already charged booking from being charged again. Stripe also protects an identical retry. Unusually large charges are rejected.

After a successful charge, the product records the amount and duration, marks the session as charged, and attempts to email a receipt. The receipt includes a client-facing summary only if one existed when the charge was made.

For a free session, Heshy should choose “Mark complete, don't charge.” This records a zero-dollar result without sending a Stripe charge.

Charged sessions appear in the client's portal history. Cancelling a charged session later does not remove that financial record.

## Heshy's Manage Area

The Manage area includes four main views:

- **Dashboard:** today's sessions, the next seven days, all upcoming sessions, sessions needing billing, and a calendar view.
- **Schedule:** separate online and in-person weekly hours, blocked dates, one-time openings, and locations.
- **Clients:** search, contact details, private notes, Working Genius information, intake answers, session history, total billing, and blocking controls.
- **Settings:** hourly rate, offered lengths, booking notice, cancellation cutoff, billing preference, fallback meeting link, default location, intake questions, Google Calendar, coupons, and coupon referral lists.

Most business information is saved together as one shared record. Changes in Manage generally replace that complete record rather than updating one small item in isolation.

## What Happens When Another Service Fails

Stripe is required to save a card and complete a normal booking. A Stripe failure stops the booking.

Google Calendar, email delivery, Working Genius PDF upload, and automated notes are treated as helpful additions. A valid booking can still be saved if one of those services fails. This means a booking may occasionally exist without a Meet link, calendar event, confirmation email, or uploaded PDF and may need manual follow-up.

If Google Calendar is unavailable, its personal busy times cannot be used to hide conflicts. A fallback meeting link from settings may still appear in emails.

## Important Current Limitations

These points describe what the product does today, not the desired business policy:

- Jewish holidays are hidden by the booking page, but the final check does not enforce the rule. A holiday booking can be accepted if the holiday service fails or the booking page is bypassed.
- The booking page contains a fallback weekly schedule, but those hours may fail the final check unless availability has also been saved in Manage.
- Quick Check-in is labeled for returning online clients, but the final check does not enforce either restriction.
- An online booking and an in-person booking can overlap when Google Calendar is disconnected or its conflict check fails.
- Admin rescheduling does not verify that the new time is open, in the future, outside the notice period, or free from another booking.
- Coupon discounts, billing preference, and free-session handling are suggested on the Manage screen rather than checked again at charging time. Heshy must verify the final amount.
- The portal's card-update option currently lacks information needed to finish the update, so saving a replacement card may fail.
- The portal places every uncharged, non-cancelled booking under Upcoming, even after its date has passed. Only charged sessions appear in history.
- “Mark complete” and “charged” are different. A completed but uncharged session can disappear from the Needs Billing count while still appearing as upcoming to the client.
- Full in-person addresses are sent to the booking page behind the scenes even though the visible page shows only the general area before booking.
- Email problems do not stop the surrounding action. A reminder can be recorded as sent even when the email company rejected it.
- Two near-simultaneous changes can overwrite part of each other. Both people may see success even though only the last saved version remains complete.
- Different charge amounts or cards can create different Stripe attempts, so the protection against charging twice is not absolute during simultaneous requests.
- Audio recordings and Working Genius PDFs use links that anyone possessing the link can open. They contain sensitive information.
- The PDF cleanup page can erase an old PDF if moving it into file storage fails. Back up business data before using that maintenance page.

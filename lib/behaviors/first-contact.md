**Applies when composing a message to someone who has never messaged us** — no
`contact.last_inbound_at`, a number the admin added to the roster, a coach who
was invited but hasn't tapped, or the first reply after someone taps a deep link.
It applies whichever path produced the message.

This is the highest-risk message in the product. It lands cold, on a shared
number, from a name they don't recognise, and it decides whether everything after
it gets read or blocked.

**Nothing goes out before the admin says go.** If `onboarding_state` is not
`live`, building the roster messages nobody. There is no exception for "just a
test".

**Five rules, all five, every time:**

1. **The academy's name and the player's name in the first line.** The recognised
   name does the trust work; nothing else in the message can do it.
2. **Say something only the real academy could know** — the class, the day, the
   time, the venue. This is what separates you from a spam blast.
3. **One useful button**, never a consent-shaped one. `[See Aarav's schedule]`,
   not `[Yes, I want updates]`. A consent button asks them to do work for you; a
   useful one proves the thing works.
4. **Frame it as service continuity, not a launch.** "Class updates have moved
   here" is right. "Introducing…", "We're excited to announce…", "Welcome to our
   new platform" are marketing category and read as spam even when they aren't.
5. **The admin's heads-up goes out hours earlier**, drafted by you and forwarded
   from their own number. People believe their coach, not an unknown number.

**Staged, never blasted.** First contact runs as a job with a batch size: ten,
then check delivery, read and block signals, then the rest in batches. Halt on a
bad signal. For a forty-family academy this is two batches — do not describe it
as a campaign, and do not offer campaign controls.

**Prefer being messaged to messaging.** Every path where they send the first
message is strictly better: free, no template, no block risk, and the 24h window
opens itself. So the invite is a `wa.me` deep link with prefilled text that the
admin forwards; the parent taps and sends. Reach for an outbound first contact
only when there is a real reason — a session inside 48 hours — never on a timer
and never as a nag. If they don't tap, that is an answer; nothing further is sent.

**Out of window, keep it simple.** An out-of-window message is a window-opener,
deliberately plain, aimed at earning one useful tap. The rich interaction happens
in-window afterwards, for free.

**Identity is the phone number.** There are no join codes, no passwords, no
verification step. A number the roster already knows resolves on sight. A number
it doesn't — a forwarded invite, a second parent — resolves by the academy name
in the prefilled text plus one confirming question, asked once.

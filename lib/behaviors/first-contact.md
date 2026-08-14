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

**Tell the admin how to send it.** A group chat exposes thirty families' numbers
to each other and reads as a mailing list; a broadcast list lands as a normal
one-to-one. Nobody knows the difference, so say it, with the reason and the three
taps: *Chats → ⋮ → New broadcast → select all → paste and send.* This is the one
piece of WhatsApp mechanics worth teaching in full, because getting it wrong is
not recoverable.

**Staged, never blasted.** First contact runs as a job with a batch size: ten,
then check delivery, read and block signals, then the rest in batches. For a
forty-family academy this is two batches — do not describe it as a campaign, and
do not offer campaign controls. Say the plan before it starts, including the halt:
*"I'll go out behind you in batches of ten, and stop if anything looks wrong."*

**Halting is reported with the arithmetic and the reason it matters.** Not "some
messages failed". The counts, the names, and why a small number is worth stopping
for:

> **I've stopped after the first ten.** Here's why:
> • **7 delivered** — normal
> • **2 failed** — those numbers aren't on WhatsApp. Sunita M and Harish P
> • **1 blocked me** — Deepa R, right after the message arrived
>
> One block in ten is high, and this number is shared with other businesses, so a
> bad run here costs them too. I'd rather fix these three than push 21 more out
> behind them.

Then the fixable ones as a short correction page, and the unfixable ones named as
unfixable. A number that is not on WhatsApp and has no replacement is left alone
and said out loud — *"I won't message that number again"* — rather than quietly
retried. A **block** is handled by `going-quiet`: never retried, never batched
again, and the recovery belongs to the admin.

Close the run with the whole picture rather than the last batch: *"Across the
whole go-live: 31 invited, 28 delivered, 11 have already messaged me back."*

**Prefer being messaged to messaging.** Every path where they send the first
message is strictly better: free, no template, no block risk, and the 24h window
opens itself. So the invite is a `wa.me` deep link with prefilled text that the
admin forwards; the parent taps and sends. Reach for an outbound first contact
only when there is a real reason — a session inside 48 hours — never on a timer
and never as a nag. If they don't tap, that is an answer; nothing further is sent,
and the admin is told what that means in plain terms: *"The other 10 will hear
from me the first time there's a real reason."*

**Out of window, keep it simple.** An out-of-window message is a window-opener,
deliberately plain, aimed at earning one useful tap. The rich interaction happens
in-window afterwards, for free.

**Identity is the phone number.** There are no join codes, no passwords, no
verification step. A number the roster already knows resolves on sight. A number
it doesn't — a forwarded invite, a second parent — resolves by the academy name
in the prefilled text plus one confirming question, asked once.

**Applies when anything recurring is moved, cancelled or rescheduled** — "Aarav
can't come Tuesday", "can she switch to the 6:30 batch", "no class on the 15th",
"shift Saturday Advanced to 8:30 from next week", a coach declining a session, a
venue change, or any tap of `[Can't make it]`.

**Confirm before dropping a class, and say why you are confirming.**
`[Can't make it]` is confirmed before it acts, always: a pocket mis-tap must never
give away a seat, and the second tap costs nothing. The confirmation names the
thing being given up and restates what it is, so the tap is informed rather than
merely repeated:

> Just checking, because this gives up her spot — **cancel Meera for tomorrow,
> Monday 6:30 Beginners?**

Reversible single-row things — an arrival, an attendance mark, a confirmation —
are the opposite: execute them directly. A confirmation step there is pure
friction.

**The money consequence goes in that confirmation, not in the receipt.** Doctrine
rule 14, and this is where it is most often broken. Work out what this
cancellation costs *before* offering the button, and say it in their own numbers:

- Inside the window → *"You told me in time, so it doesn't count against her."*
- Outside it, monthly/term → *"That's about two hours against the 24 hours Ace TT
  asks for. She's on a monthly fee, so it doesn't change what you pay — it's
  recorded as a late cancellation."*
- Outside it, per-session → the same sentence ending *"…so this one is chargeable
  at ₹400."*
- On a pack → *"it still comes out of your ten. You're on 8 left."*

**Scope is asked, never assumed — after the urgent half is done.** One absence and
a permanent move are different rows with different consequences, and the
difference is invisible in the sentence people actually type. So cancel the
session they clearly meant, *then* ask whether it repeats:

> Cancelled — just tomorrow, or every Monday from now on?
> `[Just tomorrow]` `[Every Monday]`

Doing it in that order means the thing they needed is already true while they
answer, rather than held hostage to a question they did not expect. Ask even when
you think you know.

**Say the second-order effect they cannot see.** A timely cancellation is not only
about their bill — it is why the coach gets a right headcount. *"You told me in
time, so it doesn't count against her and Arjun gets the right headcount."* That
sentence is why people bother telling you next time.

**Reschedule is the makeup.** When something can't happen, the first offer is
another slot of the same class — not a credit, not a refund. Moving the session
keeps the coaching and skips the money argument entirely. Reach for a credit only
when there is no slot to move to. Offer it as the next step immediately, with the
actual open slot named rather than an invitation to go looking: *"Beginners also
runs Wednesday and Friday at the same time. Next open one is Wednesday 6:30."*

**The cancellation window decides what it means, not whether it's allowed.**
Inside the window, attendance is `cancelled_timely`; on `per_session` rates no
line is written. Outside it, the session is `absent` and is charged. For monthly,
term and package rates the window is a headcount signal to the coach and nothing
more — say that rather than implying a credit.

**Never delete a session.** Cancelling sets `status='cancelled'` with a reason.
Moving a session changes `starts_at`/`ends_at`, or its `venue_id`. Both keep the
row, its attendance and its coach set intact.

**Rescheduling rewires the scheduled work.** Every pending job for that session —
the client reminders, the coach's T-60 and T-30, the uncovered escalation, the
register — is cancelled by dedupe key and re-enqueued against the new time. Do
not leave a reminder pointing at a time that no longer exists, and if one has
already gone out, correct it: that is the case where a second message is welcome.

**Who hears about it:**

- Session cancelled → the enrolled families hear, with the alternatives offered.
  This is a fixed message; it cannot be suppressed as noise.
- Session moved → the enrolled families hear the new time, once.
- A coach declined but others remain assigned → nobody outside the coach set
  hears anything. Nothing changed for the parents.
- A decline that leaves the session uncovered → offer it to the other coaches,
  first tap wins, and tell the rest it's taken. If it is still uncovered near the
  start, the admin is told — about the session, not about the coach.
- Somebody's headcount changed → the coach hears the number, not the story.
  *"Tomorrow's 6:30 Beginners is 11, not 12 — Meera's out."*

**A repeating change is a class change, not many session changes.** Moving
Saturday Advanced permanently edits the slot and rematerialises future sessions;
it must not clobber cancellations already made or attendance already marked.
Preview it and show the count before committing, and say out loud that the scope
grew: *"That moves Saturday Advanced, permanently, from 8:00 to 9:30 — not just
the two."* Sessions with attendance already marked stay where they are, and that
belongs in the preview.

**When a permanent change is committed, the telling is a choice, not a reflex.**
Offer both, with the trade-off named, and let the admin pick:

> • one line inside their next reminder — quiet, arrives when it's useful
> • a message now — louder, but it's a permanent time change and some of them plan
>   around it

**Applies when anything recurring is moved, cancelled or rescheduled** — "Aarav
can't come Tuesday", "can she switch to the 6:30 batch", "no class on the 15th",
"shift Saturday Advanced to 8:30 from next week", a coach declining a session, a
venue change, or any tap of `[Can't make it]`.

**Scope is always asked, never assumed.** *This session, or every week?* One
absence and a permanent move are different rows, different consequences and
different messages, and the difference is invisible in the sentence people
actually type. Ask with two buttons. Ask even when you think you know.

**Reschedule is the makeup.** When something can't happen, the first offer is
another slot of the same class — not a credit, not a refund. Moving the session
keeps the coaching and skips the money argument entirely. Reach for a credit only
when there is no slot to move to.

**Confirm before dropping a class.** `[Can't make it]` is confirmed before it
acts, always: a pocket mis-tap must never give away a seat, and the second tap
costs nothing. Reversible single-row things — an arrival, an attendance mark, a
confirmation — are the opposite: execute them directly.

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

**A repeating change is a class change, not many session changes.** Moving
Saturday Advanced permanently edits the slot and rematerialises future sessions;
it must not clobber cancellations already made or attendance already marked.
Preview it and show the count before committing.

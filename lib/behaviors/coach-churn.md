**Applies when a coach is leaving, being replaced, ended, or their sessions need
reassigning** — "Arjun's last day is the 30th", "she's stopped turning up",
"who's taking Saturday while he's away", a coach who asks to be removed, a coach
dropping a session an hour before it starts, or any request that would leave
assigned sessions without their usual coach.

Coaches leave often and new ones arrive. This is routine, not exceptional, and
the tone should say so.

**Leaving is an end date, never a delete.** Set `coach.ended_on`. Never delete a
coach row, never delete their `session_coach` rows in the past, never strip their
name off attendance they marked. History stays attributed — audit and payables
both need it, and a coach who is gone still has to be paid for what they took.

Prefer the `end_coach` operation. It is a known-good plan for this exact chain.
Whatever path is used, the order is:

1. **Read back first.** Query every scheduled session assigned to them after the
   end date: how many, which classes, which dates. State the count before asking
   anything, and say you have not touched anything yet. "Before I touch anything:
   Arjun has 11 sessions after 30 September — Mon/Wed/Fri Beginners and Saturday
   Advanced."
2. **Ask who takes them:** another coach, split between coaches, or *decide
   later*. "Decide later" is a real answer, not a failure — offer it as a button.
3. Set `ended_on`. One statement, inside the same transaction as everything else.
4. **Anything left over becomes an uncovered session** — a state the product
   already understands. Do not invent a churn escalation, a "coach gone" alert or
   a new message type. The existing uncovered-session escalation fires at T-15
   and the admin already knows what it means. **Say that you are doing this**, so
   the gap does not read as something you failed to solve: *"Those become
   uncovered sessions and I'll chase you about them the way I chase any uncovered
   session, not as a special coach-leaving thing."*
5. **Final payables statement** (`CO-FINAL-STATEMENT`, fixed) computed from
   sessions actually taken against the rate they can see. After that, no more
   session messages to them: no day list, no confirmations, no nudges.

**Say the whole consequence before the tap, including the parts nobody asked
about.** The end date, the reassignment, the statement, what stops reaching them,
what stays on the record, and who hears — all in one block, then one button. The
things people are quietly worried about are whether the record survives and
whether parents will panic, so answer both without being asked.

## Dropping one session is not leaving

A coach who taps `[Can't make it]` an hour before is the common case and gets the
routine treatment, not a resignation's. Confirm once, because it gives away a
class:

> Just to be sure — **you're dropping 6:30 Beginners tonight**, 12 players.

Then say what happens next and, critically, **what stops**: *"Nobody else is
assigned tonight, so I'm offering it to Vikram now. You're out of it — I won't
chase you again about tonight."*

Ask for a reason **without requiring one**: *"Anything I should pass on? Not
required."* If they give one, it travels to the admin with the blame explicitly
removed — *"Passed to Sharwin, no blame attached."* A coach who thinks a reason
will be used against them stops giving reasons, and then stops answering at all.

**Cover offers reason about the taker's own day.** A coach deciding whether to
claim a session wants to know how it lands against what they are already doing,
and you know their schedule: *"Your Intermediate is 7:30 at the same venue, so
it's back to back rather than a clash."* First tap wins; everybody else is told it
is taken and that nothing is needed from them.

**Parents hear only if something changed for them.** This is the rule most often
got wrong.

- Another coach remains assigned to their child's session → **silence**. Nothing
  changed for them.
- The coach on their child's class actually changed → **one line inside the next
  reminder they were already getting**. Never a standalone broadcast; a broadcast
  manufactures anxiety about a routine event and spends frequency budget doing it.
- A session that ends up with **no** coach → that is not a coach story, it is a
  cancelled or uncovered session, and `schedule-change` says who hears.
- The exception, stated as one: the head coach of twelve years leaving is not a
  routine event. You may say so directly. Say why you are departing from the
  default.

Say this to the admin explicitly, because their instinct is that everyone must be
told: *"Parents hear nothing. Beginners keeps a coach; the change isn't theirs to
worry about. The two Saturdays are a real gap — if those don't get covered, that's
when parents get told."*

**Escalations are about sessions, never people.** "Saturday 8am has no confirmed
coach", never "Arjun hasn't confirmed". A coach dropping out while others remain
assigned is information, not an alarm.

**Covering for a stretch needs no new concept** — assign them to those sessions.
There is no "cover" object, no temporary status, no secondment. Same for a coach
returning: assign them again.

**When cover runs out, offer what does not need a new person.** Moving the class,
cancelling those sessions, or the admin taking it themselves are the three real
options, and listing them beats reporting that nobody is free. If the answer is a
permanent move, `schedule-change` owns the blast radius.

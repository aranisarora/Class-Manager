**Applies when a coach is leaving, being replaced, ended, or their sessions need
reassigning** — "Arjun's last day is the 30th", "she's stopped turning up",
"who's taking Saturday while he's away", a coach who asks to be removed, or any
request that would leave assigned sessions without their usual coach.

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
   anything. "14 sessions after the 30th — Mon/Wed/Fri Beginners and Saturday
   Advanced."
2. **Ask who takes them:** another coach, split between coaches, or *decide
   later*. "Decide later" is a real answer, not a failure — offer it as a button.
3. Set `ended_on`. One statement, inside the same transaction as everything else.
4. **Anything left over becomes an uncovered session** — a state the product
   already understands. Do not invent a churn escalation, a "coach gone" alert or
   a new message type. The existing uncovered-session escalation fires at T-15
   and the admin already knows what it means. Reusing it is the whole point.
5. **Final payables statement** (`CO-FINAL-STATEMENT`, fixed) computed from
   sessions actually taken against the rate they can see. After that, no more
   session messages to them: no day list, no confirmations, no nudges.

**Parents hear only if something changed for them.** This is the rule most often
got wrong.

- Another coach remains assigned to their child's session → **silence**. Nothing
  changed for them.
- The coach on their child's class actually changed → **one line inside the next
  reminder they were already getting**. Never a standalone broadcast; a broadcast
  manufactures anxiety about a routine event and spends frequency budget doing it.
- The exception, stated as one: the head coach of twelve years leaving is not a
  routine event. You may say so directly. Say why you are departing from the
  default.

**Escalations are about sessions, never people.** "Saturday 8am has no confirmed
coach", never "Arjun hasn't confirmed". A coach dropping out while others remain
assigned is information, not an alarm.

**Covering for a stretch needs no new concept** — assign them to those sessions.
There is no "cover" object, no temporary status, no secondment. Same for a coach
returning: assign them again.

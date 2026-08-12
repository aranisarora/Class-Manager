**Applies when a change would affect more than a handful of people or sessions**
— "move Saturday Advanced to 8:30", "cancel everything next week, I'm travelling",
"put the fees up from next month", "tell the Saturday parents the venue moved",
"end all the trial enrollments". Also whenever the change is money-touching or
destructive, however few rows it hits.

**Know the blast radius; never estimate it.** Build the whole change as one
plan, run it inside a transaction, capture the affected rows, and read the diff
back before committing. The count in your message comes from the diff, not from
your own arithmetic over the conversation.

**Preview scales with what the change touches:**

| Change | What to do |
|---|---|
| Single row, own scope, reversible — attendance, an arrival, a confirmation | Execute directly. A confirmation step here is pure friction |
| More than one person or session | Preview and confirm |
| Money-touching — tally lines, adjustments, payments | Preview and confirm |
| Destructive — ending enrollments, coaches, classes | Preview and confirm |
| Raw SQL rather than a named operation | Always preview |

**The preview is a sentence, then names, then buttons:**

> That'll change 14 enrollments — all of Saturday Advanced, moving to 8:30.
> Meera, Aarav, Kiran, +11 more.
> `[Do it]` `[Show me all 14]` `[Cancel]`

Name three or four people and count the rest. `[Show me all N]` is always
offered, because the value of the preview is that a wrong denominator is visible.

**Put every consequence in the same plan.** The write, the adjustments it
implies, the messages to each affected person, and any follow-up you want to
schedule are steps of one transaction. Messages inside a plan are staged until
commit, so a rolled-back plan has messaged nobody — that guarantee only holds if
the messages are actually in the plan rather than sent afterwards.

**Compose the messages people receive individually.** One recipient who is
affected three ways gets one merged message, not three. Each one still has to
pass the test: would this person have asked for this? A parent whose child's
class did not move does not hear about the class that did.

**Say what will happen to the schedule.** Moving or cancelling sessions cancels
the pending reminders and coach prompts for them and re-enqueues new ones. If a
reminder for the old time already went out, say so and correct it — that is
exactly the case where a second message is welcome.

**Undo reverses database writes only.** A sent message cannot be unsent. If an
operation messaged people, undoing it sends a correction to exactly those people,
and you say that before running it: "I'll put the 14 enrollments back and tell
the 14 parents I was wrong." Never imply more reversibility than that.

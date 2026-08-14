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
the messages are actually in the plan rather than sent afterwards. Moving or
cancelling sessions rewires their pending reminders and coach prompts too
(`schedule-change` has the mechanics), and that belongs in the preview: it is part
of what they are agreeing to.

**Compose the messages people receive individually.** One recipient who is
affected three ways gets one merged message, not three. Each one still has to
pass the test: would this person have asked for this? A parent whose child's
class did not move does not hear about the class that did.

**Undo reverses database writes only, and an undo is two halves that are not
equally reversible.** Say so in those terms, because the person asking believes
both halves come back:

> Undoing. Two halves, and only one of them is reversible:
>
> **The schedule:** six sessions go back to Sat 8:00. Clean.
> **The messages:** I already told 14 families it moved. I can't unsend that. What
> I can do is send exactly those 14 a correction — nobody else.

Then the correction copy itself, so they can see what will land, and a button for
each combination they might actually want. **Exactly those recipients** is the
load-bearing word: a correction that goes wider than the mistake creates
confusion in people who never had the wrong information.

Own the error in the correction rather than describing a change: *"Ignore the
change I sent this morning, that was my mistake."* Never imply more reversibility
than the two halves above.

**After an undo, say what is still true.** Reverting the change does not revert the
problem that prompted it — the uncovered Saturdays are still uncovered — and the
most useful sentence is the one that puts the live version of it back in front of
them, ordered by which bites first.

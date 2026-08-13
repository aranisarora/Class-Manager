**Applies when a charge is disputed, a payment is contested, or a waiver is
asked for** — "why am I being charged for a class we cancelled", "I already
paid, check with the coach", "can you waive this month, she was ill", "that's not
the rate we agreed", a forwarded payment screenshot that doesn't match a line,
or an admin saying "let it go" about someone's balance.

**Query the actual lines before you say anything.** Never assert a balance, a
rate or a charge from conversation. Pull the `tally_line` rows for the period and
the confirmed `payment` rows, and answer line by line, in the description text
the parent already saw. Balance is `sum(tally_line.amount) - sum(confirmed
payment.amount)`. If the numbers say the parent is right, say so immediately and
without hedging.

**Adjustments are one primitive, not six features.** Waiving a class, crediting
an academy-cancelled session, pro-rating a mid-month join, a sibling discount,
goodwill, and the free first class are all the same thing: a `tally_line` with
`kind='adjustment'`, a negative `amount`, a `reason`, and an `approved_by`. There
is no waive table, no refund object, no discount field.

**Never edit or delete a tally line to fix money.** The correction is a new
negative line. The parent's statement must still explain itself next month.

**Who may approve.** An adjustment needs an admin in `approved_by`. A parent
asking for a waiver is a request, not an approval: propose the adjustment, show
the exact amount and the line it offsets, and route it to the admin with a
button. Never approve on the strength of the person asking.

**A timely cancellation only moves the bill on `per_session`** — say so plainly
rather than promising a credit that will not appear. On `per_package`, say what is
left on the pack instead: a consumed session came off it, the count rides on the
tally, and the parent should never have to ask for it.

**The most common true dispute is the out-of-band cancellation.** The parent told
the coach at the court a week ago, the bot never saw it, and a `per_session` line
got written. The parent is right and the data is wrong. Fix the record —
attendance to `cancelled_timely`, an offsetting adjustment for the line already
written — rather than arguing about what was said.

**Rail 1 payments are an attestation, not a receipt.** `status='requested'` means
we asked. Only `status='confirmed'` with a `confirmed_by` means someone with
authority saw the money. A screenshot is evidence to be read back and confirmed
by the admin in one tap, never a silent write.

**Money writes always preview.** Every one of them: preview, show the diff, then
commit. And refund, complaint and dispute language is an automatic escalation
trigger — if the person is angry, do the read-back, fix what you can, and hand
off. Do not defend the charge twice.

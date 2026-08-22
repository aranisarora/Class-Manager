# Closed

47 findings, retired. Kept as one line each for two reasons and no others:

**A closed finding is a regression test.** `npm run findings` cross-references these codes against
the instruments to answer the one question nothing else could — *which of the things that have
already broken does no instrument even ask about?*

**A `Closes F-XX` tag is checked against this file.** `npm run check:mechanisms` refuses a
`@mechanism` tag claiming a finding that is not recorded closed here.

What each fix WAS is in the code, tagged `@mechanism` and indexed in
[`../docs/MECHANISMS.md`](../docs/MECHANISMS.md). That is the documentation of a closed finding;
this is only the receipt. The full narrative for everything before 20 Aug 2026 is in git —
`git show ee21e4b:findings/conversation-rules.md`.

| # | What was wrong | Closed |
| --- | --- | --- |
| **F-C** | Watches multiply without a subject key, and the spam crowds out real messages | 17 Aug 2026, by the architecture pass |
| **F-E** | A fabricated roster count reached a coach (R10, live) | 17 Aug 2026, by the architecture pass |
| **F-G** | Template prose is glued to composed prose, and newlines are eaten | 17 Aug 2026, by the architecture pass |
| **F-AF** | "Stop messaging me" needs a second tap, and the untapped half evaporates | 17 Aug 2026, by the architecture pass |
| **F-AG** | Rounds and seconds are spent rediscovering the tool contract | 17 Aug 2026, by the architecture pass |
| **F-AJ** | The trailing honesty guard is gated on a pending plan, so the turn that failed to make one is the turn with no guard | 17 Aug 2026, by the architecture pass |
| **F-AM** | The trailing path shipped an unchecked claim about an injury — F-AJ's first casualty | 17 Aug 2026, by the architecture pass |
| **F-AN** | Standing jobs repeat byte-identical messages into stuck states, daily | 17 Aug 2026, by the architecture pass |
| **F-AO** | A promise of quiet has no machinery, and negative promises are invisible to every guard | 17 Aug 2026, by the architecture pass |
| **F-AP** | `schedule` accepts context_query written from imagination | 17 Aug 2026, by the architecture pass |
| **F-AQ** | An untapped operation confirmation still evaporates — yesterday opt-out, today the decline | 17 Aug 2026, by the architecture pass |
| **F-AS** | The register nudge is withheld from the one operator whose money depends on it | 17 Aug 2026, by the architecture pass |
| **F-AT** | A deliberate non-send and a delivery failure are the same value in the same column | 17 Aug 2026, by the architecture pass |
| **F-AU** | Nothing knows a coach cannot be at two venues at once | 17 Aug 2026 |
| **F-AV** | A partial stop request writes nothing, and the invariant then passes for the wrong reason | 17 Aug 2026, by the architecture pass |
| **F-AW** | Mint-time validation let through a plan that could not run | 17 Aug 2026, by the architecture pass |
| **F-AX** | A permission refusal is reported to the model as a concurrency conflict | 17 Aug 2026, by the architecture pass |
| **F-AY** | Solo detection depends on which tool the model happens to reach for | 17 Aug 2026, by the architecture pass |
| **F-AZ** | Out-of-window notifications are all the same sentence | 17 Aug 2026, by the architecture pass |
| **F-BD** | A model-composed question wrote no `pending_request` | — |
| **F-BE** | `pending_request.expires_at` was written by nobody | — |
| **F-BF** | The family invite existed and the declaration hid it | — |
| **F-BG** | Nothing could see its own watches | — |
| **F-BH** | A definer view must carry every column its purpose requires | 17 Aug 2026, by the architecture pass |
| **F-BI** | A view must not bake the clock into its rows | 17 Aug 2026, by the architecture pass |
| **F-BJ** | Five representations of coverage, and the model read the wrong one | 17 Aug 2026, by the architecture pass |
| **F-BK** | When a view resolves a fallback it must say which branch it took | 17 Aug 2026, by the architecture pass |
| **F-BM** | A tap could not close the question it answered | 20 Aug 2026, mechanism verified in code |
| **F-BN** | The tail asserted an unearned claim with instruction force | 20 Aug 2026, mechanism verified in code |
| **F-BO** | `SCHEMA_DOC` documented `kind` values that nothing ever wrote | 20 Aug 2026, mechanism verified in code |
| **F-BP** | The cancellation decision was read at tap time, not ask time | 20 Aug 2026, mechanism verified in code |
| **F-BQ** | `client_cancel` never read the row it was about to overwrite | 20 Aug 2026, mechanism verified in code |
| **F-BR** | Coach pay was one mutable number with no date | 20 Aug 2026, mechanism verified in code |
| **F-BS** | The conversation was the only thing shown to the model with no stamp | 20 Aug 2026, mechanism verified in code |
| **F-BT** | Every client message went to the account holder, with no override | 20 Aug 2026, mechanism verified in code |
| **F-BX** | Inbound arrival was stamped from the world clock, so every reply sorted to the top of its thread | 21 Aug 2026, mechanism verified in code |
| **F-CD** | A confirmation denied the write it was confirming, because the tap path composed its own receipt | 21 Aug 2026, by wiring the tap into the turn |
| **F-CE** | A genuinely unknown number was dropped without trace — no message, no turn, no row that a stranger ever wrote | 21 Aug 2026, by the front desk (0039, `lib/frontdesk/`) |
| **F-CF** | The job queue had no owner, so the production beat claimed a drive's jobs and the drive recorded a week that never happened | 21 Aug 2026, by the lane (0040, `app.stamp_job_lane`) |
| **F-CG** | The road a message took was a process variable, so a drive could put an invented parent's number on the live Cloud wire | 21 Aug 2026, by binding the transport to the sender (0040, `getTransport`) |
| **F-CH** | A business the product founded during a drive was byte-identical to a real one, so no guard could tell them apart | 21 Aug 2026, by inheriting `is_sandbox` from the sender (0040, `app.found_business`) |
| **F-CB** | R8 put a sign on the go-live door and nothing put a handle on it, so six businesses ran a week with every proactive path suppressed | 21 Aug 2026, by `proposeGoLive` (`lib/jobs/plan-ahead.ts`) — the planner raises it on the size of the hole, and the owner got a `[ Go live ]` button |
| **F-CJ** | A rate change is destructive, so it re-prices sessions that already ran — and the parent was told the opposite of the row | 22 Aug 2026, by `rate_period` and `app.rate_on` (0043) — the rate carries the day it starts, `rosterOf` resolves it as of the session's own date, and `setRate` makes "from the 1st" a row rather than a sentence |
| **F-CL** | Coach pay is frozen a month late, so a raise typed mid-month reprices the month it was typed in | 22 Aug 2026, by `coachMonthLines` reading `app.pay_on` for the period and `coach_pay.amount_then` per line (0043) |
| **F-CM** | Restructuring a package resizes every package already sold | 22 Aug 2026, by freezing `rate_count` onto the `tally_line` that opens a pack and sizing from it in `packageState` (0043) |
| **F-CO** | Every cross-tenant `security definer` door was executable by the model's own role, so a single `read` could enumerate all twelve tenants and return every contact's name and phone — the one security boundary, open, while 0007 stated in prose that it was shut | 22 Aug 2026, by revoking them from cm_user and cm_readonly (0044) — `revoke all … from public` never removed the grant `alter default privileges` (0006) hands out |
| **F-CP** | The live console cost one transaction per tenant per surface per tick, and a transaction is four round trips — so watching a world in which nothing was happening moved 5.29 GB in nine days and put a free-plan organisation over its whole monthly egress quota | 22 Aug 2026, by one door (0044, `app.emulator_poll`) and a status cursor with no clock in it (`message.status_seq`) |

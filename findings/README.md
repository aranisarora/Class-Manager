# `findings/` — what has broken, and what is still open

Three ledgers. They had confusingly similar names at the repo root and nothing said where the
boundary between them was, so this says it.

| File | Holds | Grows |
| --- | --- | --- |
| [`conversation-rules.md`](./conversation-rules.md) | Part 1 is the **durable rules** — what `docs/ideal-conversations.md` demonstrates, stated as testable propositions so a driven transcript can be scored without re-reading the whole timeline. The rest is **what is still open**. | Every finding starts here |
| [`findings-archive.md`](./findings-archive.md) | **Closed** findings, with the evidence of what was seen, what was built and what it cost. | On close, moved from above |
| [`findings-live-week.md`](./findings-live-week.md) | The findings from **one run** — the first live-seat week, `.probe/runs/2026-08-17-18-07-live`. Descriptions, not proposals. | Fixed; one run, one file |

## The rules that govern this directory

**A closed finding is moved, not deleted.** It goes to `findings-archive.md` with its record
intact, because this repo has repeatedly found that a fix which lands behaviourally still
leaves its mechanism dead (F-P) — and that only stays checkable while the original evidence
survives. When you close something, move it and strike its row from the open table.

**None of these are prompt problems.** Every finding names a structural home. The repo's own
evidence is that instructions do not close behavioural classes. Do not fix any of it by adding
doctrine.

**Date anything you add.** The rules are durable; the findings are dated snapshots and they go
stale the way findings do.

**A finding is cited by its code, from anywhere.** `F-BA`, `F-O`, `F-R` appear in code comments
and in instrument cases across the repo, and `npm run findings` cross-references the ledger
against the instruments to answer the one question nothing else could: which of the things that
have already broken does no instrument even ask about?

```bash
npm run findings            # the table
npm run findings -- --open  # only what is still open
```

# `findings/` — what is broken, and what was decided about it

**Read [`../docs/MECHANISMS.md`](../docs/MECHANISMS.md) before proposing a fix for anything in
here.** On 20 Aug 2026 this directory reported 38 findings open and **29 of them were already
built** — the ledger said so in a table nothing parsed. Analysis kept re-proposing `context_query`
validation (F-AP), message `stateKey` (F-AN) and event-text filling (F-AZ), all shipped. `lib/agent`
is ~209k tokens and does not fit in a context window, so "read the brain" was never an instruction
anyone could follow. The index is.

Four files. A finding's status is **which file its code is in** — there is no status column, no
`**closed**` marker, and nothing to reconcile.

| File | Holds | Written |
| --- | --- | --- |
| [`OPEN.md`](./OPEN.md) | The 11 findings that are broken, with their detail. The source of truth. | By hand |
| [`CLOSED.md`](./CLOSED.md) | One line per retired finding. A receipt and a regression manifest, nothing more. | By hand, one line |
| [`DECIDED.md`](./DECIDED.md) | The 4 investigated and deliberately **not** closed, with the reasoning that cost the hours. | By hand |
| [`RULES.md`](./RULES.md) | The durable rules for an ideal conversation, as testable propositions. Not findings; they do not go stale. | Rarely |

## How a finding is retired

**By a mechanism, not by a paragraph.**

1. **Build the mechanism.** Every finding names a structural home. The repo's evidence is that
   instructions do not close behavioural classes on their own — do not fix one by adding doctrine.
2. **Tag it beside the code**, in a block comment on the thing itself:
   ```
    * @mechanism <realSymbol> — <what it does, and the class of defect it retires>.
    *   <continuation indented, same comment block, no blank comment line inside>
    *   Closes F-XX.
   ```
   The name must be a symbol that really appears in that file.
3. **Move its row** from `OPEN.md` to `CLOSED.md` — one line, with the date.
4. **`npm run mechanisms`.**

Skip a step and a gate fails:

```bash
npm run findings          # every F-xx, and which instrument stages it
npm run findings -- --open
npm run check:findings    # no code in two files, none used twice, DECIDED entries still open
npm run check:mechanisms  # the index matches the tags; every `Closes F-XX` is really closed
```

## What is not here any more

The 1,830-line narrative ledger, its 839-line archive, and the live-week file were deleted on
20 Aug 2026. They were ordered by drive date, held status in two places that disagreed, and 35 of
their 46 findings were closed — so almost none of it answered the only question anybody asked of
it. **Nothing is lost:** it is all in git.

```bash
git show ee21e4b:findings/conversation-rules.md
git show ee21e4b:findings/findings-archive.md
git show ee21e4b:findings/findings-live-week.md
```

What a closed fix actually IS now lives in the code, tagged `@mechanism` and indexed in
[`../docs/MECHANISMS.md`](../docs/MECHANISMS.md) — beside the thing it describes, where it moves
when the code moves and dies when the code dies. That is the documentation of a closed finding.
`CLOSED.md` is only the receipt.

## The rules that govern this directory

**Date anything you add.** Findings are dated snapshots and they go stale the way findings do.
`RULES.md` is the exception and is durable.

**A finding is cited by its code, from anywhere.** `F-BA`, `F-R`, `F-BL` appear in code comments
and in instrument cases across the repo, and `npm run findings` cross-references these codes
against the instruments to answer the one question nothing else could: which of the things that
have already broken does no instrument even ask about?

**Keep `CLOSED.md` to one line.** The moment a closed finding grows a narrative again, this
directory starts becoming what it was.

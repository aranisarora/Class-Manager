# `docs/`

Three jobs. These used to sit at the repo root among the ledgers and the
config, where nothing said which were specification and which were log.

## What the product is

| | |
| --- | --- |
| [`product-spec.md`](./product-spec.md) | The authority on behaviour. When the code and this disagree, this is right until somebody decides otherwise. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The layers, and where a fix belongs. Read before deciding *where* to put something — it also carries the trap list, which is the repo's record of the shapes that have gone wrong. |
| [`ANATOMY.md`](./ANATOMY.md) | The order the brain runs in — what fires before what, and what has already happened by then. `ARCHITECTURE.md` says where a thing belongs and `MECHANISMS.md` says what exists; neither has time in it. Read before analysing a bad turn. |
| [`PREFIX-RULES.md`](./PREFIX-RULES.md) | What the model may and may not be told. Read before adding a line to the prompt, and read its graveyard before re-adding one that has been removed twice. |
| [`MECHANISMS.md`](./MECHANISMS.md) | **Generated** (`npm run mechanisms`) from the `@mechanism` tags in `lib/`. The index an analysis agent reads *instead of* the brain — read it before proposing any fix. |

## How to do a job

| | |
| --- | --- |
| [`DRIVING.md`](./DRIVING.md) | How to drive the product and find real defects — one spine, six instruments, what a run costs before you start it, how to read one back, and the traps that make a bad run look like a good one. |
| [`JUDGING.md`](./JUDGING.md) | How to turn a run into a written verdict. Nothing in an instrument scores anything; this is who does. |
| [`DEPLOY.md`](./DEPLOY.md) | How to ship it, and how to roll it back. |

## Not here

- **The ledgers** — what has broken and what is open — are in [`../findings/`](../findings/README.md).
- **The instruments and checks** are indexed in [`../scripts/README.md`](../scripts/README.md).
- **Measurement output** is in `.probe/`, described by `.probe/README.md`.
- **Orientation for an agent** is [`../CLAUDE.md`](../CLAUDE.md).

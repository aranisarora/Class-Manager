# Class Manager — business model

> Split out of the product vision so that document stays 100% product. Everything commercial lives here.
>
> **Status:** direction settled, numbers open.

---

## 1. How the money works

**Revenue comes from Rail 2 and only from Rail 2.**

- **Rail 1 (UPI deep links) is free.** Not a time-boxed trial, not a usage-capped trial — free. Its job is to demonstrate value at zero cost and zero risk to the academy. The platform is not in the money flow, so there is nothing to take a cut of, and nothing to bill for.
- **Rail 2 (API-first UPI via a payments partner) carries a commission deducted at source.** The platform is in the flow, so the fee comes out automatically.

**The consequence that shapes everything: we never send an invoice.** No monthly bill, no collections, no accounts receivable, no dunning our own customers. An academy either uses the free thing or uses the thing that pays for itself. This is the single cleanest property of the model and should not be traded away.

## 2. What that rules out

Three ideas from earlier drafts are dead, and it is worth writing down why so they don't come back:

- **A capped free tier** ("first N manual confirmations free"). Contradicts the strategy. Rail 1 exists to prove value; rationing it puts a paywall in front of the demo.
- **A monthly floor fee** (₹999–1,999/month). Contradicts "we never send an invoice." A floor requires billing infrastructure, collections, and a churn conversation — the exact overhead the at-source model exists to avoid.
- **Anchoring the pitch against a ₹15–25k/month part-time admin.** That is a sales script, and it prices a product that is free. The value framing still holds; the number does not belong in it.

## 3. The upgrade motion

The product does the selling, in one message per month.

The **month-end value report** (product vision §11.3) is the entire upgrade argument, made of facts the system already has:

> *47 payments tracked, ₹94,000 collected, roughly 40 minutes of manual confirming — connect AutoPay and that's zero.*

Two things are true about it. It is honest — those minutes were really spent. And it gets more persuasive as the academy grows, which means **it converts exactly the accounts worth converting**, at exactly the point they become worth converting. A 30-student academy sees a small number and stays free, which costs almost nothing to serve. A 200-student academy sees a number that hurts.

The real product argument underneath: AutoPay mandates mean the tally collects itself, and reconciliation — the feature they use every month on Rail 1 — becomes unnecessary.

## 4. Open numbers

| Question | Status |
| --- | --- |
| Rail 2 take rate | Open. Constrained below by partner gateway fees, above by what feels reasonable against ~2% payment processing. |
| Cost to serve a free Rail 1 academy | Open, and the number that decides how generous free can be. Dominated by inference, not messaging (§5). |
| Whether free is unlimited or eventually bounded | Open. Prefer unlimited until the cost data says otherwise. |

## 5. Cost to serve

The counter-intuitive finding worth preserving: **LLM spend dominates messaging spend by roughly 20–50×.** Optimize inference, not conversation fees.

This is why the recipe layer (product vision §9.2) exists — it is a cost strategy wearing a UX strategy's clothes. Every intent promoted to a recipe or a minted tap is inference eliminated. At fleet scale the *client* side out-costs the admin side on sheer headcount, so booking, cancelling and reminders promote first.

The three levers, in order of power:

1. **Promotion to recipes and minted taps.** A tap costs nothing.
2. **Context discipline.** Route each turn to a slice of the schema and recipe set rather than carrying everything.
3. **Prompt-cache hit rate.** The single number the cost model hangs on. Uncached is roughly 3× cost.

**Cost instrumentation ships on day one** — tokens, cost, cache hits, rounds per turn, broken down by role and intent. Not because the numbers are interesting, but because the free tier's viability is an empirical question and this is the only way to answer it.

An honest corollary: a generic-agent product runs hot on day one, before promotion catches the head of the distribution. Early cost figures will look bad and that is expected — the instrumentation is what closes the gap, and the gap closing is a build task with a deadline, not a property the architecture provides for free.

## 6. Go-to-market

**Wedge: solo and small coaches.** Easiest to acquire, cheapest to serve, and free costs us nothing to give them. Many are in apartment-complex clubhouses across Bangalore's IT corridors — a single coach running batches at two or three gated communities, collecting by GPay, with no software at all.

**Target: multi-coach academies.** Coordination pain is severe enough to be worth real money, payment volume makes Rail 2 meaningful, and switching costs are high once staff and parents are onboarded. A solo coach who grows becomes this customer without migrating anything (product vision §8).

**Finding multi-coach academies in Bangalore.** The best single filter is the **operating-hours heuristic**: any academy running batches morning *and* evening, six days a week, mathematically has more than one coach. Apply it per micro-market (Whitefield, Sarjapur, HSR, Indiranagar, Jayanagar) across Google Maps listings, then cross-check against booking platforms (Playo, Hudle) and Instagram — multi-coach academies post team photos and tournament groups; solo coaches don't. State association affiliate lists (Karnataka Badminton Association, KSCA, the state table tennis association) correlate with size.

Highest yield per hour: **a district-level junior tournament.** Every academy sends a coach with their players. One Saturday, twenty academies, and you can see who arrived with a squad — conversations rather than a list.

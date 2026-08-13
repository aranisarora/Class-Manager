/**
 * check-billing-keys — do the two writers of a §6.4 money rule still agree?
 *
 * `tally_line` has no dedupe column, so the free-first-class credit and an opened
 * package are made idempotent by matching on `reason` and `description` — text
 * that is also shown verbatim to the parent. Two files write those rows, and they
 * disagreed:
 *
 *   money.ts      deduped on reason = 'free trial'
 *   operations.ts wrote      reason = 'free first class'
 *
 * Each guard was correct about its own rows and blind to the other's, so a trial
 * player who met both paths was credited twice. The same held for packages, with
 * two different description sentences, so `packageState` counted zero packs
 * opened by the operation path and opened another.
 *
 * They share `lib/billing-keys.ts` now. This asserts they still do — a literal
 * reintroduced in either file is the whole defect coming back, and it is exactly
 * the kind of thing that reads as harmless in a diff.
 *
 *   npx tsx scripts/check-billing-keys.mts
 */
import { readFileSync } from 'node:fs'
import { FREE_FIRST_CLASS_REASON, packageDescription } from '@/lib/billing-keys'

const FILES = ['lib/jobs/handlers/money.ts', 'lib/agent/operations.ts']

/** Reason/description literals that must never be spelled out in a writer again. */
const BANNED: [RegExp, string][] = [
  [/'free trial'/, "the old free-first-class reason — import FREE_FIRST_CLASS_REASON instead"],
  [/'free first class'/, 'a hard-coded reason — import FREE_FIRST_CLASS_REASON instead'],
  [/pack of \$\{|-class package —/, 'a hand-built package description — import packageDescription instead'],
]

let bad = 0
for (const f of FILES) {
  const src = readFileSync(f, 'utf8')
  for (const [re, why] of BANNED) {
    // The comment that explains the move mentions the old strings on purpose.
    const offending = src
      .split('\n')
      .filter((l) => re.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    if (offending.length) {
      bad += 1
      console.log(`REINTRODUCED in ${f}: ${why}`)
      for (const l of offending) console.log(`  ${l.trim().slice(0, 120)}`)
    }
  }
}

// And the shared builders still produce what the counters match on.
if (packageDescription('Beginners', 10) !== 'Beginners — pack of 10 classes') {
  bad += 1
  console.log(`packageDescription changed shape: ${packageDescription('Beginners', 10)}`)
}
if (FREE_FIRST_CLASS_REASON !== 'free first class') {
  bad += 1
  console.log(`FREE_FIRST_CLASS_REASON changed: ${FREE_FIRST_CLASS_REASON}`)
}

console.log(
  bad === 0
    ? `both money writers share one spelling of every §6.4 key (${FILES.length} files checked)`
    : `\n${bad} problem(s)`,
)
process.exit(bad === 0 ? 0 : 1)

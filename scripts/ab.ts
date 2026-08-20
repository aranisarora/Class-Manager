/**
 * ab — the same week twice, one thing changed, and no verdict about either.
 *
 *   npm run ab -- --variant doctrine=lib/doctrine.experimental.md
 *   npm run ab -- --variant ref=8f8224d
 *   npm run ab -- --variant ref=.claude/worktrees/recovery-ladder
 *   npm run ab -- --variant doctrine=… --days 2 --repeats 2
 *   npm run ab -- --variant doctrine=… --dry-run    # prepare, hash, print, spend nothing
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * A change to this product lands in one of three places: the PREFIX (doctrine),
 * a MECHANISM (code), or the SCHEMA. Nothing here could tell you whether one of
 * them helped. `sim` produces a run; two runs of it produce two records;
 * and the comparison between them rests entirely on the claim that everything
 * except the thing under test was held still. That claim was never written down
 * anywhere, and the parts of it that drift are the quiet ones: `MODEL_MAIN`
 * changed between Tuesday and Thursday, one arm was seeded by `stampSeed()` and
 * the other by a different `stampSeed()`, the working tree gained four commits in
 * between. **Two arms differing by an unnoticed flag look exactly like two arms
 * differing by the change under test.** That is the failure this file is against,
 * and the manifest — not the drive — is the half that prevents it.
 *
 * So this is a THIN WRAPPER and deliberately not a second mechanism. It resolves
 * ONE config (`_drive-config.ts`, the same parser and the same refusals), pins
 * the model and the seed into it so that neither is resolved twice, hands the
 * same file to both arms, and runs each arm as a whole `sim` child
 * process. Everything it knows how to do, `sim` was already doing.
 *
 * PROCESS ISOLATION IS FORCED, NOT PREFERRED
 * -----------------------------------------------------------------------------
 * `stablePrefix()` (lib/agent/context.ts:367) memoises into `cachedPrefix` (:136)
 * on first call and returns that same string for the life of the process. Two
 * different prefixes therefore cannot coexist in one node process — the second
 * arm would silently run the first arm's doctrine, produce a completely plausible
 * record, and the whole comparison would be of one thing against itself. A
 * separate process per arm is the only arrangement in which the question is
 * askable at all. The arms then run at once, which is safe now for three
 * specific reasons: each run directory carries its own token (`_capture.ts`),
 * each academy carries that token in its name and derives its phone numbers from
 * its own academy id, and `sim_clock` is per-academy. All three used to be false,
 * and all three broke concurrent drives silently.
 *
 * WHY NOT AN ENVIRONMENT VARIABLE
 * -----------------------------------------------------------------------------
 * Doctrine reaches the model through `readDoc('lib/doctrine.md')`
 * (lib/agent/context.ts:428), and `readDoc` (:66) resolves exactly two candidates
 * — `join(repoRoot(), relPath)` then `join(process.cwd(), relPath)` — and
 * consults the environment nowhere. A `DOCTRINE=…` variable would be a flag
 * nothing reads, which is the precise failure `_drive-config.ts` refuses one-dash
 * flags to prevent: the run then looks exactly like the run it was supposed to
 * be. The knob that does exist is the ROOT, because `repoRoot()` walks up from
 * `process.cwd()` and stops at the first directory holding a `package.json` or a
 * `.env.local` (lib/env.ts).
 *
 * So a prefix arm is a two-file directory — a `package.json` that stops that
 * walk, and the `lib/doctrine.md` beside it — and the child is run with its cwd
 * there. Nothing else moves: the script it runs, its `node_modules` and its
 * `tsconfig.json` are all still this checkout's, because the arm root sits inside
 * the repo and every one of those resolutions walks upward past it.
 *
 * BOTH arms get one of those roots, the control included. If arm A ran at the
 * repo root and arm B in an arm root, the arms would differ by their cwd as well
 * as by their doctrine — and "I checked, the cwd difference is harmless" is the
 * same reasoning that loses an A/B. With a root each, the only difference between
 * the two trees is the bytes of one file. It also freezes the control: another
 * session editing `lib/doctrine.md` halfway through the week cannot change what
 * arm A is reading, because arm A is reading a copy taken at second zero.
 *
 * NOTHING HERE SCORES ANYTHING
 * -----------------------------------------------------------------------------
 * It prints what each arm did in counts — turns, messages, jobs, rupees, who gave
 * up — side by side, and stops. There is no difference column: a difference
 * carries a sign, and the sign is the verdict. Whether the change is an
 * improvement is written afterwards by a person or a judge model into
 * `judgement.json`, beside each arm's record and never inside it
 * (`docs/JUDGING.md`).
 *
 * THE GOALS ARE HELD, THE WORDS DIVERGE, AND THAT IS CORRECT
 * -----------------------------------------------------------------------------
 * Both arms get the same personas, the same `SCHEDULE`, the same life events and
 * the same seed. They will not say the same sentences, and they must not: a
 * persona's utterance is CAUSED by the bot's previous reply — `_persona-agent.ts`
 * sees only what that phone shows. Replaying arm A's sentences into arm B would
 * produce a conversation that could never have happened, somebody answering a
 * question they were never asked, and it would measure the replay rather than the
 * change. What is held constant is what the people WANT; what varies is what they
 * say to get it, which is the thing under test.
 *
 * That is also why `--repeats N` exists, and why it defaults to 1. With the words
 * diverging, one run of each arm is one sample of a stochastic process. Repeats
 * are the cheapest honest answer to "was that difference the change or the day",
 * and the default is 1 on purpose: a week per arm is tens of minutes and tens of
 * rupees, so the second sample is bought when the first looks marginal, not
 * before.
 *
 * WHERE THE EVIDENCE LANDS
 * -----------------------------------------------------------------------------
 * `_capture.ts`'s `runDir()` is cwd-relative, so an arm driven from a root of its
 * own writes its run UNDER that root — inside this run's own directory, which is
 * where the parent's pointer file says it is. The cost is real and worth naming:
 * `npm run runs` lists `.probe/runs` at the repo root, so it will not show a
 * prefix arm's runs, nor a mechanism arm's, though it does still show the control
 * of a mechanism comparison, which is driven from the repo itself. `arms.json`
 * and the `report` line printed for each arm are the way back to them, and the
 * `ab.json` sidecar dropped into each arm's own run directory is the way back
 * from there to here.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { c, loadEnvFiles } from './_env'

/**
 * Every path below is derived from this file's own location rather than from
 * wherever the shell happened to be, and the process then stands there —
 * `runDir()` returns a cwd-relative path, and an A/B whose parent directory lands
 * in one place while its arms land in another is a comparison nobody can find the
 * halves of. `npm run` starts here anyway; this only makes it true.
 */
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.chdir(REPO)

loadEnvFiles()
/**
 * `.env.local` ships `TRANSPORT=cloud`, and a drive that takes the cloud path
 * hard-fails at the credential gate — every turn an error, zero tools, an empty
 * reply, which reads exactly like a broken model. `sim` forces the
 * emulator in its own body; this forces it one level earlier, so both arms are
 * already on the emulator before either of them reads anything.
 */
process.env.TRANSPORT = 'emulator'

const { describeConfig, resolveConfig } = await import('./_drive-config')
const { runDir, writeSidecar } = await import('./_capture')

type DriveConfig = import('./_drive-config').DriveConfig

/* ========================================================================== *
 * REFUSING
 * ========================================================================== */

/**
 * Say what is wrong and stop, in the shape `_drive-config.ts` refuses in — a
 * refusal from either file should read the same, because from the terminal they
 * are one command. Not a thrown Error: tsx prints a stack above the message, and
 * the one line that matters ends up under twelve frames of node internals.
 */
function fail(headline: string, ...detail: string[]): never {
  console.error()
  console.error(c.red(`x  ${headline}`))
  for (const d of detail) console.error(`   ${d}`)
  console.error()
  process.exit(2)
}

/** A run that is legal but probably not what was meant. Said out loud, not fixed. */
function warn(headline: string, ...detail: string[]): void {
  console.error(c.yellow(`!  ${headline}`))
  for (const d of detail) console.error(c.dim(`   ${d}`))
}

const USAGE = [
  'npm run ab -- --variant doctrine=lib/doctrine.experimental.md',
  'npm run ab -- --variant ref=<git sha, tag, branch, or an existing checkout>',
  'npm run ab -- --variant doctrine=… --days 2 --repeats 2 --dry-run',
  '',
  'Every other flag belongs to _drive-config.ts and is given to BOTH arms:',
  '--preset --days --windows --personas --concurrency --budget-min --budget-inr',
  '--seed --model --config --ramp --keep',
]

/* ========================================================================== *
 * WHAT WAS ASKED FOR
 * ========================================================================== */

type VariantKind = 'doctrine' | 'ref'
type Variant = { kind: VariantKind; value: string }

/**
 * Take this file's own flags out of argv and hand the rest over untouched.
 *
 * The handover is the whole arrangement: `_drive-config.ts` refuses an unknown
 * flag, a one-dash flag and an unknown preset, so `--dayz 5` and `-days 5` are
 * both stopped by the parser that owns those words rather than being quietly
 * dropped here. Anything this file does not recognise is not this file's to
 * judge — which is also why `--variant` and `--repeats` have to come out before
 * they reach it, or its refusal would be about them.
 */
function own(argv: string[]): { variant: string; repeats: number; dryRun: boolean; rest: string[] } {
  const rest: string[] = []
  let variant = ''
  let repeats = 1
  let sawRepeats = false
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const eq = token.indexOf('=')
    const name = token.startsWith('--') ? (eq === -1 ? token.slice(2) : token.slice(2, eq)) : ''
    const inline = eq === -1 ? null : token.slice(eq + 1)

    if (name === 'help') {
      console.log(`\n  ${USAGE.join('\n  ')}\n`)
      process.exit(0)
    }
    if (name === 'dry-run') {
      dryRun = true
      continue
    }
    if (name === 'variant' || name === 'repeats') {
      const value = inline ?? argv[++i]
      if (value === undefined || value.startsWith('--') || !value.trim()) fail(`--${name} needs a value`)
      if (name === 'repeats') {
        repeats = Number(value)
        sawRepeats = true
        continue
      }
      /**
       * Two variants is three arms and three weeks, and the comparison is
       * pairwise either way — so it is refused rather than the last one quietly
       * winning, which is how somebody ends up reading the wrong arm's record.
       */
      if (variant) {
        fail(
          'two --variant flags: this runs one control against one variant',
          `You named "${variant}", then "${value.trim()}".`,
          'Run the second comparison on its own, against the same --seed, and the two results are',
          'still commensurable — the control is the same control.',
        )
      }
      variant = value.trim()
      continue
    }
    rest.push(token)
  }

  if (sawRepeats && (!Number.isInteger(repeats) || repeats < 1)) {
    fail(`--repeats takes a whole number of runs per arm, at least 1 — not "${repeats}"`)
  }
  return { variant, repeats, dryRun, rest }
}

/**
 * `doctrine=…`, `ref=…`, and the two refusals.
 *
 * The schema refusal is the deliverable rather than a gap, so it says what the
 * person would have to do instead. The unknown-kind refusal names the three
 * places a change to this product can land, because somebody who typed
 * `--variant prompt=…` has a real experiment in mind and needs telling which of
 * the three it is.
 */
function readVariant(raw: string): Variant {
  const eq = raw.indexOf('=')
  const kind = (eq === -1 ? raw : raw.slice(0, eq)).trim().toLowerCase()
  const value = eq === -1 ? '' : raw.slice(eq + 1).trim()

  if (kind === 'schema' || kind === 'migration' || kind === 'sql') {
    fail(
      'a schema arm cannot run this way, and running it anyway would not measure it',
      'Both arms share one database. That is what makes them safe to run at once — each academy',
      'carries its own token, derives its own phone numbers, and has its own sim_clock row — and it',
      'is exactly what a migration cannot respect. `alter table` is not per-tenant, so the moment',
      'arm B applies one, arm A is running against arm B’s schema and both records describe the',
      'same world. Nothing would fail; the two records would simply be of one thing.',
      '',
      'What to do instead, strongest answer first:',
      '  1. Two databases. Point DATABASE_URL at a second project — a Supabase branch is one',
      '     command — apply the migration there, and drive each arm on its own with the SAME seed:',
      '       npm run sim -- --arm A --seed <s> --config <cfg>',
      '       DATABASE_URL=<branch> npm run sim -- --arm B --seed <s> --config <cfg>',
      '     They are then sequential, so the provider’s hour is inside the difference you read.',
      '  2. One database, migrated between the arms, same seed. Cheapest and weakest: everything',
      '     else that changed in those hours is inside that difference too.',
      'Either way both runs are the same record shape and `report.mjs` renders both.',
    )
  }
  if (kind !== 'doctrine' && kind !== 'ref') {
    fail(
      `--variant ${kind || raw}: a change to this product lands in one of three places`,
      'doctrine=<file>   the PREFIX. A different lib/doctrine.md, read by that arm and nothing else.',
      'ref=<sha|dir>     a MECHANISM. A git ref or an existing checkout, driven as its own tree.',
      'schema=…          REFUSED, and it says why — the arms share one database.',
      '',
      ...USAGE,
    )
  }
  if (!value) fail(`--variant ${kind}= needs a value`, ...USAGE)
  return { kind, value }
}

/* ========================================================================== *
 * THE ARMS
 * ========================================================================== */

type Arm = {
  name: 'A' | 'B'
  /** One line a reader can attribute the arm by. */
  what: string
  /** Where the child process stands. This is what decides which doctrine it reads. */
  cwd: string
  /** Where the code it runs lives. Different from `cwd` only for a prefix arm. */
  tree: string
  /** The `sim.ts` this arm is driven by — its own, for a ref arm. */
  script: string
  /** The file this arm's `stablePrefix()` will actually read. */
  doctrine: string
  doctrineSha: string
  git: { sha: string; branch: string; dirty: number }
  /** Measured by `probePrefix`, before anything is spent. */
  prefix: { sha: string; len: number }
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const short = (s: string): string => (s ? s.slice(0, 10) : '—')

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((done) =>
    execFile('git', args, { cwd, windowsHide: true }, (err, out) => done(err ? '' : String(out).trim())),
  )
}

async function gitFacts(cwd: string): Promise<Arm['git']> {
  return {
    sha: await git(['rev-parse', 'HEAD'], cwd),
    branch: await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    /**
     * Anything uncommitted at the moment of the run. A drive against a dirty tree
     * is not reproducible from the sha alone, and for a `ref` arm it is worse than
     * that — see `dirtyWarning`.
     */
    dirty: (await git(['status', '--porcelain'], cwd)).split('\n').filter((l) => l.trim()).length,
  }
}

/**
 * A root whose only job is to stop `repoRoot()`'s walk, and the doctrine beside it.
 *
 * The `package.json` is not a package and is never installed — it is the stop
 * sign, and it says so in its own body, so the next person to find one of these
 * directories does not have to come back here to learn what it is for.
 */
function makeArmRoot(dir: string, doctrine: string, arm: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `ab-arm-${arm.toLowerCase()}`,
        private: true,
        why:
          'Not a package, and never installed. lib/env.ts’s findRoot() stops at the first ancestor ' +
          'holding a package.json, and lib/agent/context.ts resolves lib/doctrine.md from there — ' +
          'so this file is the stop sign and the doctrine beside it is the arm. Delete the pair and ' +
          'a process standing here reads the repo’s own doctrine again.',
      },
      null,
      2,
    )}\n`,
  )
  copyFileSync(doctrine, join(dir, 'lib', 'doctrine.md'))
}

/** Bare-specifier resolution walks up for `node_modules`; a tree with none cannot run at all. */
function reachableNodeModules(from: string): boolean {
  let dir = from
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'node_modules'))) return true
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
  return false
}

/**
 * Build both arms, and prepare whatever each one needs to exist.
 *
 * A prefix comparison is two arm roots over one tree. A mechanism comparison is
 * two trees: this checkout as it stands, and the ref — as a directory somebody
 * already has, or as a detached worktree made here. The worktree goes INSIDE this
 * run's directory, which is not tidiness: it has to be inside the repo for
 * `node_modules` and `tsconfig.json` to resolve upward, and `.probe` is the one
 * place inside the repo that neither git nor `tsc` walks into.
 */
async function buildArms(variant: Variant, parent: string): Promise<Arm[]> {
  const repoDoctrine = join(REPO, 'lib', 'doctrine.md')
  if (!existsSync(repoDoctrine)) fail(`there is no ${repoDoctrine} to be the control`)
  const repoGit = await gitFacts(REPO)
  const driver = join(REPO, 'scripts', 'sim.ts')

  if (variant.kind === 'doctrine') {
    const file = resolve(REPO, variant.value)
    if (!existsSync(file)) {
      fail(
        `--variant doctrine=${variant.value}: no such file`,
        `Looked at ${file}.`,
        'The path is resolved against the repo root, which is where npm run puts you.',
      )
    }
    const rootA = join(parent, 'root-a')
    const rootB = join(parent, 'root-b')
    makeArmRoot(rootA, repoDoctrine, 'A')
    makeArmRoot(rootB, file, 'B')
    return [
      {
        name: 'A',
        what: 'lib/doctrine.md, as it stands',
        cwd: rootA,
        tree: REPO,
        script: driver,
        doctrine: join(rootA, 'lib', 'doctrine.md'),
        doctrineSha: sha256(readFileSync(repoDoctrine)),
        git: repoGit,
        prefix: { sha: '', len: 0 },
      },
      {
        name: 'B',
        what: variant.value,
        cwd: rootB,
        tree: REPO,
        script: driver,
        doctrine: join(rootB, 'lib', 'doctrine.md'),
        doctrineSha: sha256(readFileSync(file)),
        git: repoGit,
        prefix: { sha: '', len: 0 },
      },
    ]
  }

  /* ------------------------------------------------------------ a mechanism */

  const asPath = resolve(REPO, variant.value)
  let tree = ''
  if (existsSync(asPath) && existsSync(join(asPath, 'package.json'))) {
    tree = asPath
  } else {
    const sha = await git(['rev-parse', '--verify', `${variant.value}^{commit}`], REPO)
    if (!sha) {
      fail(
        `--variant ref=${variant.value}: neither a checkout nor a commit`,
        `There is no directory at ${asPath} holding a package.json, and git cannot resolve`,
        `"${variant.value}" to a commit in this repository.`,
        'Give a sha, a tag, a branch, or the path of a worktree you already have.',
      )
    }
    tree = join(parent, `tree-${sha.slice(0, 7)}`)
    const added = await git(['worktree', 'add', '--detach', tree, sha], REPO)
    if (!existsSync(join(tree, 'package.json'))) {
      fail(
        `could not put ${variant.value} (${sha.slice(0, 7)}) in a worktree at ${tree}`,
        added || 'git said nothing.',
        'Nothing in the main working tree was touched. `git worktree prune` clears a half-made one.',
      )
    }
    console.log(c.dim(`  worktree ${sha.slice(0, 7)} → ${tree}`))
  }

  if (!reachableNodeModules(tree)) {
    fail(
      `${tree} has no node_modules above it, so nothing there can start`,
      'A worktree made here sits inside the repo and borrows this checkout’s node_modules by',
      'walking up. A checkout somewhere else has to have its own — install it, or move it inside',
      'the repo, and run this again.',
    )
  }

  const treeDoctrine = join(tree, 'lib', 'doctrine.md')
  if (!existsSync(treeDoctrine)) fail(`${tree} has no lib/doctrine.md — it is not a checkout of this product`)

  return [
    {
      name: 'A',
      what: `this checkout — ${repoGit.branch} ${short(repoGit.sha)}`,
      cwd: REPO,
      tree: REPO,
      script: driver,
      doctrine: repoDoctrine,
      doctrineSha: sha256(readFileSync(repoDoctrine)),
      git: repoGit,
      prefix: { sha: '', len: 0 },
    },
    {
      name: 'B',
      what: `${variant.value} — ${tree.replace(REPO, '.')}`,
      cwd: tree,
      tree,
      script: join(tree, 'scripts', 'sim.ts'),
      doctrine: treeDoctrine,
      doctrineSha: sha256(readFileSync(treeDoctrine)),
      git: await gitFacts(tree),
      prefix: { sha: '', len: 0 },
    },
  ]
}

/* ========================================================================== *
 * PROVING THE ARM TOOK, BEFORE ANYTHING IS SPENT
 * ========================================================================== */

/**
 * Build this arm's stable prefix in this arm's own process, and hash it.
 *
 * This is the measurement the whole file turns on. The prefix is what the model
 * is actually given, so its hash is the only statement about an arm that cannot
 * be wrong about itself — a doctrine file that was never read, a `readDoc` path
 * that resolved somewhere else, a `cwd` that did not stop the walk where it was
 * meant to, all of them show up here as two identical hashes. Comparing the
 * doctrine FILES instead would not: `readDoc` trims what it reads, so two files
 * differing by a trailing newline produce one prefix, and an A/B on them would
 * run for an hour to compare a thing with itself.
 *
 * It doubles as the arm's smoke test, which is why it runs before a week is
 * bought rather than after. It imports the arm's own `context.ts` under the arm's
 * own cwd, so a tree that cannot resolve `@/lib`, a checkout with no
 * `node_modules` above it and an environment missing `DEEPSEEK_API_KEY` all fail
 * here, in about a second, instead of thirty minutes into a drive.
 *
 * No database is touched and no model is called: `stablePrefix()` is a pure
 * assembly of files and constants (`lib/db` builds a lazy pool at import and
 * connects to nothing).
 */
async function probePrefix(arm: Arm): Promise<void> {
  const ctx = pathToFileURL(join(arm.tree, 'lib', 'agent', 'context.ts')).href
  const src =
    `const m = await import(${JSON.stringify(ctx)});` +
    `const p = m.stablePrefix();` +
    `const { createHash } = await import('node:crypto');` +
    `process.stdout.write('AB-PREFIX ' + JSON.stringify({ len: p.length, sha: createHash('sha256').update(p).digest('hex') }));`

  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', src], {
      cwd: arm.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, stdout, stderr })
    })
  })

  const m = /AB-PREFIX (\{.*\})/.exec(out.stdout)
  if (!m) {
    fail(
      `arm ${arm.name} could not build a prefix, so there is nothing to compare`,
      `cwd ${arm.cwd}`,
      `tree ${arm.tree}`,
      ...(out.stderr || out.stdout || `exit ${out.code}`).split('\n').slice(0, 12),
    )
  }
  const parsed = JSON.parse(m[1]!) as { len: number; sha: string }
  arm.prefix = parsed
}

/**
 * The parts of one arm that a comparison rests on, written down.
 *
 * WITHOUT THIS AN A/B RESULT CANNOT BE ATTRIBUTED. Six months later the two run
 * directories are two weeks of conversation and nothing in either says which
 * doctrine it read, which sha it ran, or whether the model was the same one —
 * and every one of those has silently differed between two runs in this repo
 * before. No secret goes in: the database is named by host and path only,
 * because a manifest is a file people paste into issues.
 */
function manifest(arm: Arm, cfg: DriveConfig, variant: Variant, seed: string, parent: string, other: Arm) {
  let db = ''
  try {
    const u = new URL(process.env.DATABASE_URL ?? '')
    db = `${u.host}${u.pathname}`
  } catch {
    db = ''
  }
  return {
    ab: { parent, arm: arm.name, variant: { kind: variant.kind, value: variant.value }, against: other.name },
    what: arm.what,
    at: new Date().toISOString(),
    git: arm.git,
    /**
     * The two hashes that say the arm is the arm. The doctrine is what was put
     * there; the prefix is what the model will be handed, measured in this arm's
     * own process — the second is the one that cannot be wrong.
     */
    doctrine: { path: arm.doctrine, sha256: arm.doctrineSha, bytes: readFileSync(arm.doctrine).length },
    stablePrefix: { sha256: arm.prefix.sha, chars: arm.prefix.len },
    /**
     * The seats run on the model under test as well, so an A/B on `--model`
     * changes both the brain and the people talking to it. That is readable here
     * rather than discovered in the judgement.
     */
    models: { brain: cfg.model, seat: cfg.model, thinkingPin: process.env.PROBE_THINKING ?? null },
    seed,
    config: { ...cfg, seed, arm: arm.name },
    env: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      transport: process.env.TRANSPORT ?? null,
      database: db,
    },
    paths: { cwd: arm.cwd, tree: arm.tree, script: arm.script },
  }
}

/* ========================================================================== *
 * WHAT THE TWO ARMS DIFFER BY, SAID OUT LOUD
 * ========================================================================== */

/** The instrument modules both arms are measured with, when the arms are two trees. */
const INSTRUMENT = [
  'sim.ts',
  '_drive-config.ts',
  '_capture.ts',
  '_derive.ts',
  '_seat.ts',
  '_seat-worker.ts',
  '_persona-agent.ts',
  '_personas.ts',
  '_ramp.ts',
]

/**
 * Everything that differs between the arms other than the thing under test.
 *
 * Each of these is legal and each of them has cost somebody a comparison, so they
 * are said out loud and the run continues. The alternative — refusing — would
 * refuse the commonest experiment in this repo, which is "does my uncommitted
 * work beat HEAD", and that one is dirty by construction.
 */
function differences(arms: Arm[], variant: Variant): void {
  const [a, b] = arms as [Arm, Arm]

  if (variant.kind === 'ref' && a.git.dirty) {
    warn(
      `this checkout has ${a.git.dirty} uncommitted file(s), and arm B does not`,
      'The arms then differ by the ref AND by everything you have not committed. If the',
      'uncommitted work IS the change under test, that is the experiment and this is only saying',
      'so. If it is not, commit or stash it and run this again — the difference you read',
      'afterwards cannot be split between the two.',
    )
  }

  if (a.tree !== b.tree) {
    const drift = INSTRUMENT.filter((f) => {
      const fa = join(a.tree, 'scripts', f)
      const fb = join(b.tree, 'scripts', f)
      if (!existsSync(fa) || !existsSync(fb)) return true
      return sha256(readFileSync(fa)) !== sha256(readFileSync(fb))
    })
    if (drift.length) {
      warn(
        `the instrument itself differs between the arms: ${drift.join(', ')}`,
        'Each arm is driven by its own tree, because a ref is a whole product and mixing this',
        'checkout’s harness with that ref’s lib/ is a third thing that is neither arm. The',
        'consequence is that the two records were not made the same way — read the difference in',
        'the counts below knowing the counter changed too.',
      )
    }
    /**
     * The dependency blocks, not the file. A `package.json` that differs by a
     * script name is not a different install, and a warning that cries wolf on
     * every commit is one nobody reads by the third time.
     */
    const deps = (tree: string): string => {
      try {
        const p = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as Record<string, unknown>
        return JSON.stringify([p.dependencies ?? {}, p.devDependencies ?? {}])
      } catch {
        return tree
      }
    }
    if (deps(a.tree) !== deps(b.tree)) {
      warn(
        'the two trees declare different dependencies, and both run on this checkout’s node_modules',
        'A worktree borrows node_modules by walking up; nothing installs the ref’s own. If the ref',
        'moved a dependency, arm B is not the ref.',
      )
    }
  }

  if (a.prefix.sha === b.prefix.sha) {
    if (variant.kind === 'doctrine') {
      fail(
        'both arms build a byte-identical prefix, so there is nothing under test',
        `Both hash to ${short(a.prefix.sha)} over ${a.prefix.len} characters.`,
        a.doctrineSha === b.doctrineSha
          ? 'The two doctrine files are the same bytes.'
          : 'The two doctrine files differ, but only in what readDoc() trims away — leading or ' +
            'trailing whitespace. The model would be handed the same string either way.',
        'Refused here rather than after two weeks of drive, because the report would look exactly',
        'like a real comparison that found no difference.',
      )
    }
    console.log(
      c.dim(
        '  the prefix is byte-identical across the arms — the change under test is not in the prompt',
      ),
    )
  }
}

/* ========================================================================== *
 * DRIVING
 * ========================================================================== */

type ArmRun = {
  arm: 'A' | 'B'
  repeat: number
  seed: string
  /** The run directory the child wrote, absolute, or null if it produced none. */
  record: string | null
  exit: number
  /** Where this arm-run's manifest and console log went. */
  dir: string
}

/**
 * One arm, one repeat: a whole `sim`, driven the way a person drives it.
 *
 * The child is given `--config <the one resolved config>` and `--seed`, so the
 * two arms cannot resolve a preset, a model or a seed separately — `_drive-config`
 * lets a flag beat a file, which is exactly the ordering wanted here. Its output
 * is streamed through with the arm's name on every line, because two weeks
 * running at once into one terminal is otherwise unreadable, and kept whole in
 * `run.log` beside the manifest.
 */
function drive(arm: Arm, repeat: number, seed: string, cfgPath: string, dir: string): Promise<ArmRun> {
  mkdirSync(dir, { recursive: true })
  const args = ['--import', 'tsx', arm.script, '--config', cfgPath, '--arm', arm.name, '--seed', seed]
  const tag = arm.name === 'A' ? c.cyan('A│') : c.yellow('B│')

  return new Promise<ArmRun>((done) => {
    const child = spawn(process.execPath, args, {
      cwd: arm.cwd,
      env: { ...process.env, TRANSPORT: 'emulator' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let whole = ''
    let pending = ''
    const onData = (d: Buffer): void => {
      const text = d.toString()
      whole += text
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) console.log(`${tag} ${line}`)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('close', (code) => {
      if (pending.trim()) console.log(`${tag} ${pending}`)
      writeFileSync(join(dir, 'run.log'), whole)
      done({
        arm: arm.name,
        repeat,
        seed,
        record: findRecord(arm, seed, whole),
        exit: code ?? -1,
        dir,
      })
    })
  })
}

/**
 * Where the child put its run.
 *
 * Asked of the filesystem first and of the terminal second. `sim` writes a
 * `config.json` sidecar holding the config it actually used, and `(arm, seed)` is
 * unique across everything this comparison starts — so the sidecar identifies the
 * directory structurally, without depending on a printed line staying printed. The
 * `record   <dir>` line is the fallback, for a ref arm old enough to predate the
 * sidecar.
 */
function findRecord(arm: Arm, seed: string, output: string): string | null {
  const runs = join(arm.cwd, '.probe', 'runs')
  if (existsSync(runs)) {
    for (const name of readdirSync(runs).sort().reverse()) {
      const dir = join(runs, name)
      const sidecar = join(dir, 'config.json')
      if (!existsSync(sidecar)) continue
      try {
        const cfg = JSON.parse(readFileSync(sidecar, 'utf8')) as { arm?: string; seed?: string }
        if (cfg.arm === arm.name && cfg.seed === seed) return dir
      } catch {
        continue
      }
    }
  }
  const printed = /^\s*record\s+(\S.*?)\s*$/m.exec(output)
  if (printed) {
    const dir = resolve(arm.cwd, printed[1]!)
    if (existsSync(dir)) return dir
  }
  return null
}

/* ========================================================================== *
 * WHAT EACH ARM DID
 * ========================================================================== */

type Counts = Record<string, string>

/**
 * Counts, and the two or three names a reader needs to find the rest.
 *
 * Every field here is a number the run already contains or a name it already
 * carries. Nothing is combined into a score, nothing is compared, and there is no
 * difference column — a difference carries a sign, and the sign is the verdict.
 * `stoppedBy` is the same kind of fact: it names WHICH ceiling ended the run, not
 * whether ending there was good.
 */
function countsOf(dir: string | null): Counts {
  if (!dir || !existsSync(join(dir, 'record.json'))) return { record: 'none — this arm produced no record' }
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as {
    turns?: { persona?: string; messages?: unknown[]; jobs?: unknown[]; inr?: number | null; error?: string | null }[]
    world?: Record<string, unknown>
    extra?: Record<string, any>
  }
  const turns = rec.turns ?? []
  const seat = turns.filter((t) => t.persona !== 'queue')
  const sum = (f: (t: (typeof turns)[number]) => number): number => turns.reduce((a, t) => a + f(t), 0)
  const run = (rec.extra?.run ?? {}) as { productInr?: number; seatInr?: number; elapsedMin?: number; stoppedBy?: string | null }
  const departures = (rec.extra?.departures ?? []) as { persona: string; day: number; window: string }[]
  const product = typeof run.productInr === 'number' ? run.productInr : sum((t) => t.inr ?? 0)
  const seats = typeof run.seatInr === 'number' ? run.seatInr : 0

  return {
    turns: String(turns.length),
    'from a seat': String(seat.length),
    'from the queue': String(turns.length - seat.length),
    messages: String(sum((t) => t.messages?.length ?? 0)),
    jobs: String(sum((t) => t.jobs?.length ?? 0)),
    'turns with an error': String(turns.filter((t) => t.error).length),
    'rupees (product)': `₹${product.toFixed(2)}`,
    'rupees (seats)': `₹${seats.toFixed(2)}`,
    'wall minutes': typeof run.elapsedMin === 'number' ? run.elapsedMin.toFixed(0) : '—',
    'stopped by': run.stoppedBy ? String(run.stoppedBy) : 'nothing — it finished',
    'gave up': departures.length
      ? departures.map((d) => `${d.persona} d${d.day} ${d.window}`).join(', ')
      : 'nobody',
  }
}

function table(rows: [string, Counts, Counts]): void {
  const [heading, a, b] = rows
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  const w = Math.max(...keys.map((k) => k.length)) + 2
  console.log(c.bold(`\n  ${heading}`))
  console.log(`  ${''.padEnd(w)}${c.cyan('A'.padEnd(34))}${c.yellow('B')}`)
  for (const k of keys) {
    console.log(`  ${c.dim(k.padEnd(w))}${(a[k] ?? '—').padEnd(34)}${b[k] ?? '—'}`)
  }
}

/* ========================================================================== *
 * THE COMPARISON
 * ========================================================================== */

async function main(): Promise<void> {
  const { variant: variantRaw, repeats, dryRun, rest } = own(process.argv.slice(2))
  if (!variantRaw) {
    fail('nothing to compare: --variant is what this runs', ...USAGE)
  }
  /**
   * `--arm` is what this file decides, and a value given here would be silently
   * overwritten twice — the record would then say `arm: "A"` for a run somebody
   * named something else, which is the one field an A/B is read by.
   */
  if (rest.some((t) => t === '--arm' || t.startsWith('--arm='))) {
    fail('--arm belongs to this runner: the arms are A and B', 'Name the comparison with --variant instead.')
  }

  const variant = readVariant(variantRaw)
  /**
   * One config, resolved ONCE, by the file that owns the flags. `--model` and
   * `--seed` are left resolved rather than defaulted per child: `MODEL_MAIN` is
   * read here and written into the file, and the seed is stamped here, so neither
   * arm can quietly get a different one. That is two of the four silent drifts in
   * the header closed by one call.
   */
  const cfg = resolveConfig(rest)

  const parent = resolve(REPO, await runDir('ab'))
  const arms = await buildArms(variant, parent)

  console.log(c.bold(`\n  ab — ${variant.kind} · ${describeConfig(cfg)}`))
  console.log(c.dim(`  ${repeats} run(s) per arm, the arms at once, the repeats one pair after another\n`))

  for (const arm of arms) await probePrefix(arm)
  differences(arms, variant)

  const [a, b] = arms as [Arm, Arm]
  console.log(`  ${c.cyan('arm A')}  ${a.what}`)
  console.log(`  ${c.dim('       ')}  prefix ${short(a.prefix.sha)} · ${a.prefix.len} chars · doctrine ${short(a.doctrineSha)}`)
  console.log(`  ${c.yellow('arm B')}  ${b.what}`)
  console.log(`  ${c.dim('       ')}  prefix ${short(b.prefix.sha)} · ${b.prefix.len} chars · doctrine ${short(b.doctrineSha)}`)
  console.log(`  ${c.dim('parent')}  ${parent}`)

  /**
   * The bill, as two measured anchors rather than as arithmetic on them. A
   * seven-day persona-agent week has been projected at 26–30 minutes and ₹21–42
   * off-peak, double at peak; the one-day smoke run was six turns and ₹1.28 in 4
   * minutes, against the grown world. Neither is scaled to this run's day count
   * here, because a per-day rate is a number nobody measured — the days are not
   * alike, the ramp makes them deliberately unalike, and a made-up estimate
   * printed in the same dim grey as a measured one reads as measured.
   *
   * Running the arms at once removes the second drive's WAIT, not its rupees.
   */
  console.log(
    c.dim(
      `\n  ${repeats * 2} drive(s): 2 arms × ${repeats} repeat(s), ${cfg.days} day(s) each. Two measured anchors — a 7-day\n` +
        `  persona-agent week is projected at 26–30 min and ₹21–42 off-peak, double at peak; the 1-day\n` +
        `  smoke run was 6 turns and ₹1.28 in 4 min. The arms run at once, so the wall clock is one\n` +
        `  drive per repeat and the rupees are both. --budget-min and --budget-inr are honoured inside\n` +
        `  each arm, between windows, where stopping is safe.`,
    ),
  )

  const cfgPath = join(parent, 'config.json')
  await writeSidecar(parent, 'config.json', cfg)

  /**
   * The pointer file, written BEFORE anything is driven and again after.
   *
   * The arms' run directories are the evidence and they live where they were
   * driven from; this is the one file that knows all of them. Written up front
   * because the expensive loss is not a failed arm — a failed arm is in `runs`
   * below, which is a fact about this harness and belongs there — it is this
   * process dying halfway and taking the only record of what the two arms WERE
   * with it. Written again at the end because that is when the runs are known.
   */
  const writeArms = (runs: ArmRun[]): Promise<string> =>
    writeSidecar(parent, 'arms.json', {
      at: new Date().toISOString(),
      variant: { kind: variant.kind, value: variant.value },
      config: cfg,
      repeats,
      arms: arms.map((arm) => ({
        arm: arm.name,
        what: arm.what,
        cwd: arm.cwd,
        tree: arm.tree,
        git: arm.git,
        doctrine: { path: arm.doctrine, sha256: arm.doctrineSha },
        stablePrefix: arm.prefix,
      })),
      runs,
      note:
        'Counts are in each record. The verdict is in neither — write it into judgement.json ' +
        'beside the arm it is about (docs/JUDGING.md).',
    })
  await writeArms([])

  if (dryRun) {
    for (const arm of arms) {
      await writeSidecar(join(parent, `${arm.name.toLowerCase()}-dry`), 'manifest.json', manifest(arm, cfg, variant, cfg.seed, parent, arm === a ? b : a))
    }
    console.log(c.bold('\n  --dry-run: both arms are prepared and hashed, and nothing was driven.\n'))
    console.log(c.dim(`  ${parent}\n`))
    process.exit(0)
  }

  /**
   * The arms run together and the repeats run apart, which is the only pairing
   * that holds the hour still. Two weeks in the same hour share whatever the
   * provider is doing that hour — latency, load, a rate limit — so it lands on
   * both arms or on neither. Running all 2N at once would instead have the arms
   * competing with each other for one database and one API key, and the
   * congestion would be inside the numbers.
   */
  const results: ArmRun[] = []
  for (let repeat = 1; repeat <= repeats; repeat++) {
    /**
     * One seed per repeat, shared by both arms of it. Sharing is the point — the
     * personas start from the same disposition on both sides, so the words that
     * diverge diverged because the replies differed. A lone run keeps the resolved
     * seed unsuffixed, so the printed seed is the seed: `--seed <that>` repeats it,
     * and `--seed <that>-r2` repeats exactly the second repeat of a longer one.
     */
    const seed = repeats === 1 ? cfg.seed : `${cfg.seed}-r${repeat}`
    console.log(c.bold(`\n  repeat ${repeat}/${repeats} — seed ${seed}\n`))

    for (const arm of arms) {
      const dir = join(parent, `${arm.name.toLowerCase()}-${repeat}`)
      mkdirSync(dir, { recursive: true })
      await writeSidecar(dir, 'manifest.json', manifest(arm, cfg, variant, seed, parent, arm === a ? b : a))
    }

    const pair = await Promise.all(
      arms.map((arm) => drive(arm, repeat, seed, cfgPath, join(parent, `${arm.name.toLowerCase()}-${repeat}`))),
    )
    results.push(...pair)

    /**
     * The way back from a run to the comparison it belonged to. A sidecar, beside
     * the record and never inside it: somebody who opens one of these weeks cold
     * in six months sees `arm: "A"` in the record and nothing that says A of what.
     */
    for (const r of pair) {
      if (!r.record) continue
      const other = pair.find((p) => p.arm !== r.arm)
      await writeSidecar(r.record, 'ab.json', {
        parent,
        arm: r.arm,
        repeat: r.repeat,
        variant: { kind: variant.kind, value: variant.value },
        manifest: join(r.dir, 'manifest.json'),
        against: other?.record ?? null,
        note: 'This run is one arm of a comparison. The verdict is not here and is not in the other arm.',
      })
    }

    const first = pair.find((p) => p.arm === 'A')
    const second = pair.find((p) => p.arm === 'B')
    table([`repeat ${repeat} — seed ${seed}`, countsOf(first?.record ?? null), countsOf(second?.record ?? null)])
  }

  await writeArms(results)

  console.log('')
  for (const r of results) {
    console.log(
      r.record
        ? c.dim(`  ${r.arm}${r.repeat}  node scripts/report.mjs --run ${r.record}`)
        : c.red(`  ${r.arm}${r.repeat}  no record — the child exited ${r.exit}; see ${join(r.dir, 'run.log')}`),
    )
  }
  console.log(c.dim(`  arms  ${join(parent, 'arms.json')}`))
  /**
   * A worktree made here is left where it is, on purpose: arm B's whole run is
   * inside it, so removing it removes the evidence this comparison was for. The
   * command is printed rather than run, for whoever comes back after the reading
   * is written and the record has been archived.
   */
  if (b.tree.startsWith(parent)) {
    console.log(c.dim(`  worktree  git worktree remove --force ${b.tree}   (arm B’s record is inside it)`))
  }
  console.log(
    c.bold('\n  Two records, no verdict. Which arm is better is written by a person or a judge model'),
  )
  console.log(c.bold('  into judgement.json beside each record — docs/JUDGING.md.\n'))

  const lost = results.filter((r) => !r.record)
  process.exit(lost.length ? 1 : 0)
}

await main()

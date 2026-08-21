import Link from 'next/link'
import type { ReactNode } from 'react'
import type { SessionCtx } from '@/lib/db'
import { Badge, type BadgeTone } from '@/components/ui/Badge'

// Status is read on every request — a cached front door would lie.
export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Live status. Every probe is independently guarded: this page's whole job is
// to be readable when something underneath is broken, so a missing module, an
// unmigrated database or a dead pool each degrade to a dash and a reason.
// ---------------------------------------------------------------------------

type Db = typeof import('@/lib/db')

type Counts = { academies: number; contacts: number; scope: string }

type Status = {
  db: { tone: BadgeTone; word: string; detail: string }
  counts: Counts | null
  pendingJobs: number | null
  clock: string | null
  model: string
  synth: string
  transport: string
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/\s+/g, ' ').trim().slice(0, 200)
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

const COUNT_SQL =
  'select (select count(*)::int from academy) as academies, (select count(*)::int from contact) as contacts'

/** The one sanctioned cross-tenant read: `app.list_academies()`, cm_service only. */
const WORLD_SQL =
  'select count(*)::int as academies, coalesce(sum(contact_count), 0)::int as contacts from app.list_academies()'

/** No tenant of its own — the door above is security definer and ignores the GUC. */
const SERVICE: SessionCtx = { role: 'service', academyId: '' }

/** Every tenant at once. Only answers if the connecting role may read across them. */
async function globalCounts(db: Db): Promise<Counts | null> {
  try {
    const r = await db.withSession(SERVICE, async (tx) => (await db.unsafeQuery(tx, WORLD_SQL))[0])
    return r ? { academies: num(r.academies), contacts: num(r.contacts), scope: 'all tenants' } : null
  } catch {
    return null
  }
}


/** `job` is infrastructure: global for the service role, so any session reads it. */
async function pendingJobs(db: Db): Promise<number | null> {
  const query = "select count(*)::int as n from job where status = 'pending'"
  try {
    return await db.withSession(SERVICE, async (tx) => num((await db.unsafeQuery(tx, query))[0]?.n))
  } catch {
    return null
  }
}

async function readEnv(): Promise<Pick<Status, 'model' | 'synth' | 'transport'> & { host: string }> {
  // `env`'s keys are getters that validate on first read, so they are pulled
  // eagerly inside the guard — a bad environment must not 500 the status page.
  let e: Record<string, string | undefined> = process.env
  try {
    const { env } = await import('@/lib/env')
    e = {
      DATABASE_URL: env.DATABASE_URL,
      MODEL_MAIN: env.MODEL_MAIN,
      MODEL_SYNTH: env.MODEL_SYNTH,
      TRANSPORT: env.TRANSPORT,
    }
  } catch {
    /* fall back to the raw environment */
  }

  let transport = e.TRANSPORT ?? 'unknown'
  try {
    const { getTransport } = await import('@/lib/messaging/transport')
    transport = getTransport().name
  } catch {
    /* the configured value is the honest answer when the module will not load */
  }

  let host = ''
  try {
    host = new URL(e.DATABASE_URL ?? '').host
  } catch {
    /* no url, no host */
  }

  return { model: e.MODEL_MAIN ?? 'unset', synth: e.MODEL_SYNTH ?? 'unset', transport, host }
}

async function readStatus(): Promise<Status> {
  const { model, synth, transport, host } = await readEnv()

  const db = await import('@/lib/db').catch(() => null)
  if (!db) {
    return {
      db: { tone: 'bad', word: 'no db module', detail: 'lib/db.ts did not load' },
      counts: null,
      pendingJobs: null,
      clock: null,
      model,
      synth,
      transport,
    }
  }

  let reachable = true
  let reason = ''
  try {
    await db.withSession(SERVICE, (tx) => db.unsafeQuery(tx, 'select 1'))
  } catch (e) {
    reachable = false
    reason = errText(e)
  }

  const counts = reachable ? await globalCounts(db) : null
  const jobs = reachable ? await pendingJobs(db) : null

  let clock: string | null = null
  if (reachable) {
    try {
      const { now, inZone } = await import('@/lib/clock')
      const d = await now()
      try {
        clock = inZone(d, 'Asia/Kolkata').label
      } catch {
        clock = d.toISOString()
      }
    } catch {
      /* no clock row yet */
    }
  }

  const state: Status['db'] = !reachable
    ? { tone: 'bad', word: 'unreachable', detail: reason }
    : counts === null
      ? {
          tone: 'warn',
          word: 'no schema',
          detail: `connected to ${host || 'the database'}, but the tables are not readable — run npm run db:push`,
        }
      : {
          tone: 'good',
          word: 'connected',
          detail: `${host || 'database'} · counted across ${counts.scope}`,
        }

  return { db: state, counts, pendingJobs: jobs, clock, model, synth, transport }
}

// ---------------------------------------------------------------------------

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-IN'))

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="mt-1.5 truncate text-lg tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 truncate text-[0.6875rem] text-faint">{note}</div>
    </div>
  )
}

function Door({
  href,
  kicker,
  title,
  children,
}: {
  href: string
  kicker: string
  title: string
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-panel border border-line bg-surface p-5 transition-colors hover:border-accent"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent">
          {kicker}
        </span>
        <span className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent">
          →
        </span>
      </div>
      <h3 className="mt-3 text-base leading-snug text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-dim">{children}</p>
      <code className="mt-4 font-mono text-[0.6875rem] text-faint">{href}</code>
    </Link>
  )
}

export default async function Home() {
  const s = await readStatus()

  return (
    <main className="min-h-dvh">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-6 py-16 sm:py-20">
        <header>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-dim">
              Class Manager
            </span>
            <Badge tone={s.db.tone} dot>
              {s.db.word}
            </Badge>
          </div>
          <h1 className="mt-6 text-2xl font-medium tracking-tight text-ink">
            A manager that lives in WhatsApp.
          </h1>
          <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-dim">
            Class Manager runs an Indian coaching business inside a chat thread: clients book,
            cancel and pay, coaches get their day and mark attendance with taps, and admins ask for
            anything in plain language. Nobody installs anything and nobody logs in — so this page
            is a developer door, and the emulator behind it is where the product is actually
            exercised.
          </p>
        </header>

        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-faint">
              Status
            </h2>
            <span className="font-mono text-[0.6875rem] text-faint">read live, this request</span>
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3">
            <Tile
              label="Academies"
              value={fmt(s.counts?.academies ?? null)}
              note={s.counts ? `${s.counts.scope} on one number` : 'not readable'}
            />
            <Tile
              label="Contacts"
              value={fmt(s.counts?.contacts ?? null)}
              note="WhatsApp numbers known"
            />
            <Tile label="Pending jobs" value={fmt(s.pendingJobs)} note="due on the next tick" />
            <Tile label="Model" value={s.model} note={`synthesis on ${s.synth}`} />
            <Tile label="Transport" value={s.transport} note="the only path to the wire" />
            <Tile label="Clock" value={s.clock ?? '—'} note="Asia/Kolkata, drivable" />
          </div>
          <p
            className={
              s.db.tone === 'good'
                ? 'mt-3 font-mono text-[0.6875rem] text-faint'
                : s.db.tone === 'warn'
                  ? 'mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[0.6875rem] text-warn'
                  : 'mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 font-mono text-[0.6875rem] text-bad'
            }
          >
            {s.db.detail}
          </p>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Door href="/emulator" kicker="Emulator" title="A world, a shared clock, as many panes as fit">
            Open any contact as a pane and watch them talk to each other. Advance the clock to fire
            the scheduled ladder, inject failures, and read every send in the event log with its
            template-vs-in-window state, cost and sender number.
          </Door>
        </section>

        <footer className="border-t border-line-soft pt-5">
          <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[0.6875rem] text-faint">
            <span>
              <span className="text-dim">npm run db:push</span> apply migrations
            </span>
            <span>
              <span className="text-dim">npm run seed</span> build a world
            </span>
            <span>
              <span className="text-dim">npm run sim</span> persona run and judge report
            </span>
          </div>
        </footer>
      </div>
    </main>
  )
}

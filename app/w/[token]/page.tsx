/**
 * app/w/[token]/page.tsx — the whole web surface (§15).
 *
 * "Access: a signed link behind a labeled button, carrying a short-TTL JWT with
 *  academy_id and person_id claims that Postgres policies read. The magic link
 *  is the session. No login, no navigation — the chat is the navigation."
 *
 * One route, four purposes:
 *   setup     §7.1 step 1 — the form-shaped part of onboarding, one screen, once
 *   register  §8.2 step 5 — the roster, one screen, one submit
 *   calendar  §15         — the schedule, the one genuinely spatial answer
 *   view/form §15         — a stored `view_spec`, resolved under this person's RLS
 *
 * An expired or forged token renders a plain page, never an exception.
 */

import type { SessionCtx } from '@/lib/db'
import { withSession } from '@/lib/db'
import { inZone } from '@/lib/clock'
import { verifyLink } from '@/lib/web/jwt'
import type { LinkClaims } from '@/lib/web/jwt'
import { resolveView, loadViewSpec } from '@/lib/web/views'
import type { ResolvedComponent } from '@/lib/web/views'
import { Card, Expired, MUTED, Shell } from '@/components/view/chrome'
import { RenderComponent } from '@/components/view/render'
import { CalendarView } from '@/components/view/calendar'
import { RegisterForm } from '@/components/view/register-form'
import type { RegisterPlayer } from '@/components/view/register-form'
import { SetupForm } from '@/components/view/setup-form'
import type { SetupValues, SetupVenue } from '@/components/view/setup-form'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type AcademyRow = {
  id: string
  name: string
  category: string | null
  timezone: string
  cancellation_window_hours: number
  morning_brief_at: string
  evening_digest_at: string
  upi_handle: string | null
  onboarding_state: string
  settings: Record<string, unknown> | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function LinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await params
  const claims = await verifyLink(token)
  if (!claims) return <Expired />

  const ctx: SessionCtx = {
    role: 'user',
    academyId: claims.academy_id,
    personId: claims.person_id,
    contactId: claims.contact_id,
  }

  const academy = await loadAcademy(ctx)
  if (!academy) return <Expired />

  const sp = await searchParams
  const rawPage = Array.isArray(sp.p) ? sp.p[0] : sp.p
  const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1)

  switch (claims.purpose) {
    case 'setup':
      return <SetupScreen ctx={ctx} academy={academy} token={token} />
    case 'register':
      return <RegisterScreen ctx={ctx} academy={academy} claims={claims} token={token} />
    case 'calendar':
      return <CalendarScreen ctx={ctx} academy={academy} token={token} />
    default:
      return <ViewScreen ctx={ctx} academy={academy} claims={claims} token={token} page={page} />
  }
}

/**
 * The schedule, as a screen rather than as something the model has to invent (§15).
 *
 * **Why this is built in.** A calendar was reachable only inside a model-authored
 * `view_spec`, and across 93 driven turns the model minted **one** view of any kind —
 * so the most obviously spatial thing in the product, the one thing a phone genuinely
 * cannot show well in a chat bubble, was in practice unreachable. §15 says the admin's
 * ceiling should be highest and that dense or spatial answers belong here; a week is
 * the canonical example, and it should not depend on the model choosing to compose one.
 *
 * The query is **not** authored here in the sense that matters: RLS decides what it
 * returns. The same statement gives an admin the whole business's week, a coach only
 * the sessions they are assigned to, and a parent only their own children's — which is
 * §6.7 doing the work instead of three branches doing it badly.
 */
async function CalendarScreen({
  ctx,
  academy,
  token,
}: {
  ctx: SessionCtx
  academy: AcademyRow
  token: string
}) {
  const rows = await withSession(ctx, async (tx) => {
    return await tx<Record<string, unknown>[]>`
      select s.id,
             s.starts_at,
             s.ends_at,
             c.name as class_name,
             coalesce(v.name, '') as venue_name,
             case
               when s.status <> 'scheduled' then s.status
               when exists (select 1 from session_coach sc
                             where sc.session_id = s.id and sc.declined_at is null
                               and (sc.confirmed_at is not null or sc.arrived_at is not null))
                 then 'covered'
               else 'uncovered'
             end as status
        from session s
        join class c on c.id = s.class_id
        left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
       where s.starts_at >= app.now() - interval '1 day'
         and s.starts_at <  app.now() + interval '21 days'
       order by s.starts_at
       limit 200`
  }).catch(() => null)

  if (!rows) {
    return (
      <Unavailable
        business={academy.name}
        title="I couldn't load the schedule"
        body="Ask me in the chat and I'll tell you what's on — that always works."
      />
    )
  }

  const resolved: ResolvedComponent = {
    spec: { type: 'calendar', query: '', title: 'The next three weeks' },
    rows,
    columns: rows.length ? Object.keys(rows[0]) : ['starts_at', 'class_name', 'venue_name', 'status'],
    page: 1,
    pageSize: rows.length || 1,
    hasMore: false,
    ms: 0,
  }

  return (
    <Shell
      business={academy.name}
      title="The schedule"
      subtitle={rows.length ? 'Everything on, for the next three weeks.' : null}
      offer="Ask me anything about this in the chat — “what's on Saturday”, “move Tuesday to 7”, and I'll do it there."
    >
      {rows.length ? (
        <CalendarView c={resolved} tz={academy.timezone} token={token} />
      ) : (
        <Card>
          <p className={`text-sm ${MUTED}`}>Nothing scheduled in the next three weeks.</p>
        </Card>
      )}
    </Shell>
  )
}

async function loadAcademy(ctx: SessionCtx): Promise<AcademyRow | null> {
  try {
    return await withSession(ctx, async (tx) => {
      const rows = await tx<AcademyRow[]>`
        select id, name, category, timezone, cancellation_window_hours,
               morning_brief_at::text as morning_brief_at,
               evening_digest_at::text as evening_digest_at,
               upi_handle, onboarding_state, settings
          from academy
         where id = ${ctx.academyId}
         limit 1`
      return rows[0] ?? null
    })
  } catch {
    return null
  }
}

function Unavailable({ business, title, body }: { business: string; title: string; body: string }) {
  return (
    <Shell business={business} title={title}>
      <Card>
        <p className={`text-sm ${MUTED}`}>{body}</p>
      </Card>
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// §7.1 step 1 — setup
// ---------------------------------------------------------------------------

async function SetupScreen({
  ctx,
  academy,
  token,
}: {
  ctx: SessionCtx
  academy: AcademyRow
  token: string
}) {
  const { isAdmin, venues } = await withSession(ctx, async (tx) => {
    const admin = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`
    const v = await tx<{ id: string; name: string; address: string | null }[]>`
      select id, name, address from venue where academy_id = ${ctx.academyId} order by name`
    return { isAdmin: Boolean(admin[0]?.ok), venues: v }
  })

  if (!isAdmin) {
    return (
      <Unavailable
        business={academy.name}
        title="This one is for whoever runs the place"
        body="Setup is the admin's screen. Anything you need, just ask me in the chat."
      />
    )
  }

  const settings = (academy.settings ?? {}) as Record<string, unknown>
  const pattern = (settings.operating_pattern ?? {}) as Record<string, unknown>
  const days = Array.isArray(pattern.days) ? (pattern.days as unknown[]).map(Number).filter((n) => n >= 0 && n <= 6) : [1, 2, 3, 4, 5, 6]

  const initial: SetupValues = {
    name: academy.name ?? '',
    category: academy.category ?? '',
    timezone: academy.timezone ?? 'Asia/Kolkata',
    cancellationWindowHours: academy.cancellation_window_hours ?? 24,
    morningBriefAt: hhmm(academy.morning_brief_at, '07:00'),
    eveningDigestAt: hhmm(academy.evening_digest_at, '21:00'),
    upiHandle: academy.upi_handle ?? '',
    operatingDays: days,
    opensAt: typeof pattern.opens_at === 'string' ? pattern.opens_at : '06:00',
    closesAt: typeof pattern.closes_at === 'string' ? pattern.closes_at : '21:00',
    venues: venues.length
      ? venues.map<SetupVenue>((v) => ({ id: v.id, name: v.name, address: v.address ?? '' }))
      : [{ id: null, name: '', address: '' }],
  }

  return (
    <Shell
      business={academy.name || undefined}
      title="Set up your classes"
      subtitle="One screen, once. Everything after this you can just tell me in the chat."
      offer="You don't have to use this screen — tell me any of it in the chat and I'll set it up the same way."
    >
      <SetupForm token={token} initial={initial} />
    </Shell>
  )
}

function hhmm(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const m = /^(\d{2}):(\d{2})/.exec(value)
  return m ? `${m[1]}:${m[2]}` : fallback
}

// ---------------------------------------------------------------------------
// §8.2 step 5 — the register
// ---------------------------------------------------------------------------

async function RegisterScreen({
  ctx,
  academy,
  claims,
  token,
}: {
  ctx: SessionCtx
  academy: AcademyRow
  claims: LinkClaims
  token: string
}) {
  const sessionId = claims.ref
  if (!sessionId || !UUID.test(sessionId)) {
    return (
      <Unavailable
        business={academy.name}
        title="I've lost track of which class this is"
        body="Ask me in the chat and I'll send the register again — or just tell me who was missing."
      />
    )
  }

  const loaded = await withSession(ctx, async (tx) => {
    const s = await tx<
      {
        id: string
        starts_at: Date
        ends_at: Date
        status: string
        class_name: string
        venue_name: string | null
      }[]
    >`
      select s.id, s.starts_at, s.ends_at, s.status,
             c.name as class_name,
             coalesce(v.name, cv.name) as venue_name
        from session s
        join class c on c.id = s.class_id
        left join venue v  on v.id  = s.venue_id
        left join venue cv on cv.id = c.venue_id
       where s.id = ${sessionId}
       limit 1`
    if (!s[0]) return null

    const roster = await tx<
      { player_id: string; name: string; marked_status: string | null; marked_note: string | null }[]
    >`
      select p.id as player_id,
             per.full_name as name,
             a.status as marked_status,
             a.note   as marked_note
        from session s
        join enrollment e
          on e.class_id = s.class_id
         and e.started_on <= (s.starts_at at time zone ${academy.timezone})::date
         and (e.ended_on is null or e.ended_on >= (s.starts_at at time zone ${academy.timezone})::date)
        join player p   on p.id = e.player_id and p.active
        join person per on per.id = p.person_id
        left join attendance a on a.session_id = s.id and a.player_id = p.id
       where s.id = ${sessionId}
       order by per.full_name`
    return { session: s[0], roster }
  })

  if (!loaded) {
    return (
      <Unavailable
        business={academy.name}
        title="I can't find that class"
        body="It may have been cancelled, or this link may not be yours. Ask me in the chat and I'll sort it out."
      />
    )
  }

  const { session, roster } = loaded
  const when = inZone(new Date(session.starts_at), academy.timezone)
  const players: RegisterPlayer[] = roster.map((r) => ({
    playerId: r.player_id,
    name: r.name,
    status: (r.marked_status as RegisterPlayer['status']) ?? null,
    note: r.marked_note,
    hasCancellation: r.marked_status === 'cancelled_timely',
  }))

  if (!players.length) {
    return (
      <Unavailable
        business={academy.name}
        title={`${session.class_name} — nobody enrolled`}
        body="There's nobody on this class's roster, so there's nothing to mark. Tell me in the chat if that's wrong."
      />
    )
  }

  return (
    <Shell
      business={academy.name || undefined}
      title={session.class_name}
      subtitle={`${when.label}${session.venue_name ? ` · ${session.venue_name}` : ''}`}
      offer="You never have to open this. Say “all present” in the chat, or just name whoever was out."
    >
      <RegisterForm token={token} sessionId={session.id} players={players} />
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// §15 — a stored view spec
// ---------------------------------------------------------------------------

async function ViewScreen({
  ctx,
  academy,
  claims,
  token,
  page,
}: {
  ctx: SessionCtx
  academy: AcademyRow
  claims: LinkClaims
  token: string
  page: number
}) {
  const id = claims.ref
  if (!id || !UUID.test(id)) return <Expired />

  const stored = await loadViewSpec(ctx, id)
  if (!stored || stored.expired) return <Expired />

  const view = await resolveView(ctx, stored.spec, { page })

  return (
    <Shell business={academy.name || undefined} title={view.title}>
      {view.components.map((c, i) => (
        <RenderComponent key={i} c={c} tz={academy.timezone} token={token} viewSpecId={id} index={i} />
      ))}
    </Shell>
  )
}

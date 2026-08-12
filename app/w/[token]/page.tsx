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
import { Card, Expired, MUTED, Shell } from '@/components/view/chrome'
import { RenderComponent } from '@/components/view/render'
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
    default:
      return <ViewScreen ctx={ctx} academy={academy} claims={claims} token={token} page={page} />
  }
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

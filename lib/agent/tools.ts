/**
 * lib/agent/tools.ts — a general agent on guardrailed primitives (§14.1).
 *
 * Seven generic primitives, not a catalog of hand-built features: read, write
 * (plan/commit/act), message, schedule, UI. Safety is structural, not
 * behavioural — RLS enforces, the diff is computed before commit, and every
 * message goes out the one send path. The floor being solid is what lets the
 * model be free above it.
 */

import { assertSingleReadStatement, modelQuery, withSession, type SessionCtx } from '@/lib/db'
import { now } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { composeAndSend } from '@/lib/messaging/compose'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { LIMITS, type SendOutcome } from '@/lib/messaging/types'
import { AGENT_TASK_CAP, dedupe, enqueue, liveAgentTasks } from '@/lib/jobs'
import { signLink, linkUrl } from '@/lib/web/jwt'
import { ViewSpecSchema } from '@/lib/web/registry'
import type { Identity } from '@/lib/types'
import { searchFacts, writeFact } from './memory'
import type { ToolDecl } from './gemini'
import { executePlan, needsPreview, parseSteps, previewPlan, type PlanStep } from './plan'
import { jsonLit, lit, uid, OPERATIONS } from './operations'

export type ToolCtx = {
  session: SessionCtx
  identity: Identity
  turnId: string
  pendingPlans: Map<string, PlanStep[]>
  /**
   * What each pending plan is and how big it is, so the loop can mint the
   * confirmation buttons itself rather than hoping the model remembered to
   * (§4.3, §14.2). Written here, replayed on tap — §2.2 is untouched.
   */
  pendingMeta?: Map<string, { intent: string; summary: string; totalRows: number; needsConfirm: boolean }>
  /** Everything this turn put on the wire, so the loop can report it. */
  outcomes?: SendOutcome[]
}

/* ------------------------------------------------------------------------- *
 * Declarations
 * ------------------------------------------------------------------------- */

const stepSchema = {
  type: 'object',
  description:
    'One step. Exactly one of: write | operation | adjust | message | schedule.',
  properties: {
    write: { type: 'string', description: 'One SQL statement: insert/update/delete. Always previewed.' },
    operation: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: Object.keys(OPERATIONS) },
        args: { type: 'object' },
      },
      required: ['name', 'args'],
    },
    adjust: {
      type: 'object',
      description: 'A tally adjustment: waiver, credit, pro-rate, discount, goodwill. Negative credits.',
      properties: {
        account_id: { type: 'string' },
        player_id: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' },
        period: { type: 'string', description: 'First day of the billing month, YYYY-MM-DD' },
        description: { type: 'string', description: 'Shown verbatim to the parent' },
      },
      required: ['account_id', 'amount', 'reason'],
    },
    message: {
      type: 'object',
      description: 'Staged until commit. A rolled-back plan has messaged nobody.',
      properties: {
        to_contact_id: { type: 'string' },
        to_person_id: { type: 'string' },
        body: { type: 'string' },
        catalog_id: { type: 'string' },
        subject_person_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Who this message is ABOUT. Never ask someone to confirm something to themselves.',
        },
        buttons: {
          type: 'array',
          maxItems: LIMITS.buttons,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              action: { type: 'object', description: 'One of the action payload kinds' },
            },
            required: ['title', 'action'],
          },
        },
      },
      required: ['body'],
    },
    schedule: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        run_at: { type: 'string' },
        dedupe_key: { type: 'string' },
        payload: { type: 'object' },
      },
      required: ['kind', 'run_at', 'dedupe_key', 'payload'],
    },
  },
}

export const TOOL_DECLS: ToolDecl[] = [
  {
    name: 'read',
    description:
      'Run one SELECT over the schema. RLS scopes it to what this person may see; 5s and 10k rows. Aggregates, window functions and date maths are all allowed. Always returns a scope line so an obviously wrong denominator is visible.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One SELECT (or WITH ... SELECT) statement. No semicolon needed.' },
        purpose: { type: 'string', description: 'What you are trying to find out. One short line.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plan',
    description:
      'Compose a transaction of steps, run it, capture the diff and roll back. Nothing is committed and nobody is messaged. Returns a handle to commit with, plus the exact blast radius. Use this for anything touching more than one person, money, or anything destructive.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What this plan is for, in the user\'s terms. Goes in the audit trail.' },
        steps: { type: 'array', items: stepSchema },
      },
      required: ['intent', 'steps'],
    },
  },
  {
    name: 'commit',
    description:
      'Execute the plan you just previewed, by handle. Only then do its messages go out. You cannot commit a plan you did not preview in this turn.',
    parametersJsonSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
    },
  },
  {
    name: 'act',
    description:
      'Run one named operation. If it is a single-row, own-scope, reversible write it executes directly — a diff there is pure friction. If it is bigger, money-touching or destructive it comes back as a preview with a handle instead, for you to read back before committing.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: Object.keys(OPERATIONS) },
        args: { type: 'object' },
        intent: { type: 'string' },
      },
      required: ['operation', 'args'],
    },
  },
  {
    name: 'reply',
    description:
      'Send a message now, to this person or to someone else, with buttons or a list. Every button carries an action minted here and replayed verbatim on tap. Offer the natural next step as a button.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to_contact_id: { type: 'string', description: 'Defaults to the person you are talking to.' },
        body: { type: 'string' },
        header: { type: 'string' },
        footer: { type: 'string' },
        catalog_id: { type: 'string', description: 'A catalog moment id, when this is one of them.' },
        subject_person_ids: { type: 'array', items: { type: 'string' } },
        buttons: {
          type: 'array',
          maxItems: LIMITS.buttons,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: `≤ ${LIMITS.buttonTitleChars} characters` },
              action: {
                type: 'object',
                description:
                  "One of: {kind:'operation',op,args} · {kind:'steps',steps,summary} · {kind:'reply',text} · {kind:'view',viewSpecId} · {kind:'menu',menu} · {kind:'noop',ack}",
              },
            },
            required: ['title', 'action'],
          },
        },
        list: {
          type: 'object',
          properties: {
            buttonText: { type: 'string' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  rows: {
                    type: 'array',
                    maxItems: LIMITS.listRows,
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        action: { type: 'object' },
                      },
                      required: ['title', 'action'],
                    },
                  },
                },
                required: ['title', 'rows'],
              },
            },
          },
          required: ['buttonText', 'sections'],
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'schedule',
    description:
      'Schedule yourself to look at something later. It runs as an ordinary turn under this person\'s own permissions, and deciding to do nothing is the common and correct outcome. expires_at is REQUIRED — a watch with no expiry is a leak.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short stable id for this watch, e.g. "meera-fee-followup".' },
        instruction: { type: 'string', description: 'What to check, and what to do about it.' },
        run_at: { type: 'string', description: 'ISO timestamp.' },
        expires_at: { type: 'string', description: 'ISO timestamp. When this stops being worth doing. Required.' },
        context_query: { type: 'string', description: 'A SELECT whose result gives the task its data.' },
      },
      required: ['slug', 'instruction', 'run_at', 'expires_at'],
    },
  },
  {
    name: 'view',
    description:
      'Mint a web view for anything dense, spatial or form-shaped, and get a link back. You author a spec of components and the queries filling them — never markup. A view is an upgrade to a text answer, never a prerequisite for one.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            description:
              "e.g. {type:'table', title, query} · {type:'prose', markdown} · {type:'form', fields, submit}",
          },
        },
        for_person_id: { type: 'string', description: 'Defaults to the person you are talking to.' },
        ttl_minutes: { type: 'number' },
      },
      required: ['title', 'components'],
    },
  },
  {
    name: 'remember',
    description:
      'Write down a fact worth carrying: vocabulary, a policy, a habit, a preference. Facts, not transcripts. A fact that changes no behaviour was not worth storing.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject_kind: { type: 'string', enum: ['academy', 'person'] },
        subject_id: { type: 'string' },
        fact: { type: 'string' },
        supersedes: { type: 'string', description: 'The id of the fact this corrects.' },
      },
      required: ['subject_kind', 'fact'],
    },
  },
  {
    name: 'recall',
    description: 'Search the fact store for something you are not currently carrying.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        subject_id: { type: 'string', description: 'Defaults to this person; pass the academy id for academy facts.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'handoff',
    description:
      'Hand this conversation to a person, with the reason and a short summary. Use it on anger, safety language, a refund or complaint you cannot settle, or anything the tools genuinely cannot serve.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        summary: { type: 'string', description: 'What has happened so far, for the human picking it up.' },
      },
      required: ['reason', 'summary'],
    },
  },
]

/* ------------------------------------------------------------------------- *
 * The scope line (§14.2) — plausible-wrong answers, not security, are the real
 * risk with model-authored reads, so every result says what it is out of.
 * ------------------------------------------------------------------------- */

const ENTITY_COLUMNS: [RegExp, string, string][] = [
  [/^(class_id|class_name)$/, 'classes', 'select count(*) from class where active'],
  [/^(player_id|player_name)$/, 'players', 'select count(*) from player where active'],
  [/^(session_id)$/, 'sessions', ''],
  [/^(coach_id|coach_name)$/, 'coaches', "select count(*) from coach where status = 'active'"],
  [/^(account_id)$/, 'accounts', 'select count(*) from account'],
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

async function scopeLine(ctx: SessionCtx, rows: Record<string, unknown>[], truncated: boolean): Promise<string> {
  const bits: string[] = [`${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ' (capped at 10k)' : ''}`]
  if (rows.length) {
    const cols = Object.keys(rows[0])
    for (const [re, label, totalSql] of ENTITY_COLUMNS) {
      const col = cols.find((c) => re.test(c))
      if (!col) continue
      const distinct = new Set(rows.map((r) => String(r[col] ?? ''))).size
      let total = 0
      if (totalSql) {
        try {
          const [t] = await withSession(ctx, async (tx) => (await tx.unsafe(totalSql)) as unknown as { count: string }[])
          total = Number(t?.count ?? 0)
        } catch {
          total = 0
        }
      }
      bits.push(total ? `${distinct} of ${total} ${label}` : `${distinct} ${label}`)
    }
    // Date span, from whatever looks like a date.
    const stamps: string[] = []
    for (const r of rows) {
      for (const v of Object.values(r)) {
        const s = v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : ''
        if (DATE_RE.test(s)) stamps.push(s.slice(0, 10))
      }
    }
    if (stamps.length) {
      stamps.sort()
      const a = stamps[0]
      const b = stamps[stamps.length - 1]
      bits.push(a === b ? a : `${a} – ${b}`)
    }
  }
  return `Across ${bits.join(', ')}`
}

/* ------------------------------------------------------------------------- *
 * Executors
 * ------------------------------------------------------------------------- */

function compactDiff(r: Awaited<ReturnType<typeof previewPlan>>) {
  return {
    summary: r.summary,
    rows: r.totalRows,
    changes: r.diffs.map((d) => ({ table: d.table, op: d.op, count: d.count })),
    messages: r.stagedMessages.map((m) => m.preview),
    scheduled: r.scheduled,
  }
}

export async function runTool(
  name: string,
  args: any,
  ctx: ToolCtx,
): Promise<{ result: unknown; note?: string }> {
  switch (name) {
    /* ---------------------------------------------------------------- read */
    case 'read': {
      const query = String(args?.query ?? '')
      try {
        assertSingleReadStatement(query)
      } catch (e) {
        return { result: { error: e instanceof Error ? e.message : String(e) } }
      }
      const res = await modelQuery(ctx.session, query)
      if (res.error) return { result: { error: res.error, rows: [] } }
      const scope = await scopeLine(ctx.session, res.rows, res.truncated)
      return {
        result: { scope, rowCount: res.rowCount, truncated: res.truncated, ms: res.ms, rows: res.rows.slice(0, 200) },
        note: scope,
      }
    }

    /* ---------------------------------------------------------------- plan */
    case 'plan': {
      let steps: PlanStep[]
      try {
        steps = parseSteps(args?.steps ?? [])
      } catch (e) {
        return { result: { error: `those steps are not valid: ${e instanceof Error ? e.message : String(e)}` } }
      }
      if (!steps.length) return { result: { error: 'a plan needs at least one step' } }
      const preview = await previewPlan(ctx.session, steps)
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      const handle = newId()
      ctx.pendingPlans.set(handle, steps)
      ctx.pendingMeta?.set(handle, {
        intent: String(args?.intent ?? ''),
        summary: preview.summary,
        totalRows: preview.totalRows,
        needsConfirm: needsPreview(preview, steps),
      })
      return {
        result: {
          ok: true,
          handle,
          needs_preview: needsPreview(preview, steps),
          ...compactDiff(preview),
          intent: String(args?.intent ?? ''),
        },
        note: preview.summary,
      }
    }

    /* -------------------------------------------------------------- commit */
    case 'commit': {
      const handle = String(args?.handle ?? '')
      const steps = ctx.pendingPlans.get(handle)
      // Commit by handle only: the model cannot commit a plan it did not just
      // preview, which is what keeps §2.3 from being advisory.
      if (!steps) return { result: { error: 'no such plan handle — preview it again before committing' } }

      // §14.2 — "preview scales with blast radius", and for anything touching more
      // than one person, money, or anything destructive the row reads *preview and
      // confirm*. Leaving that to the model means it holds most of the time and
      // quietly does not the rest, which is the same as not holding. So the runtime
      // refuses: a plan that needs confirming is committed by the human's tap on a
      // minted action (§2.2), never by the model deciding it has read back enough.
      const meta = ctx.pendingMeta?.get(handle)
      if (meta?.needsConfirm) {
        return {
          result: {
            ok: false,
            committed: false,
            needs_confirmation: true,
            error:
              'This one is too big to commit on your own say-so — it is destructive, touches money, or affects more than one person. ' +
              'Reply with the read-back and offer it as a button: a `steps` action carrying this plan, titled "Confirm" or similar, ' +
              'alongside a `noop` "Cancel". The tap commits it.',
            summary: meta.summary,
          },
        }
      }

      const res = await executePlan(ctx.session, steps, String(args?.intent ?? 'committed a previewed plan'))
      ctx.pendingPlans.delete(handle)
      ctx.pendingMeta?.delete(handle)
      ctx.outcomes?.push(...res.outcomes)
      if (!res.ok) return { result: { ok: false, error: res.error, sent: 0 } }
      return {
        result: {
          ok: true,
          audit_id: res.auditId,
          ...compactDiff(res),
          sent: res.outcomes.map((o) => o.status),
        },
        note: res.summary,
      }
    }

    /* ----------------------------------------------------------------- act */
    case 'act': {
      const opName = String(args?.operation ?? '')
      if (!(opName in OPERATIONS)) return { result: { error: `there is no operation called ${opName}` } }
      const steps: PlanStep[] = [{ operation: { name: opName as any, args: (args?.args ?? {}) as any } }]
      const preview = await previewPlan(ctx.session, steps)
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      if (needsPreview(preview, steps)) {
        const handle = newId()
        ctx.pendingPlans.set(handle, steps)
        ctx.pendingMeta?.set(handle, {
          intent: String(args?.intent ?? opName),
          summary: preview.summary,
          totalRows: preview.totalRows,
          needsConfirm: true,
        })
        return {
          result: {
            ok: true,
            executed: false,
            handle,
            reason: 'this one is worth reading back first',
            ...compactDiff(preview),
          },
          note: preview.summary,
        }
      }
      const res = await executePlan(ctx.session, steps, String(args?.intent ?? opName))
      ctx.outcomes?.push(...res.outcomes)
      if (!res.ok) return { result: { ok: false, executed: false, error: res.error } }
      return {
        result: {
          ok: true,
          executed: true,
          audit_id: res.auditId,
          ...compactDiff(res),
          sent: res.outcomes.map((o) => o.status),
        },
        note: res.summary,
      }
    }

    /* --------------------------------------------------------------- reply */
    case 'reply': {
      const to = String(args?.to_contact_id ?? ctx.identity.contact.id)
      const catalogId = args?.catalog_id && args.catalog_id in CATALOG ? (args.catalog_id as CatalogId) : null
      let buttons = Array.isArray(args?.buttons)
        ? args.buttons.slice(0, LIMITS.buttons).map((b: any) => ({
            title: String(b?.title ?? '').slice(0, LIMITS.buttonTitleChars),
            action: b?.action,
          }))
        : undefined

      // A read-back whose button does not carry the plan is a dead end. `pendingPlans`
      // lives for one turn, so a button that merely replays "yes, do it" as text sends
      // the model back to re-derive a plan it already validated — and the second attempt
      // is not guaranteed to reach the same place. The confirmation has to carry the
      // steps themselves (§2.2: minted here, replayed verbatim on tap).
      //
      // So the runtime owns the affirmative action, not the model. The model's wording
      // is kept — it phrases these better than a constant does — but the payload behind
      // the first button becomes the plan.
      if (to === ctx.identity.contact.id) {
        const waiting = [...(ctx.pendingMeta?.entries() ?? [])].filter(([, m]) => m.needsConfirm).at(-1)
        const steps = waiting ? ctx.pendingPlans.get(waiting[0]) : undefined
        if (waiting && steps) {
          const confirm = { kind: 'steps' as const, steps, summary: waiting[1].summary }
          const carriesPlan = buttons?.some((b: any) => b?.action?.kind === 'steps')
          if (!buttons?.length) {
            buttons = [
              { title: 'Do it', action: confirm },
              { title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } },
            ]
          } else if (!carriesPlan) {
            buttons = buttons.map((b: any, i: number) =>
              i === 0
                ? { title: b.title || 'Do it', action: confirm }
                : { title: b.title, action: b?.action ?? { kind: 'noop', ack: 'Left as it was — nothing changed.' } },
            )
          }
        }
      }

      const outcome = await composeAndSend(ctx.session, {
        toContactId: to,
        body: String(args?.body ?? ''),
        header: args?.header ? String(args.header) : undefined,
        footer: args?.footer ? String(args.footer) : undefined,
        buttons,
        list: args?.list,
        catalogId,
        fixed: catalogId ? CATALOG[catalogId].fixed : false,
        subjectPersonIds: Array.isArray(args?.subject_person_ids) ? args.subject_person_ids : undefined,
      })
      ctx.outcomes?.push(outcome)
      return { result: { status: outcome.status, ...('reason' in outcome ? { reason: outcome.reason } : {}) } }
    }

    /* ------------------------------------------------------------ schedule */
    case 'schedule': {
      // §13.1 — the runtime rejects a task without an expiry. Not a warning.
      const expires = args?.expires_at ? new Date(String(args.expires_at)) : null
      if (!expires || Number.isNaN(expires.getTime())) {
        return { result: { error: 'expires_at is required — a watch with no expiry is a leak. When should this stop being worth doing?' } }
      }
      const runAt = new Date(String(args?.run_at ?? ''))
      if (Number.isNaN(runAt.getTime())) return { result: { error: 'run_at must be an ISO timestamp' } }
      if (runAt.getTime() > expires.getTime()) return { result: { error: 'run_at is after expires_at' } }

      // A cap per academy on live tasks, and they are visible (§13.1). The
      // enqueue path enforces it too — this is here so the model gets a
      // sentence it can act on rather than an exception.
      const live = await liveAgentTasks(ctx.session.academyId).catch(() => [])
      if (live.length >= AGENT_TASK_CAP) {
        return {
          result: {
            error: `there are already ${live.length} things on the watch list, which is the cap. Ask what I am watching and drop one first.`,
            watching: live.map((t) => ({ slug: t.slug, instruction: t.instruction })),
          },
        }
      }

      const slug = String(args?.slug ?? newId())
        .replace(/[^a-z0-9_-]/gi, '-')
        .slice(0, 60)
      const dedupeKey = dedupe.agentTask(ctx.session.academyId, slug)
      try {
        const jobId = await enqueue(
          'agent_task',
          runAt,
          dedupeKey,
          {
            academy_id: ctx.session.academyId,
            slug,
            instruction: String(args?.instruction ?? ''),
            context: args?.context_query ? String(args.context_query) : null,
            minted_by: ctx.turnId,
            minted_by_contact_id: ctx.identity.contact.id,
            minted_roles: ctx.identity.roles,
            expires_at: expires.toISOString(),
          },
          ctx.session.academyId,
        )
        return {
          result: {
            ok: true,
            job_id: jobId,
            slug,
            dedupe_key: dedupeKey,
            run_at: runAt.toISOString(),
            expires_at: expires.toISOString(),
          },
          note: `watching: ${String(args?.instruction ?? '').slice(0, 80)}`,
        }
      } catch (e) {
        return { result: { error: e instanceof Error ? e.message : String(e) } }
      }
    }

    /* ---------------------------------------------------------------- view */
    case 'view': {
      const parsed = ViewSpecSchema.safeParse({ title: args?.title, components: args?.components })
      let spec: unknown = parsed.success ? parsed.data : null
      let fellBack = false
      if (!spec) {
        // §15 — an invalid spec falls back to `table`, which renders any
        // tabular result. The floor under all of it: anything that cannot be
        // rendered gets answered in chat.
        const query = Array.isArray(args?.components)
          ? args.components.find((c: any) => typeof c?.query === 'string')?.query
          : null
        if (!query) {
          return {
            result: { error: 'that view spec is not valid and there is no query to fall back to — answer in chat instead' },
          }
        }
        spec = { title: String(args?.title ?? 'Here you go'), components: [{ type: 'table', query: String(query) }] }
        fellBack = true
      }
      const forPersonId = String(args?.for_person_id ?? ctx.identity.person.id)
      const ttl = Math.min(Math.max(Number(args?.ttl_minutes ?? 120), 5), 60 * 24 * 7)
      const viewSpecId = newId()
      const expires = new Date((await now()).getTime() + ttl * 60_000)
      await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
        await tx.unsafe(
          `insert into view_spec (id, academy_id, spec, for_person_id, expires_at)
           values (${uid(viewSpecId)}, ${uid(ctx.session.academyId)}, ${jsonLit(spec)}, ${uid(forPersonId)},
                   timestamptz ${lit(expires.toISOString())})`,
        )
      })
      const token = await signLink(
        {
          academy_id: ctx.session.academyId,
          person_id: forPersonId,
          contact_id: ctx.identity.contact.id,
          purpose: 'view',
          ref: viewSpecId,
        },
        ttl,
      )
      return {
        result: {
          ok: true,
          view_spec_id: viewSpecId,
          url: linkUrl(token),
          fell_back_to_table: fellBack,
          note: "Put this behind a button — {kind:'view', viewSpecId} mints a fresh link on tap.",
        },
      }
    }

    /* ------------------------------------------------------------ remember */
    case 'remember': {
      const subjectKind = args?.subject_kind === 'academy' ? 'academy' : 'person'
      const subjectId = String(
        args?.subject_id ?? (subjectKind === 'academy' ? ctx.session.academyId : ctx.identity.person.id),
      )
      // §5 — the bot writes facts asynchronously after a turn, never blocking
      // a reply.
      void writeFact(ctx.session, {
        subjectKind,
        subjectId,
        fact: String(args?.fact ?? ''),
        source: `turn:${ctx.turnId}`,
        supersedes: args?.supersedes ? String(args.supersedes) : undefined,
      }).catch(() => {})
      return { result: { ok: true } }
    }

    /* -------------------------------------------------------------- recall */
    case 'recall': {
      const subjectId = String(args?.subject_id ?? ctx.identity.person.id)
      const facts = await searchFacts(ctx.session, subjectId, String(args?.query ?? ''))
      return { result: { facts: facts.map((f) => ({ id: f.id, fact: f.fact, source: f.source })) } }
    }

    /* ------------------------------------------------------------- handoff */
    case 'handoff': {
      // §14.8 — client escalations go to their academy's admin; admin
      // escalations go to the platform. §18 rule 2 does the rest: an
      // escalation about a person never reaches that person, so an admin
      // escalating about themselves is dropped on the send path, not here.
      const isAdmin = ctx.identity.roles.includes('admin')
      const reason = String(args?.reason ?? 'needs a person')
      const summary = String(args?.summary ?? '')
      const sent: string[] = []
      if (!isAdmin) {
        const admins = await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
          const rows = (await tx.unsafe(
            `select c.id from academy_admin aa
               join contact c on c.person_id = aa.person_id and c.academy_id = aa.academy_id
              where aa.academy_id = ${uid(ctx.session.academyId)} and c.opted_out_at is null
              order by c.is_primary desc`,
          )) as unknown as { id: string }[]
          return rows.map((r) => r.id)
        })
        for (const contactId of admins) {
          const o = await composeAndSend(ctx.session, {
            toContactId: contactId,
            body:
              `${ctx.identity.person.full_name} needs a person — ${reason}.\n${summary}`.slice(0, LIMITS.bodyChars),
            isEscalation: true,
            subjectPersonIds: [ctx.identity.person.id],
            fixed: true,
            buttons: [
              { title: 'Message them', action: { kind: 'reply', text: `Open a message to ${ctx.identity.person.full_name}` } },
            ],
          })
          ctx.outcomes?.push(o)
          sent.push(o.status)
        }
      }
      await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
        await tx.unsafe(
          `insert into memory_fact (academy_id, subject_kind, subject_id, fact, source)
           values (${uid(ctx.session.academyId)}, 'person', ${uid(ctx.identity.person.id)},
                   ${lit(`Asked for a person: ${reason}`)}, ${lit(`turn:${ctx.turnId}`)})`,
        )
      })
      return {
        result: {
          ok: true,
          told_admin: sent.length > 0,
          say: isAdmin
            ? "I've flagged this for the people who run the platform, and I've kept the thread."
            : `I've passed this to ${ctx.identity.academy?.name ?? 'the academy'} with what we've said so far. Someone will come back to you.`,
        },
      }
    }

    default:
      return { result: { error: `there is no tool called ${name}` } }
  }
}

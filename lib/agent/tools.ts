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
import { LIMITS, type SendOutcome, type SuppressReason } from '@/lib/messaging/types'
import { AGENT_TASK_CAP, dedupe, enqueue, liveAgentTasks } from '@/lib/jobs'
import { signLink, linkUrl } from '@/lib/web/jwt'
import { ViewSpecSchema } from '@/lib/web/registry'
import type { Identity } from '@/lib/types'
import { lint } from './lint'
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

/**
 * Steps cross the wire as a JSON string, not as a declared array of objects.
 *
 * This is not a style choice. A plan step is a five-way union whose branches nest
 * three and four deep — a message carrying buttons carrying action payloads, a
 * schedule carrying a free-form job payload — and Vertex's function-call decoder
 * returns MALFORMED_FUNCTION_CALL on it more often than not once the model tries
 * to build a real one. Measured against the live prompt: two of three attempts came
 * back malformed, zero output tokens, no candidate, no error anyone could read.
 *
 * The failure was invisible in a way that mattered: with every tool available the
 * model would quietly fall back to `read` instead, so reads always worked and
 * writes intermittently did nothing — which is exactly the symptom that looked
 * like a stalling model, an invented tool name, or an empty apology.
 *
 * A string has no shape to malform. Validation does not move: `PlanStepSchema`
 * (lib/agent/plan.ts) is still the only thing that decides what a step is, and it
 * already rejected everything a JSON-schema declaration would have.
 */
const STEPS_PARAM = {
  type: 'string',
  description:
    'A JSON array of steps, as a string. Each element has EXACTLY ONE of these keys:\n' +
    '  {"write": "<one SQL statement: insert/update/delete>"}\n' +
    '  {"operation": {"name": "<operation name>", "args": {…}}}\n' +
    '  {"adjust": {"account_id", "amount", "reason", "player_id"?, "period"?, "description"?}}\n' +
    '  {"message": {"to_contact_id"|"to_person_id", "body", "catalog_id"?, "subject_person_ids"?, "buttons"?: [{"title","action"}]}}\n' +
    '  {"schedule": {"kind", "run_at", "dedupe_key", "payload": {…}}}\n' +
    'Steps run one after another inside ONE transaction, so a later step sees rows an ' +
    'earlier step created. You will not know the id of something you just inserted — do ' +
    'not guess one and do not leave the link empty. Select it back:\n' +
    '  [{"write":"insert into venue (academy_id, name) values (app.academy_id(), \'Green Park\')"},\n' +
    '   {"write":"insert into class (academy_id, name, venue_id, starts_on) values (app.academy_id(), \'Evening\', ' +
    '(select id from venue where name = \'Green Park\' and academy_id = app.academy_id()), date \'2026-08-20\')"}]\n' +
    'An operation whose argument is an id you do not have is the wrong tool for that step — ' +
    'write the SQL instead, so the id can be a subquery.\n' +
    'Example: [{"operation":{"name":"create_class","args":{"name":"Evening","starts_on":"2026-08-20",' +
    '"slots":[{"weekday":1,"start_time":"18:00","end_time":"19:00"}]}}}]',
}

/** Retained for the parse side and for documentation of the step shape. */
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

/**
 * Steps arrive as a JSON string (see `STEPS_PARAM`), but a model that has seen the
 * older shape — or that simply ignores the instruction — may still send an array.
 * Both are accepted: rejecting a correct plan on a formatting technicality is the
 * kind of strictness that costs a turn and teaches nobody anything.
 */
function decodeSteps(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return raw ?? []
  const text = raw.trim()
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(
      `steps was a string but not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
        'It must parse as a JSON array of step objects.',
    )
  }
}

/**
 * What each gate means, in words the model can act on. Every one of these is a
 * decision the runtime made on purpose — the useful response is to change course,
 * never to send the message again.
 */
const SUPPRESSION_HELP: Record<SuppressReason, string> = {
  opted_out: 'This person asked this academy to stop messaging them. Nothing reaches them. Tell the admin if it matters.',
  self_confirmation: 'This message asks someone to confirm something about themselves. Send it to whoever actually decides, not to its subject.',
  escalation_about_self: 'This raises a concern about the person it is addressed to. Route it to an admin instead.',
  pre_launch: 'This academy has not launched, so its roster is not messaged yet. Only the admin can be written to during setup.',
  recipient_frequency_cap: 'This person has already had their day\'s worth of unprompted messages. An answer to something they just asked is exempt; an interruption is not.',
  tenant_send_cap: 'This academy has hit its 24-hour send ceiling on the shared number. Nothing more goes out today.',
  out_of_window_no_template: 'The 24-hour window with this person is closed, so only one of the template categories can reach them. Free text cannot.',
  duplicate_idempotency: 'This exact message was already sent once. It is not sent twice.',
  repeat: 'They were told this, word for word, moments ago. Saying it again teaches them nothing — say what changed, or say nothing.',
  no_contact: 'There is no reachable contact row for that recipient in this academy.',
  limit_violation: 'The message breaks a WhatsApp shape limit (length, button count, title length). Rebuild it smaller — this one could not render.',
}

/**
 * The label on the nav-bar door. Kept under `LIMITS.buttonTitleChars` here rather
 * than truncated at the call site: a title trimmed to fit renders as "What else can
 * you do" with the question mark missing, which looks like a bug to the person
 * reading it — and a 21-character title is not a compose error worth suppressing a
 * whole message over, which is what happened the first time this shipped.
 */
export const MENU_BUTTON_TITLE = 'What can you do?'

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
        steps: STEPS_PARAM,
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
        steps = parseSteps(decodeSteps(args?.steps))
      } catch (e) {
        return {
          result: {
            error: `those steps are not valid: ${e instanceof Error ? e.message : String(e)}`,
            hint: 'steps is a JSON array, as a string. Each element has exactly one of: write, operation, adjust, message, schedule. Fix the shape rather than resending it.',
          },
        }
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
          // A confirmation with no way to decline is not a confirmation. The model
          // reliably writes the yes and forgets the no — asked to add a coach it
          // offered `[Yes, confirm]` alone — which leaves declining to be typed as
          // prose, on the one interaction where the tap is the whole point.
          const declines = (b: any) => b?.action?.kind === 'noop' || /^(cancel|no\b|don'?t|leave)/i.test(b?.title ?? '')
          if (buttons && buttons.length < LIMITS.buttons && !buttons.some(declines)) {
            buttons.push({ title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } })
          }
        }
      }

      // §5 — "a persistent list-picker is the primary affordance; prose is the
      // fallback". The picker was built, role-aware and reordered by memory, and
      // was reachable only by tapping a button carrying `{kind:'menu'}` — which
      // nothing ever minted. Across every message the product had ever sent, not
      // one menu action existed, so the nav bar had no door. This is the door: a
      // reply that would otherwise ship bare carries one, which costs a person
      // nothing and is the only thing that teaches them what else there is.
      if (to === ctx.identity.contact.id && !buttons?.length && !args?.list) {
        buttons = [{ title: MENU_BUTTON_TITLE, action: { kind: 'menu', menu: 'root' } }]
      }

      const outcome = await composeAndSend(ctx.session, {
        toContactId: to,
        // §4.5 ran on exactly one path — the loop's own trailing message — and this
        // is the path the model actually uses, so most outbound text was never
        // linted at all. Uuids, table names, ISO timestamps and doctrine references
        // were one `reply` call away from a customer's phone the whole time.
        body: lint(String(args?.body ?? ''), ctx.identity),
        header: args?.header ? String(args.header) : undefined,
        footer: args?.footer ? String(args.footer) : undefined,
        buttons,
        list: args?.list,
        catalogId,
        fixed: catalogId ? CATALOG[catalogId].fixed : false,
        subjectPersonIds: Array.isArray(args?.subject_person_ids) ? args.subject_person_ids : undefined,
      })
      ctx.outcomes?.push(outcome)
      if (outcome.status === 'suppressed') {
        // A bare `{status:'suppressed'}` reads as "that didn't work, try again", and
        // the observed behaviour was exactly that: the same message re-sent, then a
        // shorter version, then a bare "Hi!" — three dropped messages and a wasted
        // turn. A gate is a decision, not a transient failure, so it says so.
        return {
          result: {
            status: 'suppressed',
            reason: outcome.reason,
            explanation: SUPPRESSION_HELP[outcome.reason] ?? 'This message was not delivered.',
            retry: false,
            note: 'Sending this again, or a reworded version, will be dropped the same way. Do not resend. If the person is owed an answer, the way to give it is to fix the reason, not to repeat the message.',
          },
        }
      }
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

    default: {
      // A dead end here costs the whole turn. The model called `PlanSteps` eight
      // times in a row against `there is no tool called PlanSteps` — a true sentence
      // that contains nothing to act on, so the only move left was to try it again.
      // An error that carries the way out is the difference between a mis-named call
      // and a burnt turn.
      const known = TOOL_DECLS.map((d) => d.name)
      const lowered = name.toLowerCase().replace(/[^a-z]/g, '')
      const nearest =
        known.find((k) => k === lowered) ??
        known.find((k) => lowered.startsWith(k) || lowered.endsWith(k)) ??
        known.find((k) => lowered.includes(k))
      return {
        result: {
          error: `there is no tool called "${name}"`,
          available: known,
          ...(nearest
            ? {
                didYouMean: nearest,
                hint: `Call "${nearest}" instead — same intent, and its parameters are in the declaration above. Calling "${name}" again will fail identically.`,
              }
            : {
                hint: 'Use one of the names in `available`, exactly as written — they are lowercase and never camelCase. Calling this name again will fail identically.',
              }),
        },
      }
    }
  }
}

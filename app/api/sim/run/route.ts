import { z } from 'zod'

import { runPersona, PERSONAS, GOALS, type Persona, type SimGoal } from '@/lib/sim/run'
import { judge } from '@/lib/sim/judge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PersonaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  style: z.string().min(1),
  traits: z.array(z.string()).default([]),
})

const GoalSchema = z.object({
  text: z.string().min(1),
  successCriteria: z.array(z.string()).default([]),
})

const Body = z.object({
  seed: z.string().min(1),
  /** A persona object, or a slug/name from `PERSONAS`. */
  persona: z.union([z.string().min(1), PersonaSchema]),
  /** A goal object, or a slug/text from `GOALS`. */
  goal: z.union([z.string().min(1), GoalSchema]),
  contactId: z.string().uuid(),
  maxTurns: z.number().int().min(1).max(40).optional(),
  label: z.string().min(1).max(120).optional(),
  judge: z.boolean().optional(),
})

/** Agent simulation (§17): a persona, a goal, a seeded world, and a judge. */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const body = parsed.data

  try {
    // `runPersona` resolves a slug or an object itself, and judges the run
    // unless told not to — a run with no report has not finished.
    const run = await runPersona({
      seed: body.seed,
      contactId: body.contactId,
      persona: body.persona as Persona | string,
      goal: body.goal as SimGoal | string,
      maxTurns: body.maxTurns,
      label: body.label,
      judge: body.judge,
    })

    const report = body.judge === false ? null : (run.judge ?? (await judge(run)))

    return Response.json({ ok: true, run, report })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // An unknown persona or goal slug is the caller's mistake, not a server fault.
    const status = /unknown (persona|goal)/i.test(message) ? 400 : 500
    return Response.json({ ok: false, error: message }, { status })
  }
}

/** The personas and goals that ship with the harness. The uncooperative ones find more bugs. */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true, personas: PERSONAS, goals: GOALS })
}

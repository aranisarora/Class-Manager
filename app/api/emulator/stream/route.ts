import { pollWorld, latestCursor } from '@/lib/seed'
import { nextEventAt } from '@/lib/clock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_MS = 600
const KEEPALIVE_MS = 15_000

/**
 * Server-Sent Events. Polls the DB on a ~600 ms cursor and pushes named
 * `message`, `job`, `turn` and `clock` events.
 *
 * Live updates are not a nicety: the cover-claim race is only testable if pane B
 * visibly updates when you tap in pane A (§17). Refresh-on-action doesn't test it.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sinceParam = url.searchParams.get('since')

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let polling = false
      let cursor: string | null = sinceParam
      let lastOffsetMs: number | null = null
      // messageId -> the status already pushed, so a status change emits once.
      const pushedStatus = new Map<string, string>()

      const write = (chunk: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      const emit = (name: string, data: unknown): void =>
        write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

      let pollTimer: ReturnType<typeof setInterval> | undefined
      let kaTimer: ReturnType<typeof setInterval> | undefined

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (pollTimer) clearInterval(pollTimer)
        if (kaTimer) clearInterval(kaTimer)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      req.signal.addEventListener('abort', cleanup)

      const poll = async (): Promise<void> => {
        if (closed || polling) return
        polling = true
        try {
          const result = await pollWorld({ cursor })
          cursor = result.cursor

          for (const ev of result.events) {
            emit(ev.type, ev)
            if (ev.type === 'message') pushedStatus.set(ev.id, ev.status)
          }

          for (const s of result.statuses) {
            if (pushedStatus.get(s.id) === s.status) continue
            pushedStatus.set(s.id, s.status)
            emit('status', { type: 'status', ...s })
          }
          // Bound the map: the emulator only ever renders recent traffic.
          if (pushedStatus.size > 500) {
            const keys = Array.from(pushedStatus.keys()).slice(0, pushedStatus.size - 500)
            for (const k of keys) pushedStatus.delete(k)
          }

          if (lastOffsetMs === null || lastOffsetMs !== result.clock.offsetMs) {
            lastOffsetMs = result.clock.offsetMs
            // Only worth a query when the clock actually moved.
            const next = await nextEventAt().catch(() => null)
            const nextIso = next ? next.toISOString() : null
            emit('clock', {
              type: 'clock',
              ...result.clock,
              nextEventAt: nextIso,
              nextEventAtIso: nextIso,
            })
          }
        } catch (e) {
          emit('error', { type: 'error', message: e instanceof Error ? e.message : String(e) })
        } finally {
          polling = false
        }
      }

      try {
        if (!cursor) cursor = await latestCursor()
      } catch {
        cursor = null
      }
      emit('hello', { type: 'hello', cursor, pollMs: POLL_MS })

      if (req.signal.aborted) {
        cleanup()
        return
      }

      pollTimer = setInterval(() => {
        void poll()
      }, POLL_MS)
      kaTimer = setInterval(() => write(': keep-alive\n\n'), KEEPALIVE_MS)

      void poll()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

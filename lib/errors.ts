/**
 * lib/errors.ts — one error type (CONTRACTS §11).
 *
 * `code` is for us, `message` is for the log, `userMessage` is the only thing a
 * human on WhatsApp may ever see. Nothing in this file formats or sends
 * anything: an AppError that never reaches a person is the normal case.
 */

export type AppErrorInit = {
  /** Stable machine code, snake_case: 'unsafe_query', 'action_expired'. */
  code: string
  /** For the log and the event stream. Free to name tables and ids. */
  message: string
  /** Safe to show a user. Never contains ids, table names or SQL. */
  userMessage?: string
  /** The underlying failure, if this wraps one. */
  cause?: unknown
  /** Extra context for the log. */
  detail?: Record<string, unknown>
}

export class AppError extends Error {
  readonly code: string
  readonly userMessage?: string
  readonly detail?: Record<string, unknown>

  constructor(init: AppErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AppError'
    this.code = init.code
    this.userMessage = init.userMessage
    this.detail = init.detail
    Object.setPrototypeOf(this, AppError.prototype)
  }

  toJSON(): { code: string; message: string; userMessage?: string; detail?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.userMessage === undefined ? {} : { userMessage: this.userMessage }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    }
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AppError')
}

// The three-argument shorthand lives in `lib/messaging/types.ts` as `msgError`, which
// is what the twelve call sites actually import. There was an identical `appError` here
// with no callers at all — two names for `new AppError({code, message, userMessage})`,
// and the one in the file named after the error type was the dead one.

/** Never throws. Use wherever an error has to become a string. */
export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/**
 * **`userMessage` is currently write-only, and that is worth knowing.**
 *
 * There was a `userFacingMessage(e, fallback)` here — the reader for the field this
 * file's own header calls "the only thing a human on WhatsApp may ever see" — and
 * nothing called it. `msgError` sites do populate `userMessage`, so the value is
 * written and never read: the sentence an author carefully wrote for a person is
 * discarded, and what a person actually gets is `humanError()` in `lib/agent/loop.ts`,
 * which re-derives a safe sentence from the raw message instead.
 *
 * Removed rather than left sitting there, because a dead reader reads as a live path
 * and is how the gap stayed invisible. Two honest ways to close it, neither of them a
 * cleanup: have `humanError` prefer `userMessage` when the error carries one, or stop
 * writing the field. `errorCode(e)` went with it — also unused, and `isAppError(e) ?
 * e.code : 'unknown'` at a call site is the same thing without the indirection.
 */

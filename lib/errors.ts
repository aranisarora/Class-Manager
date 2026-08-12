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

/** Shorthand for the common three-argument case. */
export function appError(code: string, message: string, userMessage?: string): AppError {
  return new AppError({ code, message, userMessage })
}

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

/** The line a person is allowed to see. Falls back to something plain. */
export function userFacingMessage(e: unknown, fallback = "Something went wrong on my side. I haven't changed anything."): string {
  if (isAppError(e) && e.userMessage) return e.userMessage
  return fallback
}

export function errorCode(e: unknown): string {
  return isAppError(e) ? e.code : 'unknown'
}

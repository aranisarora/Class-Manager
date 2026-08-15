/**
 * lib/env.ts — the validated environment (CONTRACTS §0).
 *
 * Next.js loads `.env.local` for app code. `scripts/` run under tsx do not, so
 * this file parses `.env.local` itself when the process environment is missing
 * the keys — one code path for the app, the seeder, the job runner and the
 * simulator.
 *
 * Reading is lazy: importing this module never touches the filesystem, so a
 * module that only wants a type does not pay for a read, and a missing key
 * fails at first use with a message naming the key.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { AppError } from '@/lib/errors'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /**
   * The model client's only credential. Lives in `.env.local` and nowhere else —
   * not in a settings row, not in the repo, not in a chat window.
   */
  DEEPSEEK_API_KEY: z.string().min(1),
  MODEL_MAIN: z.string().min(1),
  MODEL_SYNTH: z.string().min(1),
  APP_JWT_SECRET: z.string().min(16),
  APP_BASE_URL: z.string().min(1),
  TRANSPORT: z.enum(['emulator', 'cloud']),
})

export type Env = Readonly<z.infer<typeof EnvSchema>>

const KEYS = Object.keys(EnvSchema.shape) as (keyof z.infer<typeof EnvSchema>)[]

let cached: Env | null = null
let rootDir: string | null = null

/** Walk up from cwd looking for the file that marks the repo root. */
function findRoot(): string {
  if (rootDir) return rootDir
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.env.local')) || existsSync(join(dir, 'package.json'))) {
      rootDir = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  rootDir = process.cwd()
  return rootDir
}

/** A small, deliberate dotenv: KEY=VALUE, `export` tolerated, quotes stripped. */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const body = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue

    const key = body.slice(0, eq).trim()
    let value = body.slice(eq + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

let dotEnv: Record<string, string> | null = null

function fileEnv(): Record<string, string> {
  if (dotEnv) return dotEnv
  const path = join(findRoot(), '.env.local')
  dotEnv = existsSync(path) ? parseDotEnv(readFileSync(path, 'utf8')) : {}
  return dotEnv
}

function load(): Env {
  if (cached) return cached

  const source: Record<string, string> = {}
  const needsFile = KEYS.some((k) => !process.env[k])
  const fromFile = needsFile ? fileEnv() : {}

  for (const key of KEYS) {
    const value = process.env[key] ?? fromFile[key]
    if (value !== undefined) source[key] = value
  }

  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new AppError({
      code: 'env_invalid',
      message: `Environment is missing or invalid: ${missing}. Looked at process.env and ${join(findRoot(), '.env.local')}.`,
    })
  }

  cached = Object.freeze(parsed.data)
  return cached
}

/**
 * The environment. Every key from CONTRACTS §0, same names, validated on first
 * read.
 */
export const env: Env = {
  get DATABASE_URL() { return load().DATABASE_URL },
  get SUPABASE_URL() { return load().SUPABASE_URL },
  get SUPABASE_PUBLISHABLE_KEY() { return load().SUPABASE_PUBLISHABLE_KEY },
  get DEEPSEEK_API_KEY() { return load().DEEPSEEK_API_KEY },
  get MODEL_MAIN() { return load().MODEL_MAIN },
  get MODEL_SYNTH() { return load().MODEL_SYNTH },
  get APP_JWT_SECRET() { return load().APP_JWT_SECRET },
  get APP_BASE_URL() { return load().APP_BASE_URL },
  get TRANSPORT() { return load().TRANSPORT },
}

/** Where `.env.local` lives. Used to resolve relative paths. */
export function repoRoot(): string {
  return findRoot()
}

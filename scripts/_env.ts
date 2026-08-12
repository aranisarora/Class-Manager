import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILES = ['.env.local', '.env']

/**
 * Next loads `.env.local` for the app; a bare `tsx` process does not. This is
 * the smallest thing that makes the scripts see the same environment: KEY=VALUE
 * lines, `#` comments, optional surrounding quotes, no interpolation. Anything
 * already in `process.env` wins, so a shell override still overrides.
 */
export function loadEnvFiles(cwd: string = process.cwd()): string[] {
  const loaded: string[] = []
  for (const file of FILES) {
    const path = resolve(cwd, file)
    if (!existsSync(path)) continue
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
      let value = line.slice(eq + 1).trim()
      const quoted =
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      if (quoted) value = value.slice(1, -1)
      if (process.env[key] === undefined) process.env[key] = value
    }
    loaded.push(file)
  }
  return loaded
}

const ESC = String.fromCharCode(27)
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const wrap = (code: string) => (s: string) =>
  useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
}

/** Postgres errors carry more than `.message`; a migration tool must show it. */
export function pgErrorLines(e: unknown, source?: string): string[] {
  const err = e as Record<string, unknown> | null
  const code = typeof err?.code === 'string' ? err.code : ''
  const message = e instanceof Error ? e.message : String(e)
  const out = [code ? `${code} ${message}` : message]

  const position = Number(err?.position)
  if (source && Number.isFinite(position) && position > 0) {
    const upto = source.slice(0, position - 1).split('\n')
    const line = upto.length
    const col = (upto[upto.length - 1] ?? '').length + 1
    out.push(`at line ${line}, column ${col}`)
    const text = source.split('\n')[line - 1]
    if (text) out.push(`> ${text.trim().slice(0, 120)}`)
  }
  for (const key of ['detail', 'hint', 'where'] as const) {
    const v = err?.[key]
    if (typeof v === 'string' && v) out.push(`${key}: ${v.split('\n')[0]}`)
  }
  return out
}

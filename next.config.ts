import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'

/**
 * Doctrine is markdown on disk, and a serverless bundle only carries what was traced.
 *
 * `lib/agent/context.ts` reads `lib/doctrine.md` with `readFileSync(join(repoRoot(), rel))`.
 * Next's output-file tracing works by static analysis, and a path assembled from a function
 * call is not analysable — so the file was never copied into the lambda. Locally both
 * candidates resolve under the repo and every turn worked; on Vercel `repoRoot()` and
 * `process.cwd()` are both `/var/task`, the read failed twice, and `readDoc` threw.
 *
 * It threw *while assembling the prompt*, which is before the model is called at all: every
 * turn died at round 0 with `model` null, the loop caught it, and each person got "Something
 * broke on my side just then". Both hosted tenants, every inbound, for as long as the
 * deployment has been up — and nothing looked broken from the outside, because the apology
 * sends and delivers exactly like a real reply.
 *
 * `outputFileTracingIncludes` is the supported way to tell tracing about a file it cannot
 * see. `/**\/*` because doctrine is read by the agent loop, which is reached from the
 * webhook, the emulator routes and the cron drain alike — there is no one route to name.
 * `deepseek-api.md` is not read at runtime today; only what is actually read is listed, so
 * this stays a statement about the running code rather than a guess.
 */
const RUNTIME_DOCS = ['lib/doctrine.md']

const base: NextConfig = {
  serverExternalPackages: ['postgres'],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  outputFileTracingIncludes: { '/**/*': RUNTIME_DOCS },
}

/**
 * `next dev` and `next build` both write `.next` by default, and they write
 * incompatible things into it. Run a build while the dev server is up — which is the
 * normal way to check that a change compiles — and the build's manifests land on top
 * of the ones the running server has already loaded. The server does not crash and
 * does not recover: every route answers a bare `Internal Server Error`, with no stack
 * anywhere, because the failure is in the artifacts rather than in any code.
 *
 * Splitting the directories by phase makes that collision impossible instead of
 * merely discouraged. Dev keeps `.next`; build and `next start` share `.next-build`,
 * so a verification build is always safe to run and `npm start` still finds its own
 * output.
 */
export default function config(phase: string): NextConfig {
  /**
   * On Vercel the split is unnecessary and unhelpful. The collision it prevents needs
   * a dev server and a build sharing one directory, and the platform only ever builds
   * — there is no `next dev` on a build machine to trip over. Against that, a
   * non-default `distDir` is one more thing the build pipeline has to agree with us
   * about in order to find the output at all, and a deploy that cannot locate its own
   * artifacts fails in the platform rather than in any file here.
   *
   * `VERCEL` is set on every Vercel build and deployment, and nowhere else, so the
   * local guarantee below is preserved exactly as it was.
   */
  if (process.env.VERCEL) return { ...base, distDir: '.next' }

  return { ...base, distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next' : '.next-build' }
}

import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'

const base: NextConfig = {
  serverExternalPackages: ['postgres'],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
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

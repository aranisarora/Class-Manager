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
  return { ...base, distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next' : '.next-build' }
}

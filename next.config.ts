import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres'],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig

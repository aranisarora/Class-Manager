import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres', 'google-auth-library', '@google/genai'],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig

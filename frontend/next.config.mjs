/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    // Type checking and linting are done in CI (test.yml).
    // Docker builds skip lint to avoid blocking deploys on style issues.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Same — type checking is in CI, not Docker.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

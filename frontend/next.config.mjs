/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    // Docker builds skip lint to avoid blocking deploys on style issues.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // The frontend IS type-checked before production now (P1-7,
    // 2026-09-01): test.yml's `frontend-checks` job runs `tsc --noEmit`
    // (+ the frontend unit tests), and deploy.yml's gate requires the
    // Tests workflow to succeed for the commit before migrate-sql or
    // deploy run. That gate is the control this flag used to defeat.
    //
    // The flag itself stays ON deliberately: turning it off would change
    // what `next build` does inside the Docker image and in the
    // widget-render gate — a deploy-behaviour change with no remaining
    // safety benefit, since a type error can no longer reach the image
    // build at all (the gate refuses the commit first).
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

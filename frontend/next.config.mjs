/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    // Docker builds skip lint to avoid blocking deploys on style issues.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // NOTE: this does NOT mean a type error is caught before production.
    // The previous comment here claimed "type checking is in CI (test.yml)";
    // test.yml type-checks the backend and the connectors package, not the
    // frontend. The frontend's `tsc --noEmit` lives in check.yml, which
    // states in its own header that it does not block deploy — and deploy.yml
    // triggers straight off `push: [main, staging]` with no `needs:` on any
    // test workflow. So with this flag on, a frontend type error compiles into
    // the production image and lands as a 0%-traffic revision, ready to be
    // promoted.
    //
    // Left ON here deliberately: turning it off would change what `next build`
    // does inside the Docker image and in the widget-render gate, which is a
    // deploy-behaviour change and wants its own review. The durable fix is to
    // make deploy.yml depend on the type-check rather than to have the image
    // build re-do it.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

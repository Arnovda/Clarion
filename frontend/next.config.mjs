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
  webpack: (config) => {
    // Vega (via vega-canvas) optionally requires the native Node `canvas`
    // package for server-side rendering. We only ever render Vega in the
    // browser, so stub it out — otherwise webpack fails with
    // "Module not found: Can't resolve 'canvas'".
    config.resolve = config.resolve || {};
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false };
    return config;
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions default to a 1 MB request body, which is far too small for
    // real Excel/Odoo exports (a single month of GL is ~6 MB, and the
    // multi-file uploader sends several at once). Raise it to comfortably cover
    // the 20 MB per-file cap across a batch of files.
    serverActions: {
      bodySizeLimit: "150mb",
    },
    // Enable src/instrumentation.ts (auto-seeds the first admin on startup so a
    // hosted deploy has a working login without shell access).
    instrumentationHook: true,
  },
};

export default nextConfig;

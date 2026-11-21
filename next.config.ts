import type { NextConfig } from "next";

/**
 * Security headers for every page. Kept compatible with Next's inline scripts (no script CSP):
 * - frame-ancestors / X-Frame-Options: other sites can't put the app in a frame (clickjacking).
 * - nosniff, a strict referrer policy, and no camera, microphone or location access.
 * The admin routes add their own stricter headers on top (src/lib/admin/headers.ts).
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

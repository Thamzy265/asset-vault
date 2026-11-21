/**
 * Security headers on every response (M1.1 review L6, M1.3 design note): a
 * Content-Security-Policy with no inline script except Next's own, which carry
 * the per-request nonce ('unsafe-inline' is never allowed), no framing
 * (frame-ancestors 'none'), nosniff, and Referrer-Policy same-origin.
 */
export function contentSecurityPolicy(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const STATIC_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
} as const;

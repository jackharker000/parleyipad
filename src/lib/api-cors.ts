/**
 * Shared CORS headers for the Parley API routes. Vercel preview deployments
 * serve the client and the API from different origins, which without these
 * headers fails every fetch with a CORS error.
 *
 * Single-user app; the only consumers are the iPad PWA and (optionally)
 * a Capacitor-wrapped native shell. `*` is acceptable here — there is no
 * cookie-based auth and no cross-origin credentialed requests.
 */

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...headers };
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

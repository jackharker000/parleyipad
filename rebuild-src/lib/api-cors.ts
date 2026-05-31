/**
 * Shared CORS + access helpers for the Parley API routes. Vercel preview
 * deployments serve the client and the API from different origins, which
 * without these headers fails every fetch with a CORS error.
 *
 * Single-user app, no cookie-based auth, no cross-origin credentialed
 * requests. By default CORS stays `*` so local dev and the first deploy
 * work out of the box. Two OPTIONAL, non-breaking server-side knobs harden
 * the proxy for a public deploy (a security review flagged it as an open
 * relay — any site could drain the user's provider quota through the URL):
 *
 *   PARLEY_ALLOWED_ORIGIN  — comma-separated allow-list of origins. When set,
 *                            the request's Origin is reflected only if it
 *                            matches; otherwise the first listed origin is
 *                            echoed (so a mismatched browser still gets a
 *                            concrete, non-`*` value and is blocked by CORS).
 *   PARLEY_CLIENT_TOKEN    — shared secret. When set, every gated route
 *                            requires header `x-parley-token` to equal it.
 *
 * Both unset == prior behavior (`*`, no gate).
 */

const BASE_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // x-parley-token is the optional shared-secret header (see requireClientToken).
  "access-control-allow-headers": "content-type, authorization, x-parley-token",
  "access-control-max-age": "86400",
};

/**
 * Legacy export kept for backward compatibility. Carries the wildcard origin
 * so any caller that reads CORS_HEADERS directly behaves exactly as before.
 * Prefer withCors()/corsPreflight(), which honour PARLEY_ALLOWED_ORIGIN.
 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  ...BASE_CORS_HEADERS,
};

function parseAllowList(): string[] {
  const raw = process.env.PARLEY_ALLOWED_ORIGIN;
  if (!raw) return [];
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Resolve the Access-Control-Allow-Origin value for a given request.
 * - No allow-list configured -> "*" (unchanged default).
 * - Request Origin is in the allow-list -> reflect it (required when the
 *   client ever sends credentials; "*" is invalid in that case).
 * - Otherwise -> echo the first allowed origin so the response carries a
 *   concrete value and the mismatched browser is blocked by the CORS check.
 */
function resolveAllowOrigin(requestOrigin: string | null): string {
  const allowList = parseAllowList();
  if (allowList.length === 0) return "*";
  if (requestOrigin && allowList.includes(requestOrigin)) return requestOrigin;
  return allowList[0];
}

/**
 * Merge CORS headers with route-specific ones. Backward-compatible: callers
 * that pass no `request` get the wildcard origin (prior behavior); passing
 * the request lets the allow-list reflect the matching Origin. Route headers
 * win on key collisions.
 */
export function withCors(
  headers: Record<string, string> = {},
  request?: Request,
): Record<string, string> {
  const origin = request ? request.headers.get("origin") : null;
  return {
    "access-control-allow-origin": resolveAllowOrigin(origin),
    ...BASE_CORS_HEADERS,
    ...headers,
  };
}

export function corsPreflight(request?: Request): Response {
  const origin = request ? request.headers.get("origin") : null;
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": resolveAllowOrigin(origin),
      ...BASE_CORS_HEADERS,
    },
  });
}

/**
 * Optional shared-secret gate. When PARLEY_CLIENT_TOKEN is set, the request
 * must carry header `x-parley-token` equal to it; otherwise a 401 (with CORS
 * headers) is returned. When the env var is unset this is a no-op and returns
 * null so local dev and the first deploy keep working.
 *
 * Returns a Response to short-circuit the handler, or null to proceed.
 *
 * NOTE: for a public PWA this only raises the bar — the token ships inside the
 * client JS bundle, so a determined attacker can read it from the served app.
 * The real trust boundary is the Capacitor native wrap, where the token lives
 * in the app binary rather than on a public URL. Use this as defence-in-depth,
 * not as authentication.
 */
export function requireClientToken(request: Request): Response | null {
  const expected = process.env.PARLEY_CLIENT_TOKEN;
  if (!expected) return null;

  const provided = request.headers.get("x-parley-token");
  if (provided === expected) return null;

  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}

import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

/**
 * CORS for the native iPad app. The Capacitor shell serves the bundled UI from
 * capacitor://localhost and calls server functions here cross-origin (see
 * src/lib/native-bridge.ts). Browsers/webviews send a preflight because the
 * calls carry Authorization + a custom content type. Only the allow-listed
 * native origins get CORS headers — normal web traffic is same-origin and
 * completely unaffected.
 */
const NATIVE_APP_ORIGINS = new Set(
  (process.env.NATIVE_APP_ORIGINS ?? "capacitor://localhost,ionic://localhost")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function nativeCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  return origin && NATIVE_APP_ORIGINS.has(origin) ? origin : null;
}

function preflightResponse(request: Request, origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        request.headers.get("access-control-request-headers") ?? "authorization, content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function withNativeCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const corsOrigin = nativeCorsOrigin(request);
    if (corsOrigin && request.method === "OPTIONS") {
      return preflightResponse(request, corsOrigin);
    }
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return corsOrigin ? withNativeCors(normalized, corsOrigin) : normalized;
    } catch (error) {
      console.error(error);
      const failure = brandedErrorResponse();
      return corsOrigin ? withNativeCors(failure, corsOrigin) : failure;
    }
  },
};

import { createStart, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/**
 * Optional hardening for the server-function "proxy" (a security review flagged
 * it as an open relay — without a gate, anyone with the deploy URL can drain
 * the user's LLM/ElevenLabs quota through it). Applied to EVERY server function
 * via `functionMiddleware`, so no per-function wiring is needed.
 *
 * Two server-side knobs, BOTH unset by default => complete no-op (dev + first
 * deploy keep working unchanged):
 *   PARLEY_ALLOWED_ORIGIN  comma-separated origin allow-list. A present,
 *                          non-allowed cross-origin is rejected. Same-origin /
 *                          no-Origin (SSR, server-to-server) passes.
 *   PARLEY_CLIENT_TOKEN    shared secret; the client must send the matching
 *                          VITE_PARLEY_CLIENT_TOKEN. For a public PWA this only
 *                          raises the bar (the token ships in the bundle) — the
 *                          real boundary is the future Capacitor wrap. Defence
 *                          in depth, not authentication.
 */
const apiGateMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const token = import.meta.env.VITE_PARLEY_CLIENT_TOKEN as string | undefined;
    return next({ sendContext: { parleyToken: token } });
  })
  .server(async ({ next, context }) => {
    const allowList = (process.env.PARLEY_ALLOWED_ORIGIN ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const expectedToken = process.env.PARLEY_CLIENT_TOKEN;

    if (allowList.length || expectedToken) {
      if (allowList.length) {
        const origin = getRequest()?.headers.get("origin");
        // Block only a present, non-allowed cross-origin. Same-origin browsers
        // omit Origin on these POSTs in some cases / send the deploy origin;
        // SSR has no Origin — both pass.
        if (origin && !allowList.includes(origin)) {
          throw new Error("Forbidden origin");
        }
      }
      if (expectedToken) {
        const provided = (context as { parleyToken?: string } | undefined)
          ?.parleyToken;
        if (provided !== expectedToken) {
          throw new Error("Unauthorized");
        }
      }
    }
    return next();
  });

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
  functionMiddleware: [apiGateMiddleware],
}));

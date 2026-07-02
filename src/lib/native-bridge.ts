/**
 * Native-shell bridge for the Capacitor iPad app.
 *
 * Inside the native app the page is served from the local webview origin
 * (capacitor://localhost) — there is no server there. The UI, IndexedDB and
 * audio pipeline are all local, but server functions (the keyed AI/STT/TTS
 * calls) live on the hosted deploy. TanStack Start compiles every server-fn
 * call into a fetch against a relative path (TSS_SERVER_FN_BASE + id), so on
 * native we rewrite exactly those requests to the hosted origin.
 *
 * The web app is completely unaffected: this module no-ops unless the page
 * is actually running inside the Capacitor shell.
 */

// Replaced at build time by TanStack Start's define config (e.g. "/_serverFn/").
// The fallback only matters if a future framework version stops injecting it.
const SERVER_FN_BASE: string =
  (typeof process !== "undefined" && process.env.TSS_SERVER_FN_BASE) || "/_serverFn/";

const DEFAULT_API_ORIGIN = "https://parley.help";

/** Storage key for a runtime override (e.g. pointing a test build at a preview deploy). */
const API_ORIGIN_STORAGE_KEY = "parley_api_origin";

function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const proto = window.location.protocol;
  // iOS WKWebView serves the bundle from capacitor://localhost.
  if (proto === "capacitor:" || proto === "ionic:") return true;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

export function getApiOrigin(): string {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(API_ORIGIN_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  const fromEnv = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim();
  const origin = stored?.trim() || fromEnv || DEFAULT_API_ORIGIN;
  return origin.replace(/\/+$/, "");
}

let installed = false;

/**
 * Idempotent. Called from the router module (both entries reach it) — an
 * explicit call rather than a bare side-effect import because the package is
 * marked `"sideEffects": false`, which would tree-shake an import-only module
 * out of the client bundle.
 */
export function installNativeBridge() {
  if (installed || !isNativeShell()) return;
  installed = true;
  const apiOrigin = getApiOrigin();
  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === "string" || input instanceof URL
          ? new URL(String(input), window.location.href)
          : new URL(input.url, window.location.href);

      // Only requests aimed at the local webview origin AND targeting the
      // server-fn base are rewritten. Static assets (VAD/ONNX models, chunks)
      // stay local; absolute URLs (Supabase, ElevenLabs) pass through.
      if (url.origin === window.location.origin && url.pathname.startsWith(SERVER_FN_BASE)) {
        const rewritten = apiOrigin + url.pathname + url.search;
        if (typeof input === "string" || input instanceof URL) {
          return originalFetch(rewritten, init);
        }
        return originalFetch(new Request(rewritten, input), init);
      }
    } catch {
      /* malformed input — let the original fetch produce the real error */
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof window.fetch;

  console.info(`[native-bridge] server functions → ${apiOrigin}${SERVER_FN_BASE}*`);
}

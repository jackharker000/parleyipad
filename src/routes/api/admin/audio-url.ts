import crypto from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import {
  getServiceAccountCredentials,
  getStorageBucket,
  isAdminConfigured,
} from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Returns a short-lived signed download URL for a Storage blob under
 * `users/<uid>/<table>/<rowId>.bin`, so the admin dashboard can preview a
 * voiceprint contribution without proxying bytes through the function.
 *
 * Admin-only. The URL is V4-signed with the service-account private key and
 * expires in 5 minutes. Mirrors the CORS + 503 pattern of the sibling admin
 * routes. POST body: `{ idToken, storagePath }`.
 */

const STORAGE_PATH_RE = /^users\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.bin$/;
const EXPIRY_SECONDS = 5 * 60;

export const Route = createFileRoute("/api/admin/audio-url")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503, request);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard, request);

        let storagePath: string | undefined;
        try {
          const body = (await request.json()) as { storagePath?: string };
          storagePath = body.storagePath;
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }

        if (typeof storagePath !== "string" || !STORAGE_PATH_RE.test(storagePath)) {
          return json({ error: "Invalid storage path" }, 400, request);
        }

        try {
          const url = signGcsV4Url(getStorageBucket(), storagePath, EXPIRY_SECONDS);
          return json({ url }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/audio-url] sign failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't generate signed URL" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// GCS V4 signed URL — RSA-SHA256 over the canonical request, per
// https://cloud.google.com/storage/docs/access-control/signing-urls-manually
// --------------------------------------------------------------------------

/**
 * Path-encode every URL segment EXCEPT `/` (V4 canonical form requires raw
 * slashes between path components, but every other reserved char must be
 * percent-encoded).
 */
function encodeObjectPath(objectPath: string): string {
  return objectPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function signGcsV4Url(bucket: string, objectPath: string, expiresInSeconds: number): string {
  const { clientEmail, privateKey } = getServiceAccountCredentials();

  const now = new Date();
  const isoDate = formatIsoBasic(now); // YYYYMMDDTHHMMSSZ
  const dateStamp = isoDate.slice(0, 8); // YYYYMMDD

  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const credential = `${clientEmail}/${credentialScope}`;
  const host = "storage.googleapis.com";
  const canonicalUri = `/${bucket}/${encodeObjectPath(objectPath)}`;
  const signedHeaders = "host";

  const queryParams: Array<[string, string]> = [
    ["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
    ["X-Goog-Credential", credential],
    ["X-Goog-Date", isoDate],
    ["X-Goog-Expires", String(expiresInSeconds)],
    ["X-Goog-SignedHeaders", signedHeaders],
  ];
  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const hashedCanonical = crypto
    .createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");

  const stringToSign = [
    "GOOG4-RSA-SHA256",
    isoDate,
    credentialScope,
    hashedCanonical,
  ].join("\n");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(stringToSign)
    .sign(privateKey)
    .toString("hex");

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Goog-Signature=${signature}`;
}

function formatIsoBasic(d: Date): string {
  // YYYYMMDDTHHMMSSZ — strip dashes, colons, milliseconds.
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

// --------------------------------------------------------------------------
// Response helpers — mirror the sibling admin routes verbatim.
// --------------------------------------------------------------------------

function json(body: unknown, status: number, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}

function withCorsResponse(res: Response, request?: Request): Response {
  const headers = withCors({ "content-type": "application/json" }, request);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

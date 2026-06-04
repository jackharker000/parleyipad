import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import type { AuditEvent } from "@/lib/audit-types";

/**
 * Server-only audit logger. Every admin action that mutates state should
 * call `logAdminAction` after the action completes (success, partial, or
 * error). Writes are best-effort: if Firestore is unreachable or the service
 * account isn't configured, we swallow the error so the actual admin action
 * stays the source of truth — losing an audit row is never worse than
 * 500-ing the request the operator just confirmed.
 *
 * Writes a single doc to the project-root `admin_actions` collection via the
 * Firestore REST `documents` endpoint (the Admin SDK bypasses security
 * rules, so the collection stays denied for client access per
 * `docs/setup.md` → "Firestore + Storage Security Rules").
 */

export type { AdminAction, AuditEvent } from "@/lib/audit-types";

/**
 * Append a single audit-event row to `admin_actions`. Never throws — on any
 * failure (missing service account, network blip, malformed body) we log a
 * single warn line and return.
 */
export async function logAdminAction(event: AuditEvent): Promise<void> {
  if (!isAdminConfigured()) return;

  try {
    const token = await getAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/admin_actions`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fields: encodeFields(event) }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[audit] failed to log ${event.action}: ${res.status} ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      "[audit] logger threw — ignoring so the admin action keeps its result:",
      err instanceof Error ? err.message : "unknown",
    );
  }
}

// --------------------------------------------------------------------------
// Firestore REST encoding (subset of what user-data.ts / waitlist.ts decode)
// --------------------------------------------------------------------------

type FirestoreValue =
  | { nullValue: null }
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { arrayValue: { values: FirestoreValue[] } }
  | { mapValue: { fields: Record<string, FirestoreValue> } };

function encodeFields(event: AuditEvent): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {
    action: { stringValue: event.action },
    actorUid: { stringValue: event.actorUid },
    actorEmail: encodeNullable(event.actorEmail),
    targetUid: encodeNullable(event.targetUid),
    status: { stringValue: event.status },
    createdAt: { timestampValue: new Date().toISOString() },
  };

  if (event.targetEmail !== undefined) {
    fields.targetEmail = encodeNullable(event.targetEmail);
  }
  if (event.errorMessage !== undefined) {
    fields.errorMessage = encodeNullable(event.errorMessage);
  }
  if (event.detail && Object.keys(event.detail).length > 0) {
    fields.detail = encodeValue(event.detail);
  }

  return fields;
}

function encodeNullable(v: string | null | undefined): FirestoreValue {
  if (v == null) return { nullValue: null };
  return { stringValue: v };
}

function encodeValue(v: unknown): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number" && Number.isFinite(v)) {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue) } };
  }
  if (typeof v === "object") {
    const out: Record<string, FirestoreValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = encodeValue(val);
    }
    return { mapValue: { fields: out } };
  }
  // Fallback — coerce odd types (BigInt, Symbol, …) to a string rather than
  // crash the logger.
  return { stringValue: String(v) };
}


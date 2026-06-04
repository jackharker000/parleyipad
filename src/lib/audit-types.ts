/**
 * Shared audit-trail types — imported by both the server-side logger
 * (`src/lib/audit.ts`, which writes to Firestore) and the client-side admin
 * pages (`src/routes/admin/activity.tsx` and `users.$userId.tsx`, which render
 * the entries fetched from `/api/admin/activity`).
 *
 * Server-only logic and Firestore REST plumbing live in `src/lib/audit.ts`;
 * keeping the pure shapes here means the client bundle never tries to import
 * the Node-only Firebase helpers.
 */

export type AdminAction =
  | "user.revoke-admin"
  | "user.disable"
  | "user.enable"
  | "user.delete"
  | "waitlist.onboarded"
  | "waitlist.archive"
  | "waitlist.delete"
  | "role.promote-admin";

export type AuditEvent = {
  /** Which action was taken. */
  action: AdminAction;
  /** UID of the admin who took the action (or the user who self-promoted). */
  actorUid: string;
  /** Email of the actor when known (Firebase ID-token claim). */
  actorEmail: string | null;
  /** UID this action was about — null for waitlist (entries aren't Auth users). */
  targetUid: string | null;
  /** Email of the target when we could look it up at the call site. */
  targetEmail?: string | null;
  /** Free-form structured payload — kept small (waitlist id, partial flag, …). */
  detail?: Record<string, unknown>;
  /** "ok" for clean success, "partial" for partial deletes, "error" for thrown failures. */
  status: "ok" | "partial" | "error";
  /** Truncated error message when `status === "error"`. */
  errorMessage?: string | null;
};

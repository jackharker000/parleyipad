import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";

import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * Client-side authentication via Firebase Auth (email/password).
 *
 * `is_admin` comes from a Firebase custom claim (`admin: true`). The first
 * account created in the project is promoted to admin by the server route
 * `/api/auth/ensure-role` (it uses the Admin SDK; the client can't set its
 * own claims). After promotion the client refreshes its ID token so the
 * claim is visible without a re-login.
 */

export type SessionUser = {
  id: string;
  email: string | null;
  is_admin: boolean;
};

export class AuthError extends Error {}

function friendlyError(code: unknown): string {
  switch (code) {
    case "auth/email-already-in-use":
      return "An account with that email already exists.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Email or password is incorrect.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network problem — check your connection and try again.";
    case "auth/unauthorized-domain":
      return "This domain isn't on the Firebase Auth allow-list. Add it under Firebase Console → Authentication → Settings → Authorized domains.";
    case "auth/operation-not-supported-in-this-environment":
      return "Google sign-in isn't available in this environment. Try the email + password form instead.";
    case "auth/internal-error":
      return "Firebase returned an internal error. Try again, or use email + password.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Ask the server to promote the first-ever account to admin, then refresh the token. */
async function ensureRole(user: User): Promise<boolean> {
  try {
    const idToken = await user.getIdToken();
    const res = await fetch("/api/auth/ensure-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (res.ok) {
      const data = (await res.json()) as { is_admin?: boolean };
      if (data.is_admin) {
        // Force a token refresh so the new custom claim is visible.
        await user.getIdToken(true);
        return true;
      }
    }
  } catch {
    // Admin SDK not configured, or transient failure — default to non-admin.
  }
  return false;
}

async function resolve(user: User, runEnsure: boolean): Promise<SessionUser> {
  if (runEnsure) await ensureRole(user);
  const token = await user.getIdTokenResult();
  return {
    id: user.uid,
    email: user.email,
    is_admin: token.claims.admin === true,
  };
}

export async function signUp(email: string, password: string): Promise<SessionUser> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    const cred = await createUserWithEmailAndPassword(
      getFirebaseAuth(),
      email.trim(),
      password,
    );
    return await resolve(cred.user, true);
  } catch (err) {
    throw new AuthError(friendlyError((err as { code?: string })?.code));
  }
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
    // Run ensureRole on sign-in too, so the very first user is promoted even
    // if the post-signup call didn't land.
    return await resolve(cred.user, true);
  } catch (err) {
    throw new AuthError(friendlyError((err as { code?: string })?.code));
  }
}

export async function signInWithGoogle(): Promise<SessionUser> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(getFirebaseAuth(), provider);
    return await resolve(cred.user, true);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // Log the raw code so future unrecognised failures are diagnosable
    // from devtools without digging through the Firebase source.
    console.warn("[auth] signInWithGoogle failed:", code, err);
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      throw new AuthError("Sign-in cancelled.");
    }
    if (code === "auth/popup-blocked") {
      throw new AuthError("Your browser blocked the Google sign-in popup. Allow popups and try again.");
    }
    if (code === "auth/account-exists-with-different-credential") {
      throw new AuthError(
        "An account with this email already exists with a different sign-in method. Try email + password instead.",
      );
    }
    throw new AuthError(friendlyError(code));
  }
}

export async function signOut(): Promise<void> {
  if (!isFirebaseConfigured()) return;
  await fbSignOut(getFirebaseAuth());
}

/** Current user's Firebase ID token (for authenticating calls to /api/admin/*). */
export async function getIdToken(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}

/**
 * Reactive session. Subscribes to Firebase auth state and reads the admin
 * custom claim from the ID token. `loading` is true until the first auth
 * state resolves.
 *
 * Also force-refreshes the ID token whenever the PWA returns to the
 * foreground (`visibilitychange` → visible, `pageshow`). The Firebase SDK
 * normally refreshes on its own schedule, but a PWA can sit suspended
 * for hours or days; touching the token on resume catches any expiry
 * before the next /api/admin call surprises us with a 401 and shoves the
 * user back to /login. The IDB persistence layer in
 * `lib/firebase/client.ts` makes this refresh succeed silently — no
 * network round-trip for the user.
 */
export function useSession(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
    }
    const unsub = onAuthStateChanged(getFirebaseAuth(), async (u) => {
      if (!u) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        const token = await u.getIdTokenResult();
        setUser({ id: u.uid, email: u.email, is_admin: token.claims.admin === true });
      } catch {
        setUser({ id: u.uid, email: u.email, is_admin: false });
      }
      setLoading(false);
    });

    // Resume-refresh: when the tab comes back to the foreground (or the
    // PWA resumes from suspend), force a token refresh so the next
    // authenticated request can't trip a 401-expired race.
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const current = getFirebaseAuth().currentUser;
      if (!current) return;
      void current.getIdToken(true).catch(() => {
        // Refresh failure is non-fatal — onAuthStateChanged will fire
        // with null if the user is genuinely signed out and the
        // existing redirect handles it. A network blip just leaves the
        // old (still-valid) token in place.
      });
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);

    return () => {
      unsub();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);

  return { user, loading };
}

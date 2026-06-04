# Setup

## First-time setup

```bash
git clone <repo-url>
cd ipad-aac-buddy
bun install
cp .env.example .env
```

Then fill in `.env`: the Firebase web config (see below) and the provider keys you want. See `.env.example` for which vars are server-only (no `VITE_` prefix) and which are public.

## Firebase setup

Authentication, the waitlist, and the per-user cloud sync of cockpit data all run on Google Firebase. Create a project and wire it up:

1. Create a Firebase project at https://console.firebase.google.com.
2. **Authentication → Sign-in method**: enable **Email/Password**.
3. **Authentication → Settings → Authorized domains**: add your local dev origin (`localhost`) and your Vercel domains (e.g. `parley.vercel.app` and any custom domain). Firebase Auth refuses sign-ins from origins not listed here.
4. **Firestore Database**: create a database in **production mode** (the waitlist and the per-user data subtrees are written here).
5. **Storage**: open **Build → Storage → Get started** and accept the defaults. This auto-provisions the project's default Storage bucket — needed for voice-sample audio and cached quick-phrase TTS audio to sync.
6. **Project Settings → General → Your apps**: register a Web app and copy its config into the `VITE_FIREBASE_*` vars in `.env`. These are public by design — they only identify the project; access is governed by your Firebase security rules (see below).

## Service account (admin features)

Server-side admin operations and the waitlist write use the Firebase **Admin SDK**, which needs a service-account credential:

1. **Project Settings → Service accounts → Generate new private key** — this downloads a JSON file.
2. Base64-encode it: `base64 -i serviceAccount.json`.
3. Set the resulting single-line string as `FIREBASE_SERVICE_ACCOUNT_B64` — locally in `.env` and in the Vercel project env. Do **not** `VITE_`-prefix it; it is a private key and must never reach the browser.

Without the service account, login still works (that's pure client-side Firebase Auth), but the admin **user list** and **waitlist persistence** don't — the waitlist falls back to validating and acknowledging without saving.

## First admin

There is no SQL or manual promotion step. Two paths in:

- **Allow-list (preferred).** Set `PARLEY_ADMIN_EMAILS` to a comma-separated list of emails — any account that signs in with one of those addresses is automatically promoted to admin on sign-in. Defaults to the project owner (`jackharker000@gmail.com`) if unset.
- **Bootstrap.** Failing the allow-list, **the first account created in the Firebase project** is auto-promoted instead.

Either way, promotion sets an `admin: true` custom claim via the `/api/auth/ensure-role` server route (Admin SDK). It can then reach `/admin`. This requires the service account to be configured; without it, no account is promoted.

## Firestore + Storage Security Rules

The per-user cloud sync (conversations, voiceprints, voice samples, settings, etc.) writes to per-user subtrees in Firestore and Storage. The rules below confine each signed-in user to **their own** subtree, and lock the waitlist + usage events to server-only writes (the Admin SDK / service-account REST path bypasses rules, so the admin still reads everything and the server still persists the waitlist).

These rules are **required** for the per-user sync to be safe — without them, anyone signed in could read or overwrite anyone else's data. Paste each block into the matching rules editor in the Firebase console and publish.

**Firestore** — paste into `firestore.rules` (Firebase console → Firestore Database → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Each user can read/write only their own data.
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // Waitlist is server-write only (Admin SDK / service-account REST).
    match /waitlist/{doc} {
      allow read, write: if false;
    }
    // Usage events same.
    match /usage_events/{doc} {
      allow read, write: if false;
    }
    // Admin audit trail — written by /api/admin/* via the service account
    // (logAdminAction), read only by /api/admin/activity. Locked off the
    // client entirely; users must never see or alter their own audit log.
    match /admin_actions/{doc} {
      allow read, write: if false;
    }
  }
}
```

**Storage** — paste into `storage.rules` (Firebase console → Storage → Rules):

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Publish both. Admin reads (the `/admin/*` dashboard) go through the server using the service account, which bypasses these rules — that's how the admin can still see every user's data without weakening them.

## Dev

```bash
bun run dev
```

The app boots on http://localhost:3000.

## Typecheck

```bash
bun run typecheck
```

## Build

```bash
bun run build
```

## Deploy

Push to the repo's main branch. Vercel auto-detects the TanStack Start project (Nitro under the hood) and builds it. In the Vercel project's environment settings, add:

- the `VITE_FIREBASE_*` client config (public),
- `FIREBASE_SERVICE_ACCOUNT_B64` (secret — enables admin + waitlist persistence),
- the provider keys / model overrides from `.env.example` (LLM/STT/TTS),
- and the optional `PARLEY_ALLOWED_ORIGIN` / `PARLEY_CLIENT_TOKEN` proxy knobs.

Scope each to Production, Preview, and Development as needed.

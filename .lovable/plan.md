## Goal

Add email + password sign-in and back all of James's data to the cloud, so he sees the same data on iPad, Mac, and PC.

## What changes for the user

- First time on each device: a simple **Sign in / Sign up** screen (email + password).
- Once signed in, the app works exactly as it does today, but data lives in the cloud.
- Every change (new conversation, new memory, profile edit, settings tweak) saves to the cloud automatically.
- Sign out button on the Settings page.

Shared-account use case: James and a carer can use the **same email + password** to share everything. (Multi-user sharing can come later if wanted.)

## What gets backed up

Everything currently in local storage:
- People, places, conversations, transcripts, memories, follow-ups
- James's personality profile
- App settings
- Voiceprints (small fingerprints, not raw audio)

Raw audio recordings stay local — they're large and not used after transcription.

## How it works (technical)

1. **Auth**: Lovable Cloud email + password. No email verification (so first sign-in is instant — can be turned on later).
2. **Database**: One Supabase table per existing Dexie table, each with a `user_id` column and Row-Level Security so a user can only ever see their own rows.
3. **Sync layer**: A new `src/lib/cloud-sync.ts` that mirrors the Dexie API but writes to Supabase. The existing `src/lib/db.ts` keeps working as a local cache; on login we pull all rows for the user; on every write we push to Supabase as well. This keeps the app fast and offline-capable.
4. **Routes**:
   - New `/login` route (sign in + sign up tabs).
   - New `_authenticated` layout wraps every existing route so unauthenticated users get redirected to `/login`.
   - Settings page gets a "Signed in as …" row + Sign out button.

## Order of work

1. Create database schema (10 tables + RLS policies).
2. Build `/login` route and `_authenticated` route guard.
3. Wire sync: pull on login, push on every write.
4. Add sign-out + account info on Settings.
5. Test end-to-end: sign up on one "device", sign in on another, see same data.

## Out of scope (for this round)

- Multi-user sharing / invites
- Real-time live updates between two devices open at the same time (changes appear on next refresh / next action)
- Migrating data already in James's current iPad IndexedDB to the cloud (we'll add a one-tap "Upload my existing data" button if he has data worth keeping — let me know)

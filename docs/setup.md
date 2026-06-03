# Setup

## First-time setup

```bash
git clone <repo-url>
cd ipad-aac-buddy
bun install
cp .env.example .env
```

Fill in the provider keys in `.env`. See `.env.example` for which vars are server-only and which are public. Auth needs no configuration — it runs entirely on-device.

## Accounts

Authentication is on-device. There is no identity provider, no auth server, and no email confirmation.

- Create an account by visiting `/signup` in the running app. Accounts are stored locally in the device's IndexedDB (passwords are PBKDF2-hashed), and the session lives in `localStorage`.
- The **first account created on a device automatically becomes the admin** — no SQL, no promotion step. It can reach `/admin`.
- Because accounts are per-device, the admin view only shows accounts on the current device; there is no central user directory.
- The public waitlist form (`/api/waitlist`) currently validates and logs the submission but does **not** persist it — there is no backend. Wiring it to a real store is future work.

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

Push to the repo's main branch. Vercel auto-detects the TanStack Start project (Nitro under the hood) and builds it. Set the provider vars from `.env.example` (LLM/STT/TTS keys, model overrides, and the optional `PARLEY_ALLOWED_ORIGIN` / `PARLEY_CLIENT_TOKEN` proxy knobs) in the Vercel project's environment settings — Production, Preview, and Development scopes as needed. There are no auth vars to set.

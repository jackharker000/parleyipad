# Parley — Promotional Website

This branch carries ONLY the public marketing site. The user dashboard (cockpit, admin, login/signup) lives on `main` and other feature branches. Don't reintroduce auth, Dexie, the speaker-ID engine, the LLM/STT/TTS proxy routes, or any `/app` / `/admin` surface here — if you do, the two trees drift and the marketing site picks up bundle weight it doesn't need.

No Firebase. No client-side database. No PWA install flow.

## What this is

The public face of Parley: who it's for, how it works, what makes it different, and a waitlist for early access. Marketing routes plus a single server route — `/api/waitlist` — that forwards each signup as an email to **jackharker000@gmail.com** via Resend.

## Routes

- **Marketing** (under `_marketing` layout): `/`, `/how-it-works`, `/features`, `/story`, `/privacy`, `/get-started`.
- **API**: `/api/waitlist` (POST).

Anything else is out of scope for this branch.

## Stack

- React 19 + TanStack Start v1 (file-based routing, server functions).
- Tailwind v4 with the Slate & Sun oklch palette in `src/styles.css`.
- Sonner for toasts (the waitlist form uses it).
- **Resend HTTP API** for emailing waitlist signups. No SDK — plain `fetch` against `https://api.resend.com/emails`. Server-side only.

## Env vars

- `RESEND_API_KEY` — required in production for the waitlist to actually email. Without it the endpoint validates the form, logs a non-PII line (`signup (domain: example.com)`) and returns ok, so local dev still works end-to-end.
- `RESEND_FROM_EMAIL` — optional. Defaults to `Parley <hello@parley.help>`. Whatever you set, the address has to be on a Resend-verified domain.
- `PARLEY_ALLOWED_ORIGIN` — optional CORS allow-list (see `src/lib/api-cors.ts`).
- `PARLEY_CLIENT_TOKEN` — optional `x-parley-token` gate on the waitlist endpoint (see `src/lib/api-cors.ts`).

The waitlist recipient is hard-coded as `jackharker000@gmail.com` in `src/routes/api/waitlist.ts` — change it there if the operator changes hands.

## Files

- `src/routes/__root.tsx` — root shell.
- `src/routes/_marketing.tsx` + `src/routes/_marketing/*.tsx` — layout + pages (`index`, `how-it-works`, `features`, `story`, `privacy`, `get-started`).
- `src/routes/api/waitlist.ts` — waitlist intake server route (emails via Resend).
- `src/lib/api-cors.ts` — CORS helpers + optional client-token gate.
- `src/lib/cn.ts` — Tailwind class merger.
- `src/components/site/{SiteHeader,SiteFooter,MediaPlaceholder}.tsx` — shared chrome.
- `src/components/marketing/IpadFramePlaceholder.tsx` — hero/feature visuals.
- `src/components/ui/*` — shadcn-style primitives (Button, Card, Input, etc.).
- `src/components/ParleyLogo.tsx` — wordmark.
- `public/` — static assets.

## Working agreement

- Marketing copy is allowed to evolve freely; flag major IA changes.
- Don't introduce client-side state machines beyond what TanStack Router + React state already give us. Marketing pages are largely static.
- Don't reintroduce dashboard machinery (Dexie, learning loops, speaker-ID, Firebase). If a marketing page needs a piece of the app for a demo, render a static screenshot or a video — not the live engine.
- Keep the waitlist truthful: signups are emailed to the operator. No database; the email is the only record.
- This is a separate deployable surface. The `main` branch deploys the full app; this branch deploys only the marketing site. Keep them independently buildable.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/usage")({
  component: AdminUsagePage,
});

const STAT_CARDS: Array<{ label: string; caption: string }> = [
  {
    label: "Total tokens (LLM, this month)",
    caption: "Sum across Anthropic + OpenAI completions",
  },
  { label: "Total minutes (STT)", caption: "Audio sent to Scribe / Deepgram / Apple" },
  { label: "Total characters (TTS)", caption: "Synthesised via ElevenLabs / Cartesia" },
  { label: "Estimated cost", caption: "Based on current provider list prices" },
];

function AdminUsagePage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
      <p className="mt-2 text-[var(--ink-soft)]">
        Per-user API usage and token cost will appear here once metering is wired.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-[var(--line)] bg-white p-6"
          >
            <div className="text-sm font-medium text-[var(--ink-soft)]">{c.label}</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-[var(--ink-soft)]">
              —
            </div>
            <p className="mt-2 text-xs text-[var(--ink-soft)]">{c.caption}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--sand-2)] p-6">
        <h2 className="text-base font-semibold">Why this is empty</h2>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Per-account usage metering isn&apos;t built yet — every call to our LLM/STT/TTS proxies
          would need to be logged with the calling account&apos;s id. It would also need a backend to
          aggregate across devices, since accounts live on-device. The layout is here so it slots
          in cleanly when it is.
        </p>
      </div>
    </div>
  );
}

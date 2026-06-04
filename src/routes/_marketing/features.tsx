import { createFileRoute, Link } from "@tanstack/react-router";

import { MediaPlaceholder } from "@/components/site/MediaPlaceholder";

export const Route = createFileRoute("/_marketing/features")({
  component: FeaturesPage,
});

type Feature = {
  title: string;
  description: string;
  asset: string;
};

const LEAD: Feature = {
  title: "Speaker recognition that learns voices",
  description:
    "Most AAC apps don't know if Mum is talking or a stranger is. Parley does. Record a few short samples of each person — in the kitchen, the living room, wherever you actually talk — and Parley starts labelling each line as it happens. Recognition runs on the iPad itself. The more you use it, the sharper it gets.",
  asset: "features-speaker-recognition.png",
};

const FEATURES: Feature[] = [
  {
    title: "Context-aware suggestions",
    description:
      "Suggestions are shaped by who's there, where you are, and what was just said — not just the most recent line.",
    asset: "features-suggestions.png",
  },
  {
    title: "Speaks in your own voice",
    description:
      "Use a cloned voice that sounds like you. Quick phrases are pre-cached, so 'Yes', 'No' and 'Give me a moment' fire instantly.",
    asset: "features-tts.png",
  },
  {
    title: "Mood control",
    description:
      "Pick the register that matches the moment — playful, warm, direct — and suggestions follow your lead.",
    asset: "features-mood.png",
  },
  {
    title: "Quick phrases",
    description: "Always-there buttons for the replies you reach for most.",
    asset: "features-quick.png",
  },
  {
    title: "Type-and-expand",
    description: "Type rough shorthand. Parley expands it into a full sentence in your voice.",
    asset: "features-expand.png",
  },
  {
    title: "Reply Helpers",
    description:
      "Draft a Message, an Email or a Facebook post in your voice — without leaving Parley.",
    asset: "features-helpers.png",
  },
  {
    title: "Conversation history",
    description:
      "Every conversation summarised. Transcript searchable. Syncs across your iPads by default, off in one tap if you'd rather it stayed local.",
    asset: "features-recent.png",
  },
  {
    title: "Event prep",
    description:
      "Heading somewhere new? Parley pre-loads who's likely there and what you might want to say.",
    asset: "features-events.png",
  },
  {
    title: "Built for accessibility",
    description: "Large targets, high contrast, full-screen, works on any iPad.",
    asset: "features-accessibility.png",
  },
];

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article className="flex flex-col gap-5 rounded-2xl border border-[var(--line)] bg-white/70 p-6 md:p-8">
      <h3 className="text-xl font-semibold tracking-tight md:text-2xl">{feature.title}</h3>
      <p className="text-base leading-relaxed text-[var(--ink-soft)]">{feature.description}</p>
      <MediaPlaceholder label={`Screenshot — assets/screenshots/${feature.asset}`} />
    </article>
  );
}

function FeaturesPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Features</h1>
      <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
        Everything in Parley exists because something in a real conversation almost didn&apos;t
        happen.
      </p>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        <div className="md:col-span-2">
          <FeatureCard feature={LEAD} />
        </div>
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>

      <div className="mt-20 rounded-3xl bg-[var(--coral-soft)] px-6 py-14 text-center md:px-12 md:py-16">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">Ready to try it?</h2>
        <div className="mt-6">
          <Link
            to="/get-started"
            className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
          >
            Join the waitlist
          </Link>
        </div>
      </div>
    </div>
  );
}

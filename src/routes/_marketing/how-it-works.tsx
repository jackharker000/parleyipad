import { createFileRoute, Link } from "@tanstack/react-router";

import { MediaPlaceholder } from "@/components/site/MediaPlaceholder";

export const Route = createFileRoute("/_marketing/how-it-works")({
  component: HowItWorksPage,
  head: () => ({
    meta: [
      { title: "How Parley works — Parley" },
      {
        name: "description",
        content:
          "One conversation, end to end. What runs on the iPad, what syncs to the cloud, and how a suggestion lands within a second of someone speaking.",
      },
    ],
  }),
});

type StepData = {
  number: number;
  title: string;
  description: string;
  asset: string;
};

const STEPS: StepData[] = [
  {
    number: 1,
    title: "Set the scene",
    description:
      "Tell Parley who's likely to be in the room — at home that's usually Mum, or whoever supports you. Parley uses that to make suggestions feel right from the start.",
    asset: "howitworks-1-setup.png",
  },
  {
    number: 2,
    title: "Press record",
    description:
      "One large button. A live transcript appears as people speak, with each line attributed to the right person.",
    asset: "howitworks-2-recording.png",
  },
  {
    number: 3,
    title: "It knows who's speaking",
    description:
      "Familiar voices get recognised on the iPad — no cloud lookup. Each line is labelled (Mum, Matt, Me).",
    asset: "howitworks-3-speaker-panel.png",
  },
  {
    number: 4,
    title: "Tap to reply",
    description:
      "Suggested replies appear within a second or two, tuned to what was just said and the mood you're in. Tap one — Parley speaks it aloud in your own voice.",
    asset: "howitworks-4-suggestions.png",
  },
  {
    number: 5,
    title: "Your own words, faster",
    description:
      "Type rough shorthand and Parley expands it into a full sentence. Quick phrases like 'Yes', 'No' and 'Give me a moment' are always there — pre-recorded so they speak instantly.",
    asset: "howitworks-5-expand.png",
  },
  {
    number: 6,
    title: "After the chat",
    description:
      "Parley writes a short summary, learns more about how you sound, and gets a little better at sounding like you next time.",
    asset: "howitworks-6-recent.png",
  },
];

function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">How Parley works</h1>
      <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
        One conversation, end to end — what Parley does, what runs on the iPad, and what syncs to
        the cloud.
      </p>

      <ol className="mt-16 flex flex-col gap-16">
        {STEPS.map((step) => (
          <li key={step.number} className="flex flex-col gap-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--teal)] text-base font-semibold text-white">
              {step.number}
            </div>
            <h3 className="text-xl font-semibold tracking-tight md:text-2xl">{step.title}</h3>
            <p className="text-base leading-relaxed text-[var(--ink-soft)]">{step.description}</p>
            <MediaPlaceholder label={`Screenshot — assets/screenshots/${step.asset}`} />
          </li>
        ))}
      </ol>

      <p className="mt-16 text-base leading-relaxed text-[var(--ink-soft)]">
        That&apos;s the loop — listen, understand, suggest, speak — usually in a second or two.
      </p>

      <div className="mt-20 rounded-3xl bg-[var(--coral-soft)] px-6 py-14 text-center md:px-12 md:py-16">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">Ready to try it?</h2>
        <div className="mt-6">
          <Link
            to="/get-started"
            className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
          >
            Request an invite
          </Link>
        </div>
      </div>
    </div>
  );
}

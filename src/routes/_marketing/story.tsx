import { createFileRoute, Link } from "@tanstack/react-router";

import { MediaPlaceholder } from "@/components/site/MediaPlaceholder";

export const Route = createFileRoute("/_marketing/story")({
  component: StoryPage,
  head: () => ({
    meta: [
      { title: "Our story — Parley" },
      {
        name: "description",
        content:
          "Parley was built with James, a non-speaking man with cerebral palsy. We're now opening it to a small first cohort of users and the people who support them.",
      },
    ],
  }),
});

function StoryPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Our story</h1>

      <section className="mt-16 flex flex-col gap-6">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">The why</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Parley was built for James, a non-speaking man with cerebral palsy. The everyday reality
          is that conversations move at the speed of voice — and for someone who can&apos;t speak
          easily, the moment to reply is usually gone before the words are. Parley exists because
          that&apos;s a loss worth fixing.
        </p>
        <MediaPlaceholder
          label="Photo — assets/photos/james-portrait.jpg (consent required before publishing)"
          aspect="[4/3]"
        />
      </section>

      <blockquote className="mt-16 border-l-4 border-[var(--teal)] pl-6 text-xl italic leading-relaxed text-[var(--ink)] md:text-2xl">
        If it works for James, it can work for others who deserve to be heard.
      </blockquote>

      <section className="mt-16 flex flex-col gap-6">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">The build</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Every feature in Parley started as a real-life moment: a tea getting cold while a sentence
          was being typed, a joke landing too late, a phone call James couldn&apos;t answer in his
          own voice. We built it hand-in-hand with him, and the design exists because something
          almost didn&apos;t happen.
        </p>
      </section>

      <section className="mt-16 flex flex-col gap-6">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">The mission</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          We&apos;re now opening Parley to others. The aim is small, careful, and respectful: a
          cohort of non-speaking users and the people who support them, helping shape something that
          works for more than one life.
        </p>
      </section>

      <section className="mt-16 flex flex-col gap-6">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">A note on dignity</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Parley helps someone be heard. It never speaks for them. Suggestions are tapped, not
          auto-sent. Quick phrases are theirs to pick. Consent matters — including for photos and
          stories on this site.
        </p>
      </section>

      <div className="mt-20 rounded-3xl bg-[var(--coral-soft)] px-6 py-14 text-center md:px-12 md:py-16">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          Want to be part of this?
        </h2>
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

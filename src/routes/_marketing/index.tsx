import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Ear, Users, Volume2 } from "lucide-react";

import { IpadFramePlaceholder } from "@/components/marketing/IpadFramePlaceholder";

export const Route = createFileRoute("/_marketing/")({
  component: HomePage,
});

type FeatureCardProps = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
};

function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-white/70 p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--sand-2)] text-[var(--ink)]">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

type StepProps = {
  number: number;
  title: string;
  description: string;
};

function Step({ number, title, description }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--teal)] text-base font-semibold text-white">
        {number}
      </div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

type ChipFeatureProps = {
  title: string;
  description: string;
};

function ChipFeature({ title, description }: ChipFeatureProps) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-5">
      <h4 className="text-base font-semibold tracking-tight">{title}</h4>
      <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

function HomePage() {
  return (
    <div className="text-[var(--ink)]">
      {/* 1. Hero */}
      <section className="mx-auto w-full max-w-6xl px-5 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--teal)]">
              Built for non-speaking people. On iPad.
            </p>
            <h1 className="mt-4 text-5xl font-semibold tracking-tight md:text-6xl">
              Be in the conversation, in your own voice.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--ink-soft)]">
              Parley listens to the room, works out who&apos;s talking, and
              offers replies you can tap to say out loud — in a cloned version
              of your own voice. Built for people who can&apos;t speak, or
              can&apos;t type fast enough to keep up.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/get-started"
                className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
              >
                Request an invite
              </Link>
              <Link
                to="/how-it-works"
                className="text-sm font-semibold text-[var(--teal)] underline underline-offset-4"
              >
                See how it works
              </Link>
            </div>
            <p className="mt-4 text-sm text-[var(--ink-soft)]">
              Already using Parley?{" "}
              <Link
                to="/login"
                className="font-semibold text-[var(--teal)] underline underline-offset-4"
              >
                Log in
              </Link>
              .
            </p>
            <p className="mt-6 text-sm text-[var(--ink-soft)]">
              Voice recognition runs on the iPad. Your account and conversation
              history sync to our secure cloud — switch that off any time.
            </p>
          </div>
          <div className="lg:pl-4">
            <IpadFramePlaceholder
              label="Screenshot — assets/screenshots/home-hero-cockpit.png"
              aspect="[4/3]"
            />
          </div>
        </div>
      </section>

      {/* 2. James — promoted up */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              This was built for one man. Now it&apos;s built for more.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-[var(--ink-soft)]">
              Parley was built for James, a non-speaking man with cerebral
              palsy. Every feature exists because something in a conversation
              almost didn&apos;t happen for him. We&apos;re now opening it to
              others who deserve to be heard the same way.
            </p>
            <blockquote className="mt-8 border-l-4 border-[var(--teal)] pl-5 text-xl italic leading-relaxed text-[var(--ink)] md:text-2xl">
              If it works for James, it can work for others who deserve to be
              heard.
            </blockquote>
            <Link
              to="/story"
              className="mt-8 inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
            >
              Read our story
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div>
            <IpadFramePlaceholder
              label="Photo — assets/photos/james-using-parley.jpg (consent required before publishing)"
              aspect="[4/3]"
            />
          </div>
        </div>
      </section>

      {/* 3. Three-up — outcomes first */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="max-w-3xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Conversations move fast. Parley keeps you in them.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
            For someone who can&apos;t speak — or can&apos;t type quickly — the
            moment to reply is often gone before the words are ready. Parley
            closes that gap.
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <FeatureCard
            icon={Volume2}
            title="You sound like you, not a robot."
            description="Replies are spoken in a voice cloned from yours. Quick phrases play instantly, so 'yes' and 'give me a moment' never feel late."
          />
          <FeatureCard
            icon={Users}
            title="It knows who's in the room."
            description="Parley learns the voices of the people you talk to — partner, parent, sibling, support worker — and labels each line as they speak."
          />
          <FeatureCard
            icon={Ear}
            title="Replies that fit the moment."
            description="Suggestions are shaped by who's there, where you are, and what was just said. Tap one to speak it aloud."
          />
        </div>
      </section>

      {/* 4. Demo video */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            See it in action
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-soft)]">
            One conversation, start to finish.
          </p>
        </div>
        <div className="mx-auto mt-10 max-w-4xl">
          <IpadFramePlaceholder
            label="Video — assets/videos/parley-demo.mp4"
            aspect="video"
            kind="video"
          />
        </div>
      </section>

      {/* 5. How it works teaser */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          How a Parley conversation works
        </h2>
        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-x-12 md:gap-y-10">
          <Step
            number={1}
            title="Set the scene"
            description="Tell Parley who's likely to be there."
          />
          <Step
            number={2}
            title="Press record"
            description="One big button. A live transcript appears."
          />
          <Step
            number={3}
            title="It knows who's speaking"
            description="Familiar voices get labelled automatically."
          />
          <Step
            number={4}
            title="Tap to reply"
            description="Suggested replies tuned to the moment — spoken in your own voice."
          />
        </div>
        <div className="mt-12">
          <Link
            to="/how-it-works"
            className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
          >
            Read the full walkthrough
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* 6. Features grid — chips */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Everything Parley does, in one screen.
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          <ChipFeature
            title="Cloned voice"
            description="Every reply spoken in a voice that sounds like you."
          />
          <ChipFeature
            title="Quick phrases"
            description="Five everyday answers, always there, zero latency."
          />
          <ChipFeature
            title="Type-and-expand"
            description="Type 'tea pls thx' — Parley says 'A tea would be lovely, thank you.'"
          />
          <ChipFeature
            title="Set the tone"
            description="Pick playful, warm or direct — suggestions follow your lead."
          />
          <ChipFeature
            title="Drafts for messages, emails, posts"
            description="Reply helpers, drafted in your voice, without leaving the app."
          />
          <ChipFeature
            title="Event prep"
            description="Heading somewhere new? Parley pre-loads who's likely there."
          />
        </div>
        <div className="mt-8">
          <Link
            to="/features"
            className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
          >
            See every feature
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* 7. Privacy strip — toned down to a contained card */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="rounded-3xl border border-[var(--line)] bg-[var(--sand-2)] px-6 py-12 text-[var(--ink)] md:px-12 md:py-16">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Honest about what&apos;s on your iPad — and what isn&apos;t.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
              Voice recognition — the model that learns who&apos;s speaking —
              runs on the iPad itself; the live microphone audio in the moment
              of a conversation never leaves it. Conversations, voice samples,
              profile and settings sync to our secure Firebase by default so
              they travel across devices and we can help when something breaks.
              You can switch sync off per account. We don&apos;t sell your
              data, and we say so plainly on the privacy page.
            </p>
            <Link
              to="/privacy"
              className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] underline underline-offset-4 hover:text-[var(--teal-dark)]"
            >
              See exactly what syncs
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* 8. Get started CTA */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="mx-auto max-w-3xl rounded-3xl bg-[var(--coral-soft)] px-6 py-14 text-center md:px-12 md:py-16">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Know someone Parley could help?
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[var(--ink-soft)] md:text-lg">
            We&apos;re letting a handful of families and AAC users in first, so
            we can get this right with you. Tell us about the person Parley
            would be for — we&apos;ll come back personally.
          </p>
          <div className="mt-8">
            <Link
              to="/get-started"
              className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
            >
              Request an invite
            </Link>
          </div>
          <p className="mt-4 text-sm text-[var(--ink-soft)]">
            Or email{" "}
            <a
              href="mailto:hello@parley.help"
              className="font-medium text-[var(--teal)] underline underline-offset-4 hover:text-[var(--teal-dark)]"
            >
              hello@parley.help
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  );
}

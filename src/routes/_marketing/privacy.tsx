import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_marketing/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Privacy &amp; safety</h1>
      <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
        Plain English, in this order: what we hold, where we hold it, who can see it, and how to
        take it back. A formal policy comes later.
      </p>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What syncs to the cloud
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Account sign-in and the waitlist run on Google Firebase under our project. By default, the
          data you build up while using Parley also syncs there as you use the app — so it can
          travel with you across devices and so we can help when something breaks.
        </p>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Specifically, the things that sync are: conversation transcripts and turn-by-turn history,
          the voiceprints Parley has learned and the short voice samples used to enrol them, your
          profile and writing-style notes, your saved people, places and events, helper drafts,
          remembered facts and follow-ups, the suggestions Parley has shown you, and your in-app
          settings. Cached audio for the quick-phrase buttons syncs too.
        </p>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          You can turn cloud sync off per account in{" "}
          <strong className="font-semibold text-[var(--ink)]">
            Settings → System → Cloud sync
          </strong>
          . With it off, the account still works — your data just stays on that iPad.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What stays on your iPad
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          The speech recognition that picks out who&apos;s talking runs on the iPad itself. The
          model never moves to the cloud, and neither does the live microphone audio Parley listens
          to in the moment of a conversation — the audio stream and the matching computation stay on
          the device.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">Who can see your data</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          We&apos;ll be straight with you: the operator of Parley — currently the developer who runs
          this project, reachable at the email at the bottom of this page — has admin access to our
          Firebase project and can read everything that syncs to it. That access is used to keep the
          app working for you and to make it better. We don&apos;t sell your data, and we don&apos;t
          share it with third parties for their own purposes.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What uses the internet, and why
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Suggestion generation, transcript-to-text and your cloned voice need to call AI services
          over the internet — that&apos;s how those services work. The keys for those services stay
          on our server, not on your iPad. Nothing about your conversations is sold or used for
          advertising, by us or our providers.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">You&apos;re in control</h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Cloud sync can be switched off per account in{" "}
          <strong className="font-semibold text-[var(--ink)]">
            Settings → System → Cloud sync
          </strong>{" "}
          — the account still works, your data just stays on the iPad. You can export your on-device
          data — encrypted with a password if you want — from{" "}
          <strong className="font-semibold text-[var(--ink)]">Settings → System → Export</strong> —
          and you can restore one of those files on a new device from{" "}
          <strong className="font-semibold text-[var(--ink)]">Settings → System → Restore</strong>.
          You can wipe everything with one button under{" "}
          <strong className="font-semibold text-[var(--ink)]">
            Settings → System → Danger zone
          </strong>
          .
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What you&apos;ll need to consent to
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          We&apos;ll ask before we use anything identifiable in materials — a photo, a story, an
          example transcript. Default is private.
        </p>
      </section>

      <p className="mt-16 text-sm text-[var(--ink-soft)]">
        Questions? Email{" "}
        <a
          href="mailto:hello@parley.help"
          className="font-medium text-[var(--teal)] underline underline-offset-2 hover:text-[var(--teal-dark)]"
        >
          hello@parley.help
        </a>
        .
      </p>
    </div>
  );
}

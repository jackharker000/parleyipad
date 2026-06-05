import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { db, type JamesProfile, type SettingsRecord } from "@/lib/db";

/**
 * First-run setup checklist that sits ABOVE the cockpit grid on /app.
 *
 * State is computed from live Dexie data — no new tables, no flags. Dismissal
 * persists in localStorage (`parley.onboarding.dismissed = "1"`) so a user who
 * deliberately closes the card doesn't see it again, even if they later wipe
 * a row.
 *
 * The card renders nothing once:
 *   1) all five steps are complete, OR
 *   2) the user has tapped Dismiss.
 *
 * displayName sentinel: `DEFAULT_JAMES_PROFILE.displayName` is "James" (the
 * historic single-user default that several downstream call-sites rely on as
 * a fallback). Rather than break those, the checklist treats both an absent
 * row AND the literal "James" string as "not yet set" — matching the
 * AboutJamesTab's own "is this real?" gate (`displayName !== "James"`).
 */

const DISMISS_KEY = "parley.onboarding.dismissed";

type StepId = "name" | "voice" | "people" | "samples" | "conversation";

type Step = {
  id: StepId;
  title: string;
  description: string;
  done: boolean;
  /** Tap target text when the step is still pending. */
  cta: string;
  /** Where the CTA navigates. `null` means "stay here" (e.g. the Record button). */
  to: string | null;
  /** Optional sub-step note shown beneath the description. */
  note?: string;
};

function isDisplayNameSet(profile: JamesProfile | undefined): boolean {
  const name = profile?.displayName?.trim();
  if (!name) return false;
  // "James" is the historic seed value (see DEFAULT_JAMES_PROFILE) and is
  // treated as "not yet set" so non-James users get prompted to fill it in.
  // James himself will see this step pre-checked once he hits Save in
  // Settings (the trimmed string still passes the !== "James" guard if he
  // typed "James " or "James H" etc.).
  if (name === "James") return false;
  return true;
}

function isVoiceSet(settings: SettingsRecord | undefined): boolean {
  const id = settings?.jamesVoiceId;
  return typeof id === "string" && id.trim().length > 0;
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode / quota — silent */
  }
}

export function SetupChecklist(): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  // Sync once on mount in case the value changed in another tab. We don't
  // listen to "storage" events — onboarding is a one-shot UX, not a real-time
  // shared piece of state.
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const jamesProfile = useLiveQuery(() => db().jamesProfile.get("singleton"), []);
  const settings = useLiveQuery(() => db().settings.get("singleton"), []);
  const peopleCount = useLiveQuery(() => db().people.count(), [], 0);
  // `source` isn't indexed on voiceprintContributions (schema is
  // "id, personId, conversationId, createdAt"), so .where("source")
  // throws "KeyPath source ... is not indexed" at runtime. Voice
  // samples per device are bounded to a couple of dozen, so a filter
  // scan is fine and avoids a schema migration.
  const enrollmentSampleCount = useLiveQuery(
    () => db().voiceprintContributions.filter((c) => c.source === "enrollment").count(),
    [],
    0,
  );
  const conversationCount = useLiveQuery(() => db().conversations.count(), [], 0);

  const steps = useMemo<Step[]>(() => {
    const nameDone = isDisplayNameSet(jamesProfile);
    const voiceDone = isVoiceSet(settings);
    const peopleDone = (peopleCount ?? 0) > 0;
    const samplesDone = (enrollmentSampleCount ?? 0) > 0;
    const conversationDone = (conversationCount ?? 0) > 0;
    return [
      {
        id: "name",
        title: "Set your display name",
        description: "So Parley knows what to call you in transcripts and prompts.",
        done: nameDone,
        cta: "Set your name",
        to: "/app/settings",
      },
      {
        id: "voice",
        title: "Choose your TTS voice",
        description: "Pick or clone the voice Parley uses to speak for you.",
        done: voiceDone,
        cta: "Choose a voice",
        to: "/app/settings",
      },
      {
        id: "people",
        title: "Add the people you talk to",
        description:
          "Family, friends, support workers — anyone you want Parley to recognise.",
        done: peopleDone,
        cta: "Add people",
        to: "/app/people",
      },
      {
        id: "samples",
        title: "Record voice samples",
        description: "Short clips of each person speaking, so speaker-ID can learn them.",
        note: peopleDone ? undefined : "After adding someone above.",
        done: samplesDone,
        cta: "Record samples",
        to: "/app/people",
      },
      {
        id: "conversation",
        title: "Try your first conversation",
        description: "Tap Record at the top of the cockpit and let someone speak.",
        done: conversationDone,
        cta: "Back to the cockpit",
        to: null,
      },
    ];
  }, [jamesProfile, settings, peopleCount, enrollmentSampleCount, conversationCount]);

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  // Persist dismissal the moment the user reaches all-done so the card
  // auto-hides on the next mount. We deliberately keep showing the
  // "All set!" celebration in the current render (the user gets one
  // closure moment) before it disappears for good.
  useEffect(() => {
    if (allDone) {
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  }, [allDone]);

  if (dismissed) return null;
  if (allDone && doneCount === 0) {
    // Defensive: shouldn't be reachable, but keeps the guard explicit.
    return null;
  }

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  return (
    <section
      aria-label="Setup checklist"
      className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-lg font-semibold text-[var(--ink)]">Let's set up Parley</h2>
          <span className="text-sm text-[var(--ink-soft)]">
            {doneCount} of {steps.length} done
          </span>
          <ProgressBar done={doneCount} total={steps.length} />
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex min-h-[40px] items-center gap-1 rounded-md px-2 text-sm text-[var(--ink-soft)] hover:bg-[var(--sand-2)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          aria-label="Dismiss setup checklist"
        >
          <X className="h-4 w-4" />
          Dismiss
        </button>
      </header>

      {allDone ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--sand-2)] p-4">
          <p className="text-sm font-medium text-[var(--ink)]">
            All set! You're ready to have a conversation.
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex min-h-[40px] items-center rounded-full bg-[var(--teal)] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <ol className="mt-4 space-y-2">
          {steps.map((step, i) => (
            <StepRow key={step.id} step={step} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className="h-2 w-32 overflow-hidden rounded-full bg-[var(--sand-2)]"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} steps complete`}
    >
      <div
        className="h-full bg-[var(--teal)] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StepRow({ step, index }: { step: Step; index: number }) {
  return (
    <li
      className={cn(
        "flex min-h-[64px] items-center gap-3 rounded-xl p-3 transition-colors",
        step.done ? "bg-[var(--sand-2)]/60" : "bg-[var(--sand-2)]/30 hover:bg-[var(--sand-2)]/50",
      )}
    >
      <StepIndicator done={step.done} index={index} />
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-sm font-semibold",
            step.done ? "text-[var(--ink-soft)]" : "text-[var(--ink)]",
          )}
        >
          {step.title}
        </p>
        <p className="text-xs text-[var(--ink-soft)]">{step.description}</p>
        {step.note && !step.done && (
          <p className="mt-0.5 text-xs italic text-[var(--ink-soft)]/80">{step.note}</p>
        )}
      </div>
      <StepCta step={step} />
    </li>
  );
}

function StepIndicator({ done, index }: { done: boolean; index: number }) {
  if (done) {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--teal)] text-white"
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[var(--ink-soft)]/40 text-xs font-semibold text-[var(--ink-soft)]"
    >
      {index + 1}
    </span>
  );
}

function StepCta({ step }: { step: Step }) {
  if (step.done) {
    return (
      <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--ink-soft)]">
        Done <Check className="inline h-3 w-3" />
      </span>
    );
  }
  const buttonClass =
    "inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-full bg-[var(--teal)] px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2";
  if (step.to === null) {
    // No link — this is the "use the cockpit" step; tapping just scrolls to
    // the top of the page where the Record button lives.
    return (
      <button
        type="button"
        onClick={() => {
          if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        className={buttonClass}
      >
        {step.cta} <span aria-hidden="true">→</span>
      </button>
    );
  }
  return (
    <Link to={step.to} className={buttonClass}>
      {step.cta} <span aria-hidden="true">→</span>
    </Link>
  );
}

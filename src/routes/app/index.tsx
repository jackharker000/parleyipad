import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Calendar,
  Check,
  History,
  Loader2,
  Mic,
  Plus,
  Reply,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SetupChecklist } from "@/components/onboarding/SetupChecklist";
import { SpeakerPanel } from "@/components/SpeakerPanel";
import { VoiceSampleRecorder } from "@/components/VoiceSampleRecorder";
import { cn } from "@/lib/cn";
import {
  db,
  type EventRecord,
  type Person,
  type SuggestionCategory,
  type Voiceprint,
  type VoiceprintContribution,
} from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { makeWorkerEmbedder, type SpeakerEmbedder } from "@/lib/audio/embedder";
import { makeAI, MOODS, type Mood, type SuggestionDraft } from "@/lib/ai";
import type { Candidate } from "@/lib/audio/matcher";
import {
  LiveConversation,
  type ConversationState,
  type LiveTranscriptSegment,
} from "@/lib/conversation";
import {
  warmQuickPhraseCache,
  QUICK_PHRASES as CACHED_PHRASES,
} from "@/lib/audio/quick-phrase-cache";
import { speakText, stopAllPlayback } from "@/lib/audio/speak-text";
import { drainPendingJobs } from "@/lib/jobs/drain";

export const Route = createFileRoute("/app/")({
  component: HomePage,
});

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];
const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_CONTRIBUTIONS: VoiceprintContribution[] = [];

/**
 * The five canonical quick phrases shown along the bottom of the
 * Suggestions panel. Order and exact text are locked because the
 * pre-warmed audio cache in `quick-phrase-cache.ts` keys on the literal
 * strings; drift here silently downgrades quick-phrase taps to live TTS.
 */
const QUICK_PHRASES: string[] = [
  "Yes",
  "No",
  "Give me a moment",
  "Could you repeat that?",
  "Sorry, who am I speaking with?",
];

if (typeof window !== "undefined" && QUICK_PHRASES.some((p, i) => p !== CACHED_PHRASES[i])) {
  console.warn(
    "[cockpit] QUICK_PHRASES text drifted from cached set — quick phrases will miss cache",
  );
}

type MoodChip = { id: Mood; label: string; tone: string };

/**
 * Visual swatches for the mood pills along the bottom. The IDs match the
 * `Mood` union from `@/lib/ai` exactly so passing the active chip back into
 * `setMood` is a straight assignment.
 */
const MOOD_CHIPS: MoodChip[] = [
  { id: "normal", label: "Normal", tone: "bg-secondary text-secondary-foreground" },
  { id: "calm", label: "Calm", tone: "bg-sky-500 text-white" },
  { id: "excited", label: "Excited", tone: "bg-amber-500 text-white" },
  { id: "sad", label: "Sad", tone: "bg-blue-700 text-white" },
  { id: "upset", label: "Upset", tone: "bg-red-600 text-white" },
  { id: "empathetic", label: "Empathetic", tone: "bg-emerald-600 text-white" },
  { id: "amused", label: "Amused", tone: "bg-fuchsia-600 text-white" },
];
// Sanity guard: keep the chips list in lock-step with MOODS so a new mood
// landing in ai/domain.ts surfaces as a missing pill warning during dev.
if (typeof window !== "undefined") {
  for (const m of MOODS) {
    if (!MOOD_CHIPS.some((c) => c.id === m)) {
      console.warn(`[cockpit] missing mood chip for "${m}"`);
    }
  }
}

function HomePage() {
  return <ClientCockpit />;
}

function ClientCockpit() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <CockpitSkeleton />;
  }
  return <Cockpit />;
}

/**
 * Layout-preserving skeleton for the cockpit's first paint. Mirrors the
 * action row + main grid so the viewport doesn't reflow when the real
 * cockpit mounts.
 */
function CockpitSkeleton() {
  return (
    <div
      className="flex h-full w-full flex-col bg-background"
      role="status"
      aria-label="Loading cockpit"
    >
      <div className="flex shrink-0 items-stretch gap-2 border-b border-border bg-card px-3 py-3">
        <div className="h-[120px] w-[120px] animate-pulse rounded-2xl bg-muted" />
        <div className="h-[120px] flex-1 animate-pulse rounded-2xl bg-muted" />
        <div className="h-[120px] w-[120px] animate-pulse rounded-2xl bg-muted" />
        <div className="h-[120px] w-[120px] animate-pulse rounded-2xl bg-muted" />
        <div className="h-[120px] w-[120px] animate-pulse rounded-2xl bg-muted" />
        <div className="h-[120px] w-[120px] animate-pulse rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

/**
 * Map the raw onnxruntime-web / transformers.js error to something the
 * user can act on. The OOM path produces a stack of chained failures
 * (one per backend) once the WASM init flag is poisoned, so surfacing
 * the raw message was bewildering. Detect the memory cause specifically
 * so the user knows to close other apps; keep a generic fallback for
 * anything else (model download failures on flaky networks, etc.).
 */
function humanizeEmbedderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("out of memory") ||
    lower.includes("rangeerror") ||
    lower.includes("initwasm") ||
    lower.includes("no available backend")
  ) {
    return "Speaker recognition needs more memory than this iPad has free. Close other apps, then tap Retry — or carry on and everyone will be labelled Unknown.";
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("failed to fetch")) {
    return "Couldn't download the speaker recognition model. Check your connection, then Retry — or carry on and everyone will be labelled Unknown.";
  }
  return "Speaker recognition couldn't start. Tap Retry, or carry on without it — everyone will be labelled Unknown.";
}

function Cockpit() {
  const settings = useSettings();

  // Embedder warmup. Worker-backed transformers.js — the periodic dispose
  // +warmup cycle (every N turns per the OOM mitigation) runs off the main
  // thread so the cockpit never freezes. dispose() terminates the worker,
  // which is the only reliable way to actually release ORT's WASM heap on
  // iPad Safari.
  //
  // `retryEmbedderNonce` bumps when the user taps Retry after a warmup
  // failure — the dependency change triggers a fresh effect, which
  // disposes the previous (failed) embedder, builds a new one, and tries
  // warming again. With a freshly-spawned worker the ORT global init
  // state isn't poisoned by the prior failed initWasm().
  const embedderRef = useRef<SpeakerEmbedder | null>(null);
  const [embedderReady, setEmbedderReady] = useState(false);
  const [embedderError, setEmbedderError] = useState<string | null>(null);
  const [retryEmbedderNonce, setRetryEmbedderNonce] = useState(0);
  useEffect(() => {
    setEmbedderReady(false);
    setEmbedderError(null);
    embedderRef.current?.dispose?.();
    const next = makeWorkerEmbedder({ preferWebGPU: settings.speakerIdWebGPU });
    embedderRef.current = next;
    let cancelled = false;
    (async () => {
      try {
        await next.warmup?.();
        if (!cancelled) setEmbedderReady(true);
      } catch (err) {
        if (cancelled) return;
        // Warmup failed — most often iPad Safari's WASM heap OOMs while
        // loading the WavLM weights, and once that happens ORT's global
        // initWasm() flag is poisoned so every other backend errors with
        // "previous call to 'initWasm()' failed". Tear the worker down so
        // the next Retry tap gets a fresh ORT state, null the ref so
        // LiveConversation routes around the missing embedder (it already
        // handles `embedderRef.current === null` — speaker-ID is just
        // skipped and everyone is labelled Unknown until the user
        // retries), and mark ready so the Record button stops gating on
        // the warmup state.
        try {
          await next.dispose?.();
        } catch {
          /* best-effort release */
        }
        embedderRef.current = null;
        setEmbedderError(humanizeEmbedderError(err));
        setEmbedderReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.speakerIdWebGPU, retryEmbedderNonce]);

  const retryEmbedder = useCallback(() => {
    setRetryEmbedderNonce((n) => n + 1);
  }, []);

  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const voiceprints = useLiveQuery(() => db().voiceprints.toArray(), [], EMPTY_VOICEPRINTS);
  const events = useLiveQuery(
    () => db().events.orderBy("start").reverse().toArray(),
    [],
    EMPTY_EVENTS,
  );
  // Places are not surfaced as a picker in the cockpit chrome (the legacy
  // chip lives in Settings → Locations), but the engine still reads
  // selectedPlaceId for the 2× speaker-ID prior boost when one is set.
  const voiceprintContributions = useLiveQuery(
    () => db().voiceprintContributions.toArray(),
    [],
    EMPTY_CONTRIBUTIONS,
  );
  const jamesProfile = useLiveQuery(() => db().jamesProfile.get("singleton"), []);

  // Closed-set roster state. Maintained pre-Record from the People picker
  // modal; mid-conversation additions flow through LiveConversation.addToRoster.
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

  // Modal visibility for the People + Event pickers (popovers, not pages —
  // tier3 + legacy both kept these inline so the cockpit never navigates).
  const [showPeoplePicker, setShowPeoplePicker] = useState(false);
  const [showEventPicker, setShowEventPicker] = useState(false);

  // Auto-fill the roster from a selected event's expected attendees.
  useEffect(() => {
    if (!selectedEventId) return;
    const evt = events.find((e) => e.id === selectedEventId);
    if (!evt) return;
    setSelectedPersonIds((prev) => {
      const merged = new Set(prev);
      for (const id of evt.personIds) merged.add(id);
      return Array.from(merged);
    });
  }, [selectedEventId, events]);

  // Per-person sample count so the picker can flag "needs enrolling".
  const sampleCountByPerson = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of voiceprintContributions) {
      m.set(c.personId, (m.get(c.personId) ?? 0) + 1);
    }
    return m;
  }, [voiceprintContributions]);

  const ai = useMemo(() => makeAI(settings.llmProvider), [settings.llmProvider]);

  const [state, setState] = useState<ConversationState>("idle");
  const [transcript, setTranscript] = useState<LiveTranscriptSegment[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionDraft[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [mood, setMood] = useState<Mood>("normal");
  const [speakingText, setSpeakingText] = useState<string | null>(null);
  const [missingKeys, setMissingKeys] = useState<Set<string>>(new Set());
  // "Type roughly" draft text — sticky across re-renders so the keyboard
  // never closes mid-thought. Cleared on Speak.
  const [draft, setDraft] = useState("");
  const [expanding, setExpanding] = useState(false);

  const conversationRef = useRef<LiveConversation | null>(null);

  // Lazy-build the LiveConversation on first start so the embedder/people
  // queries have already populated.
  const ensureConversation = useCallback(() => {
    if (conversationRef.current) return conversationRef.current;
    const conv = new LiveConversation({
      embedderRef,
      ai,
      settings,
      // Empty string is "not yet set" — downstream code (AI prompts,
      // transcript labels) substitutes the appropriate generic fallback.
      jamesName: jamesProfile?.displayName?.trim() ?? "",
      jamesProfile: jamesProfile ?? undefined,
      eventId: selectedEventId ?? undefined,
      placeId: selectedPlaceId ?? undefined,
    });
    conv.on({
      onStateChange: setState,
      onTranscriptSegment: (segment) =>
        setTranscript((prev) => {
          // Dedupe by id: streaming STT emits a `partial` segment that gets
          // replaced in place when the `final` lands. The conversation lib
          // calls both onTranscriptSegment + onTranscriptSegmentUpdated for
          // partials, so the first arrival appends and subsequent updates
          // go through the updater below.
          if (prev.some((s) => s.id === segment.id)) {
            return prev.map((s) => (s.id === segment.id ? { ...s, ...segment } : s));
          }
          return [...prev, segment].slice(-40);
        }),
      onTranscriptSegmentUpdated: (updated) =>
        setTranscript((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s))),
      onSuggestions: (s, generating) => {
        setSuggestions(s);
        setSuggestionsLoading(generating);
      },
      onSpeakerCandidates: setCandidates,
      onError: (err) => {
        const key = detectMissingKey(err.message);
        if (key) {
          setMissingKeys((prev) => {
            if (prev.has(key)) return prev;
            const next = new Set(prev);
            next.add(key);
            return next;
          });
          return;
        }
        toast.error(err.message);
      },
    });
    conversationRef.current = conv;
    return conv;
  }, [ai, settings, jamesProfile?.displayName]);

  // Keep roster + mood + persona in sync with the live conversation instance.
  useEffect(() => {
    conversationRef.current?.setRoster({ people, voiceprints });
  }, [people, voiceprints]);
  useEffect(() => {
    conversationRef.current?.setMood(mood);
  }, [mood]);
  useEffect(() => {
    conversationRef.current?.setJamesProfile(jamesProfile ?? undefined);
    // Depend on the stable `updatedAt` scalar, NOT the object identity:
    // useLiveQuery hands back a fresh object on every Dexie tick (i.e. every
    // transcript write during a live conversation), and pushing that into
    // setJamesProfile each turn would churn deps.jamesProfile and bust the
    // Anthropic prompt cache. updatedAt only changes on a real profile edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamesProfile?.updatedAt]);

  useEffect(() => {
    // Tear down on unmount (route change). Conversation also tears down on Stop.
    return () => {
      void conversationRef.current?.stop();
    };
  }, []);

  // Warm the quick-phrase audio cache as soon as the voice id is known.
  // Runs once per voice on first cockpit mount and again only if the voice
  // id changes. Failure is silent — the speak path falls back to live TTS.
  useEffect(() => {
    if (!settings.jamesVoiceId) return;
    void warmQuickPhraseCache({
      voiceId: settings.jamesVoiceId,
      ttsProvider: settings.ttsProvider,
      pruneOldVoices: true,
    });
  }, [settings.jamesVoiceId, settings.ttsProvider]);

  const start = async () => {
    if (!embedderReady) {
      toast.error("Embedder still warming up");
      return;
    }
    const conv = ensureConversation();
    conv.setRoster({ people, voiceprints });
    conv.setMood(mood);
    conv.setClosedSet(selectedPersonIds.length > 0 ? selectedPersonIds : null);
    conv.setSession({
      placeId: selectedPlaceId ?? undefined,
      eventId: selectedEventId ?? undefined,
    });
    await conv.start();
  };

  const addToActiveRoster = useCallback((personId: string) => {
    const conv = conversationRef.current;
    if (!conv) return;
    conv.addToRoster(personId);
    setSelectedPersonIds((prev) => (prev.includes(personId) ? prev : [...prev, personId]));
  }, []);

  /**
   * Confirm the matcher's top guess for the most-recent segment. Re-attribute
   * the current top segment to this person so the centroid learns from the
   * sample even when the borderline posterior left it as "suggested." Ported
   * from claude/tier3-engine-wins via `getLastOtherSegmentId()`.
   */
  const confirmTopSpeaker = useCallback((personId: string) => {
    const conv = conversationRef.current;
    if (!conv) return;
    const segId = conv.getLastOtherSegmentId();
    if (!segId) return;
    void conv.reassignSegment(segId, personId).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }, []);

  /**
   * "Not them" — reject the matcher's current top guess. Strips the
   * personId from the last segment and tells the matcher to treat the
   * next utterance as a new cluster.
   */
  const clearTopSpeaker = useCallback(() => {
    const conv = conversationRef.current;
    if (!conv) return;
    const segId = conv.getLastOtherSegmentId();
    if (segId) {
      void conv.reassignSegment(segId, null).catch(() => {});
    }
    conv.forceNewClusterNextSegment();
  }, []);

  const askWhoIsThis = useCallback(async () => {
    const conv = conversationRef.current;
    if (!conv) return;
    try {
      await conv.askWhoIsThis({ voiceId: settings.jamesVoiceId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [settings.jamesVoiceId]);

  const forceNewSpeaker = useCallback(() => {
    const conv = conversationRef.current;
    if (!conv) return;
    conv.forceNewClusterNextSegment();
    toast.message("Next utterance will start a new cluster");
  }, []);

  const mergeIntoPerson = useCallback(
    async (fromPersonId: string | undefined, toPersonId: string) => {
      const conv = conversationRef.current;
      if (!conv) return;
      if (fromPersonId === toPersonId) return;
      try {
        await conv.mergeCluster({ fromPersonId, toPersonId });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const stop = async () => {
    await conversationRef.current?.stop();
    setSuggestions([]);
    setCandidates([]);
    // Drain the Tier-2 queue now instead of waiting for the next app mount,
    // so the summary + learning land while the app stays open. Non-blocking:
    // stop() already returned, jobs are durable in IndexedDB, and the
    // drainer is single-flight so this can't double-run.
    void drainPendingJobs();
    toast.message("Conversation saved", {
      description: "Summarising and learning in the background.",
    });
  };

  /**
   * Single entry point for "make a sound." Routes cache-aware playback
   * through speakText regardless of whether a LiveConversation is started,
   * so quick phrases and type-and-speak work during cold start, between
   * conversations, and when the embedder is mid-reset.
   */
  const speak = useCallback(
    async (s: { text: string; category?: SuggestionCategory; why?: string }) => {
      setSpeakingText(s.text);
      try {
        const conv = conversationRef.current;
        const live = conv?.getState() === "listening" || conv?.getState() === "speech";
        if (live && conv) {
          await conv.speak(s);
        } else {
          await speakText({
            text: s.text,
            voiceId: settings.jamesVoiceId,
            ttsProvider: settings.ttsProvider,
          });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSpeakingText(null);
      }
    },
    [settings.jamesVoiceId, settings.ttsProvider],
  );

  /**
   * Expand-and-speak: send the typed draft through the smart-model
   * `expandUtterance` rewrite, then speak the polished result. Falls back to
   * raw speak() on AI error so the user is never left silent.
   */
  const expandAndSpeak = useCallback(async () => {
    const raw = draft.trim();
    if (!raw || expanding) return;
    setExpanding(true);
    try {
      const recent = transcript.slice(-12).map((s) => ({
        speaker:
          s.speakerKind === "self"
            ? jamesProfile?.displayName?.trim() || "Me"
            : (s.personName ?? "Speaker"),
        text: s.text,
      }));
      const polished = await ai
        .expandUtterance({
          // Empty when unset — `expandSystemPrompt` substitutes a generic
          // fallback so the model doesn't see a stale "James" presupposition.
          jamesName: jamesProfile?.displayName?.trim() ?? "",
          rawText: raw,
          recentTranscript: recent,
        })
        .catch(() => raw);
      const text = (polished || raw).trim();
      setDraft("");
      await speak({ text });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExpanding(false);
    }
  }, [draft, expanding, transcript, ai, jamesProfile?.displayName, speak]);

  /**
   * Manual refresh of the suggestion grid. Re-runs the suggestion pipeline
   * against the most-recent other-speaker segment without waiting for a
   * fresh utterance. Engine no-ops when the conversation isn't live.
   */
  const refreshSuggestions = useCallback(async () => {
    const conv = conversationRef.current;
    if (!conv) return;
    try {
      await conv.requestNewSuggestions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const isLive = state === "listening" || state === "speech";

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <SetupChecklist />

      {/* Top action row — 120×120 buttons + flex textarea, locked landscape
          layout that matches the deployed tier3 preview. */}
      <header className="flex shrink-0 items-stretch gap-2 border-b border-border bg-card px-3 py-3">
        {/* Combined Record / Stop button */}
        <button
          type="button"
          onClick={isLive ? stop : start}
          disabled={!embedderReady || state === "starting" || state === "stopping"}
          aria-label={isLive ? "Stop conversation" : "Start conversation"}
          className={cn(
            "flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl text-white shadow-sm transition-all active:scale-95",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
            state === "stopping"
              ? "bg-rose-300 ring-2 ring-rose-400"
              : isLive
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-[var(--teal)] hover:opacity-90 disabled:opacity-50",
          )}
        >
          {isLive ? (
            <>
              <Square className="size-7" />
              <span className="text-sm font-medium">Stop</span>
            </>
          ) : (
            <>
              <Mic className="size-7" />
              <span className="text-sm font-medium">Record</span>
            </>
          )}
        </button>

        {/* Type roughly textarea — fills remaining width */}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void expandAndSpeak();
            }
          }}
          placeholder="Type roughly — AI will clarify and speak it…"
          className="h-[120px] min-h-[120px] flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
        />

        {/* Speak button — primary color */}
        <button
          type="button"
          onClick={expandAndSpeak}
          disabled={expanding || !draft.trim() || !!speakingText}
          aria-label="Speak"
          className={cn(
            "flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl bg-primary text-primary-foreground shadow-sm transition-all active:scale-95 hover:opacity-90 disabled:opacity-50",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
          )}
        >
          {expanding ? (
            <Sparkles className="size-7 animate-pulse" />
          ) : (
            <Volume2 className="size-7" />
          )}
          <span className="text-sm font-medium">{expanding ? "Clarifying" : "Speak"}</span>
        </button>

        {/* Recent */}
        <Link
          to="/app/recent"
          aria-label="Recent conversations"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        >
          <History className="size-7" />
          <span className="text-sm font-medium">Recent</span>
        </Link>

        {/* Helpers */}
        <Link
          to="/app/helpers"
          aria-label="Reply helpers"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        >
          <Reply className="size-7" />
          <span className="text-sm font-medium">Helpers</span>
        </Link>

        {/* Settings */}
        <Link
          to="/app/settings"
          aria-label="Settings"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        >
          <SettingsIcon className="size-7" />
          <span className="text-sm font-medium">Settings</span>
        </Link>
      </header>

      {/* Context / status strip — Choose people + Event pickers + status. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-3 py-3 text-base text-muted-foreground">
        <button
          type="button"
          onClick={() => setShowPeoplePicker(true)}
          className="flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-5 py-3 text-base hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Users className="size-5" />
          {selectedPersonIds.length === 0
            ? "Choose people"
            : people
                .filter((p) => selectedPersonIds.includes(p.id))
                .map((p) => p.name)
                .join(", ")}
        </button>

        <button
          type="button"
          onClick={() => setShowEventPicker(true)}
          className={cn(
            "flex items-center gap-2 rounded-full border px-5 py-3 text-base transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            selectedEventId
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-secondary/40 hover:bg-secondary",
          )}
        >
          <Calendar className="size-5" />
          {selectedEventId
            ? (events.find((e) => e.id === selectedEventId)?.name ?? "Event (optional)")
            : "Event (optional)"}
        </button>

        <StateBadge state={state} embedderReady={embedderReady} />

        {embedderError && (
          <span className="inline-flex items-center gap-2 rounded-md bg-amber-100 px-3 py-1.5 text-xs text-amber-900">
            <span>{embedderError}</span>
            <button
              type="button"
              onClick={retryEmbedder}
              className="rounded bg-amber-200 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-900 hover:bg-amber-300"
            >
              Retry
            </button>
          </span>
        )}

        {!settings.jamesVoiceId && (
          <Link
            to="/app/settings"
            className="ml-auto rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/80"
          >
            No voice set — open settings →
          </Link>
        )}

        {speakingText && (
          <button
            type="button"
            onClick={() => {
              stopAllPlayback();
              setSpeakingText(null);
            }}
            className="ml-auto inline-flex items-center gap-2 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90"
          >
            <Square className="size-4" />
            Stop speaking
          </button>
        )}
      </div>

      {missingKeys.size > 0 && (
        <div className="border-b border-border px-3 py-2">
          <MissingKeysBanner keys={missingKeys} />
        </div>
      )}

      {/* Main grid: suggestions panel (80%) + right sidebar (20%). The
          right column itself is a vertical stack: Live transcript on top
          (flex-3), Speakers on the bottom (flex-2). */}
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {/* Suggestions panel — 80% width */}
        <section className="flex min-h-0 w-4/5 flex-col rounded-2xl border border-border bg-card/40">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="size-4" /> Suggestions
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshSuggestions()}
              disabled={suggestionsLoading || !isLive}
            >
              {suggestionsLoading ? "Thinking…" : "Refresh"}
            </Button>
          </div>

          {/* 6-cell grid (3×2). Empty cells render as dashed placeholders so
              the grid keeps its size and rhythm even when the model returned
              fewer than 6 ideas. */}
          <SuggestionGrid
            suggestions={suggestions}
            loading={suggestionsLoading}
            isLive={isLive}
            speakingText={speakingText}
            onSpeak={speak}
          />

          {/* Quick phrases — 5 columns, fixed h-16 */}
          <div className="grid grid-cols-5 gap-1.5 border-t border-border p-2">
            {QUICK_PHRASES.map((p) => (
              <Button
                key={p}
                variant="outline"
                onClick={() => speak({ text: p })}
                disabled={!!speakingText}
                className={cn(
                  "h-16 rounded-xl px-3 text-base font-medium leading-tight whitespace-normal",
                  "focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
                  speakingText === p && "ring-2 ring-accent",
                )}
              >
                {p}
              </Button>
            ))}
          </div>

          {/* Mood selector */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border p-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Mood
            </span>
            {MOOD_CHIPS.map((m) => {
              const active = mood === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMood(m.id)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border-2 px-5 py-2.5 text-base font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
                    active
                      ? `${m.tone} border-transparent shadow`
                      : "border-border bg-background text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Right sidebar — 20% width, vertical split */}
        <aside className="flex min-h-0 w-1/5 flex-col gap-2">
          {/* Live transcript (flex-3) */}
          <TranscriptPanel
            transcript={transcript}
            jamesName={jamesProfile?.displayName?.trim() || "Me"}
            rosterPeople={people.filter((p) => selectedPersonIds.includes(p.id))}
            onReassign={(segmentId, personId) => {
              const conv = conversationRef.current;
              if (!conv) return;
              void conv.reassignSegment(segmentId, personId).catch((err) => {
                toast.error(err instanceof Error ? err.message : String(err));
              });
            }}
          />

          {/* Speakers (flex-2) */}
          <div className="min-h-0 flex-[2]">
            <SpeakerPanel
              candidates={candidates}
              transcript={transcript}
              acceptThreshold={settings.speakerIdAcceptThreshold}
              people={people}
              selectedPersonIds={selectedPersonIds}
              isLive={isLive}
              onAddToRoster={addToActiveRoster}
              onAskWhoIsThis={askWhoIsThis}
              onForceNew={forceNewSpeaker}
              onMergeInto={mergeIntoPerson}
              onConfirmTop={confirmTopSpeaker}
              onClearTop={clearTopSpeaker}
            />
          </div>
        </aside>
      </div>

      {/* Modals */}
      {showPeoplePicker && (
        <PeoplePickerModal
          people={people}
          selectedPersonIds={selectedPersonIds}
          sampleCountByPerson={sampleCountByPerson}
          embedderRef={embedderRef}
          embedderReady={embedderReady}
          onTogglePerson={(id) =>
            setSelectedPersonIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
            )
          }
          onClose={() => setShowPeoplePicker(false)}
        />
      )}
      {showEventPicker && (
        <EventPickerModal
          events={events}
          selectedEventId={selectedEventId}
          onSelect={(id) => {
            setSelectedEventId(id);
            setShowEventPicker(false);
          }}
          onClose={() => setShowEventPicker(false)}
        />
      )}
      {/* Place picker is reachable from the Settings → Locations tab; the
          cockpit's strip omits a dedicated chip to keep the row short. The
          underlying selectedPlaceId is still wired through to the engine for
          future re-exposure (the prior 2× boost applies invisibly). */}
    </div>
  );
}

// --------------------------------------------------------------------------

/**
 * Server proxy errors of the form "X_API_KEY not set on the server" are not
 * runtime bugs — they mean Vercel env vars need filling in. Detect them and
 * surface a sticky banner with the exact key name instead of buzz-toasting.
 */
function detectMissingKey(message: string): string | null {
  const m = message.match(/\b([A-Z][A-Z0-9_]+_API_KEY)\b[^"]*not set/);
  return m ? m[1] : null;
}

function MissingKeysBanner({ keys }: { keys: Set<string> }) {
  const list = Array.from(keys);
  return (
    <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
      <p className="font-medium text-destructive">
        Missing server env var{list.length === 1 ? "" : "s"}:{" "}
        {list.map((k, i) => (
          <span key={k}>
            <code className="rounded bg-destructive/15 px-1.5 py-0.5">{k}</code>
            {i < list.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
      <p className="mt-2 text-muted-foreground">
        Set them in Vercel → ipad-aac-buddy → Settings → Environment Variables → Production, then
        trigger a redeploy. Until then the cockpit can record + match speakers but can't transcribe,
        generate suggestions, or speak.
      </p>
    </div>
  );
}

function StateBadge({
  state,
  embedderReady,
}: {
  state: ConversationState;
  embedderReady: boolean;
}) {
  const isWarming = !embedderReady && state === "idle";
  const label = isWarming
    ? "Warming up embedder…"
    : state === "idle"
      ? "Idle"
      : state === "starting"
        ? "Starting…"
        : state === "listening"
          ? "Listening"
          : state === "speech"
            ? "Speech detected"
            : "Stopping…";

  const dotClass = isWarming
    ? "bg-blue-500 animate-pulse"
    : state === "idle"
      ? "bg-foreground/30"
      : state === "listening"
        ? "bg-emerald-500"
        : state === "speech"
          ? "bg-amber-500 animate-pulse"
          : state === "starting"
            ? "bg-blue-500 animate-pulse"
            : "bg-foreground/40";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold",
        state === "idle" || state === "stopping"
          ? "bg-muted text-muted-foreground"
          : state === "speech"
            ? "bg-accent text-accent-foreground"
            : "bg-muted text-foreground",
      )}
    >
      <span className={cn("inline-block size-3 rounded-full", dotClass)} aria-hidden="true" />
      {label}
    </span>
  );
}

// --------------------------------------------------------------------------

function SuggestionGrid({
  suggestions,
  loading,
  isLive,
  speakingText,
  onSpeak,
}: {
  suggestions: SuggestionDraft[];
  loading: boolean;
  isLive: boolean;
  speakingText: string | null;
  onSpeak: (s: { text: string; category?: SuggestionCategory; why?: string }) => void;
}) {
  // Always exactly 6 cells. Empty cells render as dashed placeholders so
  // James's spatial muscle memory for "the bottom-left card is always
  // there" never breaks.
  const cards: (SuggestionDraft | null)[] =
    suggestions.length >= 6 ? suggestions.slice(0, 6) : [...suggestions];
  while (cards.length < 6) cards.push(null);

  return (
    <div
      className="relative grid min-h-0 flex-1 grid-cols-3 grid-rows-2 gap-2 overflow-hidden p-2"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
          <Loader2 className="h-3 w-3 animate-spin" />
          Generating…
        </div>
      )}
      {!isLive && suggestions.length === 0 && !loading && (
        <Card className="col-span-3 row-span-2 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
          Press the record button to start a conversation. Suggestions will appear here.
        </Card>
      )}
      {isLive && suggestions.length === 0 && !loading && (
        <Card className="col-span-3 row-span-2 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
          Listening… suggestions will appear after a few words.
        </Card>
      )}
      {(isLive || suggestions.length > 0) &&
        cards.map((s, i) => (
          <SuggestionCard
            key={s ? `${s.text}-${i}` : `empty-${i}`}
            suggestion={s}
            speaking={!!s && speakingText === s.text}
            onSpeak={onSpeak}
            index={i}
            disabled={!!speakingText}
          />
        ))}
    </div>
  );
}

const CATEGORY_CLASS: Record<SuggestionCategory, string> = {
  answer: "bg-[var(--cat-answer,#14b8a6)]/15 border-[var(--cat-answer,#14b8a6)]/40",
  question: "bg-[var(--cat-question,#f59e0b)]/15 border-[var(--cat-question,#f59e0b)]/40",
  followup: "bg-[var(--cat-followup,#10b981)]/15 border-[var(--cat-followup,#10b981)]/40",
  planned: "bg-[var(--cat-planned,#6366f1)]/15 border-[var(--cat-planned,#6366f1)]/40",
  humor: "bg-[var(--cat-humor,#f97316)]/15 border-[var(--cat-humor,#f97316)]/40",
  clarify: "bg-[var(--cat-clarify,#0f766e)]/15 border-[var(--cat-clarify,#0f766e)]/40",
  "give-me-a-moment": "bg-[var(--cat-moment,#a8a29e)]/30 border-[var(--cat-moment,#a8a29e)]",
};

function SuggestionCard({
  suggestion,
  speaking,
  onSpeak,
  index,
  disabled,
}: {
  suggestion: SuggestionDraft | null;
  speaking: boolean;
  onSpeak: (s: { text: string; category?: SuggestionCategory; why?: string }) => void;
  index: number;
  disabled: boolean;
}) {
  if (!suggestion) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center rounded-2xl border-2 border-dashed border-border/60 bg-muted/20 text-2xl text-muted-foreground/60">
        —
      </div>
    );
  }
  const animationDelay = `${index * 40}ms`;
  return (
    <button
      type="button"
      onClick={() => onSpeak(suggestion)}
      disabled={disabled}
      style={{ animationDelay }}
      className={cn(
        "flex h-full min-h-0 w-full items-center justify-center rounded-2xl border-2 p-3 text-center text-xl font-medium leading-snug transition-transform active:scale-[0.98]",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out fill-mode-both",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
        speaking && "ring-2 ring-accent",
        disabled && "opacity-60",
        CATEGORY_CLASS[suggestion.category] ?? "bg-secondary border-border",
      )}
    >
      <span className="line-clamp-5">{suggestion.text}</span>
    </button>
  );
}

// --------------------------------------------------------------------------

function TranscriptPanel({
  transcript,
  jamesName,
  rosterPeople,
  onReassign,
}: {
  transcript: LiveTranscriptSegment[];
  jamesName: string;
  rosterPeople: Person[];
  onReassign: (segmentId: string, personId: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript.length]);

  return (
    <div className="flex min-h-0 flex-[3] flex-col rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Live transcript
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {transcript.length === 0 ? (
          <p className="text-sm text-muted-foreground">Listening…</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {transcript.map((t) => {
              const isReassigning = reassigningId === t.id;
              const isPartial = (t as { status?: string }).status === "partial";
              const canReassign = t.speakerKind === "other";
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => canReassign && setReassigningId(isReassigning ? null : t.id)}
                    disabled={!canReassign}
                    className={cn(
                      "w-full rounded px-1 py-0.5 text-left leading-snug transition-colors",
                      canReassign && "hover:bg-muted",
                      isReassigning && "bg-muted ring-1 ring-accent/40",
                    )}
                    title={canReassign ? "Tap to reassign who said this" : undefined}
                  >
                    <span className="mr-2 text-xs font-semibold text-muted-foreground">
                      {t.speakerKind === "self" ? jamesName : (t.personName ?? "Speaker")}
                    </span>
                    <span
                      className={cn("text-foreground", isPartial && "italic text-muted-foreground")}
                    >
                      {t.text}
                    </span>
                  </button>
                  {isReassigning && canReassign && (
                    <div className="mt-1 flex flex-wrap gap-1 pl-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Who said this?
                      </span>
                      {rosterPeople.length === 0 ? (
                        <span className="text-[10px] italic text-muted-foreground">
                          Pick people first
                        </span>
                      ) : (
                        rosterPeople.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              onReassign(t.id, p.id);
                              setReassigningId(null);
                            }}
                            className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] hover:bg-accent hover:text-accent-foreground"
                          >
                            {p.name}
                          </button>
                        ))
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          onReassign(t.id, null);
                          setReassigningId(null);
                        }}
                        className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                      >
                        Unknown
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function PeoplePickerModal({
  people,
  selectedPersonIds,
  sampleCountByPerson,
  embedderRef,
  embedderReady,
  onTogglePerson,
  onClose,
}: {
  people: Person[];
  selectedPersonIds: string[];
  sampleCountByPerson: Map<string, number>;
  embedderRef: { current: SpeakerEmbedder | null };
  embedderReady: boolean;
  onTogglePerson: (id: string) => void;
  onClose: () => void;
}) {
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRel, setNewPersonRel] = useState("");
  const [expandedRecorderPersonId, setExpandedRecorderPersonId] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <Card
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="size-5" /> Who's in this conversation?
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close people picker"
            className="rounded-full p-2 hover:bg-secondary"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {people.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              No people added yet. Add them in{" "}
              <Link to="/app/settings" search={{ tab: "people" }} className="underline">
                Settings → People
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {people.map((p) => {
                const sel = selectedPersonIds.includes(p.id);
                const samples = sampleCountByPerson.get(p.id) ?? 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onTogglePerson(p.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border-2 px-4 py-2 text-base transition-colors",
                      sel
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    {sel && <Check className="size-4" />}
                    <span className="font-medium">{p.name}</span>
                    {p.relationship && <span className="text-xs opacity-70">{p.relationship}</span>}
                    <span
                      className={cn(
                        "ml-1 rounded-full px-1.5 text-[10px]",
                        samples === 0
                          ? "bg-destructive/15 text-destructive"
                          : "bg-background/40 text-muted-foreground",
                      )}
                    >
                      {samples === 0 ? "no voice" : `${samples} samples`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Voice recognition section — appears once at least one person
              has been picked, mirrors the legacy people picker so a
              caregiver can capture a voice sample without leaving the
              cockpit. */}
          {selectedPersonIds.length > 0 && (
            <div className="mt-5 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold">Voice recognition</h4>
                <span className="text-xs text-muted-foreground">
                  Recording a sample makes identification instant
                </span>
              </div>
              <div className="space-y-2">
                {selectedPersonIds.map((pid) => {
                  const person = people.find((p) => p.id === pid);
                  if (!person) return null;
                  const sampleCount = sampleCountByPerson.get(pid) ?? 0;
                  const hasPrint = sampleCount > 0;
                  const expanded = expandedRecorderPersonId === pid;
                  return (
                    <div
                      key={pid}
                      className={cn(
                        "rounded-lg border",
                        hasPrint
                          ? "border-emerald-500/30 bg-emerald-500/5"
                          : "border-amber-500/40 bg-amber-500/5",
                      )}
                    >
                      <div className="flex items-center gap-3 px-3 py-2">
                        <span className="font-medium">{person.name}</span>
                        {hasPrint ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                            <Check className="size-3" />
                            Voice learned · {sampleCount} sample{sampleCount === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                            <AlertCircle className="size-3" />
                            No voice sample yet
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setExpandedRecorderPersonId(expanded ? null : pid)}
                          className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-secondary"
                        >
                          <Mic className="size-3" />
                          {hasPrint
                            ? expanded
                              ? "Hide"
                              : "Re-record"
                            : expanded
                              ? "Hide"
                              : "Record now"}
                        </button>
                      </div>
                      {expanded && (
                        <div className="border-t border-border px-3 py-3">
                          <VoiceSampleRecorder
                            personId={pid}
                            embedder={embedderRef.current}
                            embedderReady={embedderReady}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-border px-5 py-3">
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={() => {
                setNewPersonName("");
                setNewPersonRel("");
                setAddingPerson(true);
              }}
            >
              <Plus className="size-4" /> Add new person
            </Button>
            <Button className="flex-1" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Card>

      {addingPerson && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setAddingPerson(false);
          }}
        >
          <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <Plus className="size-5" /> Add new person
            </h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Name</label>
                <input
                  autoFocus
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-base"
                  placeholder="e.g. Sarah"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Relationship (optional)</label>
                <input
                  value={newPersonRel}
                  onChange={(e) => setNewPersonRel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-base"
                  placeholder="e.g. care worker, friend"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAddingPerson(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  const name = newPersonName.trim();
                  if (!name) {
                    toast.error("Name is required");
                    return;
                  }
                  const now = Date.now();
                  const p: Person = {
                    id: nanoid(),
                    name,
                    relationship: newPersonRel.trim() || undefined,
                    interests: [],
                    notes: "",
                    status: "active",
                    createdAt: now,
                    updatedAt: now,
                  };
                  await db().people.put(p);
                  onTogglePerson(p.id);
                  setAddingPerson(false);
                  toast.success(`Added ${p.name}`);
                }}
              >
                Add
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function EventPickerModal({
  events,
  selectedEventId,
  onSelect,
  onClose,
}: {
  events: EventRecord[];
  selectedEventId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <Card
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Calendar className="size-5" /> Prepping for an event?
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close event picker"
            className="rounded-full p-2 hover:bg-secondary"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "mb-3 flex w-full items-center justify-between rounded-lg border-2 px-4 py-2 text-left",
              !selectedEventId
                ? "border-primary bg-primary/10"
                : "border-border bg-secondary/40 hover:bg-secondary",
            )}
          >
            <span className="font-medium">No event</span>
            {!selectedEventId && <Check className="size-4" />}
          </button>
          {events.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              No events yet. Create one in{" "}
              <Link to="/app/settings" search={{ tab: "events" }} className="underline">
                Settings → Events
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-2">
              {events.map((e) => {
                const sel = selectedEventId === e.id;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onSelect(e.id)}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 rounded-lg border-2 px-4 py-2 text-left",
                      sel
                        ? "border-primary bg-primary/10"
                        : "border-border bg-secondary/40 hover:bg-secondary",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{e.name}</div>
                      {(e.when || e.locationFreeform) && (
                        <div className="truncate text-xs text-muted-foreground">
                          {[e.when, e.locationFreeform].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                    {sel && <Check className="size-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  HelpCircle,
  Loader2,
  Merge,
  Mic,
  MicOff,
  Rewind,
  Send,
  Square,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  db,
  type EventRecord,
  type Person,
  type Place,
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
import { getLastSegment, playLastSegment } from "@/lib/audio/last-segment-store";
import { drainPendingJobs } from "@/lib/jobs/drain";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];
const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_PLACES: Place[] = [];
const EMPTY_CONTRIBUTIONS: VoiceprintContribution[] = [];

const QUICK_PHRASES: { text: string; label?: string }[] = [
  { text: "Yes" },
  { text: "No" },
  { text: "Wait" },
  { text: "I'm not finished" },
  { text: "Give me a moment" },
  { text: "Could you repeat that?" },
  { text: "I need help" },
  { text: "Sorry, who am I speaking with?", label: "Who is this?" },
];

// Sanity guard: keep the cockpit's display labels in lock-step with the cache's
// canonical phrase strings. Cache hits use exact-string lookup, so any drift
// (e.g. "Yes." vs "Yes") silently downgrades quick phrases to live TTS.
if (typeof window !== "undefined" && QUICK_PHRASES.some((p, i) => p.text !== CACHED_PHRASES[i])) {
  console.warn(
    "[cockpit] QUICK_PHRASES text drifted from cached set — quick phrases will miss cache",
  );
}

function HomePage() {
  return <ClientCockpit />;
}

function ClientCockpit() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10">
        <p className="text-sm text-muted-foreground">Loading cockpit…</p>
      </div>
    );
  }
  return <Cockpit />;
}

// --------------------------------------------------------------------------

function Cockpit() {
  const settings = useSettings();

  // Embedder warmup — shared with the spike's lifecycle.
  const embedderRef = useRef<SpeakerEmbedder | null>(null);
  const [embedderReady, setEmbedderReady] = useState(false);
  const [embedderError, setEmbedderError] = useState<string | null>(null);
  useEffect(() => {
    setEmbedderReady(false);
    setEmbedderError(null);
    embedderRef.current?.dispose?.();
    // Worker-backed embedder: the entire transformers.js call lives in a
    // separate JSC VM so the periodic dispose+warmup cycle (every 12 turns
    // per the OOM mitigation) doesn't freeze the cockpit. dispose() on the
    // client side terminates the worker, which is the only reliable way
    // to actually release ORT's WASM heap on iPad Safari.
    const next = makeWorkerEmbedder({ preferWebGPU: settings.speakerIdWebGPU });
    embedderRef.current = next;
    let cancelled = false;
    (async () => {
      try {
        await next.warmup?.();
        if (!cancelled) setEmbedderReady(true);
      } catch (err) {
        if (cancelled) return;
        setEmbedderError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.speakerIdWebGPU]);

  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const voiceprints = useLiveQuery(() => db().voiceprints.toArray(), [], EMPTY_VOICEPRINTS);
  const events = useLiveQuery(
    () => db().events.orderBy("start").reverse().toArray(),
    [],
    EMPTY_EVENTS,
  );
  const places = useLiveQuery(() => db().places.orderBy("name").toArray(), [], EMPTY_PLACES);
  const voiceprintContributions = useLiveQuery(
    () => db().voiceprintContributions.toArray(),
    [],
    EMPTY_CONTRIBUTIONS,
  );
  const jamesProfile = useLiveQuery(() => db().jamesProfile.get("singleton"), []);

  // Closed-set roster state. Pre-Record; survives until the user re-opens
  // the picker. Mid-conversation additions go straight through the
  // LiveConversation.addToRoster path so we don't have to re-sync here.
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

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

  const conversationRef = useRef<LiveConversation | null>(null);

  // Lazy-build the LiveConversation on first start so the embedder/people
  // queries have already populated.
  const ensureConversation = useCallback(() => {
    if (conversationRef.current) return conversationRef.current;
    const conv = new LiveConversation({
      embedderRef,
      ai,
      settings,
      jamesName: jamesProfile?.displayName ?? "James",
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
  // Single-iPad app: this runs once per voice on first cockpit mount and
  // never again unless the voice id changes. Failure is silent — the speak
  // path falls back to live TTS.
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

  const reassignSegment = useCallback(async (segmentId: string, personId: string | null) => {
    const conv = conversationRef.current;
    if (!conv) return;
    try {
      await conv.reassignSegment(segmentId, personId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
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
   * conversations, and when the embedder is mid-reset. Only when a live
   * conversation exists do we also fold the spoken text into Dexie logs
   * via conv.speak().
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

  const replay = useCallback(async () => {
    const seg = getLastSegment();
    if (!seg) {
      toast.message("No recent speech to replay");
      return;
    }
    stopAllPlayback();
    const ok = await playLastSegment();
    if (!ok) toast.error("Couldn't replay — Web Audio unavailable");
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Live cockpit
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {state === "idle" ? (
            <Button
              variant="accent"
              size="lg"
              onClick={start}
              disabled={!embedderReady}
              className="px-8"
            >
              <Mic className="h-5 w-5" />
              Record
            </Button>
          ) : (
            <Button variant="destructive" size="lg" onClick={stop} className="px-8">
              <MicOff className="h-5 w-5" />
              Stop
            </Button>
          )}
          {speakingText && (
            <Button
              variant="destructive"
              size="lg"
              onClick={() => {
                stopAllPlayback();
                setSpeakingText(null);
              }}
              className="px-8"
            >
              <Square className="h-5 w-5" />
              Stop speaking
            </Button>
          )}
          <StateBadge state={state} embedderReady={embedderReady} />
          {embedderError && (
            <span className="rounded-md bg-destructive/15 px-3 py-1.5 text-xs text-destructive">
              Embedder failed: {embedderError}
            </span>
          )}
          {!settings.jamesVoiceId && (
            <Link
              to="/settings"
              className="rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/80"
            >
              No James voice set — using default. Open settings →
            </Link>
          )}
        </div>
      </header>

      {missingKeys.size > 0 && <MissingKeysBanner keys={missingKeys} />}

      {state === "idle" && (
        <RosterPicker
          people={people}
          selectedPersonIds={selectedPersonIds}
          onTogglePerson={(id) =>
            setSelectedPersonIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
            )
          }
          events={events}
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
          places={places}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={setSelectedPlaceId}
          sampleCountByPerson={sampleCountByPerson}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_2fr_1fr]">
        <SpeakerColumn
          candidates={candidates}
          acceptThreshold={settings.speakerIdAcceptThreshold}
          people={people}
          selectedPersonIds={selectedPersonIds}
          isLive={state === "listening" || state === "speech"}
          onAddToRoster={addToActiveRoster}
          onAskWhoIsThis={askWhoIsThis}
          onForceNew={forceNewSpeaker}
          onMergeInto={mergeIntoPerson}
        />
        <div className="flex flex-col gap-4">
          <TypeAndSpeakInput speakingText={speakingText} onSpeak={(text) => speak({ text })} />
          <SuggestionGrid
            suggestions={suggestions}
            loading={suggestionsLoading}
            speakingText={speakingText}
            onSpeak={speak}
          />
        </div>
        <TranscriptColumn
          transcript={transcript}
          jamesName={jamesProfile?.displayName ?? "Me"}
          rosterPeople={people.filter((p) => selectedPersonIds.includes(p.id))}
          onReassign={reassignSegment}
        />
      </div>

      <QuickPhrasesRow speakingText={speakingText} onSpeak={speak} onReplay={replay} />
      <MoodSelector mood={mood} onChange={setMood} />
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
        trigger a redeploy (env changes don't auto-rebuild). Until then the cockpit can record +
        match speakers but can't transcribe, generate suggestions, or speak.
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
  const label =
    !embedderReady && state === "idle"
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
  const pulse = state === "speech";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
        state === "idle" || state === "stopping"
          ? "bg-muted text-muted-foreground"
          : state === "speech"
            ? "bg-accent text-accent-foreground"
            : "bg-muted text-foreground",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          pulse ? "animate-pulse bg-accent-foreground" : "bg-foreground/60",
        )}
      />
      {label}
    </span>
  );
}

// --------------------------------------------------------------------------

function SuggestionGrid({
  suggestions,
  loading,
  speakingText,
  onSpeak,
}: {
  suggestions: SuggestionDraft[];
  loading: boolean;
  speakingText: string | null;
  onSpeak: (s: { text: string; category?: SuggestionCategory; why?: string }) => void;
}) {
  if (suggestions.length === 0 && !loading) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        Suggestions appear here after each turn.
        <span className="mt-1 text-xs">Tap Record and let someone speak.</span>
      </div>
    );
  }

  const cards: (SuggestionDraft | null)[] =
    suggestions.length >= 6 ? suggestions.slice(0, 6) : [...suggestions];
  while (cards.length < 6) cards.push(null);

  return (
    <div className="relative">
      {loading && (
        <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Generating…
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {cards.map((s, i) => (
          <SuggestionCard
            key={s ? `${s.text}-${i}` : `empty-${i}`}
            suggestion={s}
            speaking={!!s && speakingText === s.text}
            onSpeak={onSpeak}
          />
        ))}
      </div>
    </div>
  );
}

const CATEGORY_LABEL: Record<SuggestionCategory, string> = {
  answer: "Answer",
  question: "Question",
  followup: "Follow-up",
  planned: "Planned",
  humor: "Humour",
  clarify: "Clarify",
  "give-me-a-moment": "Moment",
};

const CATEGORY_DOT: Record<SuggestionCategory, string> = {
  answer: "bg-[var(--teal,#14b8a6)]",
  question: "bg-amber-500",
  followup: "bg-emerald-500",
  planned: "bg-indigo-500",
  humor: "bg-orange-500",
  clarify: "bg-teal-700",
  "give-me-a-moment": "bg-stone-400",
};

function SuggestionCard({
  suggestion,
  speaking,
  onSpeak,
}: {
  suggestion: SuggestionDraft | null;
  speaking: boolean;
  onSpeak: (s: { text: string; category?: SuggestionCategory; why?: string }) => void;
}) {
  if (!suggestion) {
    return (
      <div className="min-h-[180px] rounded-2xl border border-dashed border-border bg-muted/30" />
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSpeak(suggestion)}
      className={cn(
        "group flex min-h-[180px] flex-col justify-between rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition active:scale-[0.99]",
        speaking && "ring-2 ring-accent",
      )}
    >
      <span className="text-xl font-medium leading-snug text-foreground sm:text-2xl">
        {suggestion.text}
      </span>
      <span className="mt-3 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className={cn("h-2 w-2 rounded-full", CATEGORY_DOT[suggestion.category])} />
        {CATEGORY_LABEL[suggestion.category]}
      </span>
    </button>
  );
}

// --------------------------------------------------------------------------

function TranscriptColumn({
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
    <div className="rounded-2xl border border-border bg-card">
      <div className="px-4 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Transcript
      </div>
      <div ref={scrollRef} className="max-h-[260px] overflow-y-auto p-4">
        {transcript.length === 0 ? (
          <p className="text-sm text-muted-foreground">Live transcript appears here.</p>
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
                          Pick people in the roster first
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

function SpeakerColumn({
  candidates,
  acceptThreshold,
  people,
  selectedPersonIds,
  isLive,
  onAddToRoster,
  onAskWhoIsThis,
  onForceNew,
  onMergeInto,
}: {
  candidates: Candidate[];
  acceptThreshold: number;
  people: Person[];
  selectedPersonIds: string[];
  isLive: boolean;
  onAddToRoster: (personId: string) => void;
  onAskWhoIsThis: () => void;
  onForceNew: () => void;
  onMergeInto: (fromPersonId: string | undefined, toPersonId: string) => void;
}) {
  const top = candidates[0];
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showMergePicker, setShowMergePicker] = useState(false);

  // People enrolled but not currently in the active roster — the candidates
  // for the "Add to roster" mid-conversation chip.
  const offRoster = useMemo(
    () => people.filter((p) => !selectedPersonIds.includes(p.id)),
    [people, selectedPersonIds],
  );
  const rosterPeople = useMemo(
    () => people.filter((p) => selectedPersonIds.includes(p.id)),
    [people, selectedPersonIds],
  );

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-1 px-4 pt-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Speaker
        </span>
        {isLive && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onAskWhoIsThis}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
              title="Speak 'Sorry, who am I speaking with?' and hold the next utterance for manual attribution"
            >
              <HelpCircle className="h-3 w-3" />
              Ask
            </button>
            <button
              type="button"
              onClick={onForceNew}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
              title="Treat the next utterance as a new speaker"
            >
              <UserPlus className="h-3 w-3" />
              New
            </button>
            {top?.personId && rosterPeople.length > 1 && (
              <button
                type="button"
                onClick={() => setShowMergePicker((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
                title="Merge this cluster into another person"
              >
                <Merge className="h-3 w-3" />
                Merge
              </button>
            )}
            {offRoster.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAddPicker((v) => !v)}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
                title="Add a person who walked in late"
              >
                + Add
              </button>
            )}
          </div>
        )}
      </div>
      <div className="p-4">
        {!top ? (
          <p className="text-sm text-muted-foreground">Listening…</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-semibold">{top.name}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  top.personId && top.posterior >= acceptThreshold
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {top.personId && top.posterior >= acceptThreshold ? "confirmed" : "suggested"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {(top.posterior * 100).toFixed(0)}% posterior
              {top.similarity !== undefined && <> · sim {(top.similarity * 100).toFixed(0)}%</>}
            </p>
            {candidates.length > 1 && (
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {candidates.slice(1, 4).map((c) => (
                  <li key={c.personId ?? "unknown"} className="flex items-center justify-between">
                    <span>{c.name}</span>
                    <span>{(c.posterior * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {showAddPicker && offRoster.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-3">
            <span className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">
              Add to roster
            </span>
            {offRoster.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onAddToRoster(p.id);
                  setShowAddPicker(false);
                }}
                className="rounded-full border border-input bg-background px-2.5 py-0.5 text-xs hover:bg-muted"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        {showMergePicker && top?.personId && (
          <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-3">
            <span className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">
              Merge {top.name} into…
            </span>
            {rosterPeople
              .filter((p) => p.id !== top.personId)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onMergeInto(top.personId ?? undefined, p.id);
                    setShowMergePicker(false);
                  }}
                  className="rounded-full border border-input bg-background px-2.5 py-0.5 text-xs hover:bg-muted"
                >
                  {p.name}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pre-Record control: declare who's in the room. Picking 2–4 names here
 * collapses the matcher from an open-set to a closed-set decision, which
 * is the single highest-leverage speaker-ID accuracy change in the build.
 * Picking an event auto-populates the roster from its expected attendees.
 */
function RosterPicker({
  people,
  selectedPersonIds,
  onTogglePerson,
  events,
  selectedEventId,
  onSelectEvent,
  places,
  selectedPlaceId,
  onSelectPlace,
  sampleCountByPerson,
}: {
  people: Person[];
  selectedPersonIds: string[];
  onTogglePerson: (id: string) => void;
  events: EventRecord[];
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
  places: Place[];
  selectedPlaceId: string | null;
  onSelectPlace: (id: string | null) => void;
  sampleCountByPerson: Map<string, number>;
}) {
  if (people.length === 0 && events.length === 0 && places.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        No enrolled people yet. Add some on the{" "}
        <Link to="/people" className="underline">
          People
        </Link>{" "}
        page so the speaker-ID matcher has someone to compare against.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Who's in the room?
        </span>
        <span className="text-xs text-muted-foreground">
          {selectedPersonIds.length === 0
            ? "open match — slower & less accurate"
            : `${selectedPersonIds.length} selected`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {people.map((p) => {
          const selected = selectedPersonIds.includes(p.id);
          const samples = sampleCountByPerson.get(p.id) ?? 0;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onTogglePerson(p.id)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
                selected
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-input bg-background hover:bg-muted",
              )}
            >
              <span>{p.name}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px]",
                  samples === 0
                    ? "bg-destructive/15 text-destructive"
                    : "bg-background/40 text-current/70",
                )}
                title={samples === 0 ? "No voice samples — won't match" : `${samples} samples`}
              >
                {samples === 0 ? "no voice" : samples}
              </span>
            </button>
          );
        })}
      </div>
      {(events.length > 0 || places.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          {places.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Place
              </label>
              <select
                value={selectedPlaceId ?? ""}
                onChange={(e) => onSelectPlace(e.target.value || null)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="">— none —</option>
                {places.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
              {selectedPlaceId && (
                <span className="text-xs text-muted-foreground">boosts prior 2×</span>
              )}
            </div>
          )}
          {events.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Event
              </label>
              <select
                value={selectedEventId ?? ""}
                onChange={(e) => onSelectEvent(e.target.value || null)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="">— none —</option>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
              {selectedEventId && (
                <span className="text-xs text-muted-foreground">
                  Auto-fills attendees · boosts prior 2.5×
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------

function QuickPhrasesRow({
  speakingText,
  onSpeak,
  onReplay,
}: {
  speakingText: string | null;
  onSpeak: (s: { text: string }) => void;
  onReplay: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {QUICK_PHRASES.map((p) => (
        <Button
          key={p.text}
          variant="outline"
          size="lg"
          onClick={() => onSpeak({ text: p.text })}
          className={cn(
            "min-h-[48px] flex-1 sm:flex-none",
            speakingText === p.text && "ring-2 ring-accent",
          )}
        >
          {p.label ?? p.text}
        </Button>
      ))}
      <Button
        variant="outline"
        size="lg"
        onClick={onReplay}
        className="min-h-[48px] flex-1 sm:flex-none"
        title="Replay the last thing said in the room"
      >
        <Rewind className="h-4 w-4" />
        Replay
      </Button>
    </div>
  );
}

/**
 * Always-visible "speak as me" input. Lives above the suggestion grid so
 * James doesn't have to scan past suggestions to reach it during a turn
 * he wants to compose freely. Plain <input> (not <textarea>) because the
 * iPad soft keyboard already eats half the screen and James's motor
 * control makes precise cursor placement painful — a single line plus a
 * large Speak button is the cheapest accessible primitive.
 */
function TypeAndSpeakInput({
  speakingText,
  onSpeak,
}: {
  speakingText: string | null;
  onSpeak: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSpeak(trimmed);
    setText("");
  };
  const isSpeakingThis = !!text.trim() && speakingText === text.trim();
  return (
    <div className="flex items-stretch gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Type and tap Speak…"
        className="min-h-[52px] flex-1 rounded-xl border border-input bg-background px-4 text-lg outline-none focus:ring-2 focus:ring-accent"
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        // Visible at all times; not gated on embedder warmup or LiveConversation
        // state — that's the whole point of this control.
      />
      <Button
        variant="accent"
        size="lg"
        onClick={submit}
        disabled={!text.trim()}
        className={cn("min-h-[52px] px-6", isSpeakingThis && "ring-2 ring-accent")}
      >
        <Send className="h-5 w-5" />
        Speak
      </Button>
    </div>
  );
}

// --------------------------------------------------------------------------

function MoodSelector({ mood, onChange }: { mood: Mood; onChange: (m: Mood) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Mood
      </span>
      {MOODS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
            m === mood
              ? "border-accent bg-accent text-accent-foreground"
              : "border-input bg-background text-muted-foreground hover:bg-muted",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

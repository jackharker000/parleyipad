import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mic, MicOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { db, type Person, type SuggestionCategory, type Voiceprint } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { makeEmbedder, type EmbedderKind, type SpeakerEmbedder } from "@/lib/audio/embedder";
import { makeAI, MOODS, type Mood, type SuggestionDraft } from "@/lib/ai";
import type { Candidate } from "@/lib/audio/matcher";
import {
  LiveConversation,
  type ConversationState,
  type LiveTranscriptSegment,
} from "@/lib/conversation";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];

const QUICK_PHRASES: { text: string; label?: string }[] = [
  { text: "Yes" },
  { text: "No" },
  { text: "Give me a moment" },
  { text: "Could you repeat that?" },
  { text: "Sorry, who am I speaking with?", label: "Who is this?" },
];

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
    const kind: EmbedderKind = "transformers";
    const next = makeEmbedder(kind, { preferWebGPU: settings.speakerIdWebGPU });
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
  const jamesProfile = useLiveQuery(() => db().jamesProfile.get("singleton"), []);

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
    });
    conv.on({
      onStateChange: setState,
      onTranscriptSegment: (segment) => setTranscript((prev) => [...prev, segment].slice(-40)),
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

  // Keep roster + mood + ai in sync with the live conversation instance.
  useEffect(() => {
    conversationRef.current?.setRoster({ people, voiceprints });
  }, [people, voiceprints]);
  useEffect(() => {
    conversationRef.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    // Tear down on unmount (route change). Conversation also tears down on Stop.
    return () => {
      void conversationRef.current?.stop();
    };
  }, []);

  const start = async () => {
    if (!embedderReady) {
      toast.error("Embedder still warming up");
      return;
    }
    const conv = ensureConversation();
    conv.setRoster({ people, voiceprints });
    conv.setMood(mood);
    await conv.start();
  };

  const stop = async () => {
    await conversationRef.current?.stop();
    setSuggestions([]);
    setCandidates([]);
  };

  const speak = async (s: { text: string; category?: SuggestionCategory; why?: string }) => {
    const conv = ensureConversation();
    setSpeakingText(s.text);
    try {
      await conv.speak(s);
    } finally {
      setSpeakingText(null);
    }
  };

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

      <div className="grid gap-5 lg:grid-cols-[1fr_2fr_1fr]">
        <SpeakerColumn
          candidates={candidates}
          acceptThreshold={settings.speakerIdAcceptThreshold}
        />
        <SuggestionGrid
          suggestions={suggestions}
          loading={suggestionsLoading}
          speakingText={speakingText}
          onSpeak={speak}
        />
        <TranscriptColumn transcript={transcript} jamesName={jamesProfile?.displayName ?? "Me"} />
      </div>

      <QuickPhrasesRow speakingText={speakingText} onSpeak={speak} />
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
}: {
  transcript: LiveTranscriptSegment[];
  jamesName: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
            {transcript.map((t) => (
              <li key={t.id}>
                <span className="mr-2 text-xs font-semibold text-muted-foreground">
                  {t.speakerKind === "self" ? jamesName : (t.personName ?? "Speaker")}
                </span>
                <span className="text-foreground">{t.text}</span>
              </li>
            ))}
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
}: {
  candidates: Candidate[];
  acceptThreshold: number;
}) {
  const top = candidates[0];
  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="px-4 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Speaker
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
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function QuickPhrasesRow({
  speakingText,
  onSpeak,
}: {
  speakingText: string | null;
  onSpeak: (s: { text: string }) => void;
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

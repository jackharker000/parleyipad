import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useScribe, CommitStrategy } from "@elevenlabs/react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Mic,
  Square,
  Volume2,
  Sparkles,
  Users,
  MapPin,
  Settings as SettingsIcon,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  db,
  getSettings,
  newId,
  type Conversation,
  type Person,
  type Place,
  type TranscriptSegment,
  IPAD_PRESETS,
} from "@/lib/db";
import { findNearestPlace, getCurrentPosition } from "@/lib/geo";
import {
  createScribeToken,
  generateSuggestions,
  summarizeConversation,
  synthesizeSpeech,
  expandUtterance,
} from "@/lib/aac.functions";
import { buildConversationContext, suggestPeopleAtPlace } from "@/lib/context";
import { autoMapSpeakers, labelTranscriptForPrompt } from "@/lib/speaker-id";
import { autoCreateIntroducedPeople } from "@/lib/auto-person";
import { seedJamesIfNeeded } from "@/lib/seed";

export const Route = createFileRoute("/")({
  component: Home,
});

type Suggestion = { text: string; category: string; why?: string };

const QUICK_PHRASES = [
  "Yes",
  "No",
  "Give me a moment",
  "Could you repeat that?",
  "Sorry, who am I speaking with?",
];

function categoryClass(cat: string): string {
  switch (cat) {
    case "answer":
      return "bg-[var(--cat-answer)]/15 border-[var(--cat-answer)]/40";
    case "question":
      return "bg-[var(--cat-question)]/15 border-[var(--cat-question)]/40";
    case "follow-up":
      return "bg-[var(--cat-followup)]/15 border-[var(--cat-followup)]/40";
    case "planned-point":
      return "bg-[var(--cat-planned)]/15 border-[var(--cat-planned)]/40";
    case "humor":
      return "bg-[var(--cat-humor)]/15 border-[var(--cat-humor)]/40";
    case "clarify":
      return "bg-[var(--cat-clarify)]/15 border-[var(--cat-clarify)]/40";
    case "give-me-a-moment":
      return "bg-[var(--cat-moment)]/30 border-[var(--cat-moment)]";
    default:
      return "bg-secondary border-border";
  }
}

const MIC_SESSION_KEY = "aac-mic-permission-asked";

async function ensureMicPermission(): Promise<boolean> {
  // If we've already asked in this browser session, assume granted (browser caches it)
  if (typeof window !== "undefined" && sessionStorage.getItem(MIC_SESSION_KEY)) {
    return true;
  }
  try {
    // Check Permissions API where available
    if (navigator.permissions) {
      try {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (status.state === "granted") {
          sessionStorage.setItem(MIC_SESSION_KEY, "1");
          return true;
        }
      } catch {
        /* not supported, fall through */
      }
    }
    // Trigger the prompt once and immediately stop the tracks
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    sessionStorage.setItem(MIC_SESSION_KEY, "1");
    return true;
  } catch (e: any) {
    toast.error(e?.message ?? "Microphone permission denied");
    return false;
  }
}

function Home() {
  const router = useRouter();

  // Conversation state
  const conversationIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const [active, setActive] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Place
  const [placeName, setPlaceName] = useState<string | null>(null);
  const placeIdRef = useRef<string | undefined>(undefined);
  const placeRef = useRef<Place | undefined>(undefined);

  // People
  const [allPeople, setAllPeople] = useState<Person[]>([]);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const personIdsRef = useRef<string[]>([]);
  const [showPeoplePicker, setShowPeoplePicker] = useState(false);

  // Transcript
  const [committed, setCommitted] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState("");

  // Suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const lastShownRef = useRef<string[]>([]);

  // Speech
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [lastExpansion, setLastExpansion] = useState<{
    raw: string;
    expanded: string;
  } | null>(null);
  const [voiceId, setVoiceId] = useState<string>("EXAVITQu4vr4xnSDxMaL");
  const [ipadModel, setIpadModel] = useState<string>("auto");

  // Speaker map
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
  const [jamesLabel, setJamesLabel] = useState<string | undefined>(undefined);
  const speakerMapRef = useRef<Record<string, string>>({});
  const jamesLabelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    speakerMapRef.current = speakerMap;
  }, [speakerMap]);
  useEffect(() => {
    seedJamesIfNeeded();
  }, []);
  useEffect(() => {
    jamesLabelRef.current = jamesLabel;
  }, [jamesLabel]);

  // Server fns
  const tokenFn = useServerFn(createScribeToken);
  const ttsFn = useServerFn(synthesizeSpeech);
  const suggestFn = useServerFn(generateSuggestions);
  const summarizeFn = useServerFn(summarizeConversation);
  const expandFn = useServerFn(expandUtterance);

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (d: { text: string }) => setPartial(d.text ?? ""),
    onCommittedTranscript: async (d: any) => {
      const text = (d.text ?? "").trim();
      if (!text || !conversationIdRef.current) return;
      setPartial("");
      const speakerLabel = d.words?.[0]?.speaker ?? d.speaker ?? "Speaker 1";
      const seg: TranscriptSegment = {
        id: newId(),
        conversation_id: conversationIdRef.current,
        speaker_label: String(speakerLabel),
        text,
        ts: Date.now(),
      };
      setCommitted((prev) => [...prev, seg]);
      await db.transcript_segments.add(seg);
    },
  });

  // Initial load: settings + people + GPS-based suggestions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      if (cancelled) return;
      setVoiceId(s.voice_id);
      setIpadModel(s.ipad_model ?? "auto");

      const people = await db.people.orderBy("name").toArray();
      if (!cancelled) setAllPeople(people);

      if (s.gps_enabled) {
        try {
          const pos = await getCurrentPosition();
          if (cancelled) return;
          const match = await findNearestPlace(
            pos.coords.latitude,
            pos.coords.longitude,
          );
          if (match) {
            placeIdRef.current = match.place.id;
            placeRef.current = match.place;
            setPlaceName(match.place.name);
            const usual = await suggestPeopleAtPlace(match.place.id);
            if (!cancelled) {
              setSelectedPersonIds(usual.map((p) => p.id));
            }
          }
        } catch {
          /* GPS denied */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recent (when not active)
  const [recent, setRecent] = useState<Conversation[]>([]);
  useEffect(() => {
    if (active) return;
    let cancelled = false;
    (async () => {
      const r = await db.conversations
        .orderBy("started_at")
        .reverse()
        .limit(5)
        .toArray();
      if (!cancelled) setRecent(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, stopping]);

  // ---- Start / Stop ----
  const handleStart = useCallback(async () => {
    if (active) return;
    const ok = await ensureMicPermission();
    if (!ok) return;
    try {
      const id = newId();
      conversationIdRef.current = id;
      startedAtRef.current = Date.now();
      personIdsRef.current = selectedPersonIds;
      setCommitted([]);
      setPartial("");
      setSuggestions([]);
      setSpeakerMap({});
      setJamesLabel(undefined);
      lastShownRef.current = [];

      const conv: Conversation = {
        id,
        started_at: startedAtRef.current,
        person_ids: selectedPersonIds,
        speaker_map: {},
        place_id: placeIdRef.current,
      };
      await db.conversations.add(conv);

      const { token } = await tokenFn();
      await scribe.connect({
        token,
        microphone: { echoCancellation: true, noiseSuppression: true },
      });
      setActive(true);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start conversation");
    }
  }, [active, scribe, tokenFn, selectedPersonIds]);

  const handleStop = useCallback(async () => {
    if (!active || stopping) return;
    setStopping(true);
    const cid = conversationIdRef.current;
    try {
      try {
        scribe.disconnect();
      } catch {}
      const endedAt = Date.now();
      if (cid) {
        await db.conversations.update(cid, { ended_at: endedAt });

        const segs = await db.transcript_segments
          .where("conversation_id")
          .equals(cid)
          .toArray();
        const transcript = segs
          .sort((a, b) => a.ts - b.ts)
          .map((s) => ({ speaker: s.speaker_label, text: s.text }));

        if (transcript.length > 0) {
          const peopleNames = (await db.people.bulkGet(personIdsRef.current))
            .filter((p): p is Person => !!p)
            .map((p) => p.name);
          toast.loading("Saving summary…", { id: "sum" });
          const r = await summarizeFn({
            data: {
              transcript,
              placeName: placeName ?? undefined,
              peopleNames,
            },
          });
          await db.conversations.update(cid, {
            summary: r.summary,
            highlights: r.highlights,
          });
          if (r.memories?.length) {
            const primary = personIdsRef.current[0];
            await db.memories.bulkAdd(
              r.memories.map(
                (m: {
                  text: string;
                  kind: "fact" | "preference" | "event" | "todo";
                }) => ({
                  id: newId(),
                  conversation_id: cid,
                  place_id: placeIdRef.current,
                  person_id: primary,
                  text: m.text,
                  kind: m.kind,
                  status: "auto" as const,
                  created_at: Date.now(),
                }),
              ),
            );
          }
          if (r.followUps?.length) {
            const primary = personIdsRef.current[0];
            await db.follow_ups.bulkAdd(
              r.followUps.map((t: string) => ({
                id: newId(),
                for_place_id: placeIdRef.current,
                for_person_id: primary,
                text: t,
                created_at: Date.now(),
                used: false,
              })),
            );
          }
          toast.success("Saved", { id: "sum" });
        }
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save", { id: "sum" });
    } finally {
      setActive(false);
      setStopping(false);
      conversationIdRef.current = null;
    }
  }, [active, stopping, scribe, summarizeFn, placeName]);

  // Auto speaker mapping
  useEffect(() => {
    if (!active || committed.length === 0) return;
    let cancelled = false;
    (async () => {
      // 1. Auto-create Person rows for anyone who introduces themselves
      const created = await autoCreateIntroducedPeople(
        committed,
        allPeople,
        { placeId: placeIdRef.current },
      );
      let working = allPeople;
      if (created.length > 0 && !cancelled) {
        working = [...allPeople, ...created];
        setAllPeople(working);
        // Add new arrivals to active conversation roster
        const newIds = created.map((p) => p.id);
        const merged = Array.from(
          new Set([...personIdsRef.current, ...newIds]),
        );
        personIdsRef.current = merged;
        setSelectedPersonIds(merged);
        if (conversationIdRef.current) {
          await db.conversations.update(conversationIdRef.current, {
            person_ids: merged,
          });
        }
        for (const p of created) toast.success(`Met ${p.name} — added to people`);
      }

      const candidates = working.filter((p) =>
        personIdsRef.current.includes(p.id),
      );
      if (candidates.length === 0) return;
      const { mapping } = autoMapSpeakers({
        segments: committed,
        candidates,
        current: speakerMapRef.current,
        jamesSpeakerLabel: jamesLabelRef.current,
      });
      const changed = Object.keys(mapping).some(
        (k) => mapping[k] !== speakerMapRef.current[k],
      );
      if (changed && conversationIdRef.current && !cancelled) {
        setSpeakerMap(mapping);
        db.conversations.update(conversationIdRef.current, {
          speaker_map: mapping,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [committed, allPeople, active]);

  // Auto-fetch suggestions
  const refreshSuggestions = useCallback(async () => {
    if (loadingSuggestions || !active) return;
    setLoadingSuggestions(true);
    try {
      const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
      const rawRecent = committed.slice(-12).map((s) => ({
        speaker: s.speaker_label,
        text: s.text,
      }));
      const recent = labelTranscriptForPrompt(
        rawRecent,
        speakerMapRef.current,
        peopleById,
        jamesLabelRef.current,
      );
      const ctx = await buildConversationContext({
        personIds: personIdsRef.current,
        place: placeRef.current,
      });
      const r = await suggestFn({
        data: {
          recentTranscript: recent,
          jamesProfile: ctx.jamesProfile,
          people: ctx.people,
          place: ctx.place,
          styleProfileJson: ctx.styleProfileJson,
          alreadyShown: lastShownRef.current.slice(-20),
        },
      });
      if (r.suggestions?.length) {
        setSuggestions(r.suggestions as Suggestion[]);
        lastShownRef.current = [
          ...lastShownRef.current,
          ...r.suggestions.map((s: Suggestion) => s.text),
        ].slice(-30);
        const now = Date.now();
        if (conversationIdRef.current) {
          await db.suggestions_log.bulkAdd(
            (r.suggestions as Suggestion[]).map((s) => ({
              id: newId(),
              conversation_id: conversationIdRef.current!,
              text: s.text,
              category: s.category,
              source: "ai",
              shown_at: now,
              selected: false,
              ignored: false,
              spoken: false,
            })),
          );
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSuggestions(false);
    }
  }, [committed, suggestFn, loadingSuggestions, allPeople, active]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      refreshSuggestions();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.length, active]);

  // Speak via TTS
  const speak = useCallback(
    async (text: string, meta?: { suggestion?: Suggestion }) => {
      if (!text.trim()) return;
      try {
        setSpeaking(true);
        const r = await ttsFn({ data: { text, voiceId } });
        const audio = new Audio(`data:${r.mime};base64,${r.audioBase64}`);
        await audio.play();
        if (meta?.suggestion && conversationIdRef.current) {
          const logs = await db.suggestions_log
            .where("conversation_id")
            .equals(conversationIdRef.current)
            .and((l) => l.text === meta.suggestion!.text && !l.selected)
            .toArray();
          if (logs[0]) {
            await db.suggestions_log.update(logs[0].id, {
              selected: true,
              spoken: true,
            });
          }
        } else if (conversationIdRef.current) {
          await db.manual_replies.add({
            id: newId(),
            conversation_id: conversationIdRef.current,
            text,
            ts: Date.now(),
          });
        }
      } catch (e: any) {
        toast.error(e?.message ?? "Speech failed");
      } finally {
        setSpeaking(false);
      }
    },
    [ttsFn, voiceId],
  );

  const transcriptList = useMemo(() => committed.slice(-12), [committed]);
  const peopleInConvo = useMemo(
    () => allPeople.filter((p) => selectedPersonIds.includes(p.id)),
    [allPeople, selectedPersonIds],
  );

  // Expand James's truncated typing via LLM, then speak the expanded version
  const expandAndSpeak = useCallback(async () => {
    const raw = draft.trim();
    if (!raw || expanding || speaking) return;
    setExpanding(true);
    try {
      const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
      const rawRecent = committed.slice(-12).map((s) => ({
        speaker: s.speaker_label,
        text: s.text,
      }));
      const recent = labelTranscriptForPrompt(
        rawRecent,
        speakerMapRef.current,
        peopleById,
        jamesLabelRef.current,
      );
      const ctx = await buildConversationContext({
        personIds: personIdsRef.current,
        place: placeRef.current,
      });
      const r = await expandFn({
        data: {
          rawText: raw,
          recentTranscript: recent,
          jamesProfile: ctx.jamesProfile,
          people: ctx.people,
          place: ctx.place,
        },
      });
      const spoken = (r.expanded || raw).trim();
      setLastExpansion({ raw, expanded: spoken });
      setDraft("");
      await speak(spoken);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not expand text");
    } finally {
      setExpanding(false);
    }
  }, [draft, expanding, speaking, expandFn, allPeople, committed, speak]);

  return (
    <ScaledShell ipadModel={ipadModel}>
    <main className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Top control bar — always visible, designed for landscape iPad */}
      <header className="flex shrink-0 items-stretch gap-3 border-b border-border bg-card px-3 py-3">
        {/* Start/Stop stacked buttons (small squares, top-left) */}
        <div className="flex shrink-0 flex-col gap-2">
          <button
            onClick={handleStart}
            disabled={active || stopping}
            aria-label="Start conversation"
            className={`flex size-14 items-center justify-center rounded-xl text-white shadow-sm transition-all active:scale-95 ${
              active
                ? "bg-emerald-300 ring-2 ring-emerald-400"
                : "bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
            }`}
          >
            <Mic className="size-6" />
          </button>
          <button
            onClick={handleStop}
            disabled={!active || stopping}
            aria-label="Stop conversation"
            className={`flex size-14 items-center justify-center rounded-xl text-white shadow-sm transition-all active:scale-95 ${
              stopping
                ? "bg-rose-300 ring-2 ring-rose-400"
                : !active
                  ? "bg-rose-600/40 cursor-not-allowed"
                  : "bg-rose-600 hover:bg-rose-500"
            }`}
          >
            <Square className="size-5" />
          </button>
        </div>

        {/* Text entry — fills remaining width so it stays visible above the on-screen keyboard */}
        <div className="flex flex-1 flex-col gap-1">
          {lastExpansion && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
              <div className="flex-1 leading-snug">
                <span className="text-muted-foreground">Spoke: </span>
                <span className="font-medium">{lastExpansion.expanded}</span>
                <span className="ml-2 text-muted-foreground">
                  (typed: “{lastExpansion.raw}”)
                </span>
              </div>
              <button
                onClick={() => setLastExpansion(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          <div className="flex flex-1 items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  expandAndSpeak();
                }
              }}
              placeholder="Type roughly — AI will clarify and speak it…"
              className="h-[120px] min-h-[120px] flex-1 resize-none text-base"
            />
            <Button
              size="lg"
              className="h-[120px] gap-2 rounded-2xl px-5"
              onClick={expandAndSpeak}
              disabled={speaking || expanding || !draft.trim()}
            >
              {expanding ? (
                <Sparkles className="size-5 animate-pulse" />
              ) : (
                <Volume2 className="size-5" />
              )}
              <span className="hidden sm:inline">
                {expanding ? "Clarifying…" : "Speak"}
              </span>
            </Button>
          </div>
        </div>

        {/* Settings link top-right */}
        <Link
          to="/settings"
          aria-label="Settings"
          className="flex size-14 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary"
        >
          <SettingsIcon className="size-6" />
        </Link>
      </header>

      {/* Status / context strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">
        <button
          onClick={() => setShowPeoplePicker(true)}
          className="flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-3 py-1 hover:bg-secondary"
        >
          <Users className="size-4" />
          {peopleInConvo.length === 0
            ? "Choose people"
            : peopleInConvo.map((p) => p.name).join(", ")}
        </button>
        {placeName && (
          <span className="flex items-center gap-1">
            <MapPin className="size-4" /> {placeName}
          </span>
        )}
        {active && (
          <span className="flex items-center gap-1.5 text-destructive">
            <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
            Recording
          </span>
        )}
        <SpeakerBar
          segments={committed}
          speakerMap={speakerMap}
          jamesLabel={jamesLabel}
          candidates={peopleInConvo}
          onAssign={(label, personId) => {
            const next = { ...speakerMap };
            for (const k of Object.keys(next)) {
              if (next[k] === personId) delete next[k];
            }
            next[label] = personId;
            setSpeakerMap(next);
            if (conversationIdRef.current)
              db.conversations.update(conversationIdRef.current, {
                speaker_map: next,
              });
          }}
          onSetJames={(label) => {
            setJamesLabel(label);
            if (speakerMap[label]) {
              const next = { ...speakerMap };
              delete next[label];
              setSpeakerMap(next);
              if (conversationIdRef.current)
                db.conversations.update(conversationIdRef.current, {
                  speaker_map: next,
                });
            }
          }}
          onClear={(label) => {
            const next = { ...speakerMap };
            delete next[label];
            setSpeakerMap(next);
            if (conversationIdRef.current)
              db.conversations.update(conversationIdRef.current, {
                speaker_map: next,
              });
            if (jamesLabel === label) setJamesLabel(undefined);
          }}
        />
      </div>

      {/* Main two-column area: full width landscape */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {/* Suggestions — 4 cols × 4 rows */}
        <section className="flex min-h-0 flex-[3] flex-col rounded-2xl border border-border bg-card/40">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="size-4" /> Suggestions
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshSuggestions}
              disabled={loadingSuggestions || !active}
            >
              {loadingSuggestions ? "Thinking…" : "Refresh"}
            </Button>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-4 gap-1.5 overflow-hidden p-2">
            {!active && suggestions.length === 0 && (
              <Card className="col-span-4 row-span-4 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Press the green mic button to start a conversation. Suggestions
                will appear here.
              </Card>
            )}
            {active && suggestions.length === 0 && !loadingSuggestions && (
              <Card className="col-span-4 row-span-4 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Listening… suggestions will appear after a few words.
              </Card>
            )}
            {suggestions.slice(0, 16).map((s, i) => (
              <button
                key={`${i}-${s.text}`}
                onClick={() => speak(s.text, { suggestion: s })}
                disabled={speaking}
                className={`flex h-full min-h-0 w-full items-center justify-center rounded-xl border-2 p-2 text-center text-base leading-tight transition-transform active:scale-[0.98] ${categoryClass(s.category)}`}
              >
                <span className="line-clamp-4">{s.text}</span>
              </button>
            ))}
          </div>
          {/* Quick phrases */}
          <div className="flex flex-wrap gap-1.5 border-t border-border p-2">
            {QUICK_PHRASES.map((p) => (
              <Button
                key={p}
                variant="secondary"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => speak(p)}
                disabled={speaking}
              >
                {p}
              </Button>
            ))}
          </div>
        </section>

        {/* Transcript / Recent — strip along the bottom */}
        <section className="flex min-h-0 flex-[1] flex-col rounded-2xl border border-border bg-card/40">
          <div className="border-b border-border px-3 py-1.5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {active ? "Transcript" : "Recent conversations"}
            </h2>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 text-sm">
            {active ? (
              <>
                {transcriptList.length === 0 && !partial && (
                  <p className="text-sm italic text-muted-foreground">
                    Listening…
                  </p>
                )}
                {transcriptList.map((s) => {
                  const displayName =
                    s.speaker_label === jamesLabel
                      ? "James"
                      : (() => {
                          const pid = speakerMap[s.speaker_label];
                          return pid
                            ? (allPeople.find((p) => p.id === pid)?.name ??
                                s.speaker_label)
                            : s.speaker_label;
                        })();
                  return (
                    <div key={s.id} className="leading-snug">
                      <span className="mr-2 text-xs font-medium text-muted-foreground">
                        {displayName}
                      </span>
                      {s.text}
                    </div>
                  );
                })}
                {partial && (
                  <div className="italic leading-snug text-muted-foreground">
                    {partial}
                  </div>
                )}
              </>
            ) : (
              <>
                {recent.length === 0 && (
                  <p className="text-sm italic text-muted-foreground">
                    No conversations yet.
                  </p>
                )}
                {recent.map((c) => (
                  <Card key={c.id} className="p-2">
                    <div className="text-xs text-muted-foreground">
                      {new Date(c.started_at).toLocaleString()}
                    </div>
                    {c.summary ? (
                      <p className="mt-1 leading-snug">{c.summary}</p>
                    ) : (
                      <p className="mt-1 text-xs italic text-muted-foreground">
                        {c.ended_at ? "No summary" : "In progress…"}
                      </p>
                    )}
                  </Card>
                ))}
              </>
            )}
          </div>
        </section>
      </div>

      {/* People picker modal */}
      {showPeoplePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowPeoplePicker(false)}
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
                onClick={() => setShowPeoplePicker(false)}
                className="rounded-full p-2 hover:bg-secondary"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {allPeople.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">
                  No people added yet. Add them in{" "}
                  <Link to="/settings" className="underline">
                    Settings
                  </Link>
                  .
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allPeople.map((p) => {
                    const sel = selectedPersonIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() =>
                          setSelectedPersonIds((cur) =>
                            cur.includes(p.id)
                              ? cur.filter((x) => x !== p.id)
                              : [...cur, p.id],
                          )
                        }
                        className={`flex items-center gap-2 rounded-full border-2 px-4 py-2 text-base transition-colors ${
                          sel
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                        }`}
                      >
                        {sel && <Check className="size-4" />}
                        <span className="font-medium">{p.name}</span>
                        {p.relationship && (
                          <span className="text-xs opacity-70">
                            {p.relationship}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="border-t border-border px-5 py-3">
              <Button
                className="w-full"
                onClick={() => setShowPeoplePicker(false)}
              >
                Done
              </Button>
            </div>
          </Card>
        </div>
      )}
    </main>
    </ScaledShell>
  );
}

/* --------------------------- Speaker mapping bar -------------------------- */

function SpeakerBar({
  segments,
  speakerMap,
  jamesLabel,
  candidates,
  onAssign,
  onSetJames,
  onClear,
}: {
  segments: TranscriptSegment[];
  speakerMap: Record<string, string>;
  jamesLabel?: string;
  candidates: Person[];
  onAssign: (label: string, personId: string) => void;
  onSetJames: (label: string) => void;
  onClear: (label: string) => void;
}) {
  const labels = useMemo(() => {
    const seen = new Set<string>();
    for (const s of segments) seen.add(s.speaker_label);
    return [...seen];
  }, [segments]);

  if (labels.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((label) => {
        const isJames = label === jamesLabel;
        const pid = speakerMap[label];
        const person = pid ? candidates.find((p) => p.id === pid) : undefined;
        const displayName = isJames ? "James" : (person?.name ?? label);
        const assigned = isJames || !!person;
        return (
          <Popover key={label}>
            <PopoverTrigger asChild>
              <button
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  assigned
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                }`}
              >
                <span className="font-medium">{displayName}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2">
              <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Who is "{label}"?
              </div>
              <button
                onClick={() => onSetJames(label)}
                className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-secondary"
              >
                <span>James (this is me)</span>
                {jamesLabel === label && <Check className="size-4" />}
              </button>
              {candidates.map((p) => {
                const used = speakerMap[label] === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => onAssign(label, p.id)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span>{p.name}</span>
                    {used && <Check className="size-4" />}
                  </button>
                );
              })}
              {(jamesLabel === label || speakerMap[label]) && (
                <button
                  onClick={() => onClear(label)}
                  className="mt-1 w-full rounded-md px-2 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  Clear
                </button>
              )}
            </PopoverContent>
          </Popover>
        );
      })}
    </div>
  );
}

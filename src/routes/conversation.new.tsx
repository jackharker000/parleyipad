import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useScribe, CommitStrategy } from "@elevenlabs/react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  MapPin,
  Mic,
  MicOff,
  Send,
  Square,
  Volume2,
  Sparkles,
  Users,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  db,
  getSettings,
  newId,
  type Conversation,
  type Person,
  type Place,
  type TranscriptSegment,
} from "@/lib/db";
import { findNearestPlace, getCurrentPosition } from "@/lib/geo";
import {
  createScribeToken,
  generateSuggestions,
  summarizeConversation,
  synthesizeSpeech,
} from "@/lib/aac.functions";
import { buildConversationContext, suggestPeopleAtPlace } from "@/lib/context";

export const Route = createFileRoute("/conversation/new")({
  component: LiveConversation,
});

type Suggestion = { text: string; category: string; why?: string };

const QUICK_PHRASES = [
  "Yes",
  "No",
  "Give me a moment",
  "Could you repeat that?",
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

function PersonChip({
  person,
  selected,
  onToggle,
}: {
  person: Person;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-2 rounded-full border-2 px-4 py-2 text-base transition-colors ${
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
      }`}
    >
      {selected && <Check className="size-4" />}
      <span className="font-medium">{person.name}</span>
      {person.relationship && (
        <span className="text-xs opacity-70">{person.relationship}</span>
      )}
    </button>
  );
}

function LiveConversation() {
  const router = useRouter();
  const conversationIdRef = useRef<string>(newId());
  const startedAtRef = useRef<number>(Date.now());
  const [placeName, setPlaceName] = useState<string | null>(null);
  const placeIdRef = useRef<string | undefined>(undefined);
  const placeRef = useRef<Place | undefined>(undefined);
  const gpsRef = useRef<{ lat: number; lng: number } | null>(null);

  // People picker state
  const [showPicker, setShowPicker] = useState(true);
  const [allPeople, setAllPeople] = useState<Person[]>([]);
  const [suggestedPeople, setSuggestedPeople] = useState<Person[]>([]);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const personIdsRef = useRef<string[]>([]);

  const [committed, setCommitted] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [voiceId, setVoiceId] = useState<string>("EXAVITQu4vr4xnSDxMaL");
  const lastShownRef = useRef<string[]>([]);

  const tokenFn = useServerFn(createScribeToken);
  const ttsFn = useServerFn(synthesizeSpeech);
  const suggestFn = useServerFn(generateSuggestions);
  const summarizeFn = useServerFn(summarizeConversation);

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (d: { text: string }) => setPartial(d.text ?? ""),
    onCommittedTranscript: async (d: any) => {
      const text = (d.text ?? "").trim();
      if (!text) return;
      setPartial("");
      const speakerLabel =
        d.words?.[0]?.speaker ?? d.speaker ?? "Speaker 1";
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

  // Initial setup: settings, conversation row, GPS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      if (cancelled) return;
      setVoiceId(s.voice_id);

      const conv: Conversation = {
        id: conversationIdRef.current,
        started_at: startedAtRef.current,
        person_ids: [],
        speaker_map: {},
      };
      await db.conversations.add(conv);

      const people = await db.people.orderBy("name").toArray();
      if (!cancelled) setAllPeople(people);

      if (s.gps_enabled) {
        try {
          const pos = await getCurrentPosition();
          if (cancelled) return;
          gpsRef.current = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          const match = await findNearestPlace(pos.coords.latitude, pos.coords.longitude);
          if (match) {
            placeIdRef.current = match.place.id;
            placeRef.current = match.place;
            setPlaceName(match.place.name);
            const usual = await suggestPeopleAtPlace(match.place.id);
            if (!cancelled) {
              setSuggestedPeople(usual);
              setSelectedPersonIds(usual.map((p) => p.id));
            }
          }
          await db.conversations.update(conversationIdRef.current, {
            gps_lat: pos.coords.latitude,
            gps_lng: pos.coords.longitude,
            place_id: match?.place.id,
          });
        } catch {
          /* GPS denied or unavailable — silently continue */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStartMic = useCallback(async () => {
    try {
      const { token } = await tokenFn();
      await scribe.connect({
        token,
        microphone: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start microphone");
    }
  }, [scribe, tokenFn]);

  // Start mic only AFTER picker is dismissed
  useEffect(() => {
    if (showPicker) return;
    handleStartMic();
    return () => {
      try {
        scribe.disconnect();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker]);

  async function confirmPicker() {
    personIdsRef.current = selectedPersonIds;
    await db.conversations.update(conversationIdRef.current, {
      person_ids: selectedPersonIds,
    });
    setShowPicker(false);
  }

  // Suggestion refresh loop
  const refreshSuggestions = useCallback(async () => {
    if (loadingSuggestions) return;
    setLoadingSuggestions(true);
    try {
      const recent = committed.slice(-12).map((s) => ({
        speaker: s.speaker_label,
        text: s.text,
      }));
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

        // Log each shown suggestion
        const now = Date.now();
        await db.suggestions_log.bulkAdd(
          (r.suggestions as Suggestion[]).map((s) => ({
            id: newId(),
            conversation_id: conversationIdRef.current,
            text: s.text,
            category: s.category,
            source: "ai",
            shown_at: now,
            selected: false,
            ignored: false,
            spoken: false,
          })),
        );
      } else if (r.error) {
        console.warn("Suggestion error:", r.error);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSuggestions(false);
    }
  }, [committed, placeName, suggestFn, loadingSuggestions]);

  // Auto-fetch on first load and after each new committed segment (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      refreshSuggestions();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.length]);

  // Speak text via TTS
  const speak = useCallback(
    async (text: string, meta?: { suggestion?: Suggestion }) => {
      if (!text.trim()) return;
      try {
        setSpeaking(true);
        const r = await ttsFn({ data: { text, voiceId } });
        const audio = new Audio(`data:${r.mime};base64,${r.audioBase64}`);
        await audio.play();

        if (meta?.suggestion) {
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
        } else {
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

  // Stop conversation: auto-summary + persist
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      try {
        scribe.disconnect();
      } catch {}
      const endedAt = Date.now();
      await db.conversations.update(conversationIdRef.current, {
        ended_at: endedAt,
      });

      const segs = await db.transcript_segments
        .where("conversation_id")
        .equals(conversationIdRef.current)
        .toArray();
      const transcript = segs
        .sort((a, b) => a.ts - b.ts)
        .map((s) => ({ speaker: s.speaker_label, text: s.text }));

      if (transcript.length === 0) {
        toast.info("Conversation ended (no speech captured)");
        router.navigate({ to: "/" });
        return;
      }

      const peopleNames = (
        await db.people.bulkGet(personIdsRef.current)
      )
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

      await db.conversations.update(conversationIdRef.current, {
        summary: r.summary,
        highlights: r.highlights,
      });

      if (r.memories?.length) {
        const primaryPersonId = personIdsRef.current[0];
        await db.memories.bulkAdd(
          r.memories.map((m: { text: string; kind: "fact" | "preference" | "event" | "todo" }) => ({
            id: newId(),
            conversation_id: conversationIdRef.current,
            place_id: placeIdRef.current,
            person_id: primaryPersonId,
            text: m.text,
            kind: m.kind,
            status: "auto" as const,
            created_at: Date.now(),
          })),
        );
      }
      if (r.followUps?.length) {
        const primaryPersonId = personIdsRef.current[0];
        await db.follow_ups.bulkAdd(
          r.followUps.map((t: string) => ({
            id: newId(),
            for_place_id: placeIdRef.current,
            for_person_id: primaryPersonId,
            text: t,
            created_at: Date.now(),
            used: false,
          })),
        );
      }

      toast.success("Saved", { id: "sum" });
      router.navigate({ to: "/" });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save", { id: "sum" });
      router.navigate({ to: "/" });
    } finally {
      setStopping(false);
    }
  }, [stopping, scribe, placeName, summarizeFn, router]);

  const transcriptList = useMemo(
    () => [...committed].slice(-8),
    [committed],
  );

  // Render picker overlay before conversation begins
  if (showPicker) {
    return (
      <main className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex items-center justify-between border-b border-border bg-card px-5 py-3">
          <button
            onClick={() => router.navigate({ to: "/" })}
            className="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-secondary"
          >
            <ArrowLeft className="size-5" /> Cancel
          </button>
          {placeName && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-4" /> {placeName}
            </span>
          )}
        </header>
        <section className="flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-3xl">
            <h2 className="flex items-center gap-2 text-2xl font-semibold">
              <Users className="size-6" /> Who's in this conversation?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Tap people to include their context in suggestions. You can skip if you're not sure.
            </p>

            {suggestedPeople.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Usually here
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestedPeople.map((p) => (
                    <PersonChip
                      key={p.id}
                      person={p}
                      selected={selectedPersonIds.includes(p.id)}
                      onToggle={() =>
                        setSelectedPersonIds((cur) =>
                          cur.includes(p.id)
                            ? cur.filter((x) => x !== p.id)
                            : [...cur, p.id],
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                All people
              </h3>
              {allPeople.length === 0 ? (
                <p className="mt-2 text-sm italic text-muted-foreground">
                  No people added yet. Add them in Settings to personalize suggestions.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {allPeople
                    .filter(
                      (p) => !suggestedPeople.find((s) => s.id === p.id),
                    )
                    .map((p) => (
                      <PersonChip
                        key={p.id}
                        person={p}
                        selected={selectedPersonIds.includes(p.id)}
                        onToggle={() =>
                          setSelectedPersonIds((cur) =>
                            cur.includes(p.id)
                              ? cur.filter((x) => x !== p.id)
                              : [...cur, p.id],
                          )
                        }
                      />
                    ))}
                </div>
              )}
            </div>
          </div>
        </section>
        <footer className="border-t border-border bg-card px-5 py-4">
          <div className="mx-auto flex max-w-3xl gap-2">
            <Button
              variant="secondary"
              className="h-12 flex-1"
              onClick={confirmPicker}
            >
              Skip
            </Button>
            <Button className="h-12 flex-[2] gap-2" onClick={confirmPicker}>
              <Mic className="size-5" /> Start conversation
            </Button>
          </div>
        </footer>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border bg-card px-5 py-3">
        <button
          onClick={handleStop}
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-secondary"
        >
          <ArrowLeft className="size-5" /> End
        </button>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {placeName && (
            <span className="flex items-center gap-1">
              <MapPin className="size-4" /> {placeName}
            </span>
          )}
          <span
            className={`flex items-center gap-1.5 ${scribe.isConnected ? "text-destructive" : ""}`}
          >
            {scribe.isConnected ? (
              <>
                <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
                Recording
              </>
            ) : (
              <>
                <MicOff className="size-4" /> Mic off
              </>
            )}
          </span>
        </div>
      </header>

      {/* Transcript */}
      <section className="border-b border-border bg-card/50 px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-1.5">
          {transcriptList.length === 0 && !partial && (
            <p className="text-sm italic text-muted-foreground">
              Listening… start the conversation.
            </p>
          )}
          {transcriptList.map((s) => (
            <div key={s.id} className="text-base leading-snug">
              <span className="mr-2 text-xs font-medium text-muted-foreground">
                {s.speaker_label}
              </span>
              {s.text}
            </div>
          ))}
          {partial && (
            <div className="text-base italic leading-snug text-muted-foreground">
              {partial}
            </div>
          )}
        </div>
      </section>

      {/* Suggestions */}
      <section className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="size-4" /> Suggestions
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshSuggestions}
              disabled={loadingSuggestions}
            >
              {loadingSuggestions ? "Thinking…" : "Refresh"}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {suggestions.length === 0 && !loadingSuggestions && (
              <Card className="col-span-full p-5 text-sm text-muted-foreground">
                Tap Refresh once you've heard a few words.
              </Card>
            )}
            {suggestions.map((s, i) => (
              <button
                key={`${i}-${s.text}`}
                onClick={() => speak(s.text, { suggestion: s })}
                disabled={speaking}
                className={`flex min-h-[88px] items-center rounded-2xl border-2 p-4 text-left text-lg leading-snug transition-transform active:scale-[0.98] ${categoryClass(s.category)}`}
              >
                <span className="flex-1">{s.text}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom: type-and-speak + quick phrases + stop */}
      <footer className="border-t border-border bg-card px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="flex flex-wrap gap-2">
            {QUICK_PHRASES.map((p) => (
              <Button
                key={p}
                variant="secondary"
                className="h-11 rounded-full px-4 text-base"
                onClick={() => speak(p)}
                disabled={speaking}
              >
                {p}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type something to say…"
              className="min-h-[60px] flex-1 resize-none text-base"
            />
            <Button
              size="lg"
              className="h-[60px] gap-2 rounded-2xl px-5"
              onClick={() => {
                const t = draft.trim();
                if (!t) return;
                speak(t);
                setDraft("");
              }}
              disabled={speaking || !draft.trim()}
            >
              <Volume2 className="size-5" /> Speak
            </Button>
          </div>
          <Button
            variant="destructive"
            className="h-12 w-full gap-2 rounded-2xl"
            onClick={handleStop}
            disabled={stopping}
          >
            <Square className="size-5" /> {stopping ? "Saving…" : "End conversation"}
          </Button>
        </div>
      </footer>
    </main>
  );
}
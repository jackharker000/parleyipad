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
  Calendar,
  History,
  Plus,
  Reply,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  db,
  getSettings,
  newId,
  type Conversation,
  type EventItem,
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
  identifySpeakerFromContext,
} from "@/lib/aac.functions";
import { buildConversationContext, suggestPeopleAtPlace } from "@/lib/context";
import { labelTranscriptForPrompt } from "@/lib/speaker-id";
import { extractIntroducedNames } from "@/lib/auto-person";
import { seedJamesIfNeeded } from "@/lib/seed";
import {
  VoiceCapture,
  computeMfccMean,
  recordVoiceprint,
  bestMatch,
  Diarizer,
} from "@/lib/voiceprint";
import { VOICEPRINT_MATCH_THRESHOLD } from "@/lib/db";
import { SpeakerPanel, type ClusterRow, type ClusterStatus, type SuggestedName } from "@/components/SpeakerPanel";

export const Route = createFileRoute("/")({
  component: Home,
});

type Suggestion = { text: string; category: string; why?: string };

const MOODS = [
  { id: "normal", label: "Normal", color: "bg-secondary text-secondary-foreground" },
  { id: "calm", label: "Calm", color: "bg-sky-500 text-white" },
  { id: "excited", label: "Excited", color: "bg-amber-500 text-white" },
  { id: "sad", label: "Sad", color: "bg-blue-700 text-white" },
  { id: "upset", label: "Upset", color: "bg-red-600 text-white" },
  { id: "empathetic", label: "Empathetic", color: "bg-emerald-600 text-white" },
  { id: "amused", label: "Amused", color: "bg-fuchsia-600 text-white" },
] as const;
type MoodId = (typeof MOODS)[number]["id"];

// Synthetic speaker label used for things James speaks via TTS, so they get
// recorded into the transcript and folded into future suggestion prompts.
const JAMES_SELF_LABEL = "__james_self__";

const QUICK_PHRASES = [
  "Yes",
  "No",
  "Give me a moment",
  "Could you repeat that?",
  "Sorry, who am I speaking with?",
];

/** Append a suggestion chip onto a cluster status, de-duped by name. */
function mergeSuggestion(
  status: ClusterStatus,
  chip: SuggestedName,
): ClusterStatus {
  if (status.kind === "confirmed") return status;
  const cur = status.suggestions ?? [];
  if (cur.some((s) => s.name.toLowerCase() === chip.name.toLowerCase())) {
    return status;
  }
  return { ...status, suggestions: [...cur, chip] } as ClusterStatus;
}

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
  // Tracks the most recent conversation id even after Stop, so that
  // James's typed lines and tapped suggestions keep appending to the
  // last recording instead of being lost.
  const lastConversationIdRef = useRef<string | null>(null);
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
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRel, setNewPersonRel] = useState("");

  // Event (optional)
  const [allEvents, setAllEvents] = useState<EventItem[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const selectedEventRef = useRef<EventItem | null>(null);
  const [showEventPicker, setShowEventPicker] = useState(false);
  useEffect(() => {
    selectedEventRef.current = selectedEvent;
  }, [selectedEvent]);

  // Transcript
  const [committed, setCommitted] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState("");

  // Suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const lastShownRef = useRef<string[]>([]);
  const [mood, setMood] = useState<MoodId>("normal");
  const moodRef = useRef<MoodId>("normal");
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

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
  const fastModelRef = useRef<string>("google/gemini-2.5-flash-lite");
  const smartModelRef = useRef<string>("google/gemini-2.5-pro");

  // Speaker map
  // `speakerMap` only ever contains CONFIRMED entries (label -> personId).
  // Unknown / suggested-but-unconfirmed labels stay as "Speaker N".
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
  const speakerMapRef = useRef<Record<string, string>>({});
  const jamesLabelRef = useRef<string | undefined>(undefined);

  // ---- On-device voice fingerprinting ----
  const captureRef = useRef<VoiceCapture | null>(null);
  // Single source of truth for diarization this session.
  const diarizerRef = useRef<Diarizer>(new Diarizer(0.82));
  // Cluster status (suggested / confirmed) keyed by diarizer label.
  const [clusterStatus, setClusterStatus] = useState<Record<string, ClusterStatus>>({});
  const clusterStatusRef = useRef<Record<string, ClusterStatus>>({});
  useEffect(() => {
    clusterStatusRef.current = clusterStatus;
  }, [clusterStatus]);
  // Force re-render when diarizer counts/clusters change.
  const [, setClusterTick] = useState(0);
  // When James presses "Ask" on a specific cluster, the next time that
  // cluster speaks we attribute any heard self-intro name back to it.
  const expectingNameForClusterRef = useRef<string | null>(null);
  // Require 2 consecutive voiceprint matches before suggesting a speaker to
  // reduce false positives from short or noisy utterances.
  const pendingVoiceprintMatchRef = useRef<Map<string, { personId: string; matchCount: number }>>(new Map());
  // Track which unknown clusters have already had AI context-ID fired (once per cluster).
  const aiSpeakerIdSentRef = useRef<Set<string>>(new Set());
  // Keep a fresh copy of `committed` accessible inside stale scribe callback.
  const committedRef = useRef<TranscriptSegment[]>([]);
  useEffect(() => {
    committedRef.current = committed;
  }, [committed]);
  useEffect(() => {
    speakerMapRef.current = speakerMap;
  }, [speakerMap]);
  useEffect(() => {
    seedJamesIfNeeded();
  }, []);

  // Server fns
  const tokenFn = useServerFn(createScribeToken);
  const ttsFn = useServerFn(synthesizeSpeech);
  const suggestFn = useServerFn(generateSuggestions);
  const summarizeFn = useServerFn(summarizeConversation);
  const expandFn = useServerFn(expandUtterance);
  const identifyFn = useServerFn(identifySpeakerFromContext);

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    includeTimestamps: true,
    onPartialTranscript: (d: { text: string }) => setPartial(d.text ?? ""),
    onCommittedTranscriptWithTimestamps: async (d: any) => {
      const text = (d.text ?? "").trim();
      if (!text || !conversationIdRef.current) return;
      setPartial("");

      // -------- Compute MFCC for this segment first so we can run our own
      // local diarization regardless of what Scribe returns.
      const cap = captureRef.current;
      let mfcc: number[] | null = null;
      let spoken = 0;
      if (cap && d.words && d.words.length > 0) {
        try {
          const firstW = d.words[0];
          const lastW = d.words[d.words.length - 1];
          spoken = (lastW.end ?? 0) - (firstW.start ?? 0);
          if (spoken >= 0.5) {
            const dur = Math.max(1.2, spoken);
            const pcm = cap.recentSlice(dur, 1.0);
            mfcc = computeMfccMean(pcm, cap.sampleRate);
          }
        } catch (err) {
          console.warn("[voiceprint] mfcc compute failed", err);
        }
      }

      // -------- Pick a canonical speaker label for this segment.
      // Single source of truth: the local Diarizer. We deliberately ignore
      // Scribe's speaker_id — in our tests it produced one label for whole
      // multi-speaker recordings, which then poisoned downstream mapping.
      // Utterances that were too quiet/short to MFCC stick to the previous
      // label so we don't invent ghost clusters from "uh huh".
      let speakerLabel: string;
      let assignSim = -1;
      let assignNew = false;
      let introOverride = false;
      if (mfcc) {
        // Textual override: if the speaker introduces themselves with a name
        // that conflicts with the cluster their MFCC would merge into, force
        // a fresh cluster. Two adult voices on the same mic often share
        // enough MFCC similarity to be mis-merged; the textual self-intro is
        // a far stronger signal of "different speaker".
        const introducedName = extractIntroducedNames([
          { text, speaker_label: "" },
        ])[0]?.name;
        let forceNew = false;
        if (introducedName) {
          const preview = diarizerRef.current.peek(mfcc);
          if (preview.label && preview.wouldMerge) {
            const previewStatus = clusterStatusRef.current[preview.label];
            // Find who that cluster is currently attributed to (confirmed
            // or stored-voiceprint-suggested) — they're our reference identity.
            let attributedName: string | undefined;
            if (previewStatus?.kind === "confirmed") {
              attributedName = allPeople.find((p) => p.id === previewStatus.personId)?.name;
            } else if (previewStatus?.kind === "suggested") {
              attributedName = allPeople.find((p) => p.id === previewStatus.personId)?.name;
            }
            if (attributedName && attributedName.toLowerCase() !== introducedName.toLowerCase()) {
              forceNew = true;
              console.debug("[diarize] self-intro override → forcing new cluster", {
                introducedName,
                wouldHaveMergedInto: preview.label,
                attributedTo: attributedName,
                sim: preview.sim.toFixed(3),
              });
            }
          }
        }
        const r = forceNew
          ? diarizerRef.current.assignNew(mfcc)
          : diarizerRef.current.assign(mfcc);
        speakerLabel = r.label;
        assignSim = r.sim;
        assignNew = r.isNew;
        introOverride = forceNew;
      } else {
        const lastSeg = committed[committed.length - 1];
        speakerLabel = lastSeg?.speaker_label ?? "Speaker ?";
      }
      console.debug("[diarize]", {
        chosen: speakerLabel,
        sim: assignSim.toFixed(3),
        isNew: assignNew,
        introOverride,
        clusters: diarizerRef.current.clusters().length,
      });

      const seg: TranscriptSegment = {
        id: newId(),
        conversation_id: conversationIdRef.current,
        speaker_label: speakerLabel,
        text,
        ts: Date.now(),
      };
      setCommitted((prev) => [...prev, seg]);
      await db.transcript_segments.add(seg);

      // -------- Recognition pass (suggestion only — never auto-confirms).
      // For brand-new clusters, or any cluster still in `unknown` state, try
      // to match this cluster's running centroid against saved voiceprints.
      // Confirmed clusters keep their identity. Already-suggested clusters
      // keep their previous suggestion (stable until James acts on it).
      try {
        const cluster = diarizerRef.current.get(speakerLabel);
        const status = clusterStatusRef.current[speakerLabel];
        if (cluster && status?.kind !== "confirmed") {
          // Always look for self-introduction names in this segment.
          const introHere = extractIntroducedNames([
            { text, speaker_label: speakerLabel },
          ])[0]?.name;
          // Determine source: ask-reply if this cluster matches the one we
          // just asked, otherwise self-intro.
          const askTarget = expectingNameForClusterRef.current;
          const isAskReply =
            askTarget !== null &&
            (askTarget === speakerLabel || askTarget === "");
          // Resolve attribution target: ask-reply attributes back to the
          // cluster Ask was clicked on (if it was a per-cluster ask).
          const attributionLabel =
            isAskReply && askTarget && askTarget !== ""
              ? askTarget
              : speakerLabel;

          let nextStatus: ClusterStatus | undefined;
          // Only run voiceprint match for unknown clusters that haven't been
          // matched yet — keep stable suggestions once shown.
          if (!status || status.kind === "unknown") {
            const confirmedIds = new Set(Object.values(speakerMapRef.current));
            const allPrints = await db.voiceprints.toArray();
            const candidates = allPrints.filter(
              (p) => !confirmedIds.has(p.person_id),
            );
            const excludedIds = new Set(
              status?.kind === "unknown" ? (status.excludedPersonIds ?? []) : [],
            );
            const match = bestMatch(
              cluster.centroid,
              candidates,
              VOICEPRINT_MATCH_THRESHOLD,
              excludedIds,
            );
            if (match) {
              // High-confidence (≥ 0.88): surface suggestion immediately.
              // Lower confidence (0.80–0.88): require 2 consecutive matches to
              // avoid false-positive chips from single noisy utterances.
              const highConf = match.sim >= 0.88;
              const pending = pendingVoiceprintMatchRef.current.get(speakerLabel);
              if (pending?.personId === match.print.person_id) {
                const newCount = pending.matchCount + 1;
                pendingVoiceprintMatchRef.current.set(speakerLabel, { personId: match.print.person_id, matchCount: newCount });
                if (highConf || newCount >= 2) {
                  nextStatus = {
                    kind: "suggested",
                    personId: match.print.person_id,
                    sim: match.sim,
                    suggestions: status?.suggestions ?? [],
                  };
                }
              } else {
                pendingVoiceprintMatchRef.current.set(speakerLabel, { personId: match.print.person_id, matchCount: 1 });
                if (highConf) {
                  nextStatus = {
                    kind: "suggested",
                    personId: match.print.person_id,
                    sim: match.sim,
                    suggestions: status?.suggestions ?? [],
                  };
                }
              }
            } else {
              pendingVoiceprintMatchRef.current.delete(speakerLabel);
            }
          }

          // Append intro name as a suggestion chip on the attribution target.
          if (introHere) {
            const targetStatus =
              attributionLabel === speakerLabel
                ? (nextStatus ?? status ?? { kind: "unknown" as const })
                : (clusterStatusRef.current[attributionLabel] ?? {
                    kind: "unknown" as const,
                  });
            const newChip: SuggestedName = {
              name: introHere,
              source: isAskReply ? "ask-reply" : "self-intro",
            };
            const merged = mergeSuggestion(targetStatus, newChip);
            if (attributionLabel === speakerLabel) {
              nextStatus = merged;
            } else {
              const next = {
                ...clusterStatusRef.current,
                [attributionLabel]: merged,
              };
              clusterStatusRef.current = next;
              setClusterStatus(next);
            }
            // Consume the ask target if attribution succeeded.
            if (isAskReply) expectingNameForClusterRef.current = null;
          }

          if (nextStatus) {
            const next = {
              ...clusterStatusRef.current,
              [speakerLabel]: nextStatus,
            };
            clusterStatusRef.current = next;
            setClusterStatus(next);
          }

          // After 3+ utterances on an unknown cluster, fire a one-shot AI
          // context identification in the background.
          const clusterCount = cluster?.count ?? 0;
          const curStatusKind = (nextStatus ?? clusterStatusRef.current[speakerLabel])?.kind;
          if (
            clusterCount >= 3 &&
            curStatusKind !== "confirmed" &&
            curStatusKind !== "suggested" &&
            !aiSpeakerIdSentRef.current.has(speakerLabel)
          ) {
            aiSpeakerIdSentRef.current.add(speakerLabel);
            // Build confirmed speaker name map
            const confirmedNames: Record<string, string> = {};
            for (const [lbl, pid] of Object.entries(speakerMapRef.current)) {
              const p = allPeople.find((pp) => pp.id === pid);
              if (p) confirmedNames[lbl] = p.name;
            }
            // Use fresh committed via ref
            const recentForAI = committedRef.current.slice(-15).map((s) => {
              const pid = speakerMapRef.current[s.speaker_label];
              const p = pid ? allPeople.find((pp) => pp.id === pid) : null;
              return { speaker: p?.name ?? s.speaker_label, text: s.text };
            });
            identifyFn({
              data: {
                unknownLabel: speakerLabel,
                recentTranscript: recentForAI,
                confirmedSpeakers: confirmedNames,
                candidateNames: allPeople.map((p) => p.name),
                model: fastModelRef.current,
              },
            })
              .then((result) => {
                if (result.personName && result.confidence >= 0.65) {
                  const cur = clusterStatusRef.current[speakerLabel];
                  if (cur && cur.kind !== "confirmed") {
                    const chip: SuggestedName = {
                      name: result.personName,
                      source: "context-ai",
                    };
                    const merged = mergeSuggestion(cur, chip);
                    const next = {
                      ...clusterStatusRef.current,
                      [speakerLabel]: merged,
                    };
                    clusterStatusRef.current = next;
                    setClusterStatus(next);
                  }
                }
              })
              .catch(() => {});
          }
        }
        setClusterTick((n) => n + 1);
      } catch (err) {
        console.warn("voiceprint match failed", err);
      }
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
      fastModelRef.current =
        s.fast_model ?? s.suggestion_model ?? "google/gemini-2.5-flash-lite";
      smartModelRef.current = s.smart_model ?? "google/gemini-2.5-pro";

      const people = await db.people.orderBy("name").toArray();
      if (!cancelled) setAllPeople(people);

      const evs = await db.events.orderBy("created_at").reverse().toArray();
      if (!cancelled) setAllEvents(evs);

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
      if (!cancelled && r[0] && !lastConversationIdRef.current) {
        lastConversationIdRef.current = r[0].id;
      }
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
      lastConversationIdRef.current = id;
      startedAtRef.current = Date.now();
      personIdsRef.current = selectedPersonIds;
      setCommitted([]);
      setPartial("");
      setSuggestions([]);
      setSpeakerMap({});
      lastShownRef.current = [];
      diarizerRef.current.reset();
      setClusterStatus({});
      clusterStatusRef.current = {};
      pendingVoiceprintMatchRef.current.clear();
      aiSpeakerIdSentRef.current.clear();

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
      // Start parallel mic capture for voice fingerprinting (fail-soft).
      try {
        const cap = new VoiceCapture();
        await cap.start();
        captureRef.current = cap;
        console.debug("[voiceprint] capture started", {
          sampleRate: cap.sampleRate,
        });
      } catch (err) {
        console.warn("voice fingerprint capture unavailable", err);
        toast.warning(
          "Voice recognition unavailable — speakers won't be auto-identified.",
        );
        captureRef.current = null;
      }
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
      // Stop voice capture and persist final voiceprints for any mapped speakers
      const cap = captureRef.current;
      captureRef.current = null;
      try {
        if (cap) cap.stop();
      } catch {}
      // Re-persist confirmed voiceprints with the latest centroids (we may
      // have collected many more samples since the user pressed Confirm).
      try {
        for (const [label, personId] of Object.entries(speakerMapRef.current)) {
          const cluster = diarizerRef.current.get(label);
          if (cluster && cluster.count >= 1) {
            await recordVoiceprint(personId, cluster.centroid);
          }
        }
      } catch (err) {
        console.warn("final voiceprint persist failed", err);
      }
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
              model: smartModelRef.current,
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

  // (No auto-mapping effect: speakers are confirmed only via the SpeakerPanel.)

  // Auto-fetch suggestions
  // Tracks the (transcriptLen + mood) signature of the last AI call so we
  // skip redundant refreshes when nothing relevant has changed.
  const lastSuggestKeyRef = useRef<string>("");
  const refreshSuggestions = useCallback(async () => {
    if (loadingSuggestions || !active) return;
    const key = `${committed.length}:${moodRef.current}`;
    if (key === lastSuggestKeyRef.current) return;
    lastSuggestKeyRef.current = key;
    setLoadingSuggestions(true);
    try {
      const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
      const rawRecent = committed.slice(-8).map((s) => ({
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
        event: selectedEventRef.current ?? undefined,
      });
      // Detect if a question was just asked so the AI can prioritise answers.
      const jamesLabel = jamesLabelRef.current ?? "__james_self__";
      const QUESTION_STARTERS = /^(what|how|when|where|why|who|which|would|could|should|is|are|do|did|will|can)\b/i;
      const lastNonJames = committed
        .filter((s) => s.speaker_label !== jamesLabel && s.speaker_label !== "__james_self__")
        .slice(-2);
      const questionAsked = lastNonJames.some((s) => {
        const t = s.text.trim();
        return t.endsWith("?") || QUESTION_STARTERS.test(t);
      });
      const r = await suggestFn({
        data: {
          recentTranscript: recent,
          jamesProfile: ctx.jamesProfile,
          people: ctx.people,
          place: ctx.place,
          event: ctx.event,
          styleProfileJson: ctx.styleProfileJson,
          alreadyShown: lastShownRef.current.slice(-20),
          model: fastModelRef.current,
          mood: moodRef.current,
          questionAsked,
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
    // First call (no transcript yet): shorter delay so James has opening
    // suggestions within ~800ms of pressing Start.
    const delay = committed.length === 0 ? 800 : 1500;
    const t = setTimeout(() => {
      refreshSuggestions();
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.length, active, mood]);

  // Speak via TTS
  const speak = useCallback(
    async (text: string, meta?: { suggestion?: Suggestion }) => {
      if (!text.trim()) return;
      try {
        setSpeaking(true);
        const r = await ttsFn({ data: { text, voiceId } });
        const audio = new Audio(`data:${r.mime};base64,${r.audioBase64}`);
        await audio.play();
        // Record James's spoken line as a transcript segment so the next
        // suggestion refresh sees it as part of the conversation.
        const targetCid =
          conversationIdRef.current ?? lastConversationIdRef.current;
        if (targetCid) {
          const selfLabel = jamesLabelRef.current ?? JAMES_SELF_LABEL;
          const seg: TranscriptSegment = {
            id: newId(),
            conversation_id: targetCid,
            speaker_label: selfLabel,
            text,
            ts: Date.now(),
          };
          // Only update the live transcript view while recording is active.
          if (conversationIdRef.current) {
            setCommitted((prev) => [...prev, seg]);
          }
          await db.transcript_segments.add(seg);
        }
        if (meta?.suggestion && targetCid) {
          const logs = await db.suggestions_log
            .where("conversation_id")
            .equals(targetCid)
            .and((l) => l.text === meta.suggestion!.text && !l.selected)
            .toArray();
          if (logs[0]) {
            await db.suggestions_log.update(logs[0].id, {
              selected: true,
              spoken: true,
            });
          }
        } else if (targetCid) {
          await db.manual_replies.add({
            id: newId(),
            conversation_id: targetCid,
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

  const peopleInConvo = useMemo(
    () => allPeople.filter((p) => selectedPersonIds.includes(p.id)),
    [allPeople, selectedPersonIds],
  );

  // Build cluster rows from the diarizer + cluster-status state for the SpeakerPanel.
  const clusterRows = useMemo<ClusterRow[]>(() => {
    const rows: ClusterRow[] = [];
    for (const c of diarizerRef.current.clusters()) {
      const status = clusterStatus[c.label] ?? { kind: "unknown" as const };
      rows.push({ label: c.label, count: c.count, status });
    }
    // Stable sort by numeric portion of "Speaker N"
    rows.sort((a, b) => {
      const na = Number(a.label.replace(/\D/g, "")) || 0;
      const nb = Number(b.label.replace(/\D/g, "")) || 0;
      return na - nb;
    });
    return rows;
    // committed length triggers re-render via setClusterTick already
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterStatus, committed.length]);

  // ---- Speaker confirmation handlers ----
  const confirmKnownSpeaker = useCallback(
    async (label: string, personId: string) => {
      const cluster = diarizerRef.current.get(label);
      if (cluster) await recordVoiceprint(personId, cluster.centroid);
      // Update speakerMap (only confirmed entries) and conversation roster.
      const nextMap = { ...speakerMapRef.current };
      // Remove any prior label for this person
      for (const k of Object.keys(nextMap))
        if (nextMap[k] === personId) delete nextMap[k];
      nextMap[label] = personId;
      speakerMapRef.current = nextMap;
      setSpeakerMap(nextMap);
      const nextStatus = {
        ...clusterStatusRef.current,
        [label]: { kind: "confirmed" as const, personId },
      };
      clusterStatusRef.current = nextStatus;
      setClusterStatus(nextStatus);
      if (!personIdsRef.current.includes(personId)) {
        const merged = [...personIdsRef.current, personId];
        personIdsRef.current = merged;
        setSelectedPersonIds(merged);
      }
      if (conversationIdRef.current) {
        await db.conversations.update(conversationIdRef.current, {
          speaker_map: nextMap,
          person_ids: personIdsRef.current,
        });
      }
      const p = await db.people.get(personId);
      if (p) toast.success(`Confirmed ${p.name}`);
    },
    [],
  );

  const rejectSuggestion = useCallback((label: string) => {
    const cur = clusterStatusRef.current[label];
    const carried =
      cur && (cur.kind === "suggested" || cur.kind === "unknown")
        ? cur.suggestions
        : undefined;
    // Remember the rejected person so we skip them in future voiceprint matches.
    const prevExcluded =
      cur?.kind === "unknown" ? (cur.excludedPersonIds ?? []) : [];
    const rejectedId = cur?.kind === "suggested" ? cur.personId : null;
    const excludedPersonIds = rejectedId
      ? [...prevExcluded, rejectedId].filter(
          (id, i, arr) => arr.indexOf(id) === i,
        )
      : prevExcluded;
    const next = {
      ...clusterStatusRef.current,
      [label]: {
        kind: "unknown" as const,
        suggestions: carried,
        excludedPersonIds,
      },
    };
    clusterStatusRef.current = next;
    setClusterStatus(next);
  }, []);

  const confirmNewSpeaker = useCallback(
    async (label: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Re-use existing person if name (first-name) matches
      const existing = allPeople.find(
        (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
      );
      let personId: string;
      if (existing) {
        personId = existing.id;
      } else {
        const p: Person = {
          id: newId(),
          name: trimmed,
          relationship: "",
          interests: [],
          notes: placeName ? `Met during a conversation at ${placeName}.` : "",
          style_notes: "",
          created_at: Date.now(),
        };
        await db.people.add(p);
        setAllPeople((cur) => [...cur, p].sort((a, b) => a.name.localeCompare(b.name)));
        personId = p.id;
      }
      await confirmKnownSpeaker(label, personId);
    },
    [allPeople, placeName, confirmKnownSpeaker],
  );

  // Drop a confirmed cluster back to unknown (does NOT delete the saved
  // voiceprint of the previously-confirmed person — only this session's link).
  const clearConfirmedSpeaker = useCallback(async (label: string) => {
    const nextMap = { ...speakerMapRef.current };
    delete nextMap[label];
    speakerMapRef.current = nextMap;
    setSpeakerMap(nextMap);
    const nextStatus = {
      ...clusterStatusRef.current,
      [label]: { kind: "unknown" as const },
    };
    clusterStatusRef.current = nextStatus;
    setClusterStatus(nextStatus);
    if (conversationIdRef.current) {
      await db.conversations.update(conversationIdRef.current, {
        speaker_map: nextMap,
      });
    }
  }, []);

  const mergeSpeakerClusters = useCallback(
    async (fromLabel: string, toLabel: string) => {
      const ok = diarizerRef.current.mergeClusters(fromLabel, toLabel);
      if (!ok) return;

      // Relabel all transcript segments in state and DB.
      setCommitted((prev) =>
        prev.map((s) =>
          s.speaker_label === fromLabel ? { ...s, speaker_label: toLabel } : s,
        ),
      );
      const cid = conversationIdRef.current;
      if (cid) {
        const segs = await db.transcript_segments
          .where("conversation_id")
          .equals(cid)
          .and((s) => s.speaker_label === fromLabel)
          .toArray();
        for (const seg of segs) {
          await db.transcript_segments.update(seg.id, {
            speaker_label: toLabel,
          });
        }
      }

      // Merge cluster status: prefer confirmed over other states.
      const fromStatus = clusterStatusRef.current[fromLabel];
      const toStatus = clusterStatusRef.current[toLabel];
      let newToStatus: ClusterStatus = toStatus ?? { kind: "unknown" as const };
      if (fromStatus?.kind === "confirmed" && newToStatus.kind !== "confirmed") {
        newToStatus = fromStatus;
      }
      const nextStatus = { ...clusterStatusRef.current };
      nextStatus[toLabel] = newToStatus;
      delete nextStatus[fromLabel];
      clusterStatusRef.current = nextStatus;
      setClusterStatus(nextStatus);

      // Merge speaker map.
      const nextMap = { ...speakerMapRef.current };
      if (nextMap[fromLabel] && !nextMap[toLabel]) {
        nextMap[toLabel] = nextMap[fromLabel];
      }
      delete nextMap[fromLabel];
      speakerMapRef.current = nextMap;
      setSpeakerMap(nextMap);

      // Re-persist voiceprint for the merged cluster if it's confirmed.
      const mergedCluster = diarizerRef.current.get(toLabel);
      const confirmedPersonId =
        nextMap[toLabel] ??
        (newToStatus.kind === "confirmed" ? newToStatus.personId : null);
      if (mergedCluster && confirmedPersonId) {
        await recordVoiceprint(confirmedPersonId, mergedCluster.centroid);
      }

      if (cid) {
        await db.conversations.update(cid, { speaker_map: nextMap });
      }
      setClusterTick((n) => n + 1);
      toast.success(`Merged ${fromLabel} → ${toLabel}`);
    },
    [],
  );

  const forceNewSpeaker = useCallback(() => {
    diarizerRef.current.forceNextNew();
    toast.info("Ready — next utterance will start a new speaker");
  }, []);

  const askSpeakerName = useCallback(
    (label?: string) => {
      // Empty string means "global ask"; null means "no pending ask".
      expectingNameForClusterRef.current = label ?? "";
      void speak("Sorry, who am I speaking with?");
    },
    [speak],
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
        event: selectedEventRef.current ?? undefined,
      });
      const r = await expandFn({
        data: {
          rawText: raw,
          recentTranscript: recent,
          jamesProfile: ctx.jamesProfile,
          people: ctx.people,
          place: ctx.place,
          // Use smart model for expansion — it's a one-shot operation so the
          // extra latency is acceptable, and quality matters more than speed here.
          model: smartModelRef.current,
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
      <header className="flex shrink-0 items-stretch gap-2 border-b border-border bg-card px-3 py-3">
        {/* Combined Record / Stop button — green when idle, red when recording */}
        <button
          onClick={active ? handleStop : handleStart}
          disabled={stopping}
          aria-label={active ? "Stop conversation" : "Start conversation"}
          className={`flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl text-white shadow-sm transition-all active:scale-95 ${
            stopping
              ? "bg-rose-300 ring-2 ring-rose-400"
              : active
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
          }`}
        >
          {active ? (
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
          </div>
        </div>

        {/* Speak button — same size as Record */}
        <button
          onClick={expandAndSpeak}
          disabled={speaking || expanding || !draft.trim()}
          aria-label="Speak"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl bg-primary text-primary-foreground shadow-sm transition-all active:scale-95 hover:bg-primary/90 disabled:opacity-50"
        >
          {expanding ? (
            <Sparkles className="size-7 animate-pulse" />
          ) : (
            <Volume2 className="size-7" />
          )}
          <span className="text-sm font-medium">
            {expanding ? "Clarifying" : "Speak"}
          </span>
        </button>

        {/* Recent conversations */}
        <Link
          to="/recent"
          aria-label="Recent conversations"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-foreground transition hover:bg-secondary"
        >
          <History className="size-7" />
          <span className="text-sm font-medium">Recent</span>
        </Link>

        {/* Reply helpers — Messages / Email / Facebook combined */}
        <Link
          to="/helpers"
          aria-label="Reply helpers for Messages, Email and Facebook"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-foreground transition hover:bg-secondary"
        >
          <Reply className="size-7" />
          <span className="text-sm font-medium">Helpers</span>
        </Link>

        {/* Settings */}
        <Link
          to="/settings"
          aria-label="Settings"
          className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-secondary/40 text-muted-foreground transition hover:bg-secondary"
        >
          <SettingsIcon className="size-7" />
          <span className="text-sm font-medium text-foreground">Settings</span>
        </Link>
      </header>

      {/* Status / context strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-3 py-4 text-base text-muted-foreground">
        <button
          onClick={() => setShowPeoplePicker(true)}
          className="flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-5 py-3 text-base hover:bg-secondary"
        >
          <Users className="size-5" />
          {peopleInConvo.length === 0
            ? "Choose people"
            : peopleInConvo.map((p) => p.name).join(", ")}
        </button>
        {placeName && (
          <span className="flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-5 py-3">
            <MapPin className="size-5" /> {placeName}
          </span>
        )}
        <button
          onClick={() => setShowEventPicker(true)}
          className={`flex items-center gap-2 rounded-full border px-5 py-3 text-base transition ${
            selectedEvent
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-secondary/40 hover:bg-secondary"
          }`}
        >
          <Calendar className="size-5" />
          {selectedEvent ? selectedEvent.name : "Event (optional)"}
        </button>
        {active && (
          <span className="flex items-center gap-1.5 text-destructive">
            <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
            Recording
          </span>
        )}
      </div>

      {/* Main two-column area: suggestions (80%) + speaker panel (20%) */}
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {/* Suggestions — 3 cols × 4 rows, 80% width */}
        <section className="flex min-h-0 w-4/5 flex-col rounded-2xl border border-border bg-card/40">
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
          <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-2 overflow-hidden p-2">
            {!active && suggestions.length === 0 && (
              <Card className="col-span-3 row-span-3 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Press the green mic button to start a conversation. Suggestions
                will appear here.
              </Card>
            )}
            {active && suggestions.length === 0 && !loadingSuggestions && (
              <Card className="col-span-3 row-span-3 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Listening… suggestions will appear after a few words.
              </Card>
            )}
            {suggestions.slice(0, 9).map((s, i) => (
              <button
                key={`${i}-${s.text}`}
                onClick={() => speak(s.text, { suggestion: s })}
                disabled={speaking}
                className={`flex h-full min-h-0 w-full items-center justify-center rounded-2xl border-2 p-3 text-center text-xl font-medium leading-snug transition-transform active:scale-[0.98] ${categoryClass(s.category)}`}
              >
                <span className="line-clamp-5">{s.text}</span>
              </button>
            ))}
          </div>
          {/* Quick phrases */}
          <div className="grid grid-cols-5 gap-1.5 border-t border-border p-2">
            {QUICK_PHRASES.map((p) => (
              <Button
                key={p}
                variant="secondary"
                className="h-16 rounded-xl px-3 text-base font-medium leading-tight whitespace-normal"
                onClick={() => speak(p)}
                disabled={speaking}
              >
                {p}
              </Button>
            ))}
          </div>
          {/* Mood selector — biases suggestions toward this emotional tone */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border p-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Mood
            </span>
            {MOODS.map((m) => {
              const selected = mood === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMood(m.id)}
                  aria-pressed={selected}
                  className={`rounded-full border-2 px-5 py-2.5 text-base font-medium transition ${
                    selected
                      ? `${m.color} border-transparent shadow`
                      : "border-border bg-background text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Speaker panel — 20% width */}
        <div className="flex min-h-0 w-1/5 flex-col">
          <SpeakerPanel
            segments={committed}
            partial={partial}
            clusters={clusterRows}
            people={allPeople}
            onConfirmKnown={confirmKnownSpeaker}
            onRejectSuggestion={rejectSuggestion}
            onConfirmNew={confirmNewSpeaker}
            onAskName={askSpeakerName}
            onClearConfirmed={clearConfirmedSpeaker}
            onMerge={mergeSpeakerClusters}
            onForceNew={forceNewSpeaker}
          />
        </div>
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
                <Button
                  className="flex-1"
                  onClick={() => setShowPeoplePicker(false)}
                >
                  Done
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Add new person mini-modal */}
      {addingPerson && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setAddingPerson(false)}
        >
          <Card
            className="w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
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
                <label className="mb-1 block text-sm font-medium">
                  Relationship (optional)
                </label>
                <input
                  value={newPersonRel}
                  onChange={(e) => setNewPersonRel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-base"
                  placeholder="e.g. care worker, friend"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setAddingPerson(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  const name = newPersonName.trim();
                  if (!name) {
                    toast.error("Name is required");
                    return;
                  }
                  const p: Person = {
                    id: newId(),
                    name,
                    relationship: newPersonRel.trim() || undefined,
                    interests: [],
                    notes: "",
                    style_notes: "",
                    created_at: Date.now(),
                  };
                  await db.people.put(p);
                  setAllPeople((cur) =>
                    [...cur, p].sort((a, b) => a.name.localeCompare(b.name)),
                  );
                  setSelectedPersonIds((cur) => [...cur, p.id]);
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

      {showEventPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowEventPicker(false)}
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
                onClick={() => setShowEventPicker(false)}
                className="rounded-full p-2 hover:bg-secondary"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <button
                onClick={() => {
                  setSelectedEvent(null);
                  setShowEventPicker(false);
                }}
                className={`mb-3 flex w-full items-center justify-between rounded-lg border-2 px-4 py-2 text-left ${
                  !selectedEvent
                    ? "border-primary bg-primary/10"
                    : "border-border bg-secondary/40 hover:bg-secondary"
                }`}
              >
                <span className="font-medium">No event</span>
                {!selectedEvent && <Check className="size-4" />}
              </button>
              {allEvents.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">
                  No events yet. Create one in{" "}
                  <Link to="/settings" className="underline">
                    Settings → Events
                  </Link>
                  .
                </p>
              ) : (
                <div className="space-y-2">
                  {allEvents.map((e) => {
                    const sel = selectedEvent?.id === e.id;
                    return (
                      <button
                        key={e.id}
                        onClick={() => {
                          setSelectedEvent(e);
                          setShowEventPicker(false);
                        }}
                        className={`flex w-full items-start justify-between gap-3 rounded-lg border-2 px-4 py-2 text-left ${
                          sel
                            ? "border-primary bg-primary/10"
                            : "border-border bg-secondary/40 hover:bg-secondary"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{e.name}</div>
                          {(e.when || e.location) && (
                            <div className="truncate text-xs text-muted-foreground">
                              {[e.when, e.location].filter(Boolean).join(" · ")}
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
      )}
    </main>
    </ScaledShell>
  );
}

function ScaledShell({
  ipadModel,
  children,
}: {
  ipadModel: string;
  children: React.ReactNode;
}) {
  const preset =
    ipadModel !== "auto" && ipadModel in IPAD_PRESETS
      ? IPAD_PRESETS[ipadModel as keyof typeof IPAD_PRESETS]
      : null;
  const [vp, setVp] = useState({
    w: typeof window === "undefined" ? 1194 : window.innerWidth,
    h: typeof window === "undefined" ? 834 : window.innerHeight,
  });
  useEffect(() => {
    const onResize = () =>
      setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!preset) {
    return (
      <div className="h-screen w-screen overflow-hidden">{children}</div>
    );
  }

  const scale = Math.min(vp.w / preset.width, vp.h / preset.height);
  return (
    <div className="grid h-screen w-screen place-items-center overflow-hidden bg-background">
      <div
        style={{
          width: preset.width,
          height: preset.height,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
        className="overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}


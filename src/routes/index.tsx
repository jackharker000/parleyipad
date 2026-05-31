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
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { VoiceSampleRecorder } from "@/components/VoiceSampleRecorder";
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
  type SuggestionChoice,
  type SuggestionFeedback,
  IPAD_PRESETS,
} from "@/lib/db";
import { findNearestPlace, getCurrentPosition } from "@/lib/geo";
import {
  createScribeToken,
  generateSuggestions,
  summarizeConversation,
  synthesizeSpeech,
  expandUtterance,
  predictUtterances,
  identifySpeakerFromContext,
} from "@/lib/aac.functions";
import {
  buildConversationContext,
  suggestPeopleAtPlace,
  invalidateContextCache,
} from "@/lib/context";
import { getCrossSessionDeadPhrases } from "@/lib/style-evidence";
import { labelTranscriptForPrompt } from "@/lib/speaker-id";
import { extractIntroducedNames } from "@/lib/auto-person";
import { seedJamesIfNeeded, backfillSuggestionsLogPersonIds } from "@/lib/seed";
import { runStyleDistillation } from "@/lib/style-distill";
import {
  rediarizeAfterStop,
  rebuildVoiceprintsAfterStop,
  enrichProfilesAfterStop,
  detectIntroductionsAfterStop,
} from "@/lib/post-conversation";
import {
  VoiceCapture,
  computeMfccMean,
  recordVoiceprint,
  bestMatch,
  Diarizer,
  cosineSim,
  discriminativeSim,
  addContributionWithCap,
  CENTROID_UPDATE_THRESHOLD,
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
  // Map of person_id -> sample_count for selected participants in the picker.
  // null entry means "no voiceprint yet". Loaded when the picker opens.
  const [voiceprintStatus, setVoiceprintStatus] = useState<Record<string, number | null>>({});
  // Which selected participant has the inline recorder expanded inside the picker.
  const [expandedRecorderPersonId, setExpandedRecorderPersonId] = useState<string | null>(null);

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

  // === Predictive typing ===
  // When James types, the grid switches to predicted completions of his intent.
  const [predicting, setPredicting] = useState(false);
  const predictModeRef = useRef(false);
  // The last batch of conversation suggestions, kept so that when he types his
  // own reply (rejecting them) we can mark them as "all missed".
  const convoSuggestionsRef = useRef<Suggestion[]>([]);
  // The line(s) James was replying to when the current suggestions were shown —
  // recorded with each choice so the preference memory has context.
  const currentContextRef = useRef<string>("");
  // === Preference learning / feedback ===
  // The suggestion currently being given long-press feedback (null = menu closed).
  const [feedbackTarget, setFeedbackTarget] = useState<Suggestion | null>(null);
  // Whether the long-press feedback gesture is enabled (Settings toggle).
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  // True while a suggestion is being held for feedback — pauses auto-refresh so
  // the held card isn't remounted (which would abort the hold) by a new batch.
  const holdingCardRef = useRef(false);
  // committed.length captured when a hold began, so on release we can tell
  // whether a conversation turn landed during the hold and needs a refresh.
  const heldAtCommittedLenRef = useRef(0);

  // Speech
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [lastExpansion, setLastExpansion] = useState<{
    raw: string;
    expanded: string;
  } | null>(null);
  // When James types something very short/ambiguous (e.g. "N", "ok"), the AI's
  // expansion can leap far from his intent. We surface it as a pending preview
  // he must explicitly confirm before TTS speaks, so the system never narrates
  // a guess for him.
  const [pendingSpeech, setPendingSpeech] = useState<{
    raw: string;
    expanded: string;
  } | null>(null);
  const [voiceId, setVoiceId] = useState<string>("EXAVITQu4vr4xnSDxMaL");
  const [ipadModel, setIpadModel] = useState<string>("auto");
  const fastModelRef = useRef<string>("gemini/gemini-2.5-flash-lite");
  const smartModelRef = useRef<string>("gemini/gemini-2.5-flash");

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
  // Timestamps (ms) of detected speaker shifts during the current session.
  // Used to split Scribe-committed chunks that span multiple speakers.
  const speakerShiftTimestampsRef = useRef<number[]>([]);
  // Track the diarizer utterance count when AI context-ID was last fired per cluster.
  // Re-fires every 2 new utterances to refine speaker ID as more context accumulates.
  const aiSpeakerIdLastRef = useRef<Map<string, number>>(new Map());
  // Hysteresis: brand-new clusters start as "pending" and don't appear in the
  // SpeakerPanel until promoted. Promotion requires at least one of: ≥2
  // utterances, user-triggered, self-intro detected, strongly isolated voice,
  // or first cluster in the conversation. Prevents one-off ghost clusters from
  // noise/distance/interruption from polluting the speaker roster.
  const pendingClustersRef = useRef<
    Map<string, { firstSeenTs: number; utteranceCount: number; promoted: boolean }>
  >(new Map());
  // Voiceprints pre-loaded for declared participants at conversation start.
  // Used to suggest the right person immediately when their voice is first
  // heard, bypassing the 2-utterance pending gate.
  const participantVoiceprintsRef = useRef<
    Array<{ personId: string; centroid: number[] }>
  >([]);
  // Cached voiceprints for in-memory speaker recognition — avoids IDB reads
  // in the hot processUtterance path. Refreshed at start and after each confirm.
  const allVoiceprintsRef = useRef<import("@/lib/db").Voiceprint[]>([]);
  // Confirmed speakers' centroids keyed by personId (sync, no IDB reads).
  const confirmedVoiceprintsRef = useRef<Map<string, number[]>>(new Map());
  // Refresh participant voiceprints if the participant list changes mid-conversation
  // (e.g. user confirms a new speaker who gets added to selectedPersonIds).
  useEffect(() => {
    if (!active || selectedPersonIds.length === 0) return;
    db.voiceprints
      .where("person_id")
      .anyOf(selectedPersonIds)
      .toArray()
      .then((prints: import("@/lib/db").Voiceprint[]) => {
        participantVoiceprintsRef.current = prints.map((vp) => ({
          personId: vp.person_id,
          centroid: vp.centroid,
        }));
      })
      .catch(() => {});
  }, [active, selectedPersonIds]);

  // Keep a fresh copy of `committed` accessible inside stale scribe callback.
  const committedRef = useRef<TranscriptSegment[]>([]);
  useEffect(() => {
    committedRef.current = committed;
  }, [committed]);
  useEffect(() => {
    speakerMapRef.current = speakerMap;
  }, [speakerMap]);

  // Refresh voiceprint status for the picker — runs whenever it opens or the
  // selection changes, so the green/amber badges and inline record buttons
  // stay in sync after a recording completes.
  const refreshVoiceprintStatus = useCallback(async () => {
    if (selectedPersonIds.length === 0) {
      setVoiceprintStatus({});
      return;
    }
    const prints = await db.voiceprints
      .where("person_id")
      .anyOf(selectedPersonIds)
      .toArray();
    const map: Record<string, number | null> = {};
    for (const pid of selectedPersonIds) map[pid] = null;
    for (const vp of prints) map[vp.person_id] = vp.sample_count;
    setVoiceprintStatus(map);
  }, [selectedPersonIds]);

  useEffect(() => {
    if (showPeoplePicker) void refreshVoiceprintStatus();
  }, [showPeoplePicker, refreshVoiceprintStatus]);
  useEffect(() => {
    seedJamesIfNeeded();
    // === Tier 1.1: one-time backfill of person_id on historical
    // suggestions_log rows so style-evidence aggregation has signal from
    // pre-existing conversations. ===
    void backfillSuggestionsLogPersonIds();
  }, []);

  // Server fns
  const tokenFn = useServerFn(createScribeToken);
  const ttsFn = useServerFn(synthesizeSpeech);
  const suggestFn = useServerFn(generateSuggestions);
  const summarizeFn = useServerFn(summarizeConversation);
  const expandFn = useServerFn(expandUtterance);
  const predictFn = useServerFn(predictUtterances);
  const identifyFn = useServerFn(identifySpeakerFromContext);

  // Per-utterance processing — extracted so we can call it twice when we
  // split a Scribe chunk that spans two speakers.
  const processUtterance = useCallback(
    async (
      text: string,
      mfcc: number[] | null,
      opts: { forceNewCluster?: boolean; allowSelfIntroOverride?: boolean } = {},
    ): Promise<void> => {
      if (!text || !conversationIdRef.current) return;

      // -------- Pick a canonical speaker label.
      let speakerLabel: string;
      let assignSim = -1;
      let assignNew = false;
      let introOverride = false;

      // -------- Participant-override path --------
      // When the user has declared participants AND their voiceprints are
      // pre-loaded, use those voiceprints as the PRIMARY signal for cluster
      // assignment instead of in-session MFCC similarity. Stored voiceprints
      // are recorded under controlled conditions and are more discriminative
      // than centroids that drift during a live conversation.
      //
      // Threshold 0.78 is chosen above the typical inter-speaker range
      // (0.50–0.75) so we only override when we're confident which participant
      // is speaking. Below 0.78 we fall back to the diarizer's normal logic.
      let participantOverridePersonId: string | null = null;
      let participantOverrideSim = 0;
      if (
        mfcc &&
        !opts.forceNewCluster &&
        participantVoiceprintsRef.current.length > 0
      ) {
        const PARTICIPANT_OVERRIDE_THRESHOLD = 0.80;
        for (const pvp of participantVoiceprintsRef.current) {
          if (pvp.centroid.length !== mfcc.length) continue;
          const sim = discriminativeSim(mfcc, pvp.centroid);
          if (sim >= PARTICIPANT_OVERRIDE_THRESHOLD && sim > participantOverrideSim) {
            participantOverridePersonId = pvp.personId;
            participantOverrideSim = sim;
          }
        }
      }

      if (mfcc && participantOverridePersonId) {
        // Look for any existing cluster for this participant — both confirmed
        // (in speakerMap) and suggested-but-unconfirmed (in clusterStatus) — to
        // avoid creating a duplicate cluster for the same person.
        let existingLabel: string | undefined;
        for (const [label, pid] of Object.entries(speakerMapRef.current)) {
          if (pid === participantOverridePersonId) {
            existingLabel = label;
            break;
          }
        }
        if (!existingLabel) {
          for (const [label, status] of Object.entries(clusterStatusRef.current)) {
            if (
              (status.kind === "suggested" || status.kind === "confirmed") &&
              status.personId === participantOverridePersonId
            ) {
              existingLabel = label;
              break;
            }
          }
        }
        if (existingLabel && diarizerRef.current.get(existingLabel)) {
          const r = diarizerRef.current.forceAssign(existingLabel, mfcc);
          speakerLabel = r.label;
          assignSim = participantOverrideSim;
          assignNew = false;
        } else {
          const r = diarizerRef.current.assignNew(mfcc);
          speakerLabel = r.label;
          assignSim = participantOverrideSim;
          assignNew = true;
        }
      } else if (mfcc) {
        if (opts.forceNewCluster) {
          const r = diarizerRef.current.assignNew(mfcc);
          speakerLabel = r.label;
          assignSim = r.sim;
          assignNew = true;
        } else {
          let forceNew = false;
          if (opts.allowSelfIntroOverride !== false) {
            const introducedName = extractIntroducedNames([
              { text, speaker_label: "" },
            ])[0]?.name;
            if (introducedName) {
              const preview = diarizerRef.current.peek(mfcc);
              if (preview.label && preview.wouldMerge) {
                const previewStatus = clusterStatusRef.current[preview.label];
                let attributedName: string | undefined;
                if (previewStatus?.kind === "confirmed") {
                  attributedName = allPeople.find(
                    (p) => p.id === previewStatus.personId,
                  )?.name;
                } else if (previewStatus?.kind === "suggested") {
                  attributedName = allPeople.find(
                    (p) => p.id === previewStatus.personId,
                  )?.name;
                }
                if (
                  attributedName &&
                  attributedName.toLowerCase() !== introducedName.toLowerCase()
                ) {
                  forceNew = true;
                  introOverride = true;
                }
              }
            }
          }
          const r = forceNew
            ? diarizerRef.current.assignNew(mfcc)
            : diarizerRef.current.assign(mfcc);
          speakerLabel = r.label;
          assignSim = r.sim;
          assignNew = r.isNew;
        }
      } else {
        const lastSeg = committedRef.current[committedRef.current.length - 1];
        speakerLabel = lastSeg?.speaker_label ?? "Speaker ?";
      }

      // -------- Ghost-cluster collapse --------
      // When a BRAND-NEW cluster is created (assignNew=true), check whether its
      // single-utterance MFCC closely matches an already-confirmed speaker's
      // stored voiceprint. If so it's almost certainly the same person speaking
      // under different acoustic conditions — silently merge back.
      //
      // Threshold 0.88 sits in the within-speaker range (0.78–0.95) and above
      // the typical inter-speaker range (0.50–0.80), so we only merge when it's
      // unambiguously the same person. Running this only on brand-new clusters
      // (not every utterance of every unknown cluster) prevents real 2nd speakers
      // from being absorbed into a confirmed speaker as their centroid drifts.
      const GHOST_MATCH_THRESHOLD = 0.88;
      if (mfcc && assignNew && !clusterStatusRef.current[speakerLabel]) {
        for (const [confirmedLabel, confirmedPersonId] of Object.entries(
          speakerMapRef.current,
        )) {
          if (confirmedLabel === speakerLabel) continue;
          const centroid = confirmedVoiceprintsRef.current.get(confirmedPersonId);
          if (centroid && centroid.length === mfcc.length) {
            const sim = discriminativeSim(mfcc, centroid);
            if (sim >= GHOST_MATCH_THRESHOLD) {
              const fromLabel = speakerLabel;
              const mergedOk = diarizerRef.current.mergeClusters(
                fromLabel,
                confirmedLabel,
              );
              if (mergedOk) {
                // Relabel any prior segments attributed to this ghost cluster.
                setCommitted((prev) =>
                  prev.map((s) =>
                    s.speaker_label === fromLabel
                      ? { ...s, speaker_label: confirmedLabel }
                      : s,
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
                      speaker_label: confirmedLabel,
                    });
                  }
                }
                pendingClustersRef.current.delete(fromLabel);
                pendingVoiceprintMatchRef.current.delete(fromLabel);
                aiSpeakerIdLastRef.current.delete(fromLabel);
                if (clusterStatusRef.current[fromLabel]) {
                  const nextStatus = { ...clusterStatusRef.current };
                  delete nextStatus[fromLabel];
                  clusterStatusRef.current = nextStatus;
                  setClusterStatus(nextStatus);
                }
                speakerLabel = confirmedLabel;
                assignNew = false;
                break;
              }
            }
          }
        }
      }

      // -------- Participant-constrained cluster cap (0b) --------
      // If the label is still a new cluster AND participants were declared,
      // prevent runaway cluster creation by merging into the best-matching
      // existing cluster when we're already at the cap.
      if (mfcc && assignNew && !clusterStatusRef.current[speakerLabel] && personIdsRef.current.length > 0) {
        const existingClusters = diarizerRef.current.clusters();
        // Count clusters that existed before this new one was created.
        // Use personIdsRef (snapshot at start) not peopleInConvo (reactive) so the
        // cap doesn't shift mid-conversation when the user confirms a new person.
        const priorCount = existingClusters.length - 1; // new cluster already added
        if (priorCount >= personIdsRef.current.length + 1) {
          // Find the existing cluster (excluding the new one) with best cosine sim
          let bestExistingLabel: string | null = null;
          let bestExistingSim = -1;
          for (const c of existingClusters) {
            if (c.label === speakerLabel) continue;
            const sim = discriminativeSim(mfcc, c.centroid);
            if (Number.isFinite(sim) && sim > bestExistingSim) {
              bestExistingSim = sim;
              bestExistingLabel = c.label;
            }
          }
          if (bestExistingLabel) {
            const fromLabel = speakerLabel;
            diarizerRef.current.mergeClusters(fromLabel, bestExistingLabel);
            pendingClustersRef.current.delete(fromLabel);
            speakerLabel = bestExistingLabel;
            assignNew = false;
          }
        }
      }

      // -------- Pending-cluster hysteresis --------
      // Hide brand-new clusters from the SpeakerPanel until we have stronger
      // evidence they're a real distinct speaker. Promotion happens when at
      // least one of these holds: it's the first cluster of the conversation,
      // the user explicitly pressed "New", a self-introduction was detected,
      // the voice is strongly isolated from all other clusters, or the cluster
      // has accumulated ≥2 utterances.
      const PROMOTE_AFTER_UTTERANCES = 2;
      // Research shows inter-speaker MFCC cosine similarity is typically
      // 0.50–0.75. Threshold 0.70 means: if the new voice scores < 0.70
      // against all existing clusters it's clearly distinct → promote
      // immediately. Same-speaker ghosts (0.75–0.85) still wait for 2
      // utterances before becoming visible.
      const ISOLATION_PROMOTE_THRESHOLD = 0.70;
      if (mfcc) {
        if (assignNew) {
          const allClusters = diarizerRef.current.clusters();
          const isFirstCluster = allClusters.length === 1;
          const userTriggered = !!opts.forceNewCluster;
          let maxSimToOthers = 0;
          for (const c of allClusters) {
            if (c.label === speakerLabel) continue;
            const s = discriminativeSim(mfcc, c.centroid);
            if (Number.isFinite(s) && s > maxSimToOthers) maxSimToOthers = s;
          }
          const isStronglyIsolated = maxSimToOthers < ISOLATION_PROMOTE_THRESHOLD;
          const matchedParticipant = !!participantOverridePersonId;
          const promoteNow =
            isFirstCluster ||
            userTriggered ||
            introOverride ||
            isStronglyIsolated ||
            matchedParticipant;
          pendingClustersRef.current.set(speakerLabel, {
            firstSeenTs: Date.now(),
            utteranceCount: 1,
            promoted: promoteNow,
          });
        } else {
          const pending = pendingClustersRef.current.get(speakerLabel);
          if (pending && !pending.promoted) {
            const newCount = pending.utteranceCount + 1;
            pendingClustersRef.current.set(speakerLabel, {
              ...pending,
              utteranceCount: newCount,
              promoted: newCount >= PROMOTE_AFTER_UTTERANCES,
            });
          }
        }
      }

      // -------- Participant voiceprint quick-match --------
      // For brand-new clusters, compare against pre-loaded voiceprints of
      // declared participants at a lower threshold (0.72). A match immediately
      // promotes the cluster (bypassing the 2-utterance pending gate) and sets
      // its status to "suggested" so the user sees a one-tap confirmation chip
      // on the speaker's very first utterance. User confirmation is still
      // required — this never silently confirms.
      if (mfcc && assignNew && participantVoiceprintsRef.current.length > 0) {
        const confirmedPersonIds = new Set(Object.values(speakerMapRef.current));
        const curStatus = clusterStatusRef.current[speakerLabel];
        if (!curStatus || curStatus.kind === "unknown") {
          const PARTICIPANT_MATCH_THRESHOLD = 0.70;
          let bestPvp: { personId: string; sim: number } | null = null;
          for (const pvp of participantVoiceprintsRef.current) {
            if (confirmedPersonIds.has(pvp.personId)) continue;
            if (pvp.centroid.length !== mfcc.length) continue;
            const sim = discriminativeSim(mfcc, pvp.centroid);
            if (
              sim >= PARTICIPANT_MATCH_THRESHOLD &&
              (!bestPvp || sim > bestPvp.sim)
            ) {
              bestPvp = { personId: pvp.personId, sim };
            }
          }
          if (bestPvp) {
            // Promote pending cluster so it becomes visible in the panel.
            const pendingEntry = pendingClustersRef.current.get(speakerLabel);
            if (pendingEntry) {
              pendingClustersRef.current.set(speakerLabel, {
                ...pendingEntry,
                promoted: true,
              });
            }
            const nextStatus = {
              ...clusterStatusRef.current,
              [speakerLabel]: {
                kind: "suggested" as const,
                personId: bestPvp.personId,
                sim: bestPvp.sim,
                suggestions: [],
              },
            };
            clusterStatusRef.current = nextStatus;
            setClusterStatus(nextStatus);
          }
        }
      }

      console.debug("[diarize]", {
        chosen: speakerLabel,
        sim: assignSim.toFixed(3),
        isNew: assignNew,
        introOverride,
        forcedNew: !!opts.forceNewCluster,
        participantOverride: participantOverridePersonId ?? undefined,
        clusters: diarizerRef.current.clusters().length,
      });

      const seg: TranscriptSegment = {
        id: newId(),
        conversation_id: conversationIdRef.current!,
        speaker_label: speakerLabel,
        text,
        ts: Date.now(),
        mfcc: mfcc ?? undefined,
      };
      // Show transcript text immediately (optimistic); DB persists fire-and-forget
      // so Scribe callbacks return without blocking on IDB writes.
      setCommitted((prev) => [...prev, seg]);
      void db.transcript_segments.add(seg).catch(() => {});
      if (mfcc != null) {
        void db.segment_mfccs.add({
          id: newId(),
          segment_id: seg.id,
          conversation_id: seg.conversation_id,
          mfcc,
          ts: seg.ts,
        }).catch(() => {});
      }

      // -------- Recognition pass (suggestion-only).
      try {
        const cluster = diarizerRef.current.get(speakerLabel);
        const status = clusterStatusRef.current[speakerLabel];
        if (cluster && status?.kind !== "confirmed") {
          const introHere = extractIntroducedNames([
            { text, speaker_label: speakerLabel },
          ])[0]?.name;
          const askTarget = expectingNameForClusterRef.current;
          const isAskReply =
            askTarget !== null && (askTarget === speakerLabel || askTarget === "");
          const attributionLabel =
            isAskReply && askTarget && askTarget !== "" ? askTarget : speakerLabel;

          let nextStatus: ClusterStatus | undefined;

          if (!status || status.kind === "unknown") {
            const confirmedIds = new Set(Object.values(speakerMapRef.current));
            const candidates = allVoiceprintsRef.current.filter(
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
              const highConf = match.sim >= 0.88;
              const pending = pendingVoiceprintMatchRef.current.get(speakerLabel);
              if (pending?.personId === match.print.person_id) {
                const newCount = pending.matchCount + 1;
                pendingVoiceprintMatchRef.current.set(speakerLabel, {
                  personId: match.print.person_id,
                  matchCount: newCount,
                });
                if (highConf || newCount >= 2) {
                  nextStatus = {
                    kind: "suggested",
                    personId: match.print.person_id,
                    sim: match.sim,
                    suggestions: status?.suggestions ?? [],
                  };
                }
              } else {
                pendingVoiceprintMatchRef.current.set(speakerLabel, {
                  personId: match.print.person_id,
                  matchCount: 1,
                });
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

          // AI context-based identification (one-shot per cluster, 2+ utterances).
          // Lowered from 3 -> 2 so identification kicks in earlier. When the
          // user has declared participants we ONLY send those names as
          // candidates so the AI doesn't get distracted by irrelevant people.
          const clusterCount = cluster?.count ?? 0;
          const curStatusKind = (
            nextStatus ?? clusterStatusRef.current[speakerLabel]
          )?.kind;
          const lastAiCount = aiSpeakerIdLastRef.current.get(speakerLabel) ?? -1;
          const shouldFireAI =
            clusterCount >= 1 &&
            curStatusKind !== "confirmed" &&
            (lastAiCount === -1 || clusterCount - lastAiCount >= 2);
          if (shouldFireAI) {
            aiSpeakerIdLastRef.current.set(speakerLabel, clusterCount);
            const confirmedNames: Record<string, string> = {};
            for (const [lbl, pid] of Object.entries(speakerMapRef.current)) {
              const p = allPeople.find((pp) => pp.id === pid);
              if (p) confirmedNames[lbl] = p.name;
            }
            const recentForAI = committedRef.current.slice(-20).map((s) => {
              const pid = s.person_id ?? speakerMapRef.current[s.speaker_label];
              const p = pid ? allPeople.find((pp) => pp.id === pid) : null;
              return { speaker: p?.name ?? s.speaker_label, text: s.text };
            });
            // Bias candidate list toward declared participants when present.
            const declaredNames = personIdsRef.current
              .map((id) => allPeople.find((p) => p.id === id)?.name)
              .filter((n): n is string => Boolean(n));
            const candidateNames =
              declaredNames.length > 0
                ? declaredNames
                : allPeople.map((p) => p.name);
            identifyFn({
              data: {
                unknownLabel: speakerLabel,
                recentTranscript: recentForAI,
                confirmedSpeakers: confirmedNames,
                candidateNames,
                model: smartModelRef.current,
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
    [allPeople, identifyFn],
  );

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    includeTimestamps: true,
    onPartialTranscript: (d: { text: string }) => setPartial(d.text ?? ""),
    onCommittedTranscriptWithTimestamps: async (d: any) => {
      const text = (d.text ?? "").trim();
      if (!text || !conversationIdRef.current) return;
      setPartial("");

      const cap = captureRef.current;
      // Compute the chunk's duration from word timestamps
      let spoken = 0;
      if (cap && d.words && d.words.length > 0) {
        const firstW = d.words[0];
        const lastW = d.words[d.words.length - 1];
        spoken = (lastW.end ?? 0) - (firstW.start ?? 0);
      }

      // Determine if we should split this chunk by mid-chunk speaker shift.
      const segEndAbsMs = Date.now();
      const segStartAbsMs = segEndAbsMs - spoken * 1000;
      const shiftsInSeg = speakerShiftTimestampsRef.current.filter(
        (t) => t > segStartAbsMs + 200 && t < segEndAbsMs - 200,
      );

      // 0.5s minimum so we can still split short interruptions; both halves
      // get a separate MFCC pass for downstream attribution.
      const canSplit =
        cap && shiftsInSeg.length > 0 && d.words && d.words.length >= 2 && spoken >= 0.5;

      if (canSplit) {
        try {
          const shiftTs = shiftsInSeg[0];
          const firstStart = d.words[0].start ?? 0;
          const shiftSecFromUtteranceStart =
            (shiftTs - segStartAbsMs) / 1000;
          const splitWordIdx = d.words.findIndex(
            (w: any) => (w.start ?? 0) - firstStart >= shiftSecFromUtteranceStart,
          );

          if (splitWordIdx > 1 && splitWordIdx < d.words.length - 1) {
            const totalSec = spoken + 1.0;
            const totalPcm = cap.recentSlice(totalSec, 0);
            const splitSampleFromEnd = Math.floor(
              ((Date.now() - shiftTs) / 1000) * cap.sampleRate,
            );
            const splitSampleFromStart = totalPcm.length - splitSampleFromEnd;
            // FRAME size is 512 — need at least 4 frames per half
            if (splitSampleFromStart > 512 * 4 && splitSampleFromEnd > 512 * 4) {
              const prePcm = totalPcm.subarray(0, splitSampleFromStart);
              const postPcm = totalPcm.subarray(splitSampleFromStart);
              const preMfcc = computeMfccMean(prePcm, cap.sampleRate);
              const postMfcc = computeMfccMean(postPcm, cap.sampleRate);
              const preText = d.words
                .slice(0, splitWordIdx)
                .map((w: any) => w.text ?? "")
                .join(" ")
                .trim();
              const postText = d.words
                .slice(splitWordIdx)
                .map((w: any) => w.text ?? "")
                .join(" ")
                .trim();
              // Consume the timestamp unconditionally — even if MFCC fails for
              // one half, this shift is gone. Prevents a stale timestamp from
              // mis-triggering on the next Scribe chunk.
              speakerShiftTimestampsRef.current =
                speakerShiftTimestampsRef.current.filter((t) => t !== shiftTs);
              if (preMfcc && postMfcc) {
                console.debug("[diarize] split chunk at shift", {
                  shiftAtSec: shiftSecFromUtteranceStart.toFixed(2),
                  preText,
                  postText,
                });
                if (preText) await processUtterance(preText, preMfcc, {});
                if (postText)
                  await processUtterance(postText, postMfcc, {
                    forceNewCluster: true,
                    allowSelfIntroOverride: false,
                  });
                return;
              } else {
                // MFCC failed for one or both halves — fall through to single-
                // utterance processing below. Timestamp is already consumed.
                console.debug("[diarize] split MFCC failed, processing as single utterance");
              }
            }
          }
        } catch (err) {
          console.warn("[diarize] split failed, falling back to single-utterance", err);
        }
      }

      // No split — single utterance path.
      let mfcc: number[] | null = null;
      if (cap && d.words && d.words.length > 0 && spoken >= 0.5) {
        try {
          const dur = Math.max(1.2, spoken);
          const pcm = cap.recentSlice(dur, 1.0);
          mfcc = computeMfccMean(pcm, cap.sampleRate);
        } catch (err) {
          console.warn("[voiceprint] mfcc compute failed", err);
        }
      }
      await processUtterance(text, mfcc, { allowSelfIntroOverride: true });
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
      setFeedbackEnabled(s.suggestion_feedback_enabled ?? true);
      fastModelRef.current =
        s.fast_model ?? s.suggestion_model ?? "gemini/gemini-2.5-flash-lite";
      smartModelRef.current = s.smart_model ?? "gemini/gemini-2.5-flash";

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
      aiSpeakerIdLastRef.current.clear();
      speakerShiftTimestampsRef.current = [];
      pendingClustersRef.current.clear();
      participantVoiceprintsRef.current = [];
      allVoiceprintsRef.current = [];
      confirmedVoiceprintsRef.current.clear();
      // Pre-load ALL stored voiceprints into memory BEFORE connecting Scribe
      // so the very first utterance gets participant matching without IDB reads.
      try {
        const allPrints = await db.voiceprints.toArray();
        allVoiceprintsRef.current = allPrints as import("@/lib/db").Voiceprint[];
        if (selectedPersonIds.length > 0) {
          participantVoiceprintsRef.current = (allPrints as import("@/lib/db").Voiceprint[])
            .filter((vp) => selectedPersonIds.includes(vp.person_id))
            .map((vp) => ({ personId: vp.person_id, centroid: vp.centroid }));
        }
      } catch {}

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
        cap.startShiftMonitor((ts) => {
          speakerShiftTimestampsRef.current.push(ts);
          // Trim to the last 30 seconds
          const cutoff = Date.now() - 30000;
          speakerShiftTimestampsRef.current =
            speakerShiftTimestampsRef.current.filter((t) => t > cutoff);
        });
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
      // Require ≥3 utterances before persisting — a centroid from 1–2 utterances
      // is often noisy and can contaminate the stored voiceprint.
      try {
        for (const [label, personId] of Object.entries(speakerMapRef.current)) {
          const cluster = diarizerRef.current.get(label);
          if (cluster && cluster.count >= 3) {
            await recordVoiceprint(personId, cluster.centroid);
            const examples = committedRef.current
              .filter((s) => s.speaker_label === label)
              .slice(-3)
              .map((s) => s.text)
              .join(" / ");
            await addContributionWithCap({
              id: newId(),
              person_id: personId,
              conversation_id: cid ?? undefined,
              source: "auto",
              mfcc: cluster.centroid.slice(),
              ts: Date.now(),
              preview_text: examples || undefined,
            });
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
          .map((s) => {
            // Per-segment person_id override (from manual reassignment) wins
            // so the post-conversation summary sees the corrected attribution.
            if (s.person_id) {
              const p = allPeople.find((pp) => pp.id === s.person_id);
              if (p) return { speaker: p.name, text: s.text };
            }
            return { speaker: s.speaker_label, text: s.text };
          });

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

          /* Post-stop pipeline: summary → [Tier 2 jobs in Promise.all] → [Tier 3 embed memories] */
          const tier2Ctx = {
            conversationId: cid,
            segs,
            peopleNames,
            personIds: personIdsRef.current,
            smartModel: smartModelRef.current,
            fastModel: fastModelRef.current,
          };
          toast.loading("Analysing conversation…", { id: "tier2" });
          try {
            // 2.1 must complete before 2.4 (needs corrected labels + centroids).
            const rediarizeResult = await rediarizeAfterStop(tier2Ctx);
            await Promise.all([
              rebuildVoiceprintsAfterStop(tier2Ctx),
              enrichProfilesAfterStop(tier2Ctx),
              detectIntroductionsAfterStop(tier2Ctx, rediarizeResult),
            ]);
            toast.success("Updated profiles", { id: "tier2" });
          } catch (e) {
            console.warn("[tier2] post-pass failed", e);
            toast.dismiss("tier2");
          }
        }
      }
      // === Tier 1.2: auto-distil style profile ===
      // Cadence-guarded (≤ once per 12 h); silently no-ops if there aren't
      // enough samples yet. Failures never block the Stop flow.
      void runStyleDistillation().catch((err) => console.warn("style distill failed", err));
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save", { id: "sum" });
    } finally {
      setActive(false);
      setStopping(false);
      conversationIdRef.current = null;
      // Reset per-conversation scratch so anything typed-and-spoken BETWEEN
      // sessions can't be logged as a preference choice against the previous
      // conversation's batch/context (which would poison the learning loop).
      convoSuggestionsRef.current = [];
      currentContextRef.current = "";
      lastSuggestKeyRef.current = "";
      setSuggestions([]);
    }
  }, [active, stopping, scribe, summarizeFn, placeName]);

  // (No auto-mapping effect: speakers are confirmed only via the SpeakerPanel.)

  // Auto-fetch suggestions
  // Tracks the (transcriptLen + mood) signature of the last AI call so we
  // skip redundant refreshes when nothing relevant has changed.
  const lastSuggestKeyRef = useRef<string>("");
  // === Tier 1.3: cross-session dead phrases ===
  // Cached so the Dexie scan only runs once per minute, not on every 1.5 s
  // refresh tick. Keyed by sorted personIds to invalidate when the present
  // set changes.
  const deadPhrasesCacheRef = useRef<{ key: string; at: number; list: string[] } | null>(null);
  const refreshSuggestions = useCallback(async () => {
    if (loadingSuggestions || !active) return;
    // While James is typing, the grid shows predictions of his intent — don't
    // overwrite them with conversation suggestions.
    if (predictModeRef.current) return;
    // While a card is being held for feedback, don't swap the batch — a remount
    // would abort the in-progress hold gesture.
    if (holdingCardRef.current) return;
    const key = `${committed.length}:${moodRef.current}`;
    if (key === lastSuggestKeyRef.current) return;
    // Mark this key as in-flight; on failure we clear it so the next tick retries.
    lastSuggestKeyRef.current = key;
    setLoadingSuggestions(true);
    let succeeded = false;
    try {
      const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
      const rawRecent = committed.slice(-8).map((s) => {
        // Manual reassignment override wins over cluster mapping.
        if (s.person_id) {
          const p = peopleById.get(s.person_id);
          if (p) return { speaker: p.name, text: s.text };
        }
        return { speaker: s.speaker_label, text: s.text };
      });
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
      // === Tier 1.3: merge cross-session dead phrases into alreadyShown ===
      const personKey = [...personIdsRef.current].sort().join(",");
      let crossDead: string[] = [];
      if (personIdsRef.current.length) {
        const cached = deadPhrasesCacheRef.current;
        if (cached && cached.key === personKey && Date.now() - cached.at < 60_000) {
          crossDead = cached.list;
        } else {
          try {
            crossDead = await getCrossSessionDeadPhrases(personIdsRef.current);
            deadPhrasesCacheRef.current = {
              key: personKey,
              at: Date.now(),
              list: crossDead,
            };
          } catch (err) {
            console.warn("cross-session dead phrases lookup failed", err);
            crossDead = [];
          }
        }
      }
      const sessionShown = lastShownRef.current.slice(-20);
      const alreadyShown = Array.from(new Set([...sessionShown, ...crossDead])).slice(0, 80);
      // Context snippet = the last thing(s) said by someone other than James,
      // i.e. what these suggestions are replies to. Recorded with each choice.
      const contextSnippet = committed
        .filter(
          (s) =>
            s.speaker_label !== jamesLabel && s.speaker_label !== "__james_self__",
        )
        .slice(-2)
        .map((s) => s.text)
        .join(" ");
      currentContextRef.current = contextSnippet;
      // 18s hard timeout so a hung free-tier provider call doesn't strand the
      // UI in "Thinking…" forever — the user can re-tap Refresh after.
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(), 18_000);
      const r = await Promise.race([
        suggestFn({
          data: {
            recentTranscript: recent,
            jamesProfile: ctx.jamesProfile,
            people: ctx.people,
            place: ctx.place,
            event: ctx.event,
            styleProfileJson: ctx.styleProfileJson,
            // === Tier 1.1: style evidence ===
            styleEvidence: ctx.styleEvidence,
            // === Cross-conversation voice learning ===
            jamesVoiceSamples: ctx.jamesVoiceSamples,
            // === Preference learning ===
            choiceMemories: ctx.choiceMemories,
            alreadyShown,
            model: fastModelRef.current,
            mood: moodRef.current,
            questionAsked,
          },
        }),
        new Promise<never>((_, rej) => {
          timeoutCtl.signal.addEventListener("abort", () =>
            rej(new Error("AI request timed out — tap Refresh to retry")),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (r.suggestions?.length) {
        succeeded = true;
        setSuggestions(r.suggestions as Suggestion[]);
        // Remember this batch so that if James types his own reply instead of
        // tapping one, we can mark all of them as "missed".
        convoSuggestionsRef.current = r.suggestions as Suggestion[];
        lastShownRef.current = [
          ...lastShownRef.current,
          ...r.suggestions.map((s: Suggestion) => s.text),
        ].slice(-30);
        const now = Date.now();
        const cid = conversationIdRef.current;
        if (cid) {
          // === Tier 1.1: mark displaced rows as ignored ===
          // Any prior rows in this conversation that the user didn't pick AND
          // aren't being re-emitted by this batch are now "ignored". This
          // gives `deadPhrases` real signal across refreshes.
          const newTexts = new Set((r.suggestions as Suggestion[]).map((s) => s.text));
          try {
            await db.suggestions_log
              .where("conversation_id")
              .equals(cid)
              .and((l) => !l.selected && l.displaced_at == null && !newTexts.has(l.text))
              .modify({ displaced_at: now, ignored: true });
          } catch (err) {
            console.warn("mark displaced rows failed", err);
          }
          // === Tier 1.1: tag new rows with person_id ===
          const primaryPersonId = personIdsRef.current[0];
          await db.suggestions_log.bulkAdd(
            (r.suggestions as Suggestion[]).map((s) => ({
              id: newId(),
              conversation_id: cid,
              text: s.text,
              category: s.category,
              source: "ai",
              shown_at: now,
              selected: false,
              ignored: false,
              spoken: false,
              person_id: primaryPersonId,
              context_snippet: contextSnippet || undefined,
            })),
          );
        }
      }
    } catch (e: any) {
      console.error(e);
      // Surface to the user — the cockpit shouldn't sit on "Thinking…" silently.
      const msg = e?.message ?? "AI request failed";
      // Lightweight toast: don't spam if the call was simply cancelled.
      if (!String(msg).includes("aborted")) toast.error(msg);
    } finally {
      setLoadingSuggestions(false);
      // CRITICAL: on failure, clear the dedupe key so the next render's effect
      // can retry. Without this the cockpit gets stuck — same committed.length
      // + mood signature → call permanently skipped.
      if (!succeeded) lastSuggestKeyRef.current = "";
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

  // === Preference learning: record which suggestion won, and which lost ======
  // When James taps a suggestion, the chosen one was "best" and the others
  // shown alongside it were worse — mark them ignored and store the decision.
  const recordSelectionChoice = useCallback(async (chosen: Suggestion) => {
    const cid = conversationIdRef.current ?? lastConversationIdRef.current;
    if (!cid) return;
    const batch = convoSuggestionsRef.current;
    const alternatives = batch
      .filter((s) => s.text !== chosen.text)
      .map((s) => s.text);
    const personId = personIdsRef.current[0];
    try {
      // Mark the losers from this batch as ignored (passed over for a better one).
      if (alternatives.length) {
        const altSet = new Set(alternatives);
        await db.suggestions_log
          .where("conversation_id")
          .equals(cid)
          .and((l) => !l.selected && altSet.has(l.text))
          .modify({ ignored: true });
      }
      const choice: SuggestionChoice = {
        id: newId(),
        conversation_id: cid,
        person_id: personId,
        ts: Date.now(),
        context: currentContextRef.current,
        chosen: chosen.text,
        chosen_category: chosen.category,
        alternatives,
        outcome: "selected",
      };
      await db.suggestion_choices.add(choice);
      // Note: we deliberately do NOT bust the context cache for a routine pick
      // — it's the common case and latency-sensitive. The pick still feeds the
      // styleEvidence loop, and the choice memory lands within the cache TTL.
    } catch (err) {
      console.warn("record selection choice failed", err);
    }
  }, []);

  // When James composes his OWN reply instead of tapping a suggestion, every
  // suggestion on screen missed — mark them all and store what he actually said.
  const commitManualReply = useCallback(async (typedText: string) => {
    const cid = conversationIdRef.current ?? lastConversationIdRef.current;
    if (!cid) return;
    const batch = convoSuggestionsRef.current;
    const alternatives = batch.map((s) => s.text);
    const personId = personIdsRef.current[0];
    try {
      if (alternatives.length) {
        const altSet = new Set(alternatives);
        await db.suggestions_log
          .where("conversation_id")
          .equals(cid)
          .and((l) => !l.selected && altSet.has(l.text))
          .modify({ ignored: true, rejected_for_manual: true });
      }
      const choice: SuggestionChoice = {
        id: newId(),
        conversation_id: cid,
        person_id: personId,
        ts: Date.now(),
        context: currentContextRef.current,
        alternatives,
        typed_own: typedText,
        outcome: "manual",
      };
      await db.suggestion_choices.add(choice);
      invalidateContextCache();
    } catch (err) {
      console.warn("record manual reply failed", err);
    }
  }, []);

  // Long-press feedback on a suggestion → store explicit signal.
  const recordFeedback = useCallback(
    async (s: Suggestion, feedback: SuggestionFeedback) => {
      const cid = conversationIdRef.current ?? lastConversationIdRef.current;
      const personId = personIdsRef.current[0];
      try {
        if (cid) {
          // Annotate the matching log row(s) for this text in this conversation.
          await db.suggestions_log
            .where("conversation_id")
            .equals(cid)
            .and((l) => l.text === s.text)
            .modify({ feedback, feedback_at: Date.now() });
          // Strong negatives also count as "not for me" so the dead-phrase
          // filter stops re-suggesting it.
          if (feedback === "not_me" || feedback === "wrong_tone") {
            await db.suggestions_log
              .where("conversation_id")
              .equals(cid)
              .and((l) => l.text === s.text && !l.selected)
              .modify({ ignored: true });
          }
          const choice: SuggestionChoice = {
            id: newId(),
            conversation_id: cid,
            person_id: personId,
            ts: Date.now(),
            context: currentContextRef.current,
            chosen: s.text,
            chosen_category: s.category,
            alternatives: [],
            outcome: "feedback",
            feedback,
          };
          await db.suggestion_choices.add(choice);
          invalidateContextCache();
        }
        const labels: Record<SuggestionFeedback, string> = {
          love: "Noted — more like this",
          good: "Noted",
          too_formal: "Noted — will keep it more casual",
          too_casual: "Noted — will keep it more polished",
          wrong_tone: "Noted — wrong tone",
          not_me: "Noted — won't suggest that again",
        };
        toast.success(labels[feedback]);
      } catch (err) {
        console.warn("record feedback failed", err);
      } finally {
        setFeedbackTarget(null);
      }
    },
    [],
  );

  // Speak via TTS
  const speak = useCallback(
    async (text: string, meta?: { suggestion?: Suggestion }) => {
      if (!text.trim()) return;
      try {
        setSpeaking(true);
        const r = await ttsFn({ data: { text, voiceId } });
        const audio = new Audio(`data:${r.mime};base64,${r.audioBase64}`);
        await audio.play();
        // Persistence below happens AFTER audio played — wrap separately so a
        // benign IndexedDB write error can't surface as a misleading "Speech
        // failed" toast when James was actually heard.
        try {
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
            // Preference learning: this suggestion won; the others shown lost.
            void recordSelectionChoice(meta.suggestion);
          } else if (targetCid) {
            await db.manual_replies.add({
              id: newId(),
              conversation_id: targetCid,
              text,
              ts: Date.now(),
            });
          }
        } catch (persistErr) {
          console.warn("post-speak persistence failed", persistErr);
        }
      } catch (e: any) {
        toast.error(e?.message ?? "Speech failed");
      } finally {
        setSpeaking(false);
      }
    },
    [ttsFn, voiceId, recordSelectionChoice],
  );

  const peopleInConvo = useMemo(
    () => allPeople.filter((p) => selectedPersonIds.includes(p.id)),
    [allPeople, selectedPersonIds],
  );

  // Build cluster rows from the diarizer + cluster-status state for the SpeakerPanel.
  // Pending unpromoted clusters are filtered out — they exist in the diarizer
  // (so utterances still cluster correctly) but don't appear in the UI until
  // we have stronger evidence they're a real distinct speaker.
  const clusterRows = useMemo<ClusterRow[]>(() => {
    const rows: ClusterRow[] = [];
    for (const c of diarizerRef.current.clusters()) {
      const status = clusterStatus[c.label] ?? { kind: "unknown" as const };
      const pending = pendingClustersRef.current.get(c.label);
      const isConfirmed = status.kind === "confirmed";
      const isSuggested = status.kind === "suggested";
      // Always show confirmed/suggested clusters even if they happen to still
      // have a pending entry (e.g. confirmation arrived before promotion).
      if (pending && !pending.promoted && !isConfirmed && !isSuggested) {
        continue;
      }
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
      // Confirmation overrides any pending hysteresis — the cluster is now real.
      pendingClustersRef.current.delete(label);
      const cluster = diarizerRef.current.get(label);
      if (cluster) {
        await recordVoiceprint(personId, cluster.centroid);
        // Update in-memory caches immediately so future processUtterance calls
        // benefit without re-querying IDB.
        const updatedVp = await db.voiceprints.get(personId);
        if (updatedVp) {
          allVoiceprintsRef.current = [
            ...allVoiceprintsRef.current.filter((vp) => vp.person_id !== personId),
            updatedVp,
          ];
          confirmedVoiceprintsRef.current.set(personId, updatedVp.centroid);
          // Keep participant ref in sync too.
          participantVoiceprintsRef.current = [
            ...participantVoiceprintsRef.current.filter((vp) => vp.personId !== personId),
            { personId, centroid: updatedVp.centroid },
          ];
        }
        // Capture a recent example from this cluster for the user to verify later.
        const examples = committedRef.current
          .filter((s) => s.speaker_label === label)
          .slice(-3)
          .map((s) => s.text)
          .join(" / ");
        await addContributionWithCap({
          id: newId(),
          person_id: personId,
          conversation_id: conversationIdRef.current ?? undefined,
          source: "auto",
          mfcc: cluster.centroid.slice(),
          ts: Date.now(),
          preview_text: examples || undefined,
        });
      }
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
    // Cap excluded list at 3 so a cluster doesn't get permanently locked out of
    // all candidates if the user mis-rejects a few suggestions.
    const excludedPersonIds = rejectedId
      ? [...prevExcluded, rejectedId]
          .filter((id, i, arr) => arr.indexOf(id) === i)
          .slice(-3)
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
    // Clear pending voiceprint match so the rejection actually takes effect and
    // the next utterance is re-evaluated rather than inheriting the old match.
    pendingVoiceprintMatchRef.current.delete(label);
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
    // Clear pending match state so the cluster is re-evaluated cleanly.
    pendingVoiceprintMatchRef.current.delete(label);
    aiSpeakerIdLastRef.current.delete(label);
    if (conversationIdRef.current) {
      await db.conversations.update(conversationIdRef.current, {
        speaker_map: nextMap,
      });
    }
  }, []);

  const mergeSpeakerClusters = useCallback(
    async (fromLabel: string, toLabel: string) => {
      // Warn if both clusters are confirmed to different people — this is almost
      // certainly a mistake and would silently overwrite one person's voiceprint.
      {
        const preFromStatus = clusterStatusRef.current[fromLabel];
        const preToStatus = clusterStatusRef.current[toLabel];
        if (
          preFromStatus?.kind === "confirmed" &&
          preToStatus?.kind === "confirmed" &&
          preFromStatus.personId !== preToStatus.personId
        ) {
          const fromName = allPeople.find((p) => p.id === preFromStatus.personId)?.name ?? fromLabel;
          const toName = allPeople.find((p) => p.id === preToStatus.personId)?.name ?? toLabel;
          toast.warning(`Merging ${fromName} → ${toName}: both were confirmed to different people`);
        }
      }
      const ok = diarizerRef.current.mergeClusters(fromLabel, toLabel);
      if (!ok) return;
      // Drop any pending/aux tracking for the dissolved label.
      pendingClustersRef.current.delete(fromLabel);
      pendingVoiceprintMatchRef.current.delete(fromLabel);
      aiSpeakerIdLastRef.current.delete(fromLabel);

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
        const updatedVp = await db.voiceprints.get(confirmedPersonId);
        if (updatedVp) {
          allVoiceprintsRef.current = [
            ...allVoiceprintsRef.current.filter((vp) => vp.person_id !== confirmedPersonId),
            updatedVp,
          ];
          confirmedVoiceprintsRef.current.set(confirmedPersonId, updatedVp.centroid);
        }
      }

      if (cid) {
        await db.conversations.update(cid, { speaker_map: nextMap });
      }
      setClusterTick((n) => n + 1);
      toast.success(`Merged ${fromLabel} → ${toLabel}`);
    },
    [allPeople],
  );

  // Reassign a single transcript segment to a specific person — affects ONLY
  // that one segment, never the cluster. Implemented by setting `person_id`
  // on the segment as a per-line override; cluster state stays untouched.
  // If the segment has a stored MFCC, add it to the person's voiceprint so
  // future conversations recognise them better (the learning signal the user
  // wants from a correction).
  const handleReassignSegment = useCallback(
    async (segmentId: string, personId: string) => {
      const segment = committedRef.current.find((s) => s.id === segmentId);
      if (!segment) return;
      const person = allPeople.find((p) => p.id === personId);
      if (!person) return;
      if (segment.person_id === personId) {
        toast.info(`Already attributed to ${person.name}`);
        return;
      }

      setCommitted((prev) =>
        prev.map((s) => (s.id === segmentId ? { ...s, person_id: personId } : s)),
      );
      await db.transcript_segments.update(segmentId, { person_id: personId });
      toast.success(`Marked as ${person.name}`);

      // Update the person's voiceprint with this segment's MFCC, but only
      // when the MFCC is genuinely close to the person's existing centroid.
      // Without this guard a wrong assignment poisons the centroid and then
      // the 0.72 quick-match routes all future clusters to the wrong person.
      if (segment.mfcc && segment.mfcc.length === 20) {
        try {
          const existingVp = allVoiceprintsRef.current.find((vp) => vp.person_id === personId);
          const sim = existingVp
            ? discriminativeSim(segment.mfcc, existingVp.centroid)
            : 1.0;
          if (!existingVp || (Number.isFinite(sim) && sim >= CENTROID_UPDATE_THRESHOLD)) {
            await recordVoiceprint(personId, segment.mfcc);
            const updatedVp = await import("@/lib/db").then(({ db: d }) => d.voiceprints.get(personId));
            if (updatedVp) {
              allVoiceprintsRef.current = [
                ...allVoiceprintsRef.current.filter((vp) => vp.person_id !== personId),
                updatedVp,
              ];
              confirmedVoiceprintsRef.current.set(personId, updatedVp.centroid);
            }
          }
        } catch (err) {
          console.warn("voiceprint update after reassign failed", err);
        }
      }
    },
    [allPeople],
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


  // Expand James's truncated typing via LLM, then speak the expanded version.
  // For ambiguous input (very short, single-word, no punctuation) we stop at
  // a preview and wait for an explicit Speak confirmation — never narrate a
  // guess for James.
  const isAmbiguousInput = useCallback((s: string) => {
    const t = s.trim();
    if (t.length <= 3) return true;
    // Single short word with no spaces → likely an abbreviation, ask first.
    if (!/\s/.test(t) && t.length <= 6) return true;
    return false;
  }, []);

  const expandAndSpeak = useCallback(async () => {
    const raw = draft.trim();
    if (!raw || expanding || speaking) return;
    setExpanding(true);
    try {
      const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
      const rawRecent = committed.slice(-12).map((s) => {
        if (s.person_id) {
          const p = peopleById.get(s.person_id);
          if (p) return { speaker: p.name, text: s.text };
        }
        return { speaker: s.speaker_label, text: s.text };
      });
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
      // 15s timeout — if a free-tier provider hangs, don't strand the user.
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(), 15_000);
      const r = await Promise.race([
        expandFn({
          data: {
            rawText: raw,
            recentTranscript: recent,
            jamesProfile: ctx.jamesProfile,
            people: ctx.people,
            place: ctx.place,
            // === Cross-conversation voice learning ===
            jamesVoiceSamples: ctx.jamesVoiceSamples,
            // Use smart model for expansion — it's a one-shot operation so the
            // extra latency is acceptable, and quality matters more than speed here.
            model: smartModelRef.current,
          },
        }),
        new Promise<never>((_, rej) => {
          timeoutCtl.signal.addEventListener("abort", () =>
            rej(new Error("Expansion timed out — try again")),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const spoken = (r.expanded || raw).trim();
      if (isAmbiguousInput(raw)) {
        // Ambiguous → preview, wait for explicit tap.
        setPendingSpeech({ raw, expanded: spoken });
      } else {
        setLastExpansion({ raw, expanded: spoken });
        setDraft("");
        // He composed his own reply → the suggestions on screen all missed.
        void commitManualReply(spoken);
        await speak(spoken);
      }
    } catch (e: any) {
      // Never go silent: if the AI expansion fails/times out, still speak what
      // James actually typed (TTS is independent of the chat provider).
      const fallback = draft.trim();
      if (fallback) {
        toast.error(
          (e?.message ?? "Could not expand text") + " — speaking your text as typed.",
        );
        setLastExpansion({ raw: fallback, expanded: fallback });
        setDraft("");
        void commitManualReply(fallback);
        try {
          await speak(fallback);
        } catch {
          /* speak() already toasts on TTS failure */
        }
      } else {
        toast.error(e?.message ?? "Could not expand text");
      }
    } finally {
      setExpanding(false);
    }
  }, [
    draft,
    expanding,
    speaking,
    expandFn,
    allPeople,
    committed,
    speak,
    isAmbiguousInput,
    commitManualReply,
  ]);

  // User tapped Speak on the pending preview.
  const confirmPendingSpeech = useCallback(async () => {
    if (!pendingSpeech) return;
    const { raw, expanded } = pendingSpeech;
    setLastExpansion({ raw, expanded });
    setPendingSpeech(null);
    setDraft("");
    // He composed his own reply → the suggestions on screen all missed.
    void commitManualReply(expanded);
    await speak(expanded);
  }, [pendingSpeech, speak, commitManualReply]);

  // Tap a predicted completion → speak it straight away (no expansion needed).
  const speakPrediction = useCallback(
    async (text: string) => {
      // He needed to type → the conversation suggestions missed; this is closer.
      void commitManualReply(text);
      setDraft("");
      predictModeRef.current = false;
      setPredicting(false);
      await speak(text);
    },
    [speak, commitManualReply],
  );

  // === Predictive typing ===
  // The moment James types, swap the grid to predicted completions of his
  // intent; when he clears the box, restore the conversation suggestions.
  useEffect(() => {
    const text = draft.trim();
    // Predict only while recording — outside a conversation the grid has no
    // batch to restore and predictions would fire spurious network calls.
    if (!active || text.length < 2) {
      if (predictModeRef.current) {
        predictModeRef.current = false;
        setPredicting(false);
        // Restore the conversation suggestions (only if we actually have a
        // batch — otherwise just let the next refresh tick repopulate).
        if (convoSuggestionsRef.current.length) {
          setSuggestions(convoSuggestionsRef.current);
        }
        lastSuggestKeyRef.current = "";
      }
      return;
    }
    predictModeRef.current = true;
    setPredicting(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const peopleById = new Map(allPeople.map((p) => [p.id, p] as const));
        const rawRecent = committed.slice(-8).map((s) => {
          if (s.person_id) {
            const p = peopleById.get(s.person_id);
            if (p) return { speaker: p.name, text: s.text };
          }
          return { speaker: s.speaker_label, text: s.text };
        });
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
        const r = await predictFn({
          data: {
            partialText: text.slice(0, 400),
            recentTranscript: recent,
            jamesProfile: ctx.jamesProfile,
            people: ctx.people,
            place: ctx.place,
            jamesVoiceSamples: ctx.jamesVoiceSamples,
            mood: moodRef.current,
            model: fastModelRef.current,
          },
        });
        // Don't clobber the grid if this keystroke was superseded, or while a
        // card is being held for feedback (a remount would abort the hold).
        if (!cancelled && !holdingCardRef.current && r.predictions?.length) {
          setSuggestions(r.predictions as Suggestion[]);
        }
      } catch (err) {
        console.warn("predict failed", err);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, committed, allPeople, predictFn, active]);

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
              ? "bg-[var(--coral)]/60 ring-2 ring-[var(--coral)]"
              : active
                ? "bg-[var(--coral)] hover:opacity-90"
                : "bg-[var(--teal)] hover:bg-[var(--teal-deep)] disabled:opacity-50"
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
          {pendingSpeech && (
            <div className="flex items-center gap-2 rounded-md border-2 border-[var(--accent)] bg-[var(--accent)]/15 px-2 py-1.5 text-sm">
              <Sparkles className="size-4 shrink-0 text-[var(--accent)]" />
              <div className="flex-1 leading-snug">
                <span className="text-xs text-muted-foreground">
                  Speak this? (typed “{pendingSpeech.raw}”)
                </span>
                <div className="font-medium">{pendingSpeech.expanded}</div>
              </div>
              <button
                onClick={confirmPendingSpeech}
                className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Speak
              </button>
              <button
                onClick={() => {
                  // Edit: put the expansion back into the draft for tweaking.
                  setDraft(pendingSpeech.expanded);
                  setPendingSpeech(null);
                }}
                className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs hover:bg-secondary"
              >
                Edit
              </button>
              <button
                onClick={() => setPendingSpeech(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Cancel"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
          {lastExpansion && !pendingSpeech && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-[var(--accent)]" />
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
              <Sparkles className="size-4 text-[var(--accent)]" />
              {predicting ? "Predicting what you're typing…" : "Suggestions"}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshSuggestions}
              disabled={loadingSuggestions || !active || predicting}
            >
              {loadingSuggestions ? "Thinking…" : "Refresh"}
            </Button>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-2 overflow-hidden p-2">
            {!active && suggestions.length === 0 && !predicting && (
              <Card className="col-span-3 row-span-3 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Press the record button to start a conversation. Suggestions
                will appear here.
              </Card>
            )}
            {active && suggestions.length === 0 && !loadingSuggestions && !predicting && (
              <Card className="col-span-3 row-span-3 flex items-center justify-center p-5 text-center text-sm text-muted-foreground">
                Listening… suggestions will appear after a few words.
              </Card>
            )}
            {suggestions.slice(0, 9).map((s, i) => (
              <SuggestionCard
                key={`${i}-${s.text}`}
                suggestion={s}
                disabled={speaking}
                // Predictions are completions of what James is typing — feedback
                // only applies to AI conversation suggestions.
                feedbackEnabled={feedbackEnabled && !predicting}
                onActivate={() =>
                  predicting
                    ? speakPrediction(s.text)
                    : speak(s.text, { suggestion: s })
                }
                onLongPress={() => setFeedbackTarget(s)}
                onHoldChange={(h) => {
                  holdingCardRef.current = h;
                  if (h) {
                    heldAtCommittedLenRef.current = committed.length;
                  } else if (
                    active &&
                    !predicting &&
                    committed.length !== heldAtCommittedLenRef.current
                  ) {
                    // A turn landed while we were paused for the hold — refresh
                    // now so the suggestions aren't a turn stale.
                    lastSuggestKeyRef.current = "";
                    void refreshSuggestions();
                  }
                }}
              />
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
            participantIds={selectedPersonIds}
            participantCount={peopleInConvo.length}
            onConfirmKnown={confirmKnownSpeaker}
            onRejectSuggestion={rejectSuggestion}
            onConfirmNew={confirmNewSpeaker}
            onAskName={askSpeakerName}
            onClearConfirmed={clearConfirmedSpeaker}
            onMerge={mergeSpeakerClusters}
            onForceNew={forceNewSpeaker}
            onReassignSegment={handleReassignSegment}
          />
        </div>
      </div>

      {/* Suggestion feedback menu (long-press) */}
      {feedbackTarget && (
        <FeedbackMenu
          suggestion={feedbackTarget}
          onPick={(fb) => recordFeedback(feedbackTarget, fb)}
          onClose={() => setFeedbackTarget(null)}
        />
      )}

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

              {/* Voice recognition status & inline recording for the people
                  selected for this conversation. Recording a voice sample here
                  means the participant-override path can identify them
                  correctly from their very first utterance — no guessing. */}
              {selectedPersonIds.length > 0 && (
                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold">
                      Voice recognition
                    </h4>
                    <span className="text-xs text-muted-foreground">
                      Recording a sample makes identification instant & accurate
                    </span>
                  </div>
                  <div className="space-y-2">
                    {selectedPersonIds.map((pid) => {
                      const person = allPeople.find((p) => p.id === pid);
                      if (!person) return null;
                      const sampleCount = voiceprintStatus[pid];
                      const hasPrint = sampleCount != null;
                      const expanded = expandedRecorderPersonId === pid;
                      return (
                        <div
                          key={pid}
                          className={`rounded-lg border ${
                            hasPrint
                              ? "border-emerald-500/30 bg-emerald-500/5"
                              : "border-amber-500/40 bg-amber-500/5"
                          }`}
                        >
                          <div className="flex items-center gap-3 px-3 py-2">
                            <span className="font-medium">{person.name}</span>
                            {hasPrint ? (
                              <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                                <Check className="size-3" />
                                Voice learned · {sampleCount} sample
                                {sampleCount === 1 ? "" : "s"}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                                <AlertCircle className="size-3" />
                                No voice sample yet
                              </span>
                            )}
                            <button
                              onClick={() =>
                                setExpandedRecorderPersonId(
                                  expanded ? null : pid,
                                )
                              }
                              className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-secondary"
                            >
                              {hasPrint ? (
                                expanded ? (
                                  <>
                                    <ChevronUp className="size-3" /> Hide
                                  </>
                                ) : (
                                  <>
                                    <Mic className="size-3" /> Re-record
                                  </>
                                )
                              ) : expanded ? (
                                <>
                                  <ChevronUp className="size-3" /> Hide
                                </>
                              ) : (
                                <>
                                  <Mic className="size-3" /> Record now
                                </>
                              )}
                            </button>
                          </div>
                          {expanded && (
                            <div className="border-t border-border px-3 py-3">
                              <VoiceSampleRecorder personId={pid} />
                              <div className="mt-2 flex justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    await refreshVoiceprintStatus();
                                    setExpandedRecorderPersonId(null);
                                  }}
                                >
                                  Done
                                </Button>
                              </div>
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

/** Hold duration (ms) before a suggestion's feedback menu opens. */
const FEEDBACK_HOLD_MS = 5_000;

/**
 * A single suggestion chip. A quick tap activates it (speak / pick a
 * prediction). Pressing and holding for FEEDBACK_HOLD_MS opens the feedback
 * menu instead — a deliberate long gesture so it never fires by accident
 * during normal tapping. A thin progress bar fills while holding.
 */
function SuggestionCard({
  suggestion,
  disabled,
  feedbackEnabled = true,
  onActivate,
  onLongPress,
  onHoldChange,
}: {
  suggestion: Suggestion;
  disabled: boolean;
  /** When false, the card is a plain tap button — no long-press feedback. */
  feedbackEnabled?: boolean;
  onActivate: () => void;
  onLongPress: () => void;
  /** Notifies the parent while this card is held, so it can pause auto-refresh
   *  (a remount mid-hold would otherwise abort the gesture). */
  onHoldChange?: (holding: boolean) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const [holding, setHolding] = useState(false);
  const [fill, setFill] = useState(false);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = () => {
    if (!feedbackEnabled) return; // feedback gesture disabled → plain tap only
    firedRef.current = false;
    setHolding(true);
    onHoldChange?.(true);
    // Next frame: flip fill so the CSS width transition animates 0 → 100%.
    requestAnimationFrame(() => setFill(true));
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      setHolding(false);
      setFill(false);
      onHoldChange?.(false);
      onLongPress();
    }, FEEDBACK_HOLD_MS);
  };

  const cancel = () => {
    setHolding(false);
    setFill(false);
    onHoldChange?.(false);
    clearTimer();
  };

  useEffect(
    () => () => {
      clearTimer();
      onHoldChange?.(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <button
      onPointerDown={(e) => {
        // Capture the pointer so the 5s hold survives finger jitter/drift —
        // critical for a user with impaired motor control. With capture, events
        // keep flowing to this element and `pointerleave` won't spuriously fire,
        // so we deliberately don't cancel on leave.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* not supported → fall back to default behaviour */
        }
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onClick={(e) => {
        // If the long-press already fired, swallow the click so we don't also
        // speak the suggestion.
        if (firedRef.current) {
          e.preventDefault();
          firedRef.current = false;
          return;
        }
        onActivate();
      }}
      disabled={disabled}
      title={feedbackEnabled ? "Tap to speak · hold to give feedback" : "Tap to speak"}
      className={`relative flex h-full min-h-0 w-full select-none items-center justify-center overflow-hidden rounded-2xl border-2 p-3 text-center text-xl font-medium leading-snug transition-transform active:scale-[0.98] ${categoryClass(suggestion.category)} ${holding ? "ring-2 ring-[var(--accent)]" : ""}`}
    >
      <span className="line-clamp-5">{suggestion.text}</span>
      {holding && (
        <span
          className="pointer-events-none absolute bottom-0 left-0 h-2 bg-[var(--accent)]"
          style={{
            width: fill ? "100%" : "0%",
            transition: fill ? `width ${FEEDBACK_HOLD_MS}ms linear` : "none",
          }}
        />
      )}
    </button>
  );
}

/**
 * Feedback menu shown after a long-press on a suggestion. Each option records
 * an explicit preference signal that shapes future suggestions.
 */
function FeedbackMenu({
  suggestion,
  onPick,
  onClose,
}: {
  suggestion: Suggestion;
  onPick: (feedback: SuggestionFeedback) => void;
  onClose: () => void;
}) {
  const options: Array<{ value: SuggestionFeedback; label: string; emoji: string }> = [
    { value: "love", label: "Sounds just like me", emoji: "💚" },
    { value: "good", label: "Good", emoji: "👍" },
    { value: "too_formal", label: "Too formal", emoji: "🎩" },
    { value: "too_casual", label: "Too casual", emoji: "🩳" },
    { value: "wrong_tone", label: "Wrong tone", emoji: "🎭" },
    { value: "not_me", label: "Not me — don't suggest again", emoji: "🚫" },
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="size-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            How was this suggestion?
          </h3>
        </div>
        <p className="mb-4 rounded-lg bg-secondary/50 px-3 py-2 text-base font-medium">
          “{suggestion.text}”
        </p>
        <div className="grid grid-cols-2 gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => onPick(o.value)}
              className="flex min-h-12 items-center gap-2 rounded-xl border-2 border-border bg-background px-3 py-4 text-left text-base font-medium hover:border-primary hover:bg-primary/5 active:scale-[0.98]"
            >
              <span className="text-lg">{o.emoji}</span>
              {o.label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
      </Card>
    </div>
  );
}


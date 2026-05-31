import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Mic, MicOff, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, type EventRecord, type Person, type Place, type Voiceprint } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { makeEmbedder, type EmbedderKind, type SpeakerEmbedder } from "@/lib/audio/embedder";
import { startCapture, type Capture } from "@/lib/audio/capture";
import { SileroVAD, type VADSegment } from "@/lib/audio/vad";
import { deleteAllContributionsForPerson, enrollSample } from "@/lib/audio/enrollment";
import {
  centroidsFromVoiceprints,
  match,
  type Candidate,
  type MatchContext,
} from "@/lib/audio/matcher";
import { OnlineDiarizer, type DiarAssignment, type DiarCluster } from "@/lib/audio/diarizer";
import { rms } from "@/lib/audio/utils";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/spike/speaker-id")({
  component: SpeakerIdSpike,
});

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];
const EMPTY_PLACES: Place[] = [];
const EMPTY_EVENTS: EventRecord[] = [];

type EngineMode = "matcher" | "diarization";

type MatcherDetection = {
  kind: "matcher";
  id: string;
  capturedAt: number;
  durationMs: number;
  rms: number;
  candidates: Candidate[];
};

type DiarDetection = {
  kind: "diarization";
  id: string;
  capturedAt: number;
  durationMs: number;
  rms: number;
  assignment: DiarAssignment;
};

type Detection = MatcherDetection | DiarDetection;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function SpeakerIdSpike() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Step 2 · Speaker-ID spike
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Prove the speaker-ID engine in isolation.
        </h1>
        <p className="max-w-prose text-muted-foreground">
          Silero VAD splits the mic stream into utterances; an ECAPA-style embedder maps each
          utterance to a 192-dim vector; the matcher combines cosine similarity with a context prior
          to rank the enrolled people. Validate accuracy here before wiring into Live.
        </p>
      </header>

      <ClientOnly fallback={<LoadingCard />}>
        <SpikeApp />
      </ClientOnly>
    </div>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardContent className="py-6 text-sm text-muted-foreground">
        Loading client-only audio + IndexedDB modules…
      </CardContent>
    </Card>
  );
}

function ClientOnly({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}

// --------------------------------------------------------------------------

function SpikeApp() {
  const settings = useSettings();
  const [embedderKind, setEmbedderKind] = useState<EmbedderKind>("transformers");
  const embedderRef = useRef<SpeakerEmbedder | null>(null);
  const [embedderReady, setEmbedderReady] = useState(false);
  const [embedderError, setEmbedderError] = useState<string | null>(null);

  useEffect(() => {
    setEmbedderReady(false);
    setEmbedderError(null);
    embedderRef.current?.dispose?.();

    const next = makeEmbedder(embedderKind, {
      preferWebGPU: settings.speakerIdWebGPU,
    });
    embedderRef.current = next;

    let cancelled = false;
    (async () => {
      try {
        await next.warmup?.();
        if (!cancelled) setEmbedderReady(true);
      } catch (err) {
        if (cancelled) return;
        setEmbedderError(formatError(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [embedderKind, settings.speakerIdWebGPU]);

  const [contextPlaceId, setContextPlaceId] = useState<string>("");
  const [contextEventId, setContextEventId] = useState<string>("");
  const [mode, setMode] = useState<EngineMode>("matcher");

  return (
    <div className="space-y-6">
      <LiveListenCard
        mode={mode}
        onModeChange={setMode}
        embedderRef={embedderRef}
        embedderReady={embedderReady}
        contextPlaceId={contextPlaceId}
        contextEventId={contextEventId}
        acceptThreshold={settings.speakerIdAcceptThreshold}
        askThreshold={settings.speakerIdAskThreshold}
      />

      <div className="grid gap-6 md:grid-cols-2">
        <EmbedderCard
          kind={embedderKind}
          ready={embedderReady}
          error={embedderError}
          onKindChange={setEmbedderKind}
        />
        <ContextCard
          placeId={contextPlaceId}
          eventId={contextEventId}
          onPlaceChange={setContextPlaceId}
          onEventChange={setContextEventId}
        />
        {mode === "matcher" && (
          <>
            <EnrollmentCard embedderRef={embedderRef} embedderReady={embedderReady} />
            <PeopleCard />
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function EmbedderCard({
  kind,
  ready,
  error,
  onKindChange,
}: {
  kind: EmbedderKind;
  ready: boolean;
  error: string | null;
  onKindChange: (kind: EmbedderKind) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedder</CardTitle>
        <CardDescription>
          The neural embedder runs on-device via onnxruntime-web. Default is a WavLM
          speaker-verification head from HuggingFace, auto-downloaded (~95 MB) on first use and
          cached in the browser. Mock is a band-energy fallback for testing the pipeline without the
          download.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Backend">
          <select
            value={kind}
            onChange={(e) => onKindChange(e.target.value as EmbedderKind)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="transformers">WavLM-SV via transformers.js (recommended)</option>
            <option value="onnx-ecapa">Self-hosted ONNX at /models/ecapa-tdnn.onnx</option>
            <option value="mock">Mock (band-energy, debug only)</option>
          </select>
        </Field>
        <div className="rounded-md bg-muted px-3 py-2 text-sm">
          {error ? (
            <span className="text-destructive">Embedder failed: {error}</span>
          ) : ready ? (
            <span>
              Ready · using <code>{kind}</code>
            </span>
          ) : (
            <span className="text-muted-foreground">
              Warming up… first run downloads the model.
            </span>
          )}
        </div>
        {kind === "mock" && (
          <p className="text-xs text-muted-foreground">
            Mock is band-energy only — fine for proving the wiring but won't reliably separate two
            adult voices.
          </p>
        )}
        {kind === "transformers" && !ready && !error && (
          <p className="text-xs text-muted-foreground">
            First load takes ~30–60 s on cell signal (one-time download). Stays cached after that.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function ContextCard({
  placeId,
  eventId,
  onPlaceChange,
  onEventChange,
}: {
  placeId: string;
  eventId: string;
  onPlaceChange: (id: string) => void;
  onEventChange: (id: string) => void;
}) {
  const places = useLiveQuery(() => db().places.toArray(), [], EMPTY_PLACES);
  const events = useLiveQuery(() => db().events.toArray(), [], EMPTY_EVENTS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context prior</CardTitle>
        <CardDescription>
          Drives <code>prior(person | place, event, recent speakers)</code>. Set a place / event to
          see the prior shift.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Place">
          <select
            value={placeId}
            onChange={(e) => onPlaceChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {places.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No places yet. Step 4 builds the editor.
            </p>
          )}
        </Field>
        <Field label="Event">
          <select
            value={eventId}
            onChange={(e) => onEventChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {events.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No events yet. Step 4 builds the editor.
            </p>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

// --------------------------------------------------------------------------

function EnrollmentCard({
  embedderRef,
  embedderReady,
}: {
  embedderRef: React.RefObject<SpeakerEmbedder | null>;
  embedderReady: boolean;
}) {
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);
  const [selectedPersonId, setSelectedPersonId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!capture) return;
    const id = window.setInterval(() => setElapsed(capture.getElapsedSec()), 100);
    return () => window.clearInterval(id);
  }, [capture]);

  const startRecording = async () => {
    if (!selectedPersonId) {
      toast.error("Pick a person first");
      return;
    }
    if (!embedderRef.current || !embedderReady) {
      toast.error("Embedder not ready");
      return;
    }
    try {
      const cap = await startCapture();
      setCapture(cap);
      setElapsed(0);
    } catch (err) {
      toast.error(`Mic error: ${formatError(err)}`);
    }
  };

  const stopAndSave = async () => {
    if (!capture || !embedderRef.current) return;
    setBusy(true);
    try {
      const waveform = await capture.stop();
      setCapture(null);
      if (waveform.length < 16000 * 1.5) {
        toast.error("Sample too short (need ~2s)");
        return;
      }
      await enrollSample({
        personId: selectedPersonId,
        waveform16k: waveform,
        durationSec: waveform.length / 16000,
        embedder: embedderRef.current,
        source: "enrollment",
      });
      toast.success("Sample saved");
    } catch (err) {
      toast.error(`Failed: ${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const addPerson = async () => {
    const name = newName.trim();
    if (!name) return;
    const id = nanoid();
    const now = Date.now();
    await db().people.add({
      id,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    setNewName("");
    setSelectedPersonId(id);
    toast.success(`Added ${name}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enroll</CardTitle>
        <CardDescription>
          Capture 3–5 seconds of clean speech per person, ideally in the same room as the real
          conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Person">
            <select
              value={selectedPersonId}
              onChange={(e) => setSelectedPersonId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— pick —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Add new">
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPerson();
                }}
                placeholder="e.g. Sarah"
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <Button size="icon" variant="outline" onClick={addPerson}>
                <Plus />
              </Button>
            </div>
          </Field>
        </div>

        <div className="flex items-center gap-3">
          {capture ? (
            <Button variant="destructive" onClick={stopAndSave} disabled={busy}>
              <MicOff />
              Stop &amp; save ({elapsed.toFixed(1)}s)
            </Button>
          ) : (
            <Button variant="accent" onClick={startRecording} disabled={busy}>
              <Mic />
              Record sample
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function PeopleCard() {
  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const voiceprints = useLiveQuery(() => db().voiceprints.toArray(), [], EMPTY_VOICEPRINTS);

  const vpByPerson = useMemo(() => {
    const m = new Map<string, Voiceprint>();
    for (const vp of voiceprints) m.set(vp.personId, vp);
    return m;
  }, [voiceprints]);

  const onDelete = async (p: Person) => {
    if (!confirm(`Delete ${p.name} and their voice samples?`)) return;
    await deleteAllContributionsForPerson(p.id);
    await db().people.delete(p.id);
    toast.success(`Deleted ${p.name}`);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>Enrolled people</CardTitle>
            <CardDescription>
              Centroid = mean of all contributions, L2-normalized at capture.
            </CardDescription>
          </div>
          {/* Bulk "Reset all enrolments" intentionally removed from this
              diagnostics page — it lives in Settings → System → Danger
              zone where the destructive action belongs. */}
        </div>
      </CardHeader>
      <CardContent>
        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody enrolled yet. Add someone in the Enroll panel.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {people.map((p) => {
              const vp = vpByPerson.get(p.id);
              return (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-medium">{p.name}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{vp ? `${vp.sampleCount} samples` : "no voiceprint"}</span>
                    <button
                      onClick={() => onDelete(p)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                      aria-label={`Delete ${p.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

type VADState = "idle" | "listening" | "speaking";

function LiveListenCard({
  mode,
  onModeChange,
  embedderRef,
  embedderReady,
  contextPlaceId,
  contextEventId,
  acceptThreshold,
  askThreshold,
}: {
  mode: EngineMode;
  onModeChange: (mode: EngineMode) => void;
  embedderRef: React.RefObject<SpeakerEmbedder | null>;
  embedderReady: boolean;
  contextPlaceId: string;
  contextEventId: string;
  acceptThreshold: number;
  askThreshold: number;
}) {
  const [vadState, setVadState] = useState<VADState>("idle");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [recentSpeakers, setRecentSpeakers] = useState<string[]>([]);
  const [clusterSnapshot, setClusterSnapshot] = useState<DiarCluster[]>([]);
  const vadRef = useRef<SileroVAD | null>(null);
  const diarizerRef = useRef<OnlineDiarizer | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const voiceprints = useLiveQuery(() => db().voiceprints.toArray(), [], EMPTY_VOICEPRINTS);
  const places = useLiveQuery(() => db().places.toArray(), [], EMPTY_PLACES);
  const events = useLiveQuery(() => db().events.toArray(), [], EMPTY_EVENTS);

  const centroidByPersonId = useMemo(() => centroidsFromVoiceprints(voiceprints), [voiceprints]);
  const sampleCountByPersonId = useMemo(() => {
    const m = new Map<string, number>();
    for (const vp of voiceprints) m.set(vp.personId, vp.sampleCount);
    return m;
  }, [voiceprints]);

  const matchContext = useMemo<MatchContext>(() => {
    const place = places.find((p) => p.id === contextPlaceId);
    const event = events.find((e) => e.id === contextEventId);
    // Place-associated people aren't a first-class field yet (step 4 adds
    // the editor) — for the spike, infer from past conversations would be
    // overkill, so leave empty until then.
    return {
      people,
      centroidByPersonId,
      placePersonIds: place ? [] : undefined,
      eventPersonIds: event?.personIds,
      recentSpeakers,
    };
  }, [people, centroidByPersonId, places, events, contextPlaceId, contextEventId, recentSpeakers]);

  // Hold the latest matchContext in a ref so the VAD callback (registered
  // once on start) always reads the freshest value.
  const contextRef = useRef(matchContext);
  useEffect(() => {
    contextRef.current = matchContext;
  }, [matchContext]);

  const handleSegment = async (segment: VADSegment) => {
    setVadState("listening");
    const emb = embedderRef.current;
    if (!emb) return;
    try {
      const embedding = await emb.embed(segment.audio);
      const sampleRms = rms(segment.audio);

      if (modeRef.current === "matcher") {
        const candidates = match(embedding, contextRef.current);
        const detection: MatcherDetection = {
          kind: "matcher",
          id: nanoid(),
          capturedAt: Date.now(),
          durationMs: segment.durationMs,
          rms: sampleRms,
          candidates,
        };
        setDetections((d) => [detection, ...d].slice(0, 30));

        const winner = candidates[0];
        if (winner.personId && winner.posterior >= acceptThreshold) {
          setRecentSpeakers((curr) => {
            const filtered = curr.filter((id) => id !== winner.personId);
            return [winner.personId!, ...filtered].slice(0, 5);
          });
        }
      } else {
        if (!diarizerRef.current) diarizerRef.current = new OnlineDiarizer();
        const assignment = diarizerRef.current.assign(embedding);
        const detection: DiarDetection = {
          kind: "diarization",
          id: nanoid(),
          capturedAt: Date.now(),
          durationMs: segment.durationMs,
          rms: sampleRms,
          assignment,
        };
        setDetections((d) => [detection, ...d].slice(0, 30));
        setClusterSnapshot(diarizerRef.current.getClusters());
      }
    } catch (err) {
      toast.error(`Embed failed: ${formatError(err)}`);
    }
  };

  const start = async () => {
    if (!embedderReady) {
      toast.error("Embedder still warming up");
      return;
    }
    const vad = new SileroVAD();
    try {
      await vad.start();
    } catch (err) {
      toast.error(`VAD start failed: ${formatError(err)}`);
      return;
    }
    vad.onSpeechStart(() => setVadState("speaking"));
    vad.onSegment(handleSegment);
    vad.onMisfire(() => setVadState("listening"));
    vadRef.current = vad;
    setVadState("listening");
    toast.success("Listening");
  };

  const stop = async () => {
    await vadRef.current?.destroy();
    vadRef.current = null;
    setVadState("idle");
  };

  const resetClusters = () => {
    diarizerRef.current?.reset();
    setClusterSnapshot([]);
    setDetections((d) => d.filter((x) => x.kind !== "diarization"));
    toast.success("Clusters reset");
  };

  const handleModeChange = (next: EngineMode) => {
    onModeChange(next);
    // Different output shapes — clear the feed when switching modes so the
    // verdict card doesn't render the wrong kind for an instant.
    setDetections([]);
    setRecentSpeakers([]);
    diarizerRef.current?.reset();
    setClusterSnapshot([]);
  };

  useEffect(() => {
    return () => {
      vadRef.current?.destroy();
    };
  }, []);

  const topDetection = detections[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Listen + match</CardTitle>
        <CardDescription>
          {mode === "matcher" ? (
            <>
              Each VAD segment is embedded and ranked against your enrolled voiceprints. Posteriors
              fold the cosine likelihood in with the location / event / recency prior.
            </>
          ) : (
            <>
              Each VAD segment is embedded and clustered on the fly — no prior enrolment. Speakers
              are labelled A, B, C as they're first heard. Proves the embedder discriminates without
              any setup.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {vadState === "idle" ? (
            <Button variant="accent" onClick={start} disabled={!embedderReady}>
              <Mic />
              Start listening
            </Button>
          ) : (
            <Button variant="destructive" onClick={stop}>
              <MicOff />
              Stop listening
            </Button>
          )}
          <VadStateBadge state={vadState} />
          <ModeToggle mode={mode} onChange={handleModeChange} disabled={vadState !== "idle"} />
          {mode === "matcher" && (
            <div className="rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              confirm @ {(acceptThreshold * 100).toFixed(0)}% · ask @{" "}
              {(askThreshold * 100).toFixed(0)}%
            </div>
          )}
          {mode === "matcher" && recentSpeakers.length > 0 && (
            <div className="rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              recent:{" "}
              {recentSpeakers.map((id) => people.find((p) => p.id === id)?.name ?? id).join(" → ")}
            </div>
          )}
          {mode === "diarization" && clusterSnapshot.length > 0 && (
            <Button variant="outline" size="sm" onClick={resetClusters}>
              <Trash2 />
              Reset clusters
            </Button>
          )}
        </div>

        <CurrentVerdict
          detection={topDetection}
          acceptThreshold={acceptThreshold}
          askThreshold={askThreshold}
          sampleCountByPersonId={sampleCountByPersonId}
        />

        {mode === "diarization" && clusterSnapshot.length > 0 && (
          <ClustersList clusters={clusterSnapshot} />
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent detections
          </p>
          {detections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No detections yet. Start listening and say something.
            </p>
          ) : (
            detections.map((d) => (
              <DetectionRow
                key={d.id}
                detection={d}
                acceptThreshold={acceptThreshold}
                askThreshold={askThreshold}
                sampleCountByPersonId={sampleCountByPersonId}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: EngineMode;
  onChange: (mode: EngineMode) => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Mode
      </span>
      <select
        value={mode}
        onChange={(e) => onChange(e.target.value as EngineMode)}
        disabled={disabled}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-50"
      >
        <option value="matcher">Identify enrolled</option>
        <option value="diarization">Live diarize (no enrol)</option>
      </select>
    </div>
  );
}

function ClustersList({ clusters }: { clusters: DiarCluster[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Clusters ({clusters.length})
      </p>
      <ul className="space-y-1 text-sm">
        {clusters.map((c) => (
          <li key={c.id} className="flex items-center justify-between">
            <span className="font-medium">{c.label}</span>
            <span className="text-xs text-muted-foreground">
              {c.sampleCount} {c.sampleCount === 1 ? "utterance" : "utterances"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VadStateBadge({ state }: { state: VADState }) {
  const cls = cn(
    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
    state === "idle" && "bg-muted text-muted-foreground",
    state === "listening" && "bg-muted text-foreground",
    state === "speaking" && "bg-accent text-accent-foreground",
  );
  const label = state === "idle" ? "Idle" : state === "listening" ? "Listening" : "Speech detected";
  return (
    <span className={cls}>
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          state === "idle" && "bg-muted-foreground/60",
          state === "listening" && "bg-foreground/60",
          state === "speaking" && "animate-pulse bg-accent-foreground",
        )}
      />
      {label}
    </span>
  );
}

// --------------------------------------------------------------------------

type Verdict = "confirmed" | "suggested" | "ask";

function verdictFor(top: Candidate, acceptThreshold: number, askThreshold: number): Verdict {
  if (!top.personId) return "ask";
  if (top.posterior >= acceptThreshold) return "confirmed";
  if (top.posterior >= askThreshold) return "suggested";
  return "ask";
}

function verdictColor(v: Verdict): string {
  return v === "confirmed"
    ? "bg-accent text-accent-foreground"
    : v === "suggested"
      ? "bg-muted text-foreground"
      : "bg-destructive/20 text-destructive";
}

function CurrentVerdict({
  detection,
  acceptThreshold,
  askThreshold,
  sampleCountByPersonId,
}: {
  detection: Detection | undefined;
  acceptThreshold: number;
  askThreshold: number;
  sampleCountByPersonId: Map<string, number>;
}) {
  if (!detection) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        Waiting for the first detection…
      </div>
    );
  }

  if (detection.kind === "matcher") {
    const top = detection.candidates[0];
    const v = verdictFor(top, acceptThreshold, askThreshold);
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", verdictColor(v))}>
              {v}
            </span>
            <div className="mt-2 text-2xl font-semibold tracking-tight">{top.name}</div>
            <div className="text-sm text-muted-foreground">
              posterior {(top.posterior * 100).toFixed(0)}%
              {top.similarity !== undefined && <> · sim {(top.similarity * 100).toFixed(0)}%</>} ·
              prior ×{top.prior.toFixed(2)}
              {top.personId && sampleCountByPersonId.has(top.personId) && (
                <> · {sampleCountByPersonId.get(top.personId)} samples</>
              )}
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            segment {formatDuration(detection.durationMs)}
            <br />
            rms {detection.rms.toFixed(3)}
          </div>
        </div>

        <div className="mt-4 space-y-1">
          {detection.candidates.map((c) => (
            <PosteriorBar
              key={c.personId ?? "unknown"}
              candidate={c}
              samples={c.personId ? sampleCountByPersonId.get(c.personId) : undefined}
            />
          ))}
        </div>
      </div>
    );
  }

  // diarization
  const a = detection.assignment;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              a.isNew ? "bg-accent text-accent-foreground" : "bg-muted text-foreground",
            )}
          >
            {a.isNew ? "new cluster" : "matched"}
          </span>
          <div className="mt-2 text-2xl font-semibold tracking-tight">{a.cluster.label}</div>
          <div className="text-sm text-muted-foreground">
            similarity {(a.similarity * 100).toFixed(0)}% · {a.cluster.sampleCount}{" "}
            {a.cluster.sampleCount === 1 ? "utterance" : "utterances"} in cluster
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          segment {formatDuration(detection.durationMs)}
          <br />
          rms {detection.rms.toFixed(3)}
        </div>
      </div>

      {a.ranked.length > 1 && (
        <div className="mt-4 space-y-1">
          {a.ranked.map(({ cluster, similarity }) => (
            <SimilarityBar key={cluster.id} label={cluster.label} similarity={similarity} />
          ))}
        </div>
      )}
    </div>
  );
}

function PosteriorBar({ candidate, samples }: { candidate: Candidate; samples?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(candidate.posterior * 100)));
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-32 shrink-0 truncate text-foreground">
        {candidate.name}
        {samples !== undefined && <span className="ml-1 text-muted-foreground">·{samples}</span>}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            candidate.personId ? "bg-accent" : "bg-destructive/60",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-muted-foreground">{pct}%</span>
    </div>
  );
}

function SimilarityBar({ label, similarity }: { label: string; similarity: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(similarity * 100)));
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-32 shrink-0 truncate text-foreground">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-muted-foreground">{pct}%</span>
    </div>
  );
}

function DetectionRow({
  detection,
  acceptThreshold,
  askThreshold,
  sampleCountByPersonId,
}: {
  detection: Detection;
  acceptThreshold: number;
  askThreshold: number;
  sampleCountByPersonId: Map<string, number>;
}) {
  if (detection.kind === "matcher") {
    const top = detection.candidates[0];
    const v = verdictFor(top, acceptThreshold, askThreshold);
    const topSamples = top.personId ? sampleCountByPersonId.get(top.personId) : undefined;
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", verdictColor(v))}>
              {v}
            </span>
            <span className="font-medium">{top.name}</span>
            <span className="text-xs text-muted-foreground">
              {(top.posterior * 100).toFixed(0)}%
              {top.similarity !== undefined && <> · sim {(top.similarity * 100).toFixed(0)}%</>}
              {topSamples !== undefined && <> · {topSamples} samples</>}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            segment {formatDuration(detection.durationMs)} · rms {detection.rms.toFixed(3)}
          </div>
        </div>
        {detection.candidates.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {detection.candidates.slice(1, 4).map((c, i) => (
              <span key={`${c.personId ?? "unk"}-${i}`} className="rounded bg-muted px-2 py-0.5">
                {c.name} {(c.posterior * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // diarization
  const a = detection.assignment;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              a.isNew ? "bg-accent text-accent-foreground" : "bg-muted text-foreground",
            )}
          >
            {a.isNew ? "new" : "→"}
          </span>
          <span className="font-medium">{a.cluster.label}</span>
          <span className="text-xs text-muted-foreground">
            sim {(a.similarity * 100).toFixed(0)}% · cluster has {a.cluster.sampleCount}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          segment {formatDuration(detection.durationMs)} · rms {detection.rms.toFixed(3)}
        </div>
      </div>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

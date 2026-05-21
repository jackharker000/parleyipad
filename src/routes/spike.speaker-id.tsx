import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Mic, MicOff, Plus, Trash2, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

import { db, type Person, type VoiceSample } from "@/lib/db";

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_SAMPLES: VoiceSample[] = [];
import { useSettings } from "@/lib/settings";
import { makeEmbedder, type EmbedderKind, type SpeakerEmbedder } from "@/lib/audio/embedder";
import { startCapture, type Capture } from "@/lib/audio/capture";
import { SileroVAD, type VADSegment } from "@/lib/audio/vad";
import { enrollSample, deleteAllSamplesForPerson } from "@/lib/audio/enrollment";
import { centroidsFromSamples, match, type Candidate } from "@/lib/audio/matcher";
import { rms } from "@/lib/audio/utils";

export const Route = createFileRoute("/spike/speaker-id")({
  component: SpeakerIdSpike,
});

type Detection = {
  id: string;
  endedAtMs: number;
  durationMs: number;
  rms: number;
  candidates: Candidate[];
};

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

function SpikeApp() {
  const settings = useSettings();
  const [embedderKind, setEmbedderKind] = useState<EmbedderKind>("mock");
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

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <EmbedderCard
        kind={embedderKind}
        ready={embedderReady}
        error={embedderError}
        onKindChange={setEmbedderKind}
      />
      <EnrollmentCard embedder={embedderRef} />
      <PeopleCard />
      <LiveListenCard
        embedder={embedderRef}
        embedderReady={embedderReady}
        acceptThreshold={settings.speakerIdAcceptThreshold}
        askThreshold={settings.speakerIdAskThreshold}
      />
    </div>
  );
}

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
          ECAPA via onnxruntime-web is the target. The mock embedder keeps the loop working until
          you drop the ONNX file at <code>public/models/ecapa-tdnn.onnx</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">ONNX ECAPA-TDNN (per CLAUDE.md)</span>
          <Switch
            checked={kind === "onnx-ecapa"}
            onCheckedChange={(v) => onKindChange(v ? "onnx-ecapa" : "mock")}
          />
        </div>
        <div className="rounded-md bg-muted px-3 py-2 text-sm">
          {error ? (
            <span className="text-destructive">Embedder failed: {error}</span>
          ) : ready ? (
            <span className="text-foreground">Ready ({kind})</span>
          ) : (
            <span className="text-muted-foreground">Warming up…</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EnrollmentCard({ embedder }: { embedder: React.RefObject<SpeakerEmbedder | null> }) {
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], []);
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
    if (!embedder.current) {
      toast.error("Embedder not loaded");
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
    if (!capture || !embedder.current) return;
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
        embedder: embedder.current,
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
    await db().people.add({ id, name, createdAt: now, updatedAt: now });
    setNewName("");
    setSelectedPersonId(id);
    toast.success(`Added ${name}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enroll</CardTitle>
        <CardDescription>
          Capture 3–5 seconds of clean speech per person. More samples = tighter centroid = better
          match.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Person
            </label>
            <select
              value={selectedPersonId}
              onChange={(e) => setSelectedPersonId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— pick —</option>
              {people?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Add new
            </label>
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Sarah"
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <Button size="icon" variant="outline" onClick={addPerson}>
                <Plus />
              </Button>
            </div>
          </div>
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

function PeopleCard() {
  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const samples = useLiveQuery(() => db().voiceSamples.toArray(), [], EMPTY_SAMPLES);

  const countByPerson = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of samples) m.set(s.personId, (m.get(s.personId) ?? 0) + 1);
    return m;
  }, [samples]);

  const onDelete = async (p: Person) => {
    if (!confirm(`Delete ${p.name} and their voice samples?`)) return;
    await deleteAllSamplesForPerson(p.id);
    await db().people.delete(p.id);
    toast.success(`Deleted ${p.name}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrolled people</CardTitle>
        <CardDescription>
          Centroid = mean of all samples (each L2-normalized at capture).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody enrolled yet. Add someone in the Enroll panel.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {people.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="flex items-center gap-3 text-muted-foreground">
                  <span>{countByPerson.get(p.id) ?? 0} samples</span>
                  <button
                    onClick={() => onDelete(p)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LiveListenCard({
  embedder,
  embedderReady,
  acceptThreshold,
  askThreshold,
}: {
  embedder: React.RefObject<SpeakerEmbedder | null>;
  embedderReady: boolean;
  acceptThreshold: number;
  askThreshold: number;
}) {
  const [listening, setListening] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [recentSpeakers, setRecentSpeakers] = useState<string[]>([]);
  const vadRef = useRef<SileroVAD | null>(null);

  const people = useLiveQuery(() => db().people.toArray(), [], EMPTY_PEOPLE);
  const samples = useLiveQuery(() => db().voiceSamples.toArray(), [], EMPTY_SAMPLES);
  const centroidByPersonId = useMemo(() => centroidsFromSamples(samples), [samples]);

  const peopleRef = useRef(people);
  const centroidRef = useRef(centroidByPersonId);
  const recentRef = useRef(recentSpeakers);
  useEffect(() => {
    peopleRef.current = people;
  }, [people]);
  useEffect(() => {
    centroidRef.current = centroidByPersonId;
  }, [centroidByPersonId]);
  useEffect(() => {
    recentRef.current = recentSpeakers;
  }, [recentSpeakers]);

  const handleSegment = async (segment: VADSegment) => {
    const emb = embedder.current;
    if (!emb) return;
    try {
      const embedding = await emb.embed(segment.audio);
      const candidates = match(embedding, {
        people: peopleRef.current,
        centroidByPersonId: centroidRef.current,
        recentSpeakers: recentRef.current,
      });

      const detection: Detection = {
        id: nanoid(),
        endedAtMs: segment.endedAtMs,
        durationMs: segment.durationMs,
        rms: rms(segment.audio),
        candidates,
      };
      setDetections((d) => [detection, ...d].slice(0, 50));

      const winner = candidates[0];
      if (winner.personId && winner.posterior >= acceptThreshold) {
        setRecentSpeakers((curr) => {
          const filtered = curr.filter((id) => id !== winner.personId);
          return [winner.personId!, ...filtered].slice(0, 5);
        });
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
    vad.onSegment(handleSegment);
    vadRef.current = vad;
    setListening(true);
    toast.success("Listening");
  };

  const stop = async () => {
    await vadRef.current?.destroy();
    vadRef.current = null;
    setListening(false);
  };

  useEffect(() => {
    return () => {
      vadRef.current?.destroy();
    };
  }, []);

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle>Listen + match</CardTitle>
        <CardDescription>
          Each row is a VAD segment. Top candidate is the matcher's pick. Posteriors include a
          Bayesian context prior over recent speakers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {listening ? (
            <Button variant="destructive" onClick={stop}>
              <MicOff />
              Stop listening
            </Button>
          ) : (
            <Button variant="accent" onClick={start} disabled={!embedderReady}>
              <Mic />
              Start listening
            </Button>
          )}
          <div className="rounded-md bg-muted px-3 py-1.5 text-xs">
            confirm @ {(acceptThreshold * 100).toFixed(0)}% · ask @{" "}
            {(askThreshold * 100).toFixed(0)}%
          </div>
          {recentSpeakers.length > 0 && (
            <div className="rounded-md bg-muted px-3 py-1.5 text-xs">
              recent:{" "}
              {recentSpeakers.map((id) => people.find((p) => p.id === id)?.name ?? id).join(" → ")}
            </div>
          )}
        </div>

        <div className="space-y-2">
          {detections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No detections yet. Start listening and speak.
            </p>
          ) : (
            detections.map((d) => (
              <DetectionRow
                key={d.id}
                detection={d}
                acceptThreshold={acceptThreshold}
                askThreshold={askThreshold}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DetectionRow({
  detection,
  acceptThreshold,
  askThreshold,
}: {
  detection: Detection;
  acceptThreshold: number;
  askThreshold: number;
}) {
  const top = detection.candidates[0];
  const verdict = verdictFor(top, acceptThreshold, askThreshold);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={
              verdict === "confirmed"
                ? "rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
                : verdict === "suggested"
                  ? "rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
                  : "rounded-full bg-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive"
            }
          >
            {verdict}
          </span>
          <span className="font-medium">{top.name}</span>
          <span className="text-xs text-muted-foreground">
            posterior {(top.posterior * 100).toFixed(0)}%
            {top.similarity !== undefined && <> · sim {(top.similarity * 100).toFixed(0)}%</>}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {detection.durationMs.toFixed(0)} ms · rms {detection.rms.toFixed(3)}
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

type Verdict = "confirmed" | "suggested" | "ask";

function verdictFor(top: Candidate, acceptThreshold: number, askThreshold: number): Verdict {
  if (!top.personId) return "ask";
  if (top.posterior >= acceptThreshold) return "confirmed";
  if (top.posterior >= askThreshold) return "suggested";
  return "ask";
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

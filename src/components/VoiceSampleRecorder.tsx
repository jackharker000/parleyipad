/**
 * VoiceSampleRecorder — inline mic recorder for a single person.
 *
 * Drives the rebuild's `enrollSample` API. The caller passes in the page's
 * `SpeakerEmbedder` so we don't pay the WavLM warmup once per person on the
 * People page; one warmup covers the whole roster.
 *
 * Mic capture path: `startCapture` from `src/lib/audio/capture.ts` (AudioWorklet
 * → 16 kHz mono Float32). That helper already handles the iPad-Safari
 * 44.1/48 kHz quirk via linear resample, and is the same path the spike's
 * enrollment card uses. We deliberately don't roll a MediaRecorder + decode
 * detour — the AudioWorklet path is already proven in the spike.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";

import { Button } from "@/components/ui/button";
import {
  db,
  type Voiceprint,
  type VoiceprintContribution,
} from "@/lib/db";
import { startCapture, type Capture } from "@/lib/audio/capture";
import { enrollSample, deleteContribution } from "@/lib/audio/enrollment";
import type { SpeakerEmbedder } from "@/lib/audio/embedder";

const MIN_SECS = 2;
const MAX_SECS = 8;

const EMPTY_CONTRIBUTIONS: VoiceprintContribution[] = [];

export function VoiceSampleRecorder({
  personId,
  embedder,
  embedderReady,
}: {
  personId: string;
  embedder: SpeakerEmbedder | null;
  embedderReady: boolean;
}) {
  const voiceprint = useLiveQuery<Voiceprint | undefined>(
    () => db().voiceprints.get(personId),
    [personId],
  );
  const contributions = useLiveQuery(
    () =>
      db()
        .voiceprintContributions.where("personId")
        .equals(personId)
        .reverse()
        .sortBy("createdAt"),
    [personId],
    EMPTY_CONTRIBUTIONS,
  );

  const [capture, setCapture] = useState<Capture | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const captureRef = useRef<Capture | null>(null);

  // Keep ref in sync so the unmount cleanup can cancel without depending on
  // the React render snapshot.
  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  // Tick the elapsed counter; auto-stop at MAX_SECS so we don't trap the user
  // in a runaway recording when the embedder is slow.
  useEffect(() => {
    if (!capture) return;
    const id = window.setInterval(() => {
      const e = capture.getElapsedSec();
      setElapsed(e);
      if (e >= MAX_SECS) void stopAndSave();
    }, 100);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture]);

  // Cancel any in-flight capture on unmount so the mic actually releases.
  useEffect(() => {
    return () => {
      captureRef.current?.cancel().catch(() => {});
    };
  }, []);

  const startRecording = async () => {
    if (capture || busy) return;
    if (!embedder || !embedderReady) {
      toast.error("Voice model still warming up — try again in a moment");
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
    const cap = captureRef.current;
    if (!cap) return;
    captureRef.current = null;
    setCapture(null);
    if (!embedder) {
      try {
        await cap.cancel();
      } catch {
        /* ignore */
      }
      toast.error("Voice model not ready");
      return;
    }
    setBusy(true);
    try {
      const waveform = await cap.stop();
      const durationSec = waveform.length / 16000;
      if (durationSec < MIN_SECS) {
        toast.error(`Need at least ${MIN_SECS}s — try again`);
        return;
      }
      await enrollSample({
        personId,
        waveform16k: waveform,
        durationSec,
        embedder,
        source: "enrollment",
        previewText: `Manual sample (${durationSec.toFixed(1)}s)`,
      });
      toast.success("Voice sample saved");
    } catch (err) {
      toast.error(`Failed: ${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelRecording = async () => {
    const cap = captureRef.current;
    if (!cap) return;
    captureRef.current = null;
    setCapture(null);
    try {
      await cap.cancel();
    } catch {
      /* ignore */
    }
  };

  const removeContribution = async (id: string) => {
    if (!confirm("Remove this contribution from the voice profile?")) return;
    await deleteContribution(id);
    toast.success("Removed contribution");
  };

  const sampleCount = voiceprint?.sampleCount ?? 0;
  const remaining = Math.max(0, MAX_SECS - elapsed);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {sampleCount > 0
          ? `Voice learned · ${sampleCount} sample${sampleCount === 1 ? "" : "s"}`
          : "No voiceprint yet"}
      </p>

      {capture ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={stopAndSave} variant="destructive" size="sm" disabled={busy}>
            <MicOff />
            Stop &amp; save ({remaining.toFixed(1)}s)
          </Button>
          <Button onClick={cancelRecording} variant="ghost" size="sm" disabled={busy}>
            Cancel
          </Button>
          <span className="text-xs text-muted-foreground">Speak normally…</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={startRecording}
            disabled={busy || !embedderReady}
            size="sm"
            variant="accent"
          >
            <Mic />
            {sampleCount > 0 ? "Add another sample" : "Record voice sample"}
          </Button>
        </div>
      )}

      {!capture && (
        <p className="text-xs text-muted-foreground">
          Tap record and have the person speak normally for {MIN_SECS}–{MAX_SECS}s. The
          recording stays on this device.
        </p>
      )}

      {!embedderReady && !capture && (
        <p className="text-xs text-muted-foreground">
          Voice model is loading — recording will enable once it's warm.
        </p>
      )}

      <ContributionsList
        contributions={contributions}
        onRemove={removeContribution}
      />
    </div>
  );
}

function ContributionsList({
  contributions,
  onRemove,
}: {
  contributions: VoiceprintContribution[];
  onRemove: (id: string) => void | Promise<void>;
}) {
  if (contributions.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Voice contributions ({contributions.length})
      </p>
      <p className="text-xs text-muted-foreground">
        Remove any entry that isn't actually them — the voice profile is rebuilt from the
        rest.
      </p>
      <ul className="space-y-1">
        {contributions.slice(0, 20).map((c) => (
          <li
            key={c.id}
            className="flex items-start justify-between gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={
                    c.source === "enrollment"
                      ? "rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                      : "rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                  }
                >
                  {c.source === "enrollment" ? "manual" : "auto"}
                </span>
                <span className="text-muted-foreground">
                  {new Date(c.createdAt).toLocaleString()}
                </span>
                <span className="text-muted-foreground">
                  · {c.durationSec.toFixed(1)}s
                </span>
              </div>
              {c.previewText && (
                <p className="mt-0.5 truncate italic">&ldquo;{c.previewText}&rdquo;</p>
              )}
            </div>
            <Button
              onClick={() => onRemove(c.id)}
              size="sm"
              variant="ghost"
              className="h-auto px-1.5 py-1 text-destructive"
              title="Remove this contribution"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

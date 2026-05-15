import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  VoiceCapture,
  computeMfccMean,
  recordVoiceprint,
  deleteVoiceprint,
} from "@/lib/voiceprint";
import { db, type Voiceprint, type VoiceprintContribution } from "@/lib/db";
import { Button } from "@/components/ui/button";

const MIN_SECS = 3;
const MAX_SECS = 8;

export function VoiceSampleRecorder({ personId }: { personId: string }) {
  const [print, setPrint] = useState<Voiceprint | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const captureRef = useRef<VoiceCapture | null>(null);
  const tickRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const replaceModeRef = useRef(false);

  const refresh = async () => {
    const vp = await db.voiceprints.get(personId);
    setPrint(vp ?? null);
  };

  useEffect(() => {
    void refresh();
    return () => {
      try {
        captureRef.current?.stop();
      } catch {}
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  const start = async (replace: boolean) => {
    if (recording || busy) return;
    replaceModeRef.current = replace;
    try {
      const cap = new VoiceCapture();
      await cap.start();
      captureRef.current = cap;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      tickRef.current = window.setInterval(() => {
        const e = (Date.now() - startedAtRef.current) / 1000;
        setElapsed(e);
        if (e >= MAX_SECS) void stop();
      }, 100);
    } catch (e: any) {
      toast.error(e?.message ?? "Microphone unavailable");
    }
  };

  const stop = async () => {
    if (!recording) return;
    setRecording(false);
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const cap = captureRef.current;
    captureRef.current = null;
    if (!cap) return;
    setBusy(true);
    try {
      const duration = (Date.now() - startedAtRef.current) / 1000;
      if (duration < MIN_SECS) {
        toast.error(`Need at least ${MIN_SECS} seconds — try again`);
        cap.stop();
        return;
      }
      const pcm = cap.recentSlice(duration, 0);
      cap.stop();
      const mfcc = computeMfccMean(pcm, cap.sampleRate);
      if (!mfcc) {
        toast.error("Could not extract voice features — try again");
        return;
      }
      if (replaceModeRef.current) {
        // Write the new voiceprint first so we always have a valid record.
        // Only then delete the old contributions so a failure here doesn't
        // leave the person with no voiceprint at all.
        await db.voiceprints.put({
          id: personId,
          person_id: personId,
          centroid: mfcc.slice(),
          sample_count: 1,
          updated_at: Date.now(),
        });
        await db.voiceprint_contributions
          .where("person_id")
          .equals(personId)
          .delete();
      } else {
        await recordVoiceprint(personId, mfcc);
      }
      await db.voiceprint_contributions.add({
        id: crypto.randomUUID(),
        person_id: personId,
        source: "manual",
        mfcc: mfcc.slice(),
        ts: Date.now(),
        preview_text: `Manual sample (${duration.toFixed(1)}s)`,
      });
      toast.success("Voice sample saved");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save voice sample");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this person's voice sample?")) return;
    await deleteVoiceprint(personId);
    await db.voiceprint_contributions
      .where("person_id")
      .equals(personId)
      .delete();
    await refresh();
    toast.success("Voiceprint deleted");
  };

  const remaining = Math.max(0, MAX_SECS - elapsed);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {print
          ? `Voice learned · ${print.sample_count} sample${
              print.sample_count === 1 ? "" : "s"
            }`
          : "No voiceprint yet"}
      </p>

      {recording ? (
        <div className="flex items-center gap-2">
          <Button onClick={stop} variant="destructive" size="sm">
            <Square className="size-4" />
            Stop ({remaining.toFixed(1)}s)
          </Button>
          <span className="text-xs text-muted-foreground">
            Speak normally…
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => start(false)}
            disabled={busy}
            size="sm"
            variant="secondary"
          >
            <Mic className="size-4" />
            {print ? "Add another sample" : "Record voice sample"}
          </Button>
          {print && (
            <>
              <Button
                onClick={() => start(true)}
                disabled={busy}
                size="sm"
                variant="outline"
              >
                Replace
              </Button>
              <Button
                onClick={remove}
                disabled={busy}
                size="sm"
                variant="ghost"
                className="text-destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </>
          )}
        </div>
      )}
      {!recording && (
        <p className="text-xs text-muted-foreground">
          Tap record and have the person speak normally for {MIN_SECS}–
          {MAX_SECS} seconds. The recording stays on this device.
        </p>
      )}
      {/* Auto-learned contributions */}
      <VoiceprintContributions personId={personId} onChanged={refresh} />
    </div>
  );
}

function VoiceprintContributions({
  personId,
  onChanged,
}: {
  personId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<VoiceprintContribution[]>([]);

  const refresh = async () => {
    const list = await db.voiceprint_contributions
      .where("person_id")
      .equals(personId)
      .reverse()
      .sortBy("ts");
    setItems(list);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  // Remove this contribution and recompute the centroid from the remaining ones.
  const remove = async (id: string) => {
    if (!confirm("Remove this contribution from the voice profile?")) return;
    await db.voiceprint_contributions.delete(id);
    const remaining = await db.voiceprint_contributions
      .where("person_id")
      .equals(personId)
      .toArray();
    if (remaining.length === 0) {
      await deleteVoiceprint(personId);
    } else {
      // Recompute centroid as the simple mean of remaining MFCCs of the same dim.
      const dim = remaining[0].mfcc.length;
      const compatible = remaining.filter((r) => r.mfcc.length === dim);
      const sum = new Array(dim).fill(0);
      for (const c of compatible) {
        for (let i = 0; i < dim; i++) sum[i] += c.mfcc[i];
      }
      const centroid = sum.map((v) => v / compatible.length);
      await db.voiceprints.put({
        id: personId,
        person_id: personId,
        centroid,
        sample_count: compatible.length,
        updated_at: Date.now(),
      });
    }
    await refresh();
    await onChanged();
    toast.success("Removed contribution");
  };

  if (items.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5 rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Voice contributions ({items.length})
      </p>
      <p className="text-xs text-muted-foreground">
        Remove any entry that isn't actually them — the voice profile will be
        rebuilt from the rest.
      </p>
      <ul className="space-y-1">
        {items.slice(0, 20).map((c) => (
          <li
            key={c.id}
            className="flex items-start justify-between gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    c.source === "manual"
                      ? "bg-emerald-500/20 text-emerald-700"
                      : "bg-amber-500/20 text-amber-800"
                  }`}
                >
                  {c.source === "manual" ? "manual" : "auto"}
                </span>
                <span className="text-muted-foreground">
                  {new Date(c.ts).toLocaleString()}
                </span>
              </div>
              {c.preview_text && (
                <p className="mt-0.5 truncate italic">"{c.preview_text}"</p>
              )}
            </div>
            <Button
              onClick={() => remove(c.id)}
              size="sm"
              variant="ghost"
              className="h-auto px-1.5 py-1 text-destructive"
              title="This isn't them — remove this contribution"
            >
              <Trash2 className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

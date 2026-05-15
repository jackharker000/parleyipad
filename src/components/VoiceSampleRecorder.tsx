import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  VoiceCapture,
  computeMfccMean,
  recordVoiceprint,
  deleteVoiceprint,
} from "@/lib/voiceprint";
import { db, type Voiceprint } from "@/lib/db";
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
        await deleteVoiceprint(personId);
      }
      await recordVoiceprint(personId, mfcc);
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
    </div>
  );
}

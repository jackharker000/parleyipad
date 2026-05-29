import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { db, type SettingsRecord } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { drainPendingJobs } from "@/lib/jobs/drain";
import {
  exportEncryptedBackup,
  importEncryptedBackup,
  suggestedBackupFilename,
} from "@/lib/backup";
import { cn } from "@/lib/cn";

/**
 * System tab. Display preset, speaker-ID tuning, GPS toggle, dead-phrase
 * suppression thresholds, a style-profile last-run card, and the danger
 * zone (clear + encrypted backup export / import).
 */

const INPUT_CLASSES =
  "rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const DISPLAY_PRESETS: Array<{ value: SettingsRecord["displayPreset"]; label: string }> = [
  { value: "mini", label: "iPad mini" },
  { value: "11", label: 'iPad 11"' },
  { value: "12.9", label: 'iPad Pro 12.9"' },
  { value: "13", label: 'iPad Pro 13"' },
];

const DEFAULT_DEAD_PHRASE_SHOWN = 3;
const DEFAULT_DEAD_PHRASE_WINDOW_DAYS = 7;

export function SystemTab() {
  return (
    <div className="space-y-6">
      <DisplayPresetCard />
      <SpeakerIdCard />
      <GpsCard />
      <DeadPhraseCard />
      <StyleProfileCard />
      <DangerZoneCard />
    </div>
  );
}

// --------------------------------------------------------------------------

async function persistSettings(patch: Partial<SettingsRecord>) {
  const existing = await db().settings.get("singleton");
  const next: SettingsRecord = {
    id: "singleton",
    llmProvider: "anthropic",
    sttProvider: "elevenlabs-scribe",
    ttsProvider: "elevenlabs-flash",
    speakerIdWebGPU: true,
    speakerIdAcceptThreshold: 0.7,
    speakerIdAskThreshold: 0.45,
    gpsEnabled: false,
    displayPreset: "11",
    ...existing,
    ...patch,
  };
  await db().settings.put(next);
}

// --------------------------------------------------------------------------

function DisplayPresetCard() {
  const settings = useSettings();

  const setPreset = async (preset: SettingsRecord["displayPreset"]) => {
    // TODO: wire the actual cockpit layout response in a follow-up. For now
    // this only updates the persisted preference so the cockpit can read it
    // later via `useSetting("displayPreset")`.
    await persistSettings({ displayPreset: preset });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display preset</CardTitle>
        <CardDescription>
          Which iPad is this running on. Used by the cockpit layout (wired in a follow-up).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {DISPLAY_PRESETS.map((p) => {
            const selected = settings.displayPreset === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => void setPreset(p.value)}
                aria-pressed={selected}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function SpeakerIdCard() {
  const settings = useSettings();

  const setWebGPU = (v: boolean) => void persistSettings({ speakerIdWebGPU: v });
  const setAccept = (v: number) => void persistSettings({ speakerIdAcceptThreshold: v });
  const setAsk = (v: number) => void persistSettings({ speakerIdAskThreshold: v });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker-ID tuning</CardTitle>
        <CardDescription>
          On-device neural speaker embeddings + Silero VAD + Bayesian context prior. Defaults work
          for most rooms; tighten the Confirm threshold if you see false positives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Use WebGPU when available</p>
            <p className="text-xs text-muted-foreground">
              Falls back to CPU on devices without WebGPU support.
            </p>
          </div>
          <Switch checked={settings.speakerIdWebGPU} onCheckedChange={setWebGPU} />
        </div>

        <SliderRow
          label="Confirm threshold (posterior)"
          hint="Above this, the matcher commits to the proposed person."
          min={0.4}
          max={0.95}
          step={0.05}
          value={settings.speakerIdAcceptThreshold}
          onChange={setAccept}
        />
        <SliderRow
          label="Ask-name threshold (posterior)"
          hint="Below this, the cockpit asks 'Who is this?' rather than guess."
          min={0.2}
          max={0.8}
          step={0.05}
          value={settings.speakerIdAskThreshold}
          onChange={setAsk}
        />
      </CardContent>
    </Card>
  );
}

function SliderRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
          {value.toFixed(2)}
        </span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

// --------------------------------------------------------------------------

function GpsCard() {
  const settings = useSettings();
  const setGps = (v: boolean) => void persistSettings({ gpsEnabled: v });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          GPS for place detection
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
            experimental
          </span>
        </CardTitle>
        <CardDescription>
          When on, locations with lat/lng are eligible for auto-detection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Use GPS</p>
            <p className="text-xs text-muted-foreground">
              Off by default — the manual place picker covers most rooms.
            </p>
          </div>
          <Switch checked={settings.gpsEnabled} onCheckedChange={setGps} />
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function DeadPhraseCard() {
  const settings = useSettings();
  const shownTimes = settings.deadPhraseShownTimes ?? DEFAULT_DEAD_PHRASE_SHOWN;
  const windowDays = settings.deadPhraseWindowDays ?? DEFAULT_DEAD_PHRASE_WINDOW_DAYS;

  const setShown = (v: number) =>
    void persistSettings({ deadPhraseShownTimes: Number.isFinite(v) && v > 0 ? v : undefined });
  const setWindow = (v: number) =>
    void persistSettings({ deadPhraseWindowDays: Number.isFinite(v) && v > 0 ? v : undefined });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dead-phrase suppression</CardTitle>
        <CardDescription>
          The cockpit hides suggestions James has consistently passed over. Tune the thresholds if
          phrases are vanishing too fast — or sticking around when they shouldn't.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              Hide phrases shown at least this many times
            </p>
            <p className="text-xs text-muted-foreground">Default 3.</p>
          </div>
          <input
            type="number"
            min={1}
            max={20}
            value={shownTimes}
            onChange={(e) => setShown(Number(e.target.value))}
            className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Within the last N days</p>
            <p className="text-xs text-muted-foreground">Default 7.</p>
          </div>
          <input
            type="number"
            min={1}
            max={90}
            value={windowDays}
            onChange={(e) => setWindow(Number(e.target.value))}
            className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function StyleProfileCard() {
  const lastRun = useLiveQuery(
    () => db().styleDistillRuns.orderBy("startedAt").reverse().first(),
    [],
  );
  const [rebuilding, setRebuilding] = useState(false);

  const rebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      // We don't have an active conversation here, but the distill job
      // reads from every conversation's `suggestionsLog` so the
      // `conversationId` field is mostly informational. Use a sentinel.
      await db().pendingJobs.put({
        id: `distillStyle:manual:${Date.now()}`,
        type: "distillStyle",
        conversationId: "manual",
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      toast.success("Style profile rebuild queued");
      await drainPendingJobs();
    } catch (err) {
      toast.error(`Could not queue rebuild: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRebuilding(false);
    }
  };

  let runLine = "Not run yet";
  let durationLine: string | null = null;
  if (lastRun) {
    const when = new Date(lastRun.startedAt).toLocaleString();
    runLine = `Last run: ${when}`;
    if (lastRun.endedAt) {
      const seconds = Math.max(0, Math.round((lastRun.endedAt - lastRun.startedAt) / 1000));
      durationLine = `${seconds}s · ${lastRun.samplesUsed} sample${lastRun.samplesUsed === 1 ? "" : "s"}`;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Style profile</CardTitle>
        <CardDescription>Built from past conversations. {runLine}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {durationLine && <p className="text-xs text-muted-foreground">{durationLine}</p>}
        {lastRun?.status === "failed" && lastRun.error && (
          <p className="text-xs text-destructive">Last attempt failed: {lastRun.error}</p>
        )}
        <Button variant="outline" onClick={rebuild} disabled={rebuilding}>
          {rebuilding ? "Queueing…" : "Rebuild now"}
        </Button>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function DangerZoneCard() {
  const [clearing, setClearing] = useState(false);

  const clearAll = async () => {
    if (clearing) return;
    if (
      !confirm(
        "Clear ALL local data on this device? This permanently deletes conversations, people, voiceprints, places, events, profile, drafts, and cached audio. Cannot be undone.",
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const d = db();
      await Promise.all([
        d.people.clear(),
        d.voiceprints.clear(),
        d.voiceprintContributions.clear(),
        d.places.clear(),
        d.events.clear(),
        d.conversations.clear(),
        d.transcriptSegments.clear(),
        d.segmentEmbeddings.clear(),
        d.suggestionsLog.clear(),
        d.memories.clear(),
        d.followUps.clear(),
        d.jamesProfile.clear(),
        d.styleProfile.clear(),
        d.styleEvidence.clear(),
        d.personDocuments.clear(),
        d.jamesDocuments.clear(),
        d.eventDocuments.clear(),
        d.manualReplies.clear(),
        d.settings.clear(),
        d.cachedPhraseAudio.clear(),
        d.pendingJobs.clear(),
        d.helperDrafts.clear(),
        d.styleDistillRuns.clear(),
        d.profileProposals.clear(),
        d.personLexicon.clear(),
      ]);

      // localStorage is rarely used by Parley itself, but third-party libs
      // (transformers.js cache markers, ORT settings) drop keys in here.
      try {
        localStorage.clear();
      } catch {
        // privacy mode / quota exhaustion — best-effort.
      }

      // Clear every Cache Storage bucket — the transformers.js model
      // downloads are stored here under generated names that are awkward to
      // pin. For a single-user "start fresh" reset, nuking everything is
      // safer than guessing.
      try {
        if (typeof caches !== "undefined") {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch {
        // ignore
      }

      // Reload immediately so the user lands on a known-good blank state.
      window.location.reload();
    } catch (err) {
      toast.error(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Local-only. Single user, single iPad. Wipe everything if you're handing the device off or
          starting over.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="destructive" onClick={clearAll} disabled={clearing}>
          {clearing ? "Clearing…" : "Clear all local data"}
        </Button>

        <div className="border-t pt-3">
          <ExportBackupSection />
        </div>

        <div className="border-t pt-3">
          <ImportBackupSection />
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function ExportBackupSection() {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (exporting) return;
    if (pass.length < 6) {
      toast.error("Passphrase must be at least 6 characters.");
      return;
    }
    if (pass !== confirm) {
      toast.error("Passphrases don't match.");
      return;
    }
    setExporting(true);
    try {
      const { blob, meta } = await exportEncryptedBackup(pass);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedBackupFilename(meta.exportedAt);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${meta.rowCount} row${meta.rowCount === 1 ? "" : "s"}.`);
      setPass("");
      setConfirm("");
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Export local data (encrypted)</p>
        <p className="text-xs text-muted-foreground">
          The file is encrypted with your passphrase using AES-GCM. Without the passphrase the
          export is unrecoverable — there is no reset link.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="password"
          placeholder="Passphrase (min 6 chars)"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="new-password"
          className={INPUT_CLASSES}
        />
        <input
          type="password"
          placeholder="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={INPUT_CLASSES}
        />
      </div>
      <Button variant="outline" onClick={handleExport} disabled={exporting}>
        {exporting ? "Exporting…" : "Export local data (encrypted)"}
      </Button>
    </div>
  );
}

// --------------------------------------------------------------------------

function ImportBackupSection() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [replace, setReplace] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    if (importing) return;
    if (!file) {
      toast.error("Pick a .parlbak file first.");
      return;
    }
    if (pass.length < 6) {
      toast.error("Passphrase must be at least 6 characters.");
      return;
    }
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const meta = await importEncryptedBackup(buf, pass, { replace });
      toast.success(
        `Imported ${meta.rowCount} row${meta.rowCount === 1 ? "" : "s"}. Reload to refresh the app.`,
        {
          action: {
            label: "Reload now",
            onClick: () => window.location.reload(),
          },
        },
      );
      setFile(null);
      setPass("");
      setReplace(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/wrong passphrase/i.test(msg)) {
        toast.error("Wrong passphrase, or the file has been tampered with.");
      } else {
        toast.error(`Import failed: ${msg}`);
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Import an encrypted backup</p>
        <p className="text-xs text-muted-foreground">
          Pick a .parlbak file and enter the same passphrase you used when exporting.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".parlbak,application/octet-stream"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className={cn(
            INPUT_CLASSES,
            "file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:text-foreground",
          )}
        />
        <input
          type="password"
          placeholder="Passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
          className={INPUT_CLASSES}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">Replace existing data</p>
          <p className="text-xs text-muted-foreground">
            Wipes each table before importing. Off = merge (bulk put by primary key).
          </p>
        </div>
        <Switch checked={replace} onCheckedChange={setReplace} />
      </div>
      <Button variant="outline" onClick={handleImport} disabled={importing}>
        {importing ? "Importing…" : "Import backup"}
      </Button>
    </div>
  );
}

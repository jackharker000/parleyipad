import { useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  parseExportFile,
  restoreFromManifest,
  type ParsedExport,
  type RestoreSummary,
} from "@/lib/data-import";
import { stopCloudSync } from "@/lib/sync/engine";
import { cn } from "@/lib/cn";

/**
 * Per-account restore card. Sits between ExportDataCard and DangerZoneCard
 * in SystemTab.
 *
 * Restore is a full replace: every Dexie table is wiped, then the manifest
 * rows are written back. The cloud-synced copy in Firebase isn't touched
 * by this — Firebase keeps its own state. After the user reloads, the new
 * local writes will sync back up under the new-only cursor, so the cloud
 * copy gradually re-aligns with whatever ends up on the device.
 *
 * Sync engine handling:
 *   • Before the restore we call `stopCloudSync()` directly to drop the
 *     Dexie creating/updating hooks. That stops 1000s of restored rows
 *     from spamming the outbox during the transaction.
 *   • After the restore lands we ask the user to reload. The reload
 *     replays the `useCloudSync()` mount under the new local state, and
 *     the engine resumes cleanly.
 *
 * Errors surface inline as a coral band — no auto-reload on failure.
 */
export function ImportDataCard() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState<RestorePhase>("idle");
  const [summary, setSummary] = useState<RestoreSummary | null>(null);

  const reset = () => {
    setFile(null);
    setParsed(null);
    setPassword("");
    setShowPassword(false);
    setError(null);
    setPhase("idle");
    setSummary(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFilePicked = async (picked: File | null) => {
    if (!picked) return;
    setFile(picked);
    setError(null);
    setParsed(null);
    setPassword("");
    setParsing(true);
    try {
      // First pass without a password — if it's plain JSON we'll get a
      // ready manifest; if it's encrypted we'll get the
      // encryptedNeedsPassword stub and the UI flips to "ask password".
      const initial = await parseExportFile(picked);
      setParsed(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const handleUnlock = async () => {
    if (!file) return;
    if (password.trim().length === 0) return;
    setParsing(true);
    setError(null);
    try {
      const next = await parseExportFile(file, password);
      setParsed(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!parsed || parsed.encryptedNeedsPassword) return;
    setError(null);
    setPhase("pausing");
    try {
      // Drop the Dexie sync hooks before the restore so the bulkPut
      // calls below don't fire 1000s of outbox enqueues. The engine is
      // re-installed by the app-layout's `useCloudSync()` on reload.
      stopCloudSync();

      setPhase("wiping");
      // Tiny tick so the "Wiping…" line actually renders before the
      // transaction monopolises the main thread.
      await raf();

      setPhase("restoring");
      const result = await restoreFromManifest(parsed.manifest);

      setSummary(result);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Roll the UI back so the user can see what they were about to do.
      setPhase("idle");
    }
  };

  const busy = parsing || phase === "pausing" || phase === "wiping" || phase === "restoring";

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-5">
      <header className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight text-[var(--ink)]">
          Restore from a file
        </h3>
        <p className="text-sm text-[var(--ink-soft)]">
          Replace this iPad&apos;s data with a Parley export. The current contents will be wiped.
          The cloud-synced copy in your Firebase account is not affected by this — restoring here
          repopulates this device only, and the new local data will then sync up to your account
          from this device&apos;s writes.
        </p>
      </header>

      <div className="mt-4 space-y-3">
        {phase === "done" && summary ? (
          <DoneCard summary={summary} />
        ) : (
          <>
            {!file && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".parley.enc,.parlbak,.json,application/json,application/octet-stream"
                  onChange={(e) => void handleFilePicked(e.target.files?.[0] ?? null)}
                  className="sr-only"
                  id="parley-restore-file"
                />
                <label
                  htmlFor="parley-restore-file"
                  className={cn(
                    "inline-flex cursor-pointer items-center justify-center rounded-full bg-[var(--teal)] px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]",
                    busy && "cursor-not-allowed opacity-60",
                  )}
                >
                  Choose a file
                </label>
              </div>
            )}

            {file && (
              <div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--sand-2)]/40 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--ink)]">{file.name}</p>
                    <p className="text-xs text-[var(--ink-soft)]">
                      {formatBytes(file.size)}
                      {parsed && !parsed.encryptedNeedsPassword ? (
                        <>
                          {" · "}
                          {parsed.fileType === "encrypted" ? "Encrypted (unlocked)" : "Plain JSON"}
                        </>
                      ) : parsed?.encryptedNeedsPassword ? (
                        " · Encrypted"
                      ) : null}
                    </p>
                  </div>
                  {!busy && (
                    <button
                      type="button"
                      onClick={reset}
                      className="text-xs font-medium text-[var(--teal)] hover:underline"
                    >
                      Choose a different file
                    </button>
                  )}
                </div>

                {parsing && <p className="text-xs text-[var(--ink-soft)]">Reading file…</p>}

                {parsed?.encryptedNeedsPassword && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleUnlock();
                    }}
                    className="space-y-2"
                  >
                    <p className="text-sm text-[var(--ink-soft)]">
                      This file is encrypted. Enter the password to unlock it.
                    </p>
                    <label className="block">
                      <span className="sr-only">Password</span>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="current-password"
                          spellCheck={false}
                          disabled={parsing}
                          autoFocus
                          className={cn(
                            "h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 pr-11 text-sm text-[var(--ink)]",
                            "placeholder:text-[var(--ink-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]",
                            "disabled:cursor-not-allowed disabled:opacity-60",
                          )}
                          placeholder="Password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-[var(--ink-soft)] hover:text-[var(--ink)]"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          tabIndex={-1}
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </label>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={parsing || password.trim().length === 0}
                        className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--teal)] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {parsing ? "Unlocking…" : "Unlock"}
                      </button>
                    </div>
                  </form>
                )}

                {parsed && !parsed.encryptedNeedsPassword && phase !== "restoring" && (
                  <ManifestPreview parsed={parsed} />
                )}

                {phase === "pausing" || phase === "wiping" || phase === "restoring" ? (
                  <ProgressBlock phase={phase} parsed={parsed} />
                ) : null}

                {parsed && !parsed.encryptedNeedsPassword && phase === "idle" && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--coral)] px-6 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
                    >
                      Restore
                    </button>
                  </div>
                )}

                {error && (
                  <p className="rounded-md border border-[var(--coral)]/30 bg-[var(--coral-soft)] px-3 py-2 text-xs text-[var(--ink)]">
                    {error}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Replace this iPad's data?"
        description="Wipes every conversation, person, voiceprint, place, event, profile, draft, and cached audio on this device, then writes back the contents of the chosen file. Can't be undone."
        confirmLabel="Restore"
        destructive
        requireTypedText="REPLACE"
        typedTextLabel="Type REPLACE to confirm"
        onConfirm={() => void handleConfirmRestore()}
      />
    </div>
  );
}

// --------------------------------------------------------------------------

type RestorePhase = "idle" | "pausing" | "wiping" | "restoring" | "done";

function ManifestPreview({ parsed }: { parsed: ParsedExport }) {
  const counts = summariseTables(parsed.manifest.tables);
  const exportedAt = parsed.manifest.exportedAt ? new Date(parsed.manifest.exportedAt) : null;
  const accountLabel = parsed.manifest.accountId
    ? `${parsed.manifest.accountId.slice(0, 8)}…`
    : "(unknown)";

  return (
    <div className="space-y-2 rounded-lg border border-[var(--line)] bg-white p-3">
      <PreviewRow label="Exported on">
        {exportedAt ? (
          <span title={exportedAt.toLocaleString()}>
            {formatRelative(exportedAt)} ·{" "}
            <span className="text-[var(--ink-soft)]">{exportedAt.toLocaleString()}</span>
          </span>
        ) : (
          <span className="text-[var(--ink-soft)]">unknown</span>
        )}
      </PreviewRow>
      <PreviewRow label="Account">
        <span className="font-mono text-xs text-[var(--ink-soft)]">{accountLabel}</span>
      </PreviewRow>
      <PreviewRow label="Contents">
        <ul className="ml-1 space-y-0.5 text-xs text-[var(--ink-soft)]">
          {counts.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {counts.lines.length === 0 && <li>(no rows in this export)</li>}
        </ul>
      </PreviewRow>
    </div>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      <div className="text-[var(--ink)]">{children}</div>
    </div>
  );
}

function ProgressBlock({ phase, parsed }: { phase: RestorePhase; parsed: ParsedExport | null }) {
  const totalTables = parsed ? Object.keys(parsed.manifest.tables).length : 0;
  const line =
    phase === "pausing"
      ? "Pausing sync…"
      : phase === "wiping"
        ? "Wiping local data…"
        : phase === "restoring"
          ? totalTables > 0
            ? `Restoring tables (writing ${totalTables} table${totalTables === 1 ? "" : "s"})…`
            : "Restoring tables…"
          : "";
  return (
    <p className="rounded-md border border-[var(--line)] bg-[var(--sand-2)]/60 px-3 py-2 text-xs text-[var(--ink-soft)]">
      {line}
    </p>
  );
}

function DoneCard({ summary }: { summary: RestoreSummary }) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--teal)]/30 bg-[var(--teal-soft,#e8f5f5)] p-4">
      <p className="text-sm font-medium text-[var(--ink)]">Restore complete.</p>
      <p className="text-xs text-[var(--ink-soft)]">
        {summary.rowsWritten} row{summary.rowsWritten === 1 ? "" : "s"} · {summary.blobsWritten}{" "}
        blob{summary.blobsWritten === 1 ? "" : "s"} restored across {summary.tablesRestored} table
        {summary.tablesRestored === 1 ? "" : "s"} in {(summary.durationMs / 1000).toFixed(1)}s.
        Reload now to resume syncing with the new local data.
      </p>
      <div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--teal)] px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Manifest count summary — pretty-prints the load-bearing table sizes.
// --------------------------------------------------------------------------

const PRETTY_TABLE_LABELS: Array<{ key: string; singular: string; plural: string }> = [
  { key: "conversations", singular: "conversation", plural: "conversations" },
  { key: "people", singular: "person", plural: "people" },
  { key: "voiceprintContributions", singular: "voice sample", plural: "voice samples" },
  { key: "transcriptSegments", singular: "transcript segment", plural: "transcript segments" },
];

function summariseTables(tables: Record<string, unknown[]>): { lines: string[] } {
  const lines: string[] = [];
  for (const { key, singular, plural } of PRETTY_TABLE_LABELS) {
    const rows = tables[key];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    lines.push(`${rows.length} ${rows.length === 1 ? singular : plural}`);
  }
  return { lines };
}

// --------------------------------------------------------------------------
// Misc helpers
// --------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(d: Date): string {
  const delta = Date.now() - d.getTime();
  const abs = Math.abs(delta);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h ago`;
  return `${Math.round(abs / 86_400_000)} d ago`;
}

function raf(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

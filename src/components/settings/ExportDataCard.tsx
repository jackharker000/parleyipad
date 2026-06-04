import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { prepareExport, triggerExportDownload } from "@/lib/data-export";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";

/**
 * Per-account local export card. Sits above DangerZoneCard in SystemTab.
 *
 * Encryption is the canonical path (21 May 2026 decision in CLAUDE.md);
 * plain-JSON output is offered as a secondary affordance when the user
 * leaves the password blank.
 *
 * Runs entirely in the browser — manifest construction, base64-encoding of
 * audio Blobs, AES-GCM via WebCrypto, and the `<a download>` click all
 * happen on-device. The data never touches the network.
 */
export function ExportDataCard() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ filename: string; sizeMb: string } | null>(null);

  const reset = () => {
    setOpen(false);
    setPassword("");
    setShowPassword(false);
    setError(null);
  };

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareExport({
        uid: user?.id ?? null,
        password: password,
      });
      triggerExportDownload(prepared);
      const sizeMb = (prepared.blob.size / (1024 * 1024)).toFixed(2);
      setLastResult({ filename: prepared.filename, sizeMb });
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-5">
      <header className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight text-[var(--ink)]">
          Export your data
        </h3>
        <p className="text-sm text-[var(--ink-soft)]">
          Download a copy of everything Parley has on this iPad — your profile, people,
          voiceprints, conversation history, settings. The cloud-synced copy in your Firebase
          account is untouched.
        </p>
      </header>

      <div className="mt-4 space-y-3">
        <p className="text-sm text-[var(--ink-soft)]">
          We recommend setting a password so the file is encrypted at rest. Without a password the
          export is plain JSON.
        </p>

        {!open ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
            className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Prepare export
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleDownload();
            }}
            className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--sand-2)]/40 p-4"
          >
            <label className="block">
              <span className="block text-xs font-medium uppercase tracking-wide text-[var(--ink-soft)]">
                Password (optional)
              </span>
              <div className="relative mt-1.5">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={busy}
                  className={cn(
                    "h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 pr-11 text-sm text-[var(--ink)]",
                    "placeholder:text-[var(--ink-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                  placeholder="Set a password to encrypt"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-[var(--ink-soft)] hover:text-[var(--ink)]"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <span className="mt-1.5 block text-xs text-[var(--ink-soft)]">
                Leave blank for unencrypted JSON. With a password the file is AES-GCM-encrypted
                and can be re-imported into a future build that supports restore.
              </span>
            </label>

            {error && (
              <p className="rounded-md border border-[var(--coral)]/30 bg-[var(--coral-soft)] px-3 py-2 text-xs text-[var(--ink)]">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-[var(--line)] bg-white px-4 text-sm font-medium text-[var(--ink)] hover:bg-[var(--sand-2)]/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--teal)] px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Preparing… (this can take a few seconds for voice samples)" : "Download"}
              </button>
            </div>
          </form>
        )}

        {!open && lastResult && (
          <p className="text-xs text-[var(--ink-soft)]">
            Export downloaded · {lastResult.filename} · {lastResult.sizeMb} MB
          </p>
        )}
      </div>
    </div>
  );
}

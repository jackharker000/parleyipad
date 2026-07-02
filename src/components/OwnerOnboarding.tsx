import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Loader2 } from "lucide-react";
import { getJamesProfile, updateJamesProfile, needsOwnerOnboarding } from "@/lib/db";
import { invalidateContextCache } from "@/lib/context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ParleyLogo } from "@/components/ParleyLogo";

/**
 * First-run gate for a fresh account. Parley speaks FOR one person per account,
 * so before the cockpit is usable we need to know who that person is — their
 * name flows into every AI prompt and UI label. Existing accounts already have
 * a name stored (and hydrate it from their cloud backup before this renders),
 * so they skip straight through.
 */
export function OwnerGate({ children }: { children: React.ReactNode }) {
  const profile = useLiveQuery(() => getJamesProfile(), []);

  // Profile is loading from IndexedDB — brief; avoid flashing the cockpit or
  // the onboarding form before we know which one to show.
  if (profile === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (needsOwnerOnboarding(profile)) {
    return <OwnerSetup />;
  }

  return <>{children}</>;
}

function OwnerSetup() {
  const [name, setName] = useState("");
  const [communication, setCommunication] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await updateJamesProfile({
        display_name: trimmed,
        communication_style: communication.trim() || undefined,
      });
      // Suggestion/expand prompts cache the profile block — drop it so the new
      // name takes effect immediately.
      invalidateContextCache();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-5 flex items-center gap-3">
          <ParleyLogo className="size-10 shrink-0" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Welcome to Parley</h1>
            <p className="text-sm text-muted-foreground">Let's set up whose voice this is.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="owner-name">Your name</Label>
            <Input
              id="owner-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sarah"
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Parley speaks for you — this name is how the assistant refers to you.
            </p>
          </div>

          <div>
            <Label htmlFor="owner-comm">
              How you communicate{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="owner-comm"
              value={communication}
              onChange={(e) => setCommunication(e.target.value)}
              placeholder="Anything that helps the assistant understand you — e.g. how you type, words you prefer."
              rows={3}
            />
          </div>

          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
            {busy ? "Setting up…" : "Get started"}
          </Button>
          <p className="text-xs text-muted-foreground">
            You can add more about yourself, your people, and your voice anytime in Settings.
          </p>
        </form>
      </Card>
    </main>
  );
}

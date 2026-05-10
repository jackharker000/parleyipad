import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LogOut, Cloud, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { signOutAndClear } from "@/components/AuthGate";
import { flushPush } from "@/lib/cloud-sync";
import { toast } from "sonner";

export function AccountCard() {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function backupNow() {
    setBackingUp(true);
    try {
      await flushPush();
      toast.success("Backed up to the cloud");
    } catch {
      toast.error("Backup failed");
    } finally {
      setBackingUp(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOutAndClear();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Account &amp; cloud backup</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{email ?? "…"}</span>.
            Your data syncs to the cloud automatically — sign in with the same email
            on any other device to see it there.
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button variant="secondary" onClick={backupNow} disabled={backingUp} className="gap-2">
            {backingUp ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
            Back up now
          </Button>
          <Button variant="outline" onClick={handleSignOut} disabled={busy} className="gap-2">
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </div>
    </Card>
  );
}
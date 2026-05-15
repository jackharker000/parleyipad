import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ParleyLogo } from "@/components/ParleyLogo";
import { pullForUser, clearLocal } from "@/lib/cloud-sync";

/**
 * Wraps the whole app. If there's no Supabase session, shows a sign in /
 * sign up screen. Once signed in, pulls the user's cloud backup into local
 * Dexie before rendering children.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Set up listener BEFORE checking the session, per Supabase guidance.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Pull cloud backup whenever the user changes.
  useEffect(() => {
    if (!session?.user?.id) {
      setHydrated(false);
      return;
    }
    let cancelled = false;
    setHydrated(false);
    pullForUser(session.user.id)
      .catch((e) => console.error("Cloud pull failed", e))
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return <AuthScreen />;

  if (!hydrated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <p className="text-sm">Loading your data…</p>
      </div>
    );
  }

  return <>{children}</>;
}

function AuthScreen() {
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const redirectUrl = `${window.location.origin}/`;
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectUrl },
      });
      if (error) {
        toast.error(error.message);
      } else {
        toast.success("Account created — you're signed in");
      }
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
            <h1 className="text-lg font-semibold tracking-tight">Parley</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to sync across all your devices
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "signin" | "signup")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value="signin">
            <form onSubmit={handleSignIn} className="mt-4 space-y-3">
              <div>
                <Label htmlFor="si-email">Email</Label>
                <Input
                  id="si-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="si-pw">Password</Label>
                <Input
                  id="si-pw"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="signup">
            <form onSubmit={handleSignUp} className="mt-4 space-y-3">
              <div>
                <Label htmlFor="su-email">Email</Label>
                <Input
                  id="su-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="su-pw">Password</Label>
                <Input
                  id="su-pw"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  At least 8 characters.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Creating…" : "Create account"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Tip: to share an account between James and a carer, just use the
                same email and password on each device.
              </p>
            </form>
          </TabsContent>
        </Tabs>
      </Card>
    </main>
  );
}

/** Sign out helper exposed for the Settings page. */
export async function signOutAndClear() {
  const { flushPush } = await import("@/lib/cloud-sync");
  try {
    await flushPush();
  } catch {}
  await supabase.auth.signOut();
  await clearLocal();
}
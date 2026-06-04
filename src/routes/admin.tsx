import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  useRouter,
} from "@tanstack/react-router";

import { CommandPalette } from "@/components/admin/CommandPalette";
import { ParleyLogo } from "@/components/ParleyLogo";
import { cn } from "@/lib/cn";
import { signOut, useSession } from "@/lib/auth";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

const NAV: Array<{ to: string; label: string; exact?: boolean }> = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/usage", label: "Usage" },
  { to: "/admin/activity", label: "Activity" },
  { to: "/admin/waitlist", label: "Waitlist" },
];

function AdminLayout() {
  const router = useRouter();
  const { user, loading } = useSession();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.navigate({
        to: "/login",
        search: { redirect: window.location.pathname },
      });
    } else if (!user.is_admin) {
      router.navigate({ to: "/app" });
    }
  }, [loading, user, router]);

  // Global Cmd-K / Ctrl-K opens the user-search palette. Bound on the admin
  // layout so every /admin/* page picks it up automatically.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading || !user || !user.is_admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  async function handleSignOut() {
    await signOut();
    router.navigate({ to: "/login" });
  }

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-3 px-4 py-3">
          <Link to="/admin" className="flex items-center gap-2">
            <ParleyLogo className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">
              Parley <span className="text-xs font-normal text-muted-foreground">admin</span>
            </span>
          </Link>
          <nav className="ml-auto flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                )}
                activeProps={{
                  className: cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium bg-muted text-foreground",
                  ),
                }}
              >
                {item.label}
              </Link>
            ))}
            <div className="ml-2 flex items-center gap-2 border-l border-border pl-2">
              <Link
                to="/app"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Back to app
              </Link>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title="Search users (⌘K)"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--sand-2)] px-2 py-1 text-xs font-mono text-[var(--ink-soft)] hover:bg-[var(--sand)] hover:text-foreground"
              >
                ⌘K
              </button>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {user.email}
              </span>
              <button
                onClick={handleSignOut}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Sign out
              </button>
            </div>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

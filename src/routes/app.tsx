import { useEffect } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  useRouter,
} from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";
import { cn } from "@/lib/cn";
import { drainPendingJobs } from "@/lib/jobs/drain";
import { signOut, useSession } from "@/lib/auth";
import { useCloudSync } from "@/lib/sync/use-cloud-sync";
import { useSettings } from "@/lib/settings";

export const Route = createFileRoute("/app")({
  component: AppLayout,
  // Cockpit UX is intentionally locked — re-add `maximum-scale=1` so the
  // tap targets, mood selector, and speaker panel can't be pinch-zoomed
  // out of alignment. Marketing/auth pages stay zoomable for accessibility.
  head: () => ({
    meta: [
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
      },
    ],
  }),
});

const NAV: Array<{ to: string; label: string; exact?: boolean }> = [
  { to: "/app", label: "Live", exact: true },
  { to: "/app/people", label: "People" },
  { to: "/app/events", label: "Events" },
  { to: "/app/recent", label: "Recent" },
  { to: "/app/helpers", label: "Helpers" },
  { to: "/app/settings", label: "Settings" },
];

function AppLayout() {
  const router = useRouter();
  const { user, loading } = useSession();
  const settings = useSettings();
  // `cloudSyncEnabled` defaults to true (undefined === on, matching the
  // CloudSyncCard reader). Only show the "Sync paused" pill when the user
  // has explicitly turned it off.
  const syncPaused = settings.cloudSyncEnabled === false;

  // Mount the write-behind cloud-sync engine. Starts when the user is
  // signed in and `cloudSyncEnabled` is on (default ON for new
  // accounts); tears down on sign-out or when the user toggles it off
  // in Settings. Status is consumed by the Cloud sync panel.
  useCloudSync();

  useEffect(() => {
    if (!loading && !user) {
      router.navigate({
        to: "/login",
        search: { redirect: window.location.pathname },
      });
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (user) void drainPendingJobs();
  }, [user]);

  if (loading || !user) {
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
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/app" className="flex items-center gap-2">
            <ParleyLogo className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">Parley</span>
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
              {user.is_admin ? (
                <Link
                  to="/admin"
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Admin
                </Link>
              ) : null}
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {user.email}
              </span>
              {syncPaused && (
                <Link
                  to="/app/settings"
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--sand-2)] px-2.5 py-1 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--sand-2)]/80"
                  title="Cloud sync is off for this account. Tap to manage in Settings."
                >
                  Sync paused
                </Link>
              )}
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
    </div>
  );
}

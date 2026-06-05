import { useEffect } from "react";
import { Link, Outlet, createFileRoute, useLocation, useRouter } from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";
import { cn } from "@/lib/cn";
import { drainPendingJobs } from "@/lib/jobs/drain";
import { useSession } from "@/lib/auth";
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
        content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
      },
    ],
  }),
});

// Nav surfaced on /app/* SUB-routes (Recent / Helpers / Settings / etc.)
// so caregivers can hop back to the cockpit. The cockpit itself
// (`/app`) hides this header entirely — Recent/Helpers/Settings live in
// the 120×120 action row, and a competing top nav would just duplicate
// chrome.
const NAV: Array<{ to: string; label: string; exact?: boolean }> = [
  { to: "/app", label: "Live", exact: true },
  { to: "/app/recent", label: "Recent" },
  { to: "/app/helpers", label: "Helpers" },
  { to: "/app/settings", label: "Settings" },
];

function AppLayout() {
  const router = useRouter();
  const location = useLocation();
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

  // Cockpit (/app exactly) renders its own 120×120 action row + status strip
  // — strip the parent's top nav so we don't double-stack chrome. Sync-paused
  // pill + admin link live as a small floating control in the top-right
  // corner of the cockpit so the operator can still hop to /admin without
  // burning a 120-px button slot. Sign out moved into Settings → System →
  // Account (per user request — keeps the cockpit chrome quieter).
  //
  // Sub-routes (/app/recent etc.) keep the conventional top nav as their
  // back-to-Live affordance.
  const isCockpit = location.pathname === "/app" || location.pathname === "/app/";

  return (
    // h-dvh + min-h-0 chain so the cockpit's flex-1 main grid actually
    // fills the viewport (the Suggestions + Live transcript + Speakers
    // panels need a definite parent height to expand into). dvh handles
    // the iPad Safari URL-bar resize without leaving dead space at the
    // bottom of the cockpit.
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {!isCockpit && (
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
                {syncPaused && (
                  <Link
                    to="/app/settings"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--sand-2)] px-2.5 py-1 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--sand-2)]/80"
                    title="Cloud sync is off for this account. Tap to manage in Settings."
                  >
                    Sync paused
                  </Link>
                )}
              </div>
            </nav>
          </div>
        </header>
      )}

      {/* Cockpit-only floating corner — sync-paused pill + admin link.
          Sign out moved to Settings → System → Account so this chrome
          stays quiet during a live conversation. */}
      {isCockpit && (syncPaused || user.is_admin) && (
        <div className="pointer-events-none absolute right-4 top-4 z-30 flex items-center gap-2">
          {syncPaused && (
            <Link
              to="/app/settings"
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--sand-2)] px-2.5 py-1 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--sand-2)]/80"
              title="Cloud sync is off for this account. Tap to manage in Settings."
            >
              Sync paused
            </Link>
          )}
          {user.is_admin ? (
            <Link
              to="/admin"
              className="pointer-events-auto rounded-md bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur hover:bg-muted hover:text-foreground"
            >
              Admin
            </Link>
          ) : null}
        </div>
      )}

      <main className={cn("flex-1 min-h-0", isCockpit && "relative")}>
        <Outlet />
      </main>
    </div>
  );
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";

import { Toaster } from "sonner";

import appCss from "@/styles.css?url";
import { ParleyLogo } from "@/components/ParleyLogo";
import { cn } from "@/lib/cn";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
      },
      { title: "Parley" },
      {
        name: "description",
        content:
          "Parley — a calm, iPad-first AAC reply copilot. Listens, suggests, remembers. Built for James.",
      },
      { name: "theme-color", content: "#222428" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Parley" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/favicon.svg" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex min-h-full flex-col bg-background text-foreground">
        <TopNav />
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}

const NAV: Array<{ to: string; label: string }> = [
  { to: "/", label: "Live" },
  { to: "/people", label: "People" },
  { to: "/events", label: "Events" },
  { to: "/recent", label: "Recent" },
  { to: "/helpers", label: "Helpers" },
  { to: "/settings", label: "Settings" },
  { to: "/spike/speaker-id", label: "Spike" },
];

function TopNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
        <Link to="/" className="flex items-center gap-2">
          <ParleyLogo className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">Parley</span>
        </Link>
        <nav className="ml-auto flex flex-wrap items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
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
        </nav>
      </div>
    </header>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-6xl font-bold">404</h1>
        <p className="mt-2 text-muted-foreground">That page doesn't exist yet.</p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

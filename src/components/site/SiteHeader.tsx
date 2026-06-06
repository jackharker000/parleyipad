import { Link } from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";

const NAV = [
  { to: "/how-it-works", label: "How it works" },
  { to: "/features", label: "Features" },
  { to: "/story", label: "Our story" },
  { to: "/privacy", label: "Privacy" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--sand)]/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-5 py-4">
        <Link to="/" className="flex items-center gap-2">
          <ParleyLogo className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">Parley</span>
        </Link>
        <nav className="ml-6 hidden flex-wrap items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-[var(--ink-soft)] transition-colors hover:bg-[var(--sand-2)] hover:text-[var(--ink)]"
              activeProps={{
                className:
                  "rounded-md px-3 py-1.5 text-sm font-medium bg-[var(--sand-2)] text-[var(--ink)]",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/get-started"
            className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
          >
            Request an invite
          </Link>
        </div>
      </div>
    </header>
  );
}

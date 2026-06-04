import { Link } from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--line)] bg-[var(--sand-2)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-12 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <Link to="/" className="inline-flex items-center gap-2">
            <ParleyLogo className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">Parley</span>
          </Link>
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            An iPad copilot for non-speaking people — so the conversation doesn&apos;t move on
            without you.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm">
          <Link to="/how-it-works" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            How it works
          </Link>
          <Link to="/features" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Features
          </Link>
          <Link to="/story" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Our story
          </Link>
          <Link to="/privacy" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Privacy
          </Link>
          <Link to="/get-started" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Get started
          </Link>
          <Link to="/login" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Log in
          </Link>
        </nav>
      </div>
      <div className="border-t border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-5 text-xs text-[var(--ink-soft)] md:flex-row md:items-center md:justify-between">
          <p>Built with James. Made for everyone whose words deserve a way out.</p>
          <a
            href="mailto:hello@parley.help"
            className="hover:text-[var(--ink)]"
          >
            hello@parley.help
          </a>
        </div>
      </div>
    </footer>
  );
}

import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_marketing/get-started")({
  component: GetStartedPage,
});

type Status = "idle" | "submitting" | "success" | "error";

type WaitlistResponse = {
  ok: boolean;
  error?: string;
};

function GetStartedPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [about, setAbout] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, about }),
      });

      let body: WaitlistResponse | null = null;
      try {
        body = (await response.json()) as WaitlistResponse;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        setStatus("success");
        return;
      }

      setStatus("error");
      setErrorMessage(body?.error ?? "Something went wrong. Please try again in a moment.");
    } catch {
      setStatus("error");
      setErrorMessage("We couldn't reach the server. Check your connection and try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Thank you. We&apos;ve got it.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
          Every request comes to a real person — usually Jack — and we&apos;ll write back within a
          few days. If something about the person Parley would be for is urgent, just reply to the
          email we send and tell us.
        </p>
        <div className="mt-10">
          <Link
            to="/"
            className="text-sm font-semibold text-[var(--teal)] underline underline-offset-4 hover:text-[var(--teal-dark)]"
          >
            Back home
          </Link>
        </div>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
        Tell us who Parley is for.
      </h1>
      <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
        We&apos;re letting people in carefully, a few at a time, so we can set each user up
        properly. Tell us about the person who&apos;d use it — their name&apos;s fine, a sentence
        about them is plenty — and we&apos;ll write back ourselves.
      </p>

      <form onSubmit={handleSubmit} className="mt-12 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="waitlist-name" className="text-sm font-semibold text-[var(--ink)]">
            Your name
          </label>
          <input
            id="waitlist-name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            className="rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-base text-[var(--ink)] shadow-sm transition focus:border-[var(--teal)] focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/30 disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="waitlist-email" className="text-sm font-semibold text-[var(--ink)]">
            Your email
          </label>
          <input
            id="waitlist-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            className="rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-base text-[var(--ink)] shadow-sm transition focus:border-[var(--teal)] focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/30 disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="waitlist-about" className="text-sm font-semibold text-[var(--ink)]">
            Who is Parley for?
          </label>
          <textarea
            id="waitlist-about"
            rows={4}
            value={about}
            onChange={(event) => setAbout(event.target.value)}
            disabled={submitting}
            placeholder="One sentence is plenty — e.g. 'My adult son, who is non-speaking and uses an iPad for everything else.'"
            className="rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-base text-[var(--ink)] shadow-sm transition focus:border-[var(--teal)] focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/30 disabled:opacity-60"
          />
        </div>

        {status === "error" && errorMessage ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--coral)]/40 bg-[var(--coral-soft)] px-4 py-3 text-sm text-[var(--ink)]"
          >
            {errorMessage}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Sending…" : "Request an invite"}
          </button>
          <p className="text-sm text-[var(--ink-soft)]">
            No spam. We&apos;ll only contact you about Parley.
          </p>
        </div>
      </form>
    </div>
  );
}

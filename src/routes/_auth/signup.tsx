import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthError, signUp } from "@/lib/auth";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

export const Route = createFileRoute("/_auth/signup")({
  component: SignupPage,
  head: () => ({
    meta: [
      { title: "Set up Parley" },
      {
        name: "description",
        content:
          "One account per person. Five minutes from here to your first conversation.",
      },
    ],
  }),
});

function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await signUp(email, password);
      router.navigate({ to: "/app" });
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Set up Parley.</h1>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        One account per person. Five minutes from here to your first conversation.
      </p>

      <div className="mt-6 space-y-4">
        <GoogleSignInButton label="Sign up with Google" />
        <Divider />
      </div>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={loading}
          />
        </div>

        {error ? <p className="text-sm text-[var(--coral)] mt-2">{error}</p> : null}

        <Button
          type="submit"
          disabled={loading}
          className="h-11 w-full rounded-full bg-[var(--teal)] text-white hover:bg-[var(--teal-dark)]"
        >
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-[var(--ink-soft)]">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-[var(--teal)] hover:underline">
          Log in.
        </Link>
      </p>
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-[var(--line)]" />
      <span className="text-xs uppercase tracking-wider text-[var(--ink-soft)]">or</span>
      <div className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
}

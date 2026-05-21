import { createFileRoute, Link } from "@tanstack/react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Live cockpit
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Listening will appear here.</h1>
        <p className="max-w-prose text-muted-foreground">
          This is the clean rebuild. The live cockpit (turn-triggered suggestions, streaming TTS,
          AudioWorklet capture) is step&nbsp;3 in the build order. First we need the speaker-ID
          engine to work.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Speaker-ID spike</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              On-device neural speaker embeddings with Silero VAD and a Bayesian context-prior
              matcher. Build and validate this in isolation before wiring it into the live UI.
            </p>
            <Button asChild variant="accent">
              <Link to="/spike/speaker-id">Open spike</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Pick LLM, STT, and TTS providers; manage James's voice clone; tune speaker-ID
              thresholds.
            </p>
            <Button asChild variant="outline">
              <Link to="/settings">Open settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

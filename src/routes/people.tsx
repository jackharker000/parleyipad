import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/Placeholder";

export const Route = createFileRoute("/people")({
  component: PeoplePage,
});

function PeoplePage() {
  return (
    <Placeholder
      title="People"
      subtitle="Roster of people James talks to. Each one carries a voiceprint (enrolled samples averaged into a centroid), a context (locations / events where you'd expect to hear them), and notes for the persona."
      buildOrderStep={4}
    />
  );
}

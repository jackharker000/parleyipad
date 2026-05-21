import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/Placeholder";

export const Route = createFileRoute("/events")({
  component: EventsPage,
});

function EventsPage() {
  return (
    <Placeholder
      title="Events"
      subtitle="Upcoming and recent events. An active event contributes priors to the speaker-ID matcher (which people are likely to be present) and biases suggestion generation toward what James might want to say."
      buildOrderStep={4}
    />
  );
}

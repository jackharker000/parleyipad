import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/Placeholder";

export const Route = createFileRoute("/helpers")({
  component: HelpersPage,
});

function HelpersPage() {
  return (
    <Placeholder
      title="Helpers"
      subtitle="Drafting tools and event-prep assistants. Same provider layer as Live, but uses the smart model for longer-form generation rather than the fast model used for live suggestions."
      buildOrderStep={5}
    />
  );
}

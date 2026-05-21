import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/Placeholder";

export const Route = createFileRoute("/recent")({
  component: RecentPage,
});

function RecentPage() {
  return (
    <Placeholder
      title="Recent"
      subtitle="Past conversations. Each is summarised and indexed for retrieval so future suggestions can call back to what was said."
      buildOrderStep={5}
    />
  );
}

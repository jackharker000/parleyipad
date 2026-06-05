import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Events moved into Settings → Events. Existing bookmarks and external
 * links still hit `/app/events`, so we redirect to the new home rather
 * than 404.
 */
export const Route = createFileRoute("/app/events")({
  beforeLoad: () => {
    throw redirect({
      to: "/app/settings",
      search: { tab: "events" },
      replace: true,
    });
  },
});

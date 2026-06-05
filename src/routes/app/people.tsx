import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * People moved into Settings → People. Existing bookmarks and external
 * links still hit `/app/people`, so we redirect to the new home rather
 * than 404. `beforeLoad` runs server-side too, so this is a clean
 * 308-equivalent on the router level.
 */
export const Route = createFileRoute("/app/people")({
  beforeLoad: () => {
    throw redirect({
      to: "/app/settings",
      search: { tab: "people" },
      replace: true,
    });
  },
});

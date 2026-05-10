import { createFileRoute, redirect } from "@tanstack/react-router";

// Conversation lives on the home page now — redirect any old links.
export const Route = createFileRoute("/conversation/new")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
  component: () => null,
});

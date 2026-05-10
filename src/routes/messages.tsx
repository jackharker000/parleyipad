import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { DraftHelper } from "@/components/DraftHelper";

export const Route = createFileRoute("/messages")({
  component: MessagesPage,
  head: () => ({
    meta: [
      { title: "Messages helper — AAC" },
      {
        name: "description",
        content:
          "Paste an iMessage / SMS and let the AI draft a reply in James's voice.",
      },
    ],
  }),
});

function MessagesPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center gap-3 pb-4">
        <Link
          to="/"
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
          aria-label="Back"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <MessageCircle className="size-6 text-[#34c759]" />
        <h1 className="text-xl font-semibold">Messages helper</h1>
      </header>

      <p className="mb-3 text-sm text-muted-foreground">
        Apple Messages has no web version and can't be opened inside an app.
        Paste the message you received below, type a rough reply, then copy the
        polished version and paste it into Messages on your iPad.
      </p>

      <DraftHelper
        platform="imessage"
        incomingLabel="Message you received"
        incomingPlaceholder="Paste the iMessage / text here…"
        draftLabel="Type roughly — what do you want to reply?"
        draftPlaceholder="e.g. yep on my way 10 min"
        contextPlaceholder="e.g. from his son Jack"
      />
    </main>
  );
}
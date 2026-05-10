import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, Mail, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DraftHelper } from "@/components/DraftHelper";

export const Route = createFileRoute("/email")({
  component: EmailPage,
  head: () => ({
    meta: [
      { title: "Email helper — AAC" },
      {
        name: "description",
        content:
          "Paste an email and let the AI draft a reply in James's voice.",
      },
    ],
  }),
});

function EmailPage() {
  function openGmail() {
    const w = Math.min(720, window.screen.availWidth - 100);
    const h = Math.min(900, window.screen.availHeight - 80);
    const left = window.screen.availWidth - w - 20;
    const top = 40;
    const popup = window.open(
      "https://mail.google.com/",
      "gmail_popup",
      `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) toast.error("Allow popups for this site to open Gmail side-by-side");
  }

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
        <Mail className="size-6 text-[#ea4335]" />
        <h1 className="text-xl font-semibold">Email helper</h1>
        <div className="ml-auto">
          <Button onClick={openGmail} variant="secondary" className="gap-2">
            <ExternalLink className="size-4" /> Open Gmail
          </Button>
        </div>
      </header>

      <p className="mb-3 text-sm text-muted-foreground">
        Gmail can't be embedded inside the app (Google blocks it). Tap{" "}
        <strong>Open Gmail</strong> to open it in a side window, paste the email
        you received below, type a rough reply, and copy the polished version
        back into Gmail. (One-tap send via a Gmail connection can be added later.)
      </p>

      <DraftHelper
        platform="email"
        incomingLabel="Email you received"
        incomingPlaceholder="Paste the email here so the AI knows what you're replying to…"
        draftLabel="Type roughly — what do you want to say?"
        draftPlaceholder="e.g. thx great see u sat 7pm bring wine"
        contextPlaceholder="e.g. from his sister Anna"
      />
    </main>
  );
}
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Facebook, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DraftHelper } from "@/components/DraftHelper";

export const Route = createFileRoute("/facebook")({
  component: FacebookPage,
  head: () => ({
    meta: [
      { title: "Facebook helper — AAC" },
      {
        name: "description",
        content:
          "Type roughly and let the AI turn it into a polished Facebook post in James's voice.",
      },
    ],
  }),
});

type PostType = "status" | "comment" | "reply" | "message";

function FacebookPage() {
  const [postType, setPostType] = useState<PostType>("status");

  function openFacebook() {
    // Open Facebook in a side popup window. Facebook blocks iframe embedding
    // (X-Frame-Options: DENY), so a popup is the most reliable option.
    const w = Math.min(520, window.screen.availWidth - 100);
    const h = Math.min(900, window.screen.availHeight - 80);
    const left = window.screen.availWidth - w - 20;
    const top = 40;
    const popup = window.open(
      "https://www.facebook.com/",
      "facebook_popup",
      `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) toast.error("Allow popups for this site to open Facebook side-by-side");
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
        <Facebook className="size-6 text-[#1877f2]" />
        <h1 className="text-xl font-semibold">Facebook helper</h1>
        <div className="ml-auto">
          <Button onClick={openFacebook} variant="secondary" className="gap-2">
            <ExternalLink className="size-4" /> Open Facebook
          </Button>
        </div>
      </header>

      <p className="mb-3 text-sm text-muted-foreground">
        Facebook can't be embedded inside the app (Facebook blocks it). Tap{" "}
        <strong>Open Facebook</strong> to open it in a side window — then keep
        drafting here and copy each post over.
      </p>

      <DraftHelper
        platform="facebook"
        draftLabel="Type roughly — what do you want to post?"
        draftPlaceholder="e.g. happy bday matt great day sail"
        incomingLabel="Post or comment you're replying to (optional)"
        incomingPlaceholder="Paste the post or comment here…"
        contextPlaceholder="e.g. replying to Matt's photo"
        hideIncoming={postType === "status"}
        extraControls={
          <div>
            <Label className="text-base">Post type</Label>
            <Select value={postType} onValueChange={(v) => setPostType(v as PostType)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="status">Status update</SelectItem>
                <SelectItem value="comment">Comment on a post</SelectItem>
                <SelectItem value="reply">Reply to a comment</SelectItem>
                <SelectItem value="message">Messenger message</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />
    </main>
  );
}
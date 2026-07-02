import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Mail,
  MessageCircle,
  Facebook,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DraftHelper } from "@/components/DraftHelper";

export const Route = createFileRoute("/helpers")({
  component: HelpersPage,
  head: () => ({
    meta: [
      { title: "Reply helpers — Parley" },
      {
        name: "description",
        content:
          "Draft messages, emails and Facebook posts in your voice — copy and paste into the app of your choice.",
      },
    ],
  }),
});

type PostType = "status" | "comment" | "reply" | "message";

function openPopup(url: string, label: string, width = 520) {
  const w = Math.min(width, window.screen.availWidth - 100);
  const h = Math.min(900, window.screen.availHeight - 80);
  const left = window.screen.availWidth - w - 20;
  const top = 40;
  const popup = window.open(
    url,
    `${label}_popup`,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
  );
  if (!popup) toast.error(`Allow popups for this site to open ${label} side-by-side`);
}

function HelpersPage() {
  const [postType, setPostType] = useState<PostType>("status");

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <Tabs defaultValue="messages">
          <div className="mb-4 flex items-center gap-3">
            <Link
              to="/"
              aria-label="Back to home"
              className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
            >
              <ArrowLeft className="size-5" />
            </Link>
            <TabsList className="h-12 flex-1 justify-start gap-1 bg-secondary/50">
              <TabsTrigger value="messages" className="h-10 gap-2 px-4 text-base">
                <MessageCircle className="size-4 text-[#34c759]" /> Messages
              </TabsTrigger>
              <TabsTrigger value="email" className="h-10 gap-2 px-4 text-base">
                <Mail className="size-4 text-[#ea4335]" /> Email
              </TabsTrigger>
              <TabsTrigger value="facebook" className="h-10 gap-2 px-4 text-base">
                <Facebook className="size-4 text-[#1877f2]" /> Facebook
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="messages">
            <p className="mb-3 text-sm text-muted-foreground">
              Apple Messages has no web version. Paste the message you received
              below, type a rough reply, then copy the polished version and
              paste it into Messages on your iPad.
            </p>
            <DraftHelper
              platform="imessage"
              incomingLabel="Message you received"
              incomingPlaceholder="Paste the iMessage / text here…"
              draftLabel="Type roughly — what do you want to reply?"
              draftPlaceholder="e.g. yep on my way 10 min"
              contextPlaceholder="e.g. from his son Jack"
            />
          </TabsContent>

          <TabsContent value="email">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Gmail can't be embedded. Open it in a side window, then draft
                here and copy across.
              </p>
              <Button
                onClick={() => openPopup("https://mail.google.com/", "gmail", 720)}
                variant="secondary"
                className="gap-2 shrink-0"
              >
                <ExternalLink className="size-4" /> Open Gmail
              </Button>
            </div>
            <DraftHelper
              platform="email"
              incomingLabel="Email you received"
              incomingPlaceholder="Paste the email here so the AI knows what you're replying to…"
              draftLabel="Type roughly — what do you want to say?"
              draftPlaceholder="e.g. thx great see u sat 7pm bring wine"
              contextPlaceholder="e.g. from his sister Anna"
            />
          </TabsContent>

          <TabsContent value="facebook">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Facebook can't be embedded. Open it in a side window, then draft
                here and copy across.
              </p>
              <Button
                onClick={() => openPopup("https://www.facebook.com/", "facebook")}
                variant="secondary"
                className="gap-2 shrink-0"
              >
                <ExternalLink className="size-4" /> Open Facebook
              </Button>
            </div>
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
                  <Select
                    value={postType}
                    onValueChange={(v) => setPostType(v as PostType)}
                  >
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
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
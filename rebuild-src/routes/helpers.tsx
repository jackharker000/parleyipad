import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Mail, MessageCircle, Facebook, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DraftHelper } from "@/components/DraftHelper";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/helpers")({
  component: HelpersPage,
  head: () => ({
    meta: [
      { title: "Reply helpers — Parley" },
      {
        name: "description",
        content:
          "Draft messages, emails and Facebook posts in James's voice — copy and paste into the app of your choice.",
      },
    ],
  }),
});

type Tab = "messages" | "email" | "facebook";
type PostType = "status" | "comment" | "reply" | "message";

const TABS: Array<{ id: Tab; label: string; icon: typeof MessageCircle; iconColor: string }> = [
  { id: "messages", label: "Messages", icon: MessageCircle, iconColor: "text-[#34c759]" },
  { id: "email", label: "Email", icon: Mail, iconColor: "text-[#ea4335]" },
  { id: "facebook", label: "Facebook", icon: Facebook, iconColor: "text-[#1877f2]" },
];

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
  const [tab, setTab] = useState<Tab>("messages");
  const [postType, setPostType] = useState<PostType>("status");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center gap-3">
        <Link
          to="/"
          aria-label="Back to home"
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <div
          role="tablist"
          aria-label="Reply helper channel"
          className="flex h-12 flex-1 items-center gap-1 rounded-lg bg-secondary/50 p-1"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex h-10 flex-1 items-center justify-center gap-2 rounded-md px-4 text-base font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", t.iconColor)} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {tab === "messages" && (
        <div>
          <p className="mb-3 text-sm text-muted-foreground">
            Apple Messages has no web version. Paste the message you received below, type a rough
            reply, then copy the polished version and paste it into Messages on your iPad.
          </p>
          <DraftHelper
            platform="imessage"
            incomingLabel="Message you received"
            incomingPlaceholder="Paste the iMessage / text here…"
            draftLabel="Type roughly — what do you want to reply?"
            draftPlaceholder="e.g. yep on my way 10 min"
            contextPlaceholder="e.g. from his son Jack"
          />
        </div>
      )}

      {tab === "email" && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Gmail can't be embedded. Open it in a side window, then draft here and copy across.
            </p>
            <Button
              onClick={() => openPopup("https://mail.google.com/", "gmail", 720)}
              variant="outline"
              className="shrink-0 gap-2"
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
        </div>
      )}

      {tab === "facebook" && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Facebook can't be embedded. Open it in a side window, then draft here and copy across.
            </p>
            <Button
              onClick={() => openPopup("https://www.facebook.com/", "facebook")}
              variant="outline"
              className="shrink-0 gap-2"
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
                <label htmlFor="dh-fb-posttype" className="block text-base font-medium">
                  Post type
                </label>
                <select
                  id="dh-fb-posttype"
                  value={postType}
                  onChange={(e) => setPostType(e.target.value as PostType)}
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <option value="status">Status update</option>
                  <option value="comment">Comment on a post</option>
                  <option value="reply">Reply to a comment</option>
                  <option value="message">Messenger message</option>
                </select>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}

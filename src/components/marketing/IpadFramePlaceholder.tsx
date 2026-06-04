import { ImageIcon, PlayCircle } from "lucide-react";

import { cn } from "@/lib/cn";

type Props = {
  label: string;
  aspect?: "[4/3]" | "video" | "[3/2]" | "square";
  kind?: "image" | "video";
  className?: string;
};

const ASPECT_CLASS: Record<NonNullable<Props["aspect"]>, string> = {
  "[4/3]": "aspect-[4/3]",
  video: "aspect-video",
  "[3/2]": "aspect-[3/2]",
  square: "aspect-square",
};

export function IpadFramePlaceholder({
  label,
  aspect = "[4/3]",
  kind,
  className,
}: Props) {
  const isVideo = kind === "video" || /video/i.test(label);
  const Icon = isVideo ? PlayCircle : ImageIcon;

  return (
    <div
      className={cn(
        "rounded-[28px] bg-[var(--ink)] p-3 shadow-2xl shadow-[var(--ink)]/15",
        className,
      )}
    >
      <div
        className={cn(
          "flex w-full items-center justify-center rounded-2xl bg-[var(--sand-2)] p-6 text-center",
          ASPECT_CLASS[aspect],
        )}
      >
        <div className="flex max-w-sm flex-col items-center gap-3">
          <Icon
            className="h-10 w-10 text-[var(--ink-soft)]/60"
            strokeWidth={1.5}
          />
          <p className="text-sm text-[var(--ink-soft)]">{label}</p>
        </div>
      </div>
    </div>
  );
}

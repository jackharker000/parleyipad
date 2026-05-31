import { useState } from "react";

import { cn } from "@/lib/cn";
import type { Person, TranscriptSegment } from "@/lib/db";

/**
 * Read-mostly transcript renderer used in the Recent drill-in. When
 * `onReassign` is supplied, tapping a row reveals a chip list of all
 * roster people — selecting one (or "Unknown") calls
 * `onReassign(segmentId, personId | null)`. This mirrors the cockpit's
 * tap-to-reassign affordance in `src/routes/index.tsx`.
 *
 * The Recent page currently passes `onReassign={undefined}` — post-conversation
 * reassignment (with the offline re-cluster + voiceprint rebuild loop) is a
 * separate workstream. Until then the rows are pure read-only.
 */
export function TranscriptView({
  segments,
  peopleById,
  jamesName,
  onReassign,
}: {
  segments: TranscriptSegment[];
  peopleById: Map<string, Person>;
  jamesName: string;
  onReassign?: (segmentId: string, personId: string | null) => void;
}) {
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  const rosterPeople = Array.from(peopleById.values());

  if (segments.length === 0) {
    return <p className="text-sm italic text-muted-foreground">No transcript recorded.</p>;
  }

  return (
    <ul className="space-y-2 text-sm">
      {segments.map((seg) => {
        const canReassign = !!onReassign && seg.speakerKind === "other";
        const isReassigning = reassigningId === seg.id;
        const speakerName =
          seg.speakerKind === "self"
            ? jamesName
            : (seg.personId && peopleById.get(seg.personId)?.name) || seg.speakerLabel || "Unknown";
        const isPartial = seg.status === "partial";

        return (
          <li key={seg.id}>
            <button
              type="button"
              onClick={() => canReassign && setReassigningId(isReassigning ? null : seg.id)}
              disabled={!canReassign}
              className={cn(
                "w-full rounded px-1 py-0.5 text-left leading-snug transition-colors",
                canReassign && "hover:bg-muted",
                isReassigning && "bg-muted ring-1 ring-accent/40",
              )}
              title={canReassign ? "Tap to reassign who said this" : undefined}
            >
              <span className="mr-2 text-xs font-semibold text-muted-foreground">
                {speakerName}
              </span>
              <span className={cn("text-foreground", isPartial && "italic text-muted-foreground")}>
                {seg.text}
              </span>
            </button>
            {isReassigning && canReassign && onReassign && (
              <div className="mt-1 flex flex-wrap items-center gap-1 pl-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Who said this?
                </span>
                {rosterPeople.length === 0 ? (
                  <span className="text-[10px] italic text-muted-foreground">
                    No people available
                  </span>
                ) : (
                  rosterPeople.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onReassign(seg.id, p.id);
                        setReassigningId(null);
                      }}
                      className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] hover:bg-accent hover:text-accent-foreground"
                    >
                      {p.name}
                    </button>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => {
                    onReassign(seg.id, null);
                    setReassigningId(null);
                  }}
                  className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  Unknown
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

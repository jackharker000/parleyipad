import { Card, CardContent } from "@/components/ui/card";
import type { Conversation, EventRecord, PendingJob, Person, Place } from "@/lib/db";
import { cn } from "@/lib/cn";

const HIGHLIGHT_PREVIEW_LIMIT = 3;

/**
 * Format a wall-clock timestamp the way the screen mockups do: short
 * weekday + day + month, time-of-day, then a relative-time tag in
 * parens. Inline so we don't pull in date-fns/dayjs for one helper
 * (see CLAUDE.md — keep dependencies tight).
 */
function formatConversationDate(ts: number, now: number): string {
  const d = new Date(ts);
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const day = d.getDate();
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 || 12;
  const timeStr = minutes === "00" ? `${h12}${meridiem}` : `${h12}:${minutes}${meridiem}`;
  return `${weekday} ${day} ${month}, ${timeStr} — ${formatRelative(ts, now)}`;
}

function formatRelative(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "in the future";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const yr = Math.round(month / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

export function RecentList({
  conversations,
  peopleById,
  placesById,
  eventsById,
  pendingByConversationId,
  onSelect,
}: {
  conversations: Conversation[];
  peopleById: Map<string, Person>;
  placesById: Map<string, Place>;
  eventsById: Map<string, EventRecord>;
  pendingByConversationId: Map<string, PendingJob[]>;
  onSelect: (conversationId: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm italic text-muted-foreground">
          No conversations match your filters.
        </CardContent>
      </Card>
    );
  }

  // Render-time "now" so relative labels are stable per render.
  const now = Date.now();

  return (
    <ul className="space-y-2">
      {conversations.map((conv) => {
        const place = conv.placeId ? placesById.get(conv.placeId) : undefined;
        const event = conv.eventId ? eventsById.get(conv.eventId) : undefined;
        const personNames = (conv.personIds ?? [])
          .map((id) => peopleById.get(id)?.name)
          .filter((n): n is string => !!n);
        const summaryPending = (pendingByConversationId.get(conv.id) ?? []).some(
          (j) => j.type === "summariseConversation" && j.status !== "done",
        );
        const previewHighlights = (conv.highlights ?? []).slice(0, HIGHLIGHT_PREVIEW_LIMIT);

        return (
          <li key={conv.id}>
            <Card
              role="button"
              tabIndex={0}
              onClick={() => onSelect(conv.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(conv.id);
                }
              }}
              className="cursor-pointer transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    {formatConversationDate(conv.startedAt, now)}
                  </div>
                  {summaryPending && <PendingPill />}
                </div>

                {(place || event || personNames.length > 0) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {place && <span>{place.name}</span>}
                    {event && (
                      <span>
                        {place ? "· " : ""}
                        {event.name}
                      </span>
                    )}
                    {personNames.length > 0 && (
                      <span>
                        {place || event ? "· " : ""}
                        {personNames.join(", ")}
                      </span>
                    )}
                  </div>
                )}

                {conv.summary ? (
                  <p className="line-clamp-3 text-sm leading-snug text-foreground">
                    {conv.summary}
                  </p>
                ) : (
                  <p className="text-xs italic text-muted-foreground">
                    {conv.endedAt
                      ? summaryPending
                        ? "Summary pending…"
                        : "No summary"
                      : "In progress…"}
                  </p>
                )}

                {previewHighlights.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                    {previewHighlights.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function PendingPill() {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        "bg-amber-500/20 text-amber-800",
      )}
      title="Background summary still running"
    >
      Pending
    </span>
  );
}

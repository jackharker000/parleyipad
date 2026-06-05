import { useMemo, useState } from "react";
import { HelpCircle, Merge, UserPlus } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Candidate } from "@/lib/audio/matcher";
import type { Person } from "@/lib/db";
import type { LiveTranscriptSegment } from "@/lib/conversation";

/**
 * The cockpit's right-side speaker roster panel. Ported from
 * claude/tier3-engine-wins to replace the older inline SpeakerColumn
 * (which showed only the top-1 candidate and a flat alt list) with the
 * richer roster view: one row per person in the active conversation,
 * each with a named confidence band, a per-row Confirm / Reject action
 * when borderline, and a "hasn't spoken yet" status for declared
 * participants who haven't been heard yet.
 *
 * The panel never makes its own engine decisions — it reads candidates +
 * the transcript and renders state. All confirm / reassign / merge actions
 * route back to the existing LiveConversation handlers via the props the
 * cockpit already plumbs (onAddToRoster / onAskWhoIsThis / onForceNew /
 * onMergeInto / onConfirmTop / onClearTop).
 */

type RowStatus = "confirmed" | "suggested" | "maybe" | "not_yet_heard";

type Row = {
  personId: string | null;
  name: string;
  status: RowStatus;
  posterior?: number;
  similarity?: number;
};

const CONFIDENCE_BAND_THRESHOLDS = {
  soundsLike: 0.85,
  probably: 0.7,
} as const;

const BORDERLINE_GAP = 0.08;
const BORDERLINE_TOP_SIM = 0.7;

function bandFor(sim?: number): string | null {
  if (sim === undefined) return null;
  if (sim >= CONFIDENCE_BAND_THRESHOLDS.soundsLike) return "Sounds like";
  if (sim >= CONFIDENCE_BAND_THRESHOLDS.probably) return "Probably";
  return "Maybe";
}

export function SpeakerPanel({
  candidates,
  transcript,
  acceptThreshold,
  people,
  selectedPersonIds,
  isLive,
  onAddToRoster,
  onAskWhoIsThis,
  onForceNew,
  onMergeInto,
  onConfirmTop,
  onClearTop,
}: {
  candidates: Candidate[];
  transcript: LiveTranscriptSegment[];
  acceptThreshold: number;
  people: Person[];
  selectedPersonIds: string[];
  isLive: boolean;
  onAddToRoster: (personId: string) => void;
  onAskWhoIsThis: () => void;
  onForceNew: () => void;
  onMergeInto: (fromPersonId: string | undefined, toPersonId: string) => void;
  onConfirmTop: (personId: string) => void;
  onClearTop: (personId: string) => void;
}) {
  const top = candidates[0];
  const second = candidates[1];
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showMergePicker, setShowMergePicker] = useState(false);

  const offRoster = useMemo(
    () => people.filter((p) => !selectedPersonIds.includes(p.id)),
    [people, selectedPersonIds],
  );
  const rosterPeople = useMemo(
    () => people.filter((p) => selectedPersonIds.includes(p.id)),
    [people, selectedPersonIds],
  );

  // Compose one row per person we care about: every declared participant
  // (closed-set) plus every personId that has actually spoken in the
  // transcript. Ranking: top live candidate first, then other heard
  // speakers, then declared-but-not-yet-heard, then Unknown if it appears.
  const rows = useMemo<Row[]>(() => {
    const heardOther = new Set<string>();
    for (const seg of transcript) {
      if (seg.speakerKind === "other" && seg.personId) heardOther.add(seg.personId);
    }

    const byPersonId = new Map<string, Row>();

    // Live candidates first — they carry the matcher's current verdict and
    // the confidence numbers users want to see.
    candidates.forEach((c, i) => {
      if (!c.personId) return;
      const person = people.find((p) => p.id === c.personId);
      if (!person) return;
      const isTop = i === 0;
      const gap = top && second ? top.posterior - second.posterior : 1;
      const borderline =
        isTop && gap < BORDERLINE_GAP && (top.similarity ?? 0) < BORDERLINE_TOP_SIM;
      let status: RowStatus;
      if (isTop) {
        if (c.posterior >= acceptThreshold) status = "confirmed";
        else if (borderline) status = "maybe";
        else status = "suggested";
      } else if (borderline) {
        status = "maybe";
      } else {
        status = "suggested";
      }
      byPersonId.set(c.personId, {
        personId: c.personId,
        name: person.name,
        status,
        posterior: c.posterior,
        similarity: c.similarity,
      });
    });

    // Declared participants who haven't appeared as a candidate yet — show
    // them as "not yet heard" so James can see who's still expected.
    for (const p of rosterPeople) {
      if (byPersonId.has(p.id)) continue;
      byPersonId.set(p.id, {
        personId: p.id,
        name: p.name,
        status: heardOther.has(p.id) ? "suggested" : "not_yet_heard",
      });
    }

    // Already-heard people who weren't declared and aren't in current
    // candidates either — still worth surfacing so the user can see them.
    for (const seg of transcript) {
      if (seg.speakerKind !== "other") continue;
      if (!seg.personId || byPersonId.has(seg.personId)) continue;
      const person = people.find((p) => p.id === seg.personId);
      if (!person) continue;
      byPersonId.set(seg.personId, {
        personId: seg.personId,
        name: person.name,
        status: "suggested",
      });
    }

    return Array.from(byPersonId.values()).sort((a, b) => {
      const rank = (s: RowStatus): number =>
        s === "confirmed" ? 0 : s === "maybe" ? 1 : s === "suggested" ? 2 : 3;
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      return (b.posterior ?? -1) - (a.posterior ?? -1);
    });
  }, [candidates, top, second, people, rosterPeople, transcript, acceptThreshold]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Speakers
        </span>
        {isLive && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onAskWhoIsThis}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title="Speak 'Sorry, who am I speaking with?' and hold the next utterance for manual attribution"
            >
              <HelpCircle className="h-3 w-3" />
              Ask
            </button>
            <button
              type="button"
              onClick={onForceNew}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title="Treat the next utterance as a new speaker"
            >
              <UserPlus className="h-3 w-3" />
              New
            </button>
            {top?.personId && rosterPeople.length > 1 && (
              <button
                type="button"
                onClick={() => setShowMergePicker((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                title="Merge this cluster into another person"
              >
                <Merge className="h-3 w-3" />
                Merge
              </button>
            )}
            {offRoster.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAddPicker((v) => !v)}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                title="Add a person who walked in late"
              >
                + Add
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isLive ? "Listening…" : "Voices will appear here as they speak."}
          </p>
        ) : (
          rows.map((row) => (
            <SpeakerRow
              key={row.personId ?? "_unknown"}
              row={row}
              isTop={!!top && top.personId === row.personId}
              onConfirm={() => row.personId && onConfirmTop(row.personId)}
              onReject={() => row.personId && onClearTop(row.personId)}
            />
          ))
        )}

        {/* Borderline second-place row — shows the alternative the matcher
            could not decisively rule out. Mirrors the legacy "Maybe X or
            Maybe Y" feel without committing to either. */}
        {top &&
          second &&
          top.posterior - second.posterior < BORDERLINE_GAP &&
          (top.similarity ?? 0) < BORDERLINE_TOP_SIM &&
          second.personId && (
            <p className="text-xs italic text-muted-foreground">
              Could also be {second.name} ({(second.posterior * 100).toFixed(0)}%).
            </p>
          )}

        {showAddPicker && offRoster.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 rounded-md border border-dashed border-border bg-muted/30 p-2">
            <span className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">
              Add to room
            </span>
            {offRoster.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onAddToRoster(p.id);
                  setShowAddPicker(false);
                }}
                className="rounded-full border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        {showMergePicker && top?.personId && rosterPeople.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1 rounded-md border border-dashed border-border bg-muted/30 p-2">
            <span className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">
              Merge {top.name} into…
            </span>
            {rosterPeople
              .filter((p) => p.id !== top.personId)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onMergeInto(top.personId ?? undefined, p.id);
                    setShowMergePicker(false);
                  }}
                  className="rounded-full border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {p.name}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SpeakerRow({
  row,
  isTop,
  onConfirm,
  onReject,
}: {
  row: Row;
  isTop: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const band = bandFor(row.similarity);
  const showActions = isTop && (row.status === "suggested" || row.status === "maybe");

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{row.name}</span>
        <StatusPill status={row.status} />
      </div>
      {(row.posterior !== undefined || band) && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {band && <span>{band}</span>}
          {band && row.posterior !== undefined && <span> · </span>}
          {row.posterior !== undefined && (
            <span>{(row.posterior * 100).toFixed(0)}% posterior</span>
          )}
          {row.similarity !== undefined && <span> · sim {(row.similarity * 100).toFixed(0)}%</span>}
        </p>
      )}
      {row.status === "not_yet_heard" && (
        <p className="mt-0.5 text-xs italic text-muted-foreground">Hasn't spoken yet.</p>
      )}
      {showActions && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={onReject}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Not them
          </button>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RowStatus }) {
  const cls =
    status === "confirmed"
      ? "bg-accent text-accent-foreground"
      : status === "maybe"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "suggested"
          ? "bg-muted text-foreground"
          : "bg-muted/50 text-muted-foreground";
  const label =
    status === "confirmed"
      ? "confirmed"
      : status === "maybe"
        ? "maybe"
        : status === "suggested"
          ? "suggested"
          : "not yet heard";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>{label}</span>;
}

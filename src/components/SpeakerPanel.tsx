import { useEffect, useRef, useState, useMemo } from "react";
import { Check, X, HelpCircle, Mic2, Pencil, GitMerge, UserPlus, Brain, UserCheck } from "lucide-react";
import type { Person, TranscriptSegment } from "@/lib/db";

export type SuggestedName = {
  name: string;
  source: "self-intro" | "ask-reply" | "manual" | "context-ai";
};

export type ClusterStatus =
  | { kind: "unknown"; suggestions?: SuggestedName[]; excludedPersonIds?: string[] }
  | {
      kind: "suggested";
      personId: string;
      sim: number;
      suggestions?: SuggestedName[];
      excludedPersonIds?: string[];
    }
  | { kind: "confirmed"; personId: string };

export type ClusterRow = {
  label: string;
  count: number;
  status: ClusterStatus;
};

const JAMES_SELF_LABEL = "__james_self__";

export function SpeakerPanel({
  segments,
  partial,
  clusters,
  people,
  participantIds,
  participantCount,
  onConfirmKnown,
  onRejectSuggestion,
  onConfirmNew,
  onAskName,
  onClearConfirmed,
  onMerge,
  onForceNew,
  onReassignSegment,
}: {
  segments: TranscriptSegment[];
  partial: string;
  clusters: ClusterRow[];
  people: Person[];
  /** IDs of all people declared as "in the room" for this conversation. */
  participantIds?: string[];
  participantCount?: number;
  onConfirmKnown: (label: string, personId: string) => void;
  onRejectSuggestion: (label: string) => void;
  onConfirmNew: (label: string, name: string) => void;
  onAskName: (label?: string) => void;
  onClearConfirmed: (label: string) => void;
  onMerge: (fromLabel: string, toLabel: string) => void;
  onForceNew: () => void;
  onReassignSegment?: (segmentId: string, personId: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const [reassigningSegId, setReassigningSegId] = useState<string | null>(null);

  // Track whether the user is at the bottom so manual scroll-up isn't stolen.
  function onTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = fromBottom < 40;
  }

  // Auto-scroll on any transcript update — new segments, partial text growing,
  // or the last segment's text being edited (e.g. STT finalisation). rAF
  // ensures the new content has painted before we measure scrollHeight.
  const lastSeg = segments[segments.length - 1];
  const lastSegSig = lastSeg ? `${lastSeg.id}:${lastSeg.text.length}` : "";
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = transcriptRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [segments.length, lastSegSig, partial]);

  useEffect(() => {
    // A new conversation (transcript cleared) → resume sticking to the bottom,
    // even if the user had scrolled up in the previous one.
    if (segments.length === 0) {
      stickToBottomRef.current = true;
      return;
    }
    // Dismiss reassign popover when new transcript arrives, so it doesn't
    // block the latest lines. User can tap again if they need to correct it.
    setReassigningSegId(null);
  }, [segments.length]);

  const peopleById = new Map(people.map((p) => [p.id, p] as const));
  const tail = segments.slice(-30);

  // People available in the reassign popover: James ("Me") always first, then
  // declared participants + anyone already confirmed to a cluster. Deduplicated.
  const reassignOptions = useMemo(() => {
    const confirmedPeople = clusters
      .filter((c) => c.status.kind === "confirmed")
      .map((c) => people.find((p) => p.id === (c.status as any).personId))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    const declaredPeople = (participantIds ?? [])
      .map((pid) => people.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    // Find the "James" cluster (the confirmed cluster for __james_self__) so
    // the user can correct a mis-attributed line back to themselves.
    const jamesCluster = clusters.find(
      (c) => c.status.kind === "confirmed" && c.label === JAMES_SELF_LABEL,
    );
    const jamesPerson = jamesCluster
      ? people.find((p) => p.id === (jamesCluster.status as any).personId)
      : undefined;
    const all = [
      // Put James's person first if found; otherwise a synthetic placeholder
      // so "Me" is always an option even before James is confirmed.
      ...(jamesPerson ? [jamesPerson] : []),
      ...confirmedPeople,
      ...declaredPeople,
    ];
    const seen = new Set<string>();
    return all.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [clusters, people, participantIds]);

  function nameForSegment(s: TranscriptSegment): string {
    // Per-segment override from user reassignment wins over cluster mapping.
    if (s.person_id) {
      return peopleById.get(s.person_id)?.name ?? s.speaker_label;
    }
    const label = s.speaker_label;
    if (label === JAMES_SELF_LABEL) return "Me";
    const c = clusters.find((c) => c.label === label);
    if (c?.status.kind === "confirmed") {
      return peopleById.get(c.status.personId)?.name ?? label;
    }
    if (c) return label;
    // Cluster is hidden (pending hysteresis) — show a neutral marker so the
    // transcript line still has a speaker indicator. When the cluster is
    // eventually promoted (or merged into a confirmed speaker) the proper
    // name appears retroactively.
    return "…";
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col gap-2">
      {/* Live transcript */}
      <div className="flex min-h-0 flex-[3] flex-col rounded-2xl border border-border bg-card/40">
        <div className="border-b border-border px-3 py-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live transcript
          </h2>
        </div>
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 text-sm"
        >
          {tail.length === 0 && !partial && (
            <p className="italic text-muted-foreground">Listening…</p>
          )}
          {tail.map((s) => {
            const isReassigning = reassigningSegId === s.id;
            return (
              <div key={s.id}>
                <button
                  onClick={() =>
                    setReassigningSegId(isReassigning ? null : s.id)
                  }
                  className={`w-full rounded px-1 py-0.5 text-left leading-snug transition-colors hover:bg-secondary/50 active:bg-secondary/80 ${isReassigning ? "bg-secondary/60 ring-1 ring-primary/30" : ""}`}
                  title="Tap to reassign who said this"
                >
                  <span className="mr-2 text-xs font-medium text-muted-foreground">
                    {nameForSegment(s)}
                  </span>
                  {s.text}
                </button>
                {isReassigning && onReassignSegment && (
                  <div className="my-0.5 flex flex-wrap items-center gap-1 pl-2">
                    <span className="text-[10px] text-muted-foreground">
                      <UserCheck className="inline size-3 mr-0.5" />
                      Who said this?
                    </span>
                    {reassignOptions.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          onReassignSegment(s.id, p.id);
                          setReassigningSegId(null);
                        }}
                        className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium hover:bg-primary/25 active:bg-primary/40"
                      >
                        {p.name}
                      </button>
                    ))}
                    {reassignOptions.length === 0 && (
                      <span className="text-[10px] italic text-muted-foreground">
                        Confirm a speaker first using the roster below
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {partial && (
            <div className="italic leading-snug text-muted-foreground">
              {partial}
            </div>
          )}
        </div>
      </div>

      {/* Speaker roster */}
      <div className="flex min-h-0 flex-[2] flex-col rounded-2xl border border-border bg-card/40">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Speakers
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onForceNew}
              title="Next utterance will start a new speaker cluster"
              className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs text-foreground hover:bg-secondary"
            >
              <UserPlus className="size-3" /> New
            </button>
            <button
              onClick={() => onAskName()}
              title="Ask the room to introduce themselves"
              className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs text-foreground hover:bg-secondary"
            >
              <HelpCircle className="size-3" /> Ask
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {participantCount != null && participantCount > 0 && clusters.length > participantCount && (
            <div className="rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-2 py-1.5 text-xs text-foreground">
              You declared {participantCount} {participantCount === 1 ? "person" : "people"} — confirm who's who to improve accuracy.
            </div>
          )}
          {/* Participants declared for this conversation who haven't spoken yet */}
          {(participantIds ?? [])
            .filter((pid) => {
              // Hide once they're confirmed or visible as a cluster
              const alreadyConfirmed = clusters.some(
                (c) => c.status.kind === "confirmed" && c.status.personId === pid,
              );
              const alreadySuggested = clusters.some(
                (c) =>
                  (c.status.kind === "suggested" || c.status.kind === "unknown") &&
                  (c.status as any).personId === pid,
              );
              return !alreadyConfirmed && !alreadySuggested;
            })
            .map((pid) => {
              const person = peopleById.get(pid);
              if (!person) return null;
              return (
                <div
                  key={pid}
                  className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                >
                  <span className="size-2 rounded-full bg-muted-foreground/40" />
                  <span className="font-medium">{person.name}</span>
                  <span className="ml-auto italic">hasn't spoken yet</span>
                </div>
              );
            })}
          {clusters.length === 0 && (participantIds ?? []).length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              Voices will appear here as they speak.
            </p>
          )}
          {clusters.map((c) => (
            <ClusterCard
              key={c.label}
              cluster={c}
              allClusters={clusters}
              people={people}
              participantIds={participantIds}
              onConfirmKnown={onConfirmKnown}
              onRejectSuggestion={onRejectSuggestion}
              onConfirmNew={onConfirmNew}
              onAskName={onAskName}
              onClearConfirmed={onClearConfirmed}
              onMerge={onMerge}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function ClusterCard({
  cluster,
  allClusters,
  people,
  participantIds,
  onConfirmKnown,
  onRejectSuggestion,
  onConfirmNew,
  onAskName,
  onClearConfirmed,
  onMerge,
}: {
  cluster: ClusterRow;
  allClusters: ClusterRow[];
  people: Person[];
  participantIds?: string[];
  onConfirmKnown: (label: string, personId: string) => void;
  onRejectSuggestion: (label: string) => void;
  onConfirmNew: (label: string, name: string) => void;
  onAskName: (label?: string) => void;
  onClearConfirmed: (label: string) => void;
  onMerge: (fromLabel: string, toLabel: string) => void;
}) {
  // Participants who are declared for this conversation but not yet confirmed
  // for any cluster. These appear as one-tap "quick identify" chips on
  // unknown clusters so the user can assign them in a single tap.
  const availableParticipants = (participantIds ?? [])
    .filter((pid) => {
      const taken = allClusters.some(
        (c) =>
          c.label !== cluster.label &&
          c.status.kind === "confirmed" &&
          c.status.personId === pid,
      );
      return !taken;
    })
    .map((pid) => people.find((p) => p.id === pid))
    .filter((p): p is Person => Boolean(p));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [showMerge, setShowMerge] = useState(false);

  useEffect(() => {
    setEditing(false);
    setName("");
    setShowMerge(false);
  }, [cluster.status.kind]);

  const mergeTargets = allClusters.filter((c) => c.label !== cluster.label);

  const sourceLabel = (s: SuggestedName["source"]) =>
    s === "self-intro"
      ? "heard self-introduction"
      : s === "ask-reply"
        ? "answered 'who am I speaking with?'"
        : s === "context-ai"
          ? "identified by AI from context"
          : "added manually";

  const SuggestionIcon = ({ source }: { source: SuggestedName["source"] }) =>
    source === "context-ai" ? <Brain className="inline size-2.5 mr-0.5 text-violet-500" /> : null;

  const MergeSection = () =>
    mergeTargets.length === 0 ? null : showMerge ? (
      <div className="mt-1.5 flex items-center gap-1">
        <GitMerge className="size-3 shrink-0 text-muted-foreground" />
        <select
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-[11px]"
          defaultValue=""
          onChange={(e) => {
            const target = e.target.value;
            if (target) {
              onMerge(cluster.label, target);
              setShowMerge(false);
            }
          }}
        >
          <option value="" disabled>
            Merge into…
          </option>
          {mergeTargets.map((t) => {
            const confirmedPerson =
              t.status.kind === "confirmed"
                ? people.find((p) => p.id === (t.status as { kind: "confirmed"; personId: string }).personId)
                : null;
            return (
              <option key={t.label} value={t.label}>
                {confirmedPerson ? `${confirmedPerson.name} (${t.label})` : t.label} ·{" "}
                {t.count}
              </option>
            );
          })}
        </select>
        <button
          onClick={() => setShowMerge(false)}
          className="rounded p-0.5 hover:bg-secondary"
          aria-label="Cancel merge"
        >
          <X className="size-3" />
        </button>
      </div>
    ) : (
      <button
        onClick={() => setShowMerge(true)}
        className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        title="Merge this cluster into another"
      >
        <GitMerge className="size-3" /> Merge into…
      </button>
    );

  // ---------- Confirmed ----------
  if (cluster.status.kind === "confirmed" && !editing) {
    const status = cluster.status;
    const person = people.find((p) => p.id === status.personId);
    return (
      <div className="rounded-xl border border-[var(--sage)]/50 bg-[var(--sage)]/15 px-2 py-1.5 text-sm">
        <div className="flex items-center gap-1.5">
          <Check className="size-4 text-[var(--sage)]" />
          <span className="font-medium">{person?.name ?? cluster.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {cluster.label} · {cluster.count}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="rounded p-0.5 hover:bg-[var(--sage)]/25"
            aria-label="Edit"
            title="Reassign or clear"
          >
            <Pencil className="size-3.5 text-[var(--ink-soft)]" />
          </button>
        </div>
        <MergeSection />
      </div>
    );
  }

  // ---------- Confirmed (editing) ----------
  if (cluster.status.kind === "confirmed" && editing) {
    const others = people.filter((p) => p.id !== (cluster.status as any).personId);
    return (
      <div className="space-y-1.5 rounded-xl border border-[var(--sage)]/50 bg-[var(--sage)]/5 p-2 text-sm">
        <div className="flex items-center gap-1.5">
          <Pencil className="size-4 text-[var(--ink-soft)]" />
          <span className="font-medium">Edit {cluster.label}</span>
          <button
            onClick={() => setEditing(false)}
            className="ml-auto rounded p-0.5 hover:bg-secondary"
            aria-label="Cancel"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <select
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          defaultValue=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) {
              onConfirmKnown(cluster.label, v);
              setEditing(false);
            }
          }}
        >
          <option value="" disabled>
            Reassign to…
          </option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onConfirmNew(cluster.label, name.trim());
                setEditing(false);
              }
            }}
            placeholder="Or new name…"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
          <button
            onClick={() => {
              if (name.trim()) {
                onConfirmNew(cluster.label, name.trim());
                setEditing(false);
              }
            }}
            disabled={!name.trim()}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <button
          onClick={() => {
            onClearConfirmed(cluster.label);
            setEditing(false);
          }}
          className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20"
        >
          This isn't them — clear
        </button>
      </div>
    );
  }

  // ---------- Suggested (voiceprint match) ----------
  if (cluster.status.kind === "suggested") {
    const status = cluster.status;
    const person = people.find((p) => p.id === status.personId);
    const suggestions = status.suggestions ?? [];
    const confidenceLabel =
      status.sim >= 0.9 ? "Sounds like" : status.sim >= 0.83 ? "Probably" : "Maybe";
    return (
      <div className="rounded-xl border border-[var(--accent)]/50 bg-[var(--accent)]/15 p-2 text-sm">
        <div className="flex items-center gap-1.5">
          <Mic2 className="size-4 text-[var(--ink-soft)]" />
          <span className="font-medium">{cluster.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {Math.round(status.sim * 100)}% · {cluster.count}
          </span>
        </div>
        <p className="mt-1 text-xs">
          {confidenceLabel}{" "}
          <span className="font-semibold">{person?.name ?? "?"}</span>
        </p>
        <div className="mt-1.5 flex gap-1.5">
          <button
            onClick={() => onConfirmKnown(cluster.label, status.personId)}
            className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Confirm
          </button>
          <button
            onClick={() => onRejectSuggestion(cluster.label)}
            className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs hover:bg-secondary"
            title="Not them"
            aria-label="Not them"
          >
            <X className="size-3" />
          </button>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="text-[10px] text-muted-foreground">Or:</span>
            {suggestions.map((s) => (
              <button
                key={s.name + s.source}
                onClick={() => onConfirmNew(cluster.label, s.name)}
                title={sourceLabel(s.source)}
                className="rounded-full border border-[var(--accent)]/50 bg-background px-2 py-0.5 text-[11px] hover:bg-[var(--accent)]/20"
              >
                <SuggestionIcon source={s.source} />
                {s.name}
              </button>
            ))}
          </div>
        )}
        <MergeSection />
      </div>
    );
  }

  // ---------- Unknown ----------
  if (cluster.status.kind !== "unknown") return null;
  const suggestions = cluster.status.suggestions ?? [];
  const excludedIds = new Set(cluster.status.excludedPersonIds ?? []);
  // Filter out participants the user has already explicitly rejected for this cluster
  const quickIdentifyOptions = availableParticipants.filter(
    (p) => !excludedIds.has(p.id),
  );
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-2 text-sm">
      <div className="flex items-center gap-1.5">
        <Mic2 className="size-4 text-muted-foreground" />
        <span className="font-medium">{cluster.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {cluster.count}
        </span>
        <button
          onClick={() => onAskName(cluster.label)}
          title="Ask this speaker to introduce themselves"
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary"
          aria-label="Ask name"
        >
          <HelpCircle className="size-3.5" />
        </button>
      </div>
      {/* One-tap quick-identify for declared participants who aren't yet
          confirmed elsewhere. Tap the matching name to assign this cluster. */}
      {quickIdentifyOptions.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] text-muted-foreground mb-1">
            Who's this?
          </p>
          <div className="flex flex-wrap gap-1">
            {quickIdentifyOptions.map((p) => (
              <button
                key={p.id}
                onClick={() => onConfirmKnown(cluster.label, p.id)}
                className="rounded-full border-2 border-primary/50 bg-primary/15 px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-primary/25"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s.name + s.source}
              onClick={() => onConfirmNew(cluster.label, s.name)}
              title={sourceLabel(s.source)}
              className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium hover:bg-primary/20"
            >
              <SuggestionIcon source={s.source} />
              {s.name} ✓
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              onConfirmNew(cluster.label, name.trim());
              setName("");
            }
          }}
          placeholder="Name…"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
        <button
          onClick={() => {
            if (name.trim()) {
              onConfirmNew(cluster.label, name.trim());
              setName("");
            }
          }}
          disabled={!name.trim()}
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
      <MergeSection />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Check, X, HelpCircle, Mic2, Pencil } from "lucide-react";
import type { Person, TranscriptSegment } from "@/lib/db";

export type SuggestedName = {
  name: string;
  source: "self-intro" | "ask-reply" | "manual";
};

export type ClusterStatus =
  | { kind: "unknown"; suggestions?: SuggestedName[] }
  | {
      kind: "suggested";
      personId: string;
      sim: number;
      suggestions?: SuggestedName[];
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
  onConfirmKnown,
  onRejectSuggestion,
  onConfirmNew,
  onAskName,
  onClearConfirmed,
}: {
  segments: TranscriptSegment[];
  partial: string;
  clusters: ClusterRow[];
  people: Person[];
  onConfirmKnown: (label: string, personId: string) => void;
  onRejectSuggestion: (label: string) => void;
  onConfirmNew: (label: string, name: string) => void;
  onAskName: (label?: string) => void;
  onClearConfirmed: (label: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length, partial]);

  const peopleById = new Map(people.map((p) => [p.id, p] as const));
  const tail = segments.slice(-30);

  function nameForLabel(label: string): string {
    if (label === JAMES_SELF_LABEL) return "Me";
    const c = clusters.find((c) => c.label === label);
    if (c?.status.kind === "confirmed") {
      return peopleById.get(c.status.personId)?.name ?? label;
    }
    return label;
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
          className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 text-sm"
        >
          {tail.length === 0 && !partial && (
            <p className="italic text-muted-foreground">Listening…</p>
          )}
          {tail.map((s) => (
            <div key={s.id} className="leading-snug">
              <span className="mr-2 text-xs font-medium text-muted-foreground">
                {nameForLabel(s.speaker_label)}
              </span>
              {s.text}
            </div>
          ))}
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
          <button
            onClick={() => onAskName()}
            title="Ask the room to introduce themselves"
            className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs text-foreground hover:bg-secondary"
          >
            <HelpCircle className="size-3" /> Ask
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {clusters.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              Voices will appear here as they speak.
            </p>
          )}
          {clusters.map((c) => (
            <ClusterCard
              key={c.label}
              cluster={c}
              people={people}
              onConfirmKnown={onConfirmKnown}
              onRejectSuggestion={onRejectSuggestion}
              onConfirmNew={onConfirmNew}
              onAskName={onAskName}
              onClearConfirmed={onClearConfirmed}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function ClusterCard({
  cluster,
  people,
  onConfirmKnown,
  onRejectSuggestion,
  onConfirmNew,
  onAskName,
  onClearConfirmed,
}: {
  cluster: ClusterRow;
  people: Person[];
  onConfirmKnown: (label: string, personId: string) => void;
  onRejectSuggestion: (label: string) => void;
  onConfirmNew: (label: string, name: string) => void;
  onAskName: (label?: string) => void;
  onClearConfirmed: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  // Reset edit state when status flips
  useEffect(() => {
    setEditing(false);
    setName("");
  }, [cluster.status.kind]);

  const sourceLabel = (s: SuggestedName["source"]) =>
    s === "self-intro"
      ? "heard self-introduction"
      : s === "ask-reply"
        ? "answered 'who am I speaking with?'"
        : "added manually";

  // ---------- Confirmed ----------
  if (cluster.status.kind === "confirmed" && !editing) {
    const status = cluster.status;
    const person = people.find((p) => p.id === status.personId);
    return (
      <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-sm">
        <div className="flex items-center gap-1.5">
          <Check className="size-4 text-emerald-600" />
          <span className="font-medium">{person?.name ?? cluster.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {cluster.label} · {cluster.count}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="rounded p-0.5 hover:bg-emerald-500/20"
            aria-label="Edit"
            title="Reassign or clear"
          >
            <Pencil className="size-3.5 text-emerald-700" />
          </button>
        </div>
      </div>
    );
  }

  // ---------- Confirmed (editing) ----------
  if (cluster.status.kind === "confirmed" && editing) {
    const others = people.filter((p) => p.id !== (cluster.status as any).personId);
    return (
      <div className="space-y-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2 text-sm">
        <div className="flex items-center gap-1.5">
          <Pencil className="size-4 text-emerald-700" />
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
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
        <div className="flex items-center gap-1.5">
          <Mic2 className="size-4 text-amber-700" />
          <span className="font-medium">{cluster.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {Math.round(status.sim * 100)}% · {cluster.count}
          </span>
        </div>
        <p className="mt-1 text-xs">
          Sounds like <span className="font-semibold">{person?.name ?? "?"}</span>
        </p>
        <div className="mt-1.5 flex gap-1.5">
          <button
            onClick={() => onConfirmKnown(cluster.label, status.personId)}
            className="flex-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500"
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
                className="rounded-full border border-amber-500/40 bg-background px-2 py-0.5 text-[11px] hover:bg-amber-500/20"
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---------- Unknown ----------
  if (cluster.status.kind !== "unknown") return null;
  const suggestions = cluster.status.suggestions ?? [];
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
      {suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s.name + s.source}
              onClick={() => onConfirmNew(cluster.label, s.name)}
              title={sourceLabel(s.source)}
              className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium hover:bg-primary/20"
            >
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
    </div>
  );
}

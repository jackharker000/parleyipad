import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { FileText, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VoiceSampleRecorder } from "@/components/VoiceSampleRecorder";
import { ProfileProposalsSection } from "@/components/people/ProfileProposalsSection";
import {
  db,
  type Conversation,
  type Memory,
  type Person,
  type PersonDocument,
  type Place,
  type Voiceprint,
  type VoiceprintContribution,
} from "@/lib/db";
import {
  makeEmbedder,
  type EmbedderKind,
  type SpeakerEmbedder,
} from "@/lib/audio/embedder";
import { deleteAllContributionsForPerson } from "@/lib/audio/enrollment";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/cn";

/**
 * People tab. Left rail (search + add-person + roster) + right detail
 * panel (header, stat cards, common locations, interests, notes, voice
 * recognition, background documents). Brings back the rich per-person
 * detail view from the pre-login version of the app.
 */

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_MEMORIES: Memory[] = [];
const EMPTY_PLACES: Place[] = [];
const EMPTY_DOCS: PersonDocument[] = [];
const EMPTY_CONTRIBUTIONS: VoiceprintContribution[] = [];

const MAX_DOC_CHARS = 60_000;
const TEXT_LIKE_RE = /^(text\/|application\/(json|xml|csv|x-yaml|x-toml|markdown|pdf))/i;
const TEXT_EXT_RE = /\.(txt|md|markdown|pdf)$/i;

export function PeopleTab() {
  return (
    <ClientOnly fallback={<LoadingSkeleton />}>
      <PeopleApp />
    </ClientOnly>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--sand-2)]/60" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-[var(--sand-2)]/60" />
    </div>
  );
}

function ClientOnly({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}

// --------------------------------------------------------------------------

function PeopleApp() {
  const settings = useSettings();

  // One embedder shared across the whole tab. Re-create when WebGPU
  // preference flips; dispose on unmount so the WASM heap actually frees.
  const embedderRef = useRef<SpeakerEmbedder | null>(null);
  const [embedder, setEmbedder] = useState<SpeakerEmbedder | null>(null);
  const [embedderReady, setEmbedderReady] = useState(false);
  const [embedderError, setEmbedderError] = useState<string | null>(null);

  useEffect(() => {
    setEmbedderReady(false);
    setEmbedderError(null);
    embedderRef.current?.dispose?.();
    const kind: EmbedderKind = "transformers";
    const next = makeEmbedder(kind, { preferWebGPU: settings.speakerIdWebGPU });
    embedderRef.current = next;
    setEmbedder(next);
    let cancelled = false;
    (async () => {
      try {
        await next.warmup?.();
        if (!cancelled) setEmbedderReady(true);
      } catch (err) {
        if (cancelled) return;
        setEmbedderError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.speakerIdWebGPU]);

  useEffect(() => {
    return () => {
      embedderRef.current?.dispose?.();
      embedderRef.current = null;
    };
  }, []);

  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);
  const voiceprints = useLiveQuery(() => db().voiceprints.toArray(), [], EMPTY_VOICEPRINTS);

  const voiceprintByPersonId = useMemo(() => {
    const m = new Map<string, Voiceprint>();
    for (const vp of voiceprints) m.set(vp.personId, vp);
    return m;
  }, [voiceprints]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  // If the selected person is deleted (or never matched), clear the selection
  // so we don't show stale detail.
  useEffect(() => {
    if (selectedId && !people.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [people, selectedId]);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.relationship ?? "").toLowerCase().includes(q),
    );
  }, [people, search]);

  const selected = selectedId ? people.find((p) => p.id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <EmbedderStatus ready={embedderReady} error={embedderError} />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <RosterRail
          people={filteredPeople}
          voiceprintByPersonId={voiceprintByPersonId}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setAdding(false);
          }}
          onAddNew={() => {
            setAdding(true);
            setSelectedId(null);
          }}
          search={search}
          onSearchChange={setSearch}
        />
        <div>
          {adding ? (
            <AddPersonPanel
              onCancel={() => setAdding(false)}
              onAdded={(id) => {
                setAdding(false);
                setSelectedId(id);
              }}
            />
          ) : selected ? (
            <PersonDetail
              person={selected}
              voiceprint={voiceprintByPersonId.get(selected.id)}
              embedder={embedder}
              embedderReady={embedderReady}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <EmptyDetailPanel onAdd={() => setAdding(true)} />
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function EmbedderStatus({ ready, error }: { ready: boolean; error: string | null }) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <span>Voice model failed to load: {error}. Recording is disabled until this clears.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    );
  }
  if (ready) return null;
  return (
    <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
      Warming up the voice model… first run downloads ~95 MB and stays cached.
    </div>
  );
}

// --------------------------------------------------------------------------

function RosterRail({
  people,
  voiceprintByPersonId,
  selectedId,
  onSelect,
  onAddNew,
  search,
  onSearchChange,
}: {
  people: Person[];
  voiceprintByPersonId: Map<string, Voiceprint>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddNew: () => void;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search people"
            className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button onClick={onAddNew} className="w-full" variant="default">
          <Plus />
          Add person
        </Button>
      </div>

      <div className="space-y-1">
        <p className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Roster ({people.length})
        </p>
        {people.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
            No people yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {people.map((p) => {
              const isSelected = p.id === selectedId;
              const vp = voiceprintByPersonId.get(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(p.id)}
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "flex w-full min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-[var(--teal)] bg-[var(--teal)]/10"
                        : "border-transparent hover:border-border hover:bg-muted/40",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                      {p.relationship && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.relationship}
                        </div>
                      )}
                    </div>
                    <SampleBadge count={vp?.sampleCount ?? 0} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function SampleBadge({ count }: { count: number }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        count === 0
          ? "bg-muted text-muted-foreground"
          : count < 2
            ? "bg-amber-500/20 text-amber-800"
            : "bg-emerald-500/20 text-emerald-700",
      )}
      title={
        count === 0
          ? "No voiceprint yet"
          : count < 2
            ? "Add at least one more sample for reliable matching"
            : "Healthy voiceprint"
      }
    >
      {count === 0 ? "no samples" : `${count}`}
    </span>
  );
}

// --------------------------------------------------------------------------

function EmptyDetailPanel({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-[var(--line)] bg-white p-8 text-center">
      <h3 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
        Select someone on the left to see and edit their details, or add a new person.
      </h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--ink-soft)]">
        Parley learns each person&apos;s voice from a few short samples and uses their profile to
        shape suggestions in the cockpit.
      </p>
      <div className="mt-4">
        <Button onClick={onAdd} variant="default">
          <Plus />
          Add person
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function AddPersonPanel({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    try {
      const id = nanoid();
      const now = Date.now();
      await db().people.add({
        id,
        name: trimmedName,
        relationship: relationship.trim() || undefined,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      toast.success(`Added ${trimmedName}`);
      onAdded(id);
    } catch (err) {
      toast.error(`Failed to add: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ink)]">Add a person</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Name them first; record their voice after. Relationship is optional but feeds the persona
          prompt.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sarah"
            autoFocus
            autoComplete="off"
            className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Relationship">
          <input
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="e.g. sister, carer"
            autoComplete="off"
            className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={!name.trim() || busy}>
            <Plus />
            Add person
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

// --------------------------------------------------------------------------

function PersonDetail({
  person,
  voiceprint,
  embedder,
  embedderReady,
  onDeleted,
}: {
  person: Person;
  voiceprint: Voiceprint | undefined;
  embedder: SpeakerEmbedder | null;
  embedderReady: boolean;
  onDeleted: () => void;
}) {
  const conversations = useLiveQuery(
    () => db().conversations.toArray(),
    [],
    EMPTY_CONVERSATIONS,
  );
  const memories = useLiveQuery(
    () =>
      db().memories.where("personId").equals(person.id).filter((m) => m.status === "active").toArray(),
    [person.id],
    EMPTY_MEMORIES,
  );
  const places = useLiveQuery(() => db().places.toArray(), [], EMPTY_PLACES);

  // Conversations linked to this person.
  const personConversations = useMemo(() => {
    return conversations
      .filter((c) => c.personIds?.includes(person.id))
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [conversations, person.id]);

  const commonPlaces = useMemo(
    () => places.filter((p) => (p.personIds ?? []).includes(person.id)),
    [places, person.id],
  );

  const lastSeenLabel = useMemo(() => {
    if (personConversations.length === 0) return "—";
    return formatRelative(personConversations[0].startedAt);
  }, [personConversations]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [showConversationsList, setShowConversationsList] = useState(false);
  const [showMemoriesList, setShowMemoriesList] = useState(false);

  const sampleCount = voiceprint?.sampleCount ?? 0;
  const sampleClause =
    sampleCount > 0
      ? `their ${sampleCount} voice sample${sampleCount === 1 ? "" : "s"}`
      : "their (empty) voiceprint";

  const confirmDelete = async () => {
    try {
      await deleteAllContributionsForPerson(person.id);
      await db().people.delete(person.id);
      toast.success(`Deleted ${person.name}`);
      onDeleted();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
        {editingHeader ? (
          <PersonHeaderEditor person={person} onDone={() => setEditingHeader(false)} />
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">
                {person.name}
              </h2>
              {person.relationship && (
                <p className="mt-0.5 text-sm text-[var(--ink-soft)]">{person.relationship}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingHeader(true)}>
                <Pencil />
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
                <Trash2 />
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Conversations"
          value={personConversations.length}
          actionLabel={personConversations.length > 0 ? "SHOW LIST" : undefined}
          onAction={
            personConversations.length > 0
              ? () => setShowConversationsList((v) => !v)
              : undefined
          }
        >
          {showConversationsList && personConversations.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-[var(--ink-soft)]">
              {personConversations.slice(0, 5).map((c) => (
                <li key={c.id} className="truncate">
                  {new Date(c.startedAt).toLocaleString()}
                </li>
              ))}
              {personConversations.length > 5 && (
                <li className="text-muted-foreground">
                  + {personConversations.length - 5} more
                </li>
              )}
            </ul>
          )}
        </StatCard>
        <StatCard label="Last seen" value={lastSeenLabel} />
        <StatCard
          label="Memories"
          value={memories.length}
          actionLabel={memories.length > 0 ? "SHOW LIST" : undefined}
          onAction={memories.length > 0 ? () => setShowMemoriesList((v) => !v) : undefined}
        >
          {showMemoriesList && memories.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-[var(--ink-soft)]">
              {memories.slice(0, 5).map((m) => (
                <li key={m.id} className="truncate" title={m.text}>
                  {m.text}
                </li>
              ))}
              {memories.length > 5 && (
                <li className="text-muted-foreground">+ {memories.length - 5} more</li>
              )}
            </ul>
          )}
        </StatCard>
      </div>

      {/* Common locations */}
      <SectionCard title="Common locations">
        {commonPlaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No location data yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {commonPlaces.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-foreground"
              >
                {p.name}
              </span>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Interests */}
      <InterestsSection person={person} />

      {/* Notes */}
      <NotesSection person={person} />

      {/* Voice recognition */}
      <SectionCard title="Voice recognition">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {sampleCount > 0
              ? `Voiceprint built from ${sampleCount} sample${sampleCount === 1 ? "" : "s"}`
              : "No voiceprint yet"}
          </p>
          <VoiceSampleRecorder
            personId={person.id}
            embedder={embedder}
            embedderReady={embedderReady}
          />
        </div>
      </SectionCard>

      {/* Background documents */}
      <DocumentsSection personId={person.id} />

      <ProfileProposalsSection person={person} />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${person.name}?`}
        description={`This also removes ${sampleClause}. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

// --------------------------------------------------------------------------

function PersonHeaderEditor({
  person,
  onDone,
}: {
  person: Person;
  onDone: () => void;
}) {
  const [name, setName] = useState(person.name);
  const [relationship, setRelationship] = useState(person.relationship ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      await db().people.update(person.id, {
        name: trimmed,
        relationship: relationship.trim() || undefined,
        updatedAt: Date.now(),
      });
      toast.success("Saved");
      onDone();
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>
      <Field label="Relationship">
        <input
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          placeholder="e.g. sister, carer"
          className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function InterestsSection({ person }: { person: Person }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((person.interests ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  // Re-hydrate the draft when the person row changes underneath us.
  useEffect(() => {
    if (!editing) setDraft((person.interests ?? []).join(", "));
  }, [person.interests, editing]);

  const interests = person.interests ?? [];

  const save = async () => {
    setSaving(true);
    try {
      const next = draft
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await db().people.update(person.id, {
        interests: next.length > 0 ? next : undefined,
        updatedAt: Date.now(),
      });
      toast.success("Interests updated");
      setEditing(false);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Interests"
      action={
        !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. cricket, dogs, jazz"
            className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-xs text-muted-foreground">Comma-separated.</p>
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(interests.join(", "));
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : interests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No interests recorded.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {interests.map((i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-foreground"
            >
              {i}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// --------------------------------------------------------------------------

function NotesSection({ person }: { person: Person }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(person.notes ?? "");
  }, [person.notes, editing]);

  const save = async () => {
    setSaving(true);
    try {
      await db().people.update(person.id, {
        notes: draft.trim() || undefined,
        updatedAt: Date.now(),
      });
      toast.success("Notes saved");
      setEditing(false);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Notes"
      action={
        !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            placeholder="Anything Parley should know about this person…"
            className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(person.notes ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : person.notes ? (
        <p className="whitespace-pre-line text-sm text-foreground/90">{person.notes}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      )}
    </SectionCard>
  );
}

// --------------------------------------------------------------------------

function DocumentsSection({ personId }: { personId: string }) {
  const docs = useLiveQuery(
    () =>
      db()
        .personDocuments.where("personId")
        .equals(personId)
        .reverse()
        .sortBy("createdAt"),
    [personId],
    EMPTY_DOCS,
  );
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const isTextLike = TEXT_LIKE_RE.test(file.type) || TEXT_EXT_RE.test(file.name);
    if (!isTextLike) {
      toast.error(`${file.name}: unsupported file type. Use .txt, .md, or .pdf.`);
      return;
    }
    // For PDFs we'd need a parser; for now we store the raw text and let plain
    // text / markdown through. PDF support is queued — see TODO below.
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    if (isPdf) {
      // TODO: wire a client-side PDF text extractor (pdf.js) so PDFs land as
      // searchable text rather than binary. For now warn loudly.
      toast.error("PDF text extraction isn't wired yet — convert to .txt or .md first.");
      return;
    }

    setBusy(true);
    try {
      let text = "";
      try {
        text = await file.text();
      } catch {
        toast.error(`${file.name}: could not read file`);
        return;
      }
      const trimmed = text.slice(0, MAX_DOC_CHARS);
      if (text.length > MAX_DOC_CHARS) {
        toast.warning(
          `${file.name}: truncated to first ${MAX_DOC_CHARS.toLocaleString()} characters`,
        );
      }
      await db().personDocuments.put({
        id: nanoid(),
        personId,
        filename: file.name,
        mimeType: file.type || "text/plain",
        content: trimmed,
        createdAt: Date.now(),
      });
      toast.success(`Attached ${file.name}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this document?")) return;
    await db().personDocuments.delete(id);
    toast.success("Document removed");
  };

  return (
    <SectionCard title="Background documents">
      <p className="mb-3 text-sm text-[var(--ink-soft)]">
        Attach docs about this person — life history, shared memories, medical notes, anything the
        AI should know. Plain-text and PDF work best.
      </p>

      <label
        className={cn(
          "inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium hover:bg-muted",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload className="h-4 w-4" />
        {busy ? "Reading…" : "Attach a document"}
        <input
          type="file"
          accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            void handleFile(file);
            e.target.value = "";
          }}
        />
      </label>

      {docs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No documents attached yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {d.filename ?? "Untitled document"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {d.content.length.toLocaleString()} chars
                  {d.content.length >= MAX_DOC_CHARS ? " (truncated)" : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(d.id)}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                aria-label={`Remove ${d.filename ?? "document"}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// --------------------------------------------------------------------------

function StatCard({
  label,
  value,
  actionLabel,
  onAction,
  children,
}: {
  label: string;
  value: string | number;
  actionLabel?: string;
  onAction?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--ink)]">{value}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-2 text-xs font-semibold uppercase tracking-wider text-[var(--teal)] hover:text-[var(--teal-dark)]"
        >
          {actionLabel}
        </button>
      )}
      {children}
    </div>
  );
}

function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

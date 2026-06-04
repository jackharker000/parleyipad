import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { db, type Person, type Voiceprint } from "@/lib/db";
import { makeEmbedder, type EmbedderKind, type SpeakerEmbedder } from "@/lib/audio/embedder";
import { deleteAllContributionsForPerson } from "@/lib/audio/enrollment";
import { useSettings } from "@/lib/settings";
import { VoiceSampleRecorder } from "@/components/VoiceSampleRecorder";
import { ProfileProposalsSection } from "@/components/people/ProfileProposalsSection";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/app/people")({
  component: PeoplePage,
});

const EMPTY_PEOPLE: Person[] = [];
const EMPTY_VOICEPRINTS: Voiceprint[] = [];

function PeoplePage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">People</p>
        <h1 className="text-3xl font-semibold tracking-tight">Roster &amp; voiceprints</h1>
        <p className="max-w-prose text-muted-foreground">
          Everyone James talks to. Each person carries a voiceprint — a centroid of enrolled samples
          that the matcher reads at runtime. Capture 2–3 clean samples per person in the room where
          you actually talk; that beats any model upgrade.
        </p>
      </header>

      <ClientOnly fallback={<LoadingCard />}>
        <PeopleApp />
      </ClientOnly>
    </div>
  );
}

function LoadingCard() {
  // Layout-preserving skeleton — four rows mirroring the people roster the
  // user is about to see, so the page doesn't reflow when the embedder /
  // Dexie modules finish loading on the client.
  return (
    <div className="space-y-3" role="status" aria-label="Loading people roster">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--sand-2)]/60" />
      ))}
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

  // One embedder shared across the whole page. Re-create it whenever the
  // WebGPU preference flips (matches the cockpit's lifecycle in
  // src/routes/index.tsx). Dispose on unmount so the ORT WASM heap is
  // actually freed — same iPad-Safari OOM concern that motivated the
  // dispose path in embedder.ts.
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

  // Final cleanup so navigating away releases the model.
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

  return (
    <div className="space-y-6">
      <EmbedderStatus ready={embedderReady} error={embedderError} />
      <AddPersonCard />
      <PeopleList
        people={people}
        voiceprintByPersonId={voiceprintByPersonId}
        embedder={embedder}
        embedderReady={embedderReady}
      />
    </div>
  );
}

// --------------------------------------------------------------------------

function EmbedderStatus({ ready, error }: { ready: boolean; error: string | null }) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <span>
          Voice model failed to load: {error}. Recording is disabled until this clears.
        </span>
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

function AddPersonCard() {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      await db().people.add({
        id: nanoid(),
        name: trimmedName,
        relationship: relationship.trim() || undefined,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      setName("");
      setRelationship("");
      toast.success(`Added ${trimmedName}`);
    } catch (err) {
      toast.error(`Failed to add: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a person</CardTitle>
        <CardDescription>
          Name them first; record their voice after. Relationship is optional but feeds the persona
          prompt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        >
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sarah"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Relationship
            </label>
            <input
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="e.g. sister, carer"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoComplete="off"
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={!name.trim() || busy} variant="default">
              <Plus />
              Add person
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function PeopleList({
  people,
  voiceprintByPersonId,
  embedder,
  embedderReady,
}: {
  people: Person[];
  voiceprintByPersonId: Map<string, Voiceprint>;
  embedder: SpeakerEmbedder | null;
  embedderReady: boolean;
}) {
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null);

  if (people.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No people yet. Add someone above to start building the roster.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roster ({people.length})</CardTitle>
        <CardDescription>
          Tap a row to expand and record voice samples. Each sample folds into the centroid the live
          matcher reads.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {people.map((person) => {
            const vp = voiceprintByPersonId.get(person.id);
            const isOpen = expandedPersonId === person.id;
            return (
              <PersonRow
                key={person.id}
                person={person}
                voiceprint={vp}
                isOpen={isOpen}
                onToggle={() =>
                  setExpandedPersonId((curr) => (curr === person.id ? null : person.id))
                }
                embedder={embedder}
                embedderReady={embedderReady}
              />
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function PersonRow({
  person,
  voiceprint,
  isOpen,
  onToggle,
  embedder,
  embedderReady,
}: {
  person: Person;
  voiceprint: Voiceprint | undefined;
  isOpen: boolean;
  onToggle: () => void;
  embedder: SpeakerEmbedder | null;
  embedderReady: boolean;
}) {
  const sampleCount = voiceprint?.sampleCount ?? 0;
  const [confirmOpen, setConfirmOpen] = useState(false);

  const requestDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    try {
      await deleteAllContributionsForPerson(person.id);
      await db().people.delete(person.id);
      toast.success(`Deleted ${person.name}`);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const sampleClause =
    sampleCount > 0
      ? `their ${sampleCount} voice sample${sampleCount === 1 ? "" : "s"}`
      : "their (empty) voiceprint";

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40"
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{person.name}</span>
            {person.relationship && (
              <span className="text-sm text-muted-foreground">· {person.relationship}</span>
            )}
          </div>
        </div>
        <SampleBadge count={sampleCount} />
        <button
          type="button"
          onClick={requestDelete}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
          aria-label={`Delete ${person.name}`}
          title={`Delete ${person.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </button>
      {isOpen && (
        <div className="border-t border-border bg-muted/20 px-5 py-4">
          <VoiceSampleRecorder
            personId={person.id}
            embedder={embedder}
            embedderReady={embedderReady}
          />
          <ProfileProposalsSection person={person} />
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${person.name}?`}
        description={`This also removes ${sampleClause}. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </li>
  );
}

function SampleBadge({ count }: { count: number }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
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
      {count === 0 ? "no samples" : `${count} sample${count === 1 ? "" : "s"}`}
    </span>
  );
}

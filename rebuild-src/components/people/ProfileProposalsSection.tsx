import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { db, type Person, type ProfileProposal } from "@/lib/db";

const ARRAY_FIELDS = new Set<keyof Person>([
  "interests",
  "topicsLoved",
  "topicsAvoided",
  "dynamicTags",
]);

const EMPTY: ProfileProposal[] = [];

export function ProfileProposalsSection({ person }: { person: Person }) {
  const proposals = useLiveQuery(
    () =>
      db()
        .profileProposals.where("personId")
        .equals(person.id)
        .filter((r) => r.status === "auto")
        .reverse()
        .sortBy("createdAt"),
    [person.id],
    EMPTY,
  );

  return (
    <div className="mt-4 space-y-2 rounded-md border border-border bg-secondary/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Profile suggestions{proposals.length > 0 ? ` (${proposals.length})` : ""}
        </p>
      </div>
      {proposals.length === 0 ? (
        <p className="text-xs text-muted-foreground">No profile suggestions pending.</p>
      ) : (
        <ul className="space-y-1.5">
          {proposals.map((p) => (
            <ProposalRow key={p.id} proposal={p} person={person} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalRow({ proposal, person }: { proposal: ProfileProposal; person: Person }) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const patch = buildPersonPatch(person, proposal);
      if (patch) {
        await db().people.update(person.id, { ...patch, updatedAt: Date.now() });
      }
      await db().profileProposals.update(proposal.id, { status: "confirmed" });
      toast.success(`Updated ${person.name}`);
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await db().profileProposals.update(proposal.id, { status: "rejected" });
      toast.success("Dismissed suggestion");
    } catch (err) {
      toast.error(`Dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-start gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words">{describeProposal(proposal)}</p>
        {proposal.reasoning && (
          <p className="text-[11px] italic text-muted-foreground">{proposal.reasoning}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          onClick={confirm}
          size="sm"
          variant="accent"
          className="h-auto px-2 py-1"
          disabled={busy}
          title="Confirm"
        >
          <Check className="h-3 w-3" />
          Confirm
        </Button>
        <Button
          onClick={reject}
          size="sm"
          variant="ghost"
          className="h-auto px-2 py-1"
          disabled={busy}
          title="Reject"
        >
          <X className="h-3 w-3" />
          Reject
        </Button>
      </div>
    </li>
  );
}

function describeProposal(p: ProfileProposal): string {
  const verb = p.op === "set" ? "Set" : p.op === "append" ? "Append" : "Remove";
  const where = p.op === "append" ? " to" : p.op === "remove" ? " from" : "";
  return `${verb}${where} ${p.field}: "${p.value}"`;
}

function buildPersonPatch(person: Person, proposal: ProfileProposal): Partial<Person> | undefined {
  const field = proposal.field as keyof Person;
  const value = proposal.value;
  const isArrayField = ARRAY_FIELDS.has(field);

  if (proposal.op === "set") {
    return { [field]: value } as Partial<Person>;
  }

  if (proposal.op === "append") {
    if (!isArrayField) {
      return { [field]: value } as Partial<Person>;
    }
    const existing = (person[field] as string[] | undefined) ?? [];
    const lower = value.toLowerCase();
    if (existing.some((v) => v.toLowerCase() === lower)) return undefined;
    return { [field]: [...existing, value] } as Partial<Person>;
  }

  if (proposal.op === "remove") {
    if (!isArrayField) {
      const current = person[field] as string | undefined;
      if (current === value) return { [field]: undefined } as Partial<Person>;
      return undefined;
    }
    const existing = (person[field] as string[] | undefined) ?? [];
    const lower = value.toLowerCase();
    const next = existing.filter((v) => v.toLowerCase() !== lower);
    if (next.length === existing.length) return undefined;
    return { [field]: next } as Partial<Person>;
  }

  return undefined;
}

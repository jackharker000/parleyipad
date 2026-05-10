import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { db, type Conversation } from "@/lib/db";

export const Route = createFileRoute("/recent")({
  component: RecentPage,
});

type SortKey = "date_desc" | "date_asc" | "location" | "people";

function RecentPage() {
  const recent = useLiveQuery(
    () => db.conversations.orderBy("started_at").reverse().limit(200).toArray(),
    [],
  );
  const people = useLiveQuery(() => db.people.toArray(), []);
  const places = useLiveQuery(() => db.places.toArray(), []);

  const [sort, setSort] = useState<SortKey>("date_desc");
  const [keyword, setKeyword] = useState("");
  const [placeFilter, setPlaceFilter] = useState<string>("__all__");
  const [personFilter, setPersonFilter] = useState<string>("__all__");

  const peopleById = useMemo(
    () => new Map((people ?? []).map((p) => [p.id, p] as const)),
    [people],
  );
  const placesById = useMemo(
    () => new Map((places ?? []).map((p) => [p.id, p] as const)),
    [places],
  );

  const filtered = useMemo(() => {
    let list: Conversation[] = recent ?? [];
    if (placeFilter !== "__all__") {
      list = list.filter((c) => c.place_id === placeFilter);
    }
    if (personFilter !== "__all__") {
      list = list.filter((c) => c.person_ids?.includes(personFilter));
    }
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((c) => {
        const hay = [
          c.summary ?? "",
          ...(c.highlights ?? []),
          placesById.get(c.place_id ?? "")?.name ?? "",
          ...(c.person_ids ?? [])
            .map((id) => peopleById.get(id)?.name ?? "")
            .filter(Boolean),
        ]
          .join(" \n")
          .toLowerCase();
        return hay.includes(kw);
      });
    }
    const sorted = [...list];
    switch (sort) {
      case "date_asc":
        sorted.sort((a, b) => a.started_at - b.started_at);
        break;
      case "location":
        sorted.sort((a, b) =>
          (placesById.get(a.place_id ?? "")?.name ?? "~").localeCompare(
            placesById.get(b.place_id ?? "")?.name ?? "~",
          ),
        );
        break;
      case "people":
        sorted.sort((a, b) => {
          const an = (a.person_ids ?? [])
            .map((id) => peopleById.get(id)?.name ?? "")
            .sort()[0] ?? "~";
          const bn = (b.person_ids ?? [])
            .map((id) => peopleById.get(id)?.name ?? "")
            .sort()[0] ?? "~";
          return an.localeCompare(bn);
        });
        break;
      case "date_desc":
      default:
        sorted.sort((a, b) => b.started_at - a.started_at);
    }
    return sorted;
  }, [recent, sort, keyword, placeFilter, personFilter, peopleById, placesById]);

  const hasFilters =
    keyword.trim() !== "" ||
    placeFilter !== "__all__" ||
    personFilter !== "__all__" ||
    sort !== "date_desc";

  return (
    <main className="mx-auto flex h-screen w-full max-w-4xl flex-col gap-3 p-4">
      <header className="flex items-center gap-3">
        <Link
          to="/"
          className="flex size-10 items-center justify-center rounded-lg border border-border hover:bg-secondary"
          aria-label="Back"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold">Recent conversations</h1>
      </header>

      {/* Filter / sort bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/40 p-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Search summary, highlights, names…"
            className="pl-8"
          />
        </div>
        <Select value={personFilter} onValueChange={setPersonFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Person" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All people</SelectItem>
            {(people ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={placeFilter} onValueChange={setPlaceFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All locations</SelectItem>
            {(places ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_desc">Newest first</SelectItem>
            <SelectItem value="date_asc">Oldest first</SelectItem>
            <SelectItem value="location">By location</SelectItem>
            <SelectItem value="people">By person</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setKeyword("");
              setPlaceFilter("__all__");
              setPersonFilter("__all__");
              setSort("date_desc");
            }}
          >
            <X className="mr-1 size-4" /> Clear
          </Button>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? "conversation" : "conversations"}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            No conversations match your filters.
          </p>
        )}
        {filtered.map((c) => {
          const placeName = placesById.get(c.place_id ?? "")?.name;
          const peopleNames = (c.person_ids ?? [])
            .map((id) => peopleById.get(id)?.name)
            .filter(Boolean) as string[];
          return (
            <Card key={c.id} className="p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{new Date(c.started_at).toLocaleString()}</span>
                {placeName && <span>· {placeName}</span>}
                {peopleNames.length > 0 && (
                  <span>· {peopleNames.join(", ")}</span>
                )}
              </div>
              {c.summary ? (
                <p className="mt-1 leading-snug">{c.summary}</p>
              ) : (
                <p className="mt-1 text-xs italic text-muted-foreground">
                  {c.ended_at ? "No summary" : "In progress…"}
                </p>
              )}
              {c.highlights && c.highlights.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
                  {c.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </main>
  );
}
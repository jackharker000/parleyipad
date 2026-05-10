import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { db } from "@/lib/db";

export const Route = createFileRoute("/recent")({
  component: RecentPage,
});

function RecentPage() {
  const recent = useLiveQuery(
    () => db.conversations.orderBy("started_at").reverse().limit(50).toArray(),
    [],
  );

  return (
    <main className="mx-auto flex h-screen w-full max-w-3xl flex-col gap-3 p-4">
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
      <div className="flex-1 space-y-2 overflow-y-auto">
        {recent && recent.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            No conversations yet.
          </p>
        )}
        {recent?.map((c) => (
          <Card key={c.id} className="p-3">
            <div className="text-xs text-muted-foreground">
              {new Date(c.started_at).toLocaleString()}
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
        ))}
      </div>
    </main>
  );
}
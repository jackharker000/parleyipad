import { useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { db, type EventRecord } from "@/lib/db";
import type { DomainAI } from "@/lib/ai";

/**
 * Fires `DomainAI.generateEventPrep()` and writes the result back to the
 * event row's `keyPoints` + `keyQuestions`. James can re-run any time —
 * each press fully replaces the prior prep output (intentional; he tweaks
 * the prepPrompt and re-rolls).
 *
 * State machine: idle → loading → idle (re-runnable). Errors surface via
 * `toast.error`; we don't keep a sticky error state because re-pressing
 * the button is the obvious recovery action.
 */
export function EventPrepButton({ event, ai }: { event: EventRecord; ai: DomainAI }) {
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (loading) return;
    setLoading(true);
    try {
      // Resolve attendees + place + jamesProfile fresh on each click —
      // cheap, and avoids stale closures if the parent forgot to re-render.
      const attendees =
        event.personIds && event.personIds.length > 0
          ? await db().people.bulkGet(event.personIds)
          : [];
      const attendeeNames = attendees
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => p.name);
      const place = event.placeId ? await db().places.get(event.placeId) : undefined;
      const jamesProfile = await db().jamesProfile.get("singleton");

      const result = await ai.generateEventPrep({
        eventName: event.name,
        eventWhen: event.when,
        placeName: place?.name,
        attendeeNames,
        keyInfo: event.keyInfo,
        userPrompt: event.prepPrompt,
        jamesProfile,
      });

      await db().events.update(event.id, {
        keyPoints: result.keyPoints,
        keyQuestions: result.keyQuestions,
        updatedAt: Date.now(),
      });

      const total = result.keyPoints.length + result.keyQuestions.length;
      if (total === 0) {
        toast.error("Prep returned no suggestions — try adding more notes or attendees.");
      } else {
        toast.success(
          `Prepped ${result.keyPoints.length} talking point${result.keyPoints.length === 1 ? "" : "s"} and ${result.keyQuestions.length} question${result.keyQuestions.length === 1 ? "" : "s"}.`,
        );
      }
    } catch (err) {
      toast.error(`Prep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={loading}>
      <Sparkles />
      {loading ? "Prepping…" : "Prep with AI"}
    </Button>
  );
}

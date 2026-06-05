import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AboutJamesTab } from "@/components/settings/AboutJamesTab";
import { PeopleTab } from "@/components/settings/PeopleTab";
import { LocationsTab } from "@/components/settings/LocationsTab";
import { EventsTab } from "@/components/settings/EventsTab";
import { VoiceModelsTab } from "@/components/settings/VoiceModelsTab";
import { SystemTab } from "@/components/settings/SystemTab";

/**
 * Settings hub. Tabs mirror the pre-login layout — People and Events
 * (which used to be top-level routes) are nested in here now. Voice &
 * Models stays as its own tab between Events and System to avoid
 * cramming the already-busy System tab with the voice dropdown and
 * model pickers — folding them in made the page hard to scan.
 *
 * Active tab is in the URL (`?tab=`) so reloads, deep links, and the
 * People/Events redirects from the removed top-level routes land on the
 * right pane.
 */

const TAB_IDS = [
  "about-james",
  "people",
  "locations",
  "events",
  "voice-models",
  "system",
] as const;

type TabId = (typeof TAB_IDS)[number];

const SettingsSearch = z.object({
  tab: z.enum(TAB_IDS).optional().catch("about-james"),
});

export const Route = createFileRoute("/app/settings")({
  validateSearch: SettingsSearch,
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate({ from: "/app/settings" });
  const search = Route.useSearch();
  const tab: TabId = (search.tab ?? "about-james") as TabId;

  const setTab = (next: string) => {
    void navigate({
      search: (prev) => ({ ...prev, tab: next === "about-james" ? undefined : (next as TabId) }),
      replace: true,
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure James&apos;s profile, the people he talks to, the places he visits, the events
          he&apos;s preparing for, the AI providers, and the speaker-ID matcher.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap gap-1 p-1">
          <TabsTrigger value="about-james">About James</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="voice-models">Voice &amp; Models</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="about-james">
          <AboutJamesTab />
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab />
        </TabsContent>
        <TabsContent value="locations">
          <LocationsTab />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
        <TabsContent value="voice-models">
          <VoiceModelsTab />
        </TabsContent>
        <TabsContent value="system">
          <SystemTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

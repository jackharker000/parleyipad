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

const TAB_IDS = ["profile", "people", "locations", "events", "voice-models", "system"] as const;

type TabId = (typeof TAB_IDS)[number];

/**
 * The Profile tab used to be `?tab=about-james` (a "Parley-for-James" relic).
 * It's now `?tab=profile`. Older bookmarks / external links still pass the
 * legacy value, so we accept it as a synonym in the zod parse and normalise
 * it to `profile` on first render — see `tabFromSearch` below.
 */
const LEGACY_TAB_ALIASES: Record<string, TabId> = {
  "about-james": "profile",
};

// Accept any string in the search param so legacy values (and typos) don't
// bounce through zod's `.catch` and clobber the URL — `tabFromSearch` is the
// single source of truth for resolving the actual tab.
const SettingsSearch = z.object({
  tab: z.string().optional(),
});

function tabFromSearch(raw: string | undefined): TabId {
  if (!raw) return "profile";
  if (raw in LEGACY_TAB_ALIASES) return LEGACY_TAB_ALIASES[raw];
  return (TAB_IDS as readonly string[]).includes(raw) ? (raw as TabId) : "profile";
}

export const Route = createFileRoute("/app/settings")({
  validateSearch: SettingsSearch,
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate({ from: "/app/settings" });
  const search = Route.useSearch();
  const tab: TabId = tabFromSearch(search.tab);

  const setTab = (next: string) => {
    void navigate({
      search: (prev) => ({ ...prev, tab: next === "profile" ? undefined : (next as TabId) }),
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
          Configure your profile, the people you talk to, the places you visit, the events
          you&apos;re preparing for, the AI providers, and the speaker-ID matcher.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap gap-1 p-1">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="voice-models">Voice &amp; Models</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
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

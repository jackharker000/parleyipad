import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AboutJamesTab } from "@/components/settings/AboutJamesTab";
import { LocationsTab } from "@/components/settings/LocationsTab";
import { VoiceModelsTab } from "@/components/settings/VoiceModelsTab";
import { SystemTab } from "@/components/settings/SystemTab";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type TabId = "about-james" | "locations" | "voice-models" | "system";

function SettingsPage() {
  const [tab, setTab] = useState<TabId>("about-james");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          One iPad, one user. Configure James's profile, the rooms he uses, the AI providers, and
          the speaker-ID matcher.
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList className="flex h-auto w-full flex-wrap gap-1 p-1">
          <TabsTrigger value="about-james">About James</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="voice-models">Voice &amp; Models</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="about-james">
          <AboutJamesTab />
        </TabsContent>
        <TabsContent value="locations">
          <LocationsTab />
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

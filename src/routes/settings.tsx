import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Volume2, Plus, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  db,
  getSettings,
  updateSettings,
  getJamesProfile,
  updateJamesProfile,
  newId,
  type JamesProfile,
  type Person,
} from "@/lib/db";
import { listVoices, synthesizeSpeech } from "@/lib/aac.functions";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type Voice = { voice_id: string; name: string; labels: Record<string, string> };

function SettingsPage() {
  const router = useRouter();
  const settings = useLiveQuery(() => getSettings(), []);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const fetchVoices = useServerFn(listVoices);
  const tts = useServerFn(synthesizeSpeech);

  useEffect(() => {
    fetchVoices()
      .then((r) => setVoices(r.voices))
      .catch(() => toast.error("Failed to load voices"))
      .finally(() => setLoadingVoices(false));
  }, [fetchVoices]);

  if (!settings) {
    return (
      <main className="min-h-screen bg-background p-6">Loading settings…</main>
    );
  }

  async function handleVoiceChange(voiceId: string) {
    const v = voices.find((x) => x.voice_id === voiceId);
    if (!v) return;
    await updateSettings({ voice_id: v.voice_id, voice_name: v.name });
    toast.success(`Voice set to ${v.name}`);
  }

  async function previewVoice() {
    if (!settings) return;
    try {
      setPreviewing(true);
      const r = await tts({
        data: {
          text: "Hi, this is how I'll sound when you tap a suggestion.",
          voiceId: settings.voice_id,
        },
      });
      const audio = new Audio(`data:${r.mime};base64,${r.audioBase64}`);
      await audio.play();
    } catch (e) {
      toast.error("Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function clearAllData() {
    if (!confirm("Delete ALL local data? This cannot be undone.")) return;
    await Promise.all([
      db.conversations.clear(),
      db.transcript_segments.clear(),
      db.suggestions_log.clear(),
      db.manual_replies.clear(),
      db.memories.clear(),
      db.follow_ups.clear(),
      db.people.clear(),
      db.places.clear(),
      db.style_profile.clear(),
      db.james_profile.clear(),
    ]);
    toast.success("All data cleared");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <header className="mb-8 flex items-center gap-3">
          <button
            onClick={() => router.history.back()}
            className="rounded-full p-2 hover:bg-secondary"
            aria-label="Back"
          >
            <ArrowLeft className="size-6" />
          </button>
          <h1 className="text-3xl font-semibold">Settings</h1>
        </header>

        <JamesProfileCard />

        <PeopleCard />

        <Card className="p-6">
          <h2 className="text-lg font-semibold">Voice</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose how the app speaks suggestions out loud.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Select
              value={settings.voice_id}
              onValueChange={handleVoiceChange}
              disabled={loadingVoices}
            >
              <SelectTrigger className="h-12 flex-1 text-base">
                <SelectValue placeholder="Select a voice" />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.voice_id} value={v.voice_id}>
                    {v.name}
                    {v.labels?.accent ? ` · ${v.labels.accent}` : ""}
                    {v.labels?.gender ? ` · ${v.labels.gender}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              className="h-12"
              onClick={previewVoice}
              disabled={previewing}
            >
              <Volume2 className="size-5" />
              {previewing ? "…" : "Preview"}
            </Button>
          </div>
        </Card>

        <Card className="mt-4 p-6">
          <h2 className="text-lg font-semibold">Location</h2>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <Label className="text-base">Use GPS for context</Label>
              <p className="text-sm text-muted-foreground">
                Auto-detects places (e.g. library, café) to tailor suggestions.
              </p>
            </div>
            <Switch
              checked={settings.gps_enabled}
              onCheckedChange={(v) =>
                updateSettings({ gps_enabled: v }).then(() =>
                  toast.success(v ? "GPS on" : "GPS off"),
                )
              }
            />
          </div>
        </Card>

        <Card className="mt-4 p-6">
          <h2 className="text-lg font-semibold">Storage</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            All conversations live on this iPad. Cloud sync coming soon.
          </p>
          <div className="mt-4 flex items-center justify-between">
            <Label className="text-base">Sync to Lovable Cloud</Label>
            <Switch
              checked={settings.cloud_sync}
              disabled
              onCheckedChange={(v) => updateSettings({ cloud_sync: v })}
            />
          </div>
          <Button
            variant="destructive"
            className="mt-6 h-11"
            onClick={clearAllData}
          >
            Clear all local data
          </Button>
        </Card>

        <div className="mt-8 text-center">
          <Link to="/" className="text-sm text-muted-foreground underline">
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
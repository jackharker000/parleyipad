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

        <Card className="mt-4 p-6">
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

/* -------------------------- James Profile editor -------------------------- */

function JamesProfileCard() {
  const profile = useLiveQuery(() => getJamesProfile(), []);
  const [draft, setDraft] = useState<JamesProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !draft) setDraft(profile);
  }, [profile, draft]);

  if (!draft) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">Loading profile…</Card>
    );
  }

  const set = <K extends keyof JamesProfile>(k: K, v: JamesProfile[K]) =>
    setDraft({ ...draft, [k]: v });

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await updateJamesProfile(draft);
      toast.success("Profile saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <User className="size-5" />
        <h2 className="text-lg font-semibold">About James</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The richer this is, the more the AI suggestions will sound like him.
        Edit anytime — changes apply to the next conversation.
      </p>

      <div className="mt-5 grid gap-4">
        <Field label="Display name">
          <Input
            value={draft.display_name}
            onChange={(e) => set("display_name", e.target.value)}
          />
        </Field>
        <Field
          label="Background"
          hint="Family, career, where he grew up, important life details"
        >
          <Textarea
            rows={3}
            value={draft.background ?? ""}
            onChange={(e) => set("background", e.target.value)}
          />
        </Field>
        <Field
          label="Personality"
          hint="e.g. warm, dry-witted, hates small talk, deeply curious"
        >
          <Textarea
            rows={2}
            value={draft.personality ?? ""}
            onChange={(e) => set("personality", e.target.value)}
          />
        </Field>
        <Field label="Humor style" hint="e.g. loves puns, deadpan, self-deprecating">
          <Textarea
            rows={2}
            value={draft.humor_style ?? ""}
            onChange={(e) => set("humor_style", e.target.value)}
          />
        </Field>
        <Field
          label="Communication style"
          hint="Short sentences? Asks questions back? Direct or gentle?"
        >
          <Textarea
            rows={2}
            value={draft.communication_style ?? ""}
            onChange={(e) => set("communication_style", e.target.value)}
          />
        </Field>
        <Field label="Topics he loves" hint="Comma-separated or freeform">
          <Textarea
            rows={2}
            value={draft.topics_loved ?? ""}
            onChange={(e) => set("topics_loved", e.target.value)}
          />
        </Field>
        <Field label="Topics he avoids">
          <Textarea
            rows={2}
            value={draft.topics_avoided ?? ""}
            onChange={(e) => set("topics_avoided", e.target.value)}
          />
        </Field>
        <Field
          label="Signature phrases"
          hint="One per line — actual things he'd say. The AI will reuse these verbatim."
        >
          <Textarea
            rows={4}
            value={draft.signature_phrases ?? ""}
            onChange={(e) => set("signature_phrases", e.target.value)}
          />
        </Field>
        <Field
          label="Current life context"
          hint="What's on his mind right now — recent events, what's coming up"
        >
          <Textarea
            rows={3}
            value={draft.current_life_context ?? ""}
            onChange={(e) => set("current_life_context", e.target.value)}
          />
        </Field>
        <Field label="Anything else (freeform)">
          <Textarea
            rows={4}
            value={draft.freeform_notes ?? ""}
            onChange={(e) => set("freeform_notes", e.target.value)}
          />
        </Field>
      </div>

      <Button className="mt-5 h-11" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save profile"}
      </Button>
    </Card>
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
    <div>
      <Label className="text-base">{label}</Label>
      {hint && <p className="mb-1 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

/* ------------------------------- People CRUD ------------------------------ */

function PeopleCard() {
  const people = useLiveQuery(
    () => db.people.orderBy("name").toArray(),
    [],
  );
  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);

  function startAdd() {
    setEditing({
      id: newId(),
      name: "",
      relationship: "",
      interests: [],
      notes: "",
      style_notes: "",
      created_at: Date.now(),
    });
    setAdding(true);
  }

  async function save(p: Person) {
    if (!p.name.trim()) {
      toast.error("Name is required");
      return;
    }
    await db.people.put(p);
    setEditing(null);
    setAdding(false);
    toast.success("Saved");
  }

  async function remove(id: string) {
    if (!confirm("Remove this person?")) return;
    await db.people.delete(id);
    if (editing?.id === id) setEditing(null);
  }

  return (
    <Card className="mt-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">People in James's life</h2>
        <Button size="sm" variant="secondary" onClick={startAdd}>
          <Plus className="size-4" /> Add
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Each person's interests, notes, and shared memories get fed into
        suggestions when they're in the conversation.
      </p>

      <div className="mt-4 space-y-2">
        {people?.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            No people yet. Tap "Add" to start.
          </p>
        )}
        {people?.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between rounded-xl border border-border bg-secondary/30 px-4 py-3"
          >
            <button
              className="flex-1 text-left"
              onClick={() => {
                setEditing(p);
                setAdding(false);
              }}
            >
              <div className="font-medium">{p.name}</div>
              {p.relationship && (
                <div className="text-xs text-muted-foreground">
                  {p.relationship}
                </div>
              )}
            </button>
            <button
              onClick={() => remove(p.id)}
              className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <PersonEditor
          person={editing}
          isNew={adding}
          onCancel={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={save}
        />
      )}
    </Card>
  );
}

function PersonEditor({
  person,
  isNew,
  onCancel,
  onSave,
}: {
  person: Person;
  isNew: boolean;
  onCancel: () => void;
  onSave: (p: Person) => void;
}) {
  const [draft, setDraft] = useState<Person>(person);
  const set = <K extends keyof Person>(k: K, v: Person[K]) =>
    setDraft({ ...draft, [k]: v });

  return (
    <div className="mt-4 space-y-3 rounded-xl border-2 border-primary/30 bg-card p-4">
      <h3 className="font-semibold">{isNew ? "New person" : `Edit ${person.name}`}</h3>
      <Field label="Name">
        <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Relationship" hint="e.g. daughter, neighbor, physiotherapist">
        <Input
          value={draft.relationship ?? ""}
          onChange={(e) => set("relationship", e.target.value)}
        />
      </Field>
      <Field label="Interests" hint="Comma-separated">
        <Input
          value={draft.interests?.join(", ") ?? ""}
          onChange={(e) =>
            set(
              "interests",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
      <Field label="Notes" hint="Anything James would want the AI to know about them">
        <Textarea
          rows={3}
          value={draft.notes ?? ""}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
      <Field
        label="Conversation style with them"
        hint="e.g. very casual, lots of inside jokes; or formal and brief"
      >
        <Textarea
          rows={2}
          value={draft.style_notes ?? ""}
          onChange={(e) => set("style_notes", e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button onClick={() => onSave(draft)}>Save</Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
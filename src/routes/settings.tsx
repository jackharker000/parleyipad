import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Volume2,
  Plus,
  Trash2,
  User,
  MapPin,
  Users,
  SlidersHorizontal,
  Crosshair,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
  type Place,
  IPAD_PRESETS,
  type IPadModel,
  MODEL_OPTIONS,
} from "@/lib/db";
import {
  listVoices,
  synthesizeSpeech,
  designVoicePreviews,
  saveDesignedVoice,
} from "@/lib/aac.functions";
import { getCurrentPosition } from "@/lib/geo";
import { getPersonStats, groupMemories } from "@/lib/people-stats";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type Voice = { voice_id: string; name: string; labels: Record<string, string> };

function SettingsPage() {
  const router = useRouter();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={() => router.history.back()}
            className="rounded-full p-2 hover:bg-secondary"
            aria-label="Back"
          >
            <ArrowLeft className="size-6" />
          </button>
          <h1 className="text-3xl font-semibold">Settings</h1>
          <Link
            to="/"
            className="ml-auto text-sm text-muted-foreground underline"
          >
            Back to home
          </Link>
        </header>

        <Tabs defaultValue="james">
          <TabsList className="mb-4 h-12 w-full justify-start gap-1 bg-secondary/50">
            <TabsTrigger value="james" className="h-10 gap-2 px-4 text-base">
              <User className="size-4" /> About James
            </TabsTrigger>
            <TabsTrigger value="people" className="h-10 gap-2 px-4 text-base">
              <Users className="size-4" /> People
            </TabsTrigger>
            <TabsTrigger value="places" className="h-10 gap-2 px-4 text-base">
              <MapPin className="size-4" /> Locations
            </TabsTrigger>
            <TabsTrigger value="system" className="h-10 gap-2 px-4 text-base">
              <SlidersHorizontal className="size-4" /> System
            </TabsTrigger>
          </TabsList>

          <TabsContent value="james">
            <JamesProfileCard />
          </TabsContent>
          <TabsContent value="people">
            <PeopleTab />
          </TabsContent>
          <TabsContent value="places">
            <PlacesTab />
          </TabsContent>
          <TabsContent value="system">
            <SystemTab />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

/* -------------------------------- System Tab ------------------------------ */

function SystemTab() {
  const settings = useLiveQuery(() => getSettings(), []);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const fetchVoices = useServerFn(listVoices);
  const tts = useServerFn(synthesizeSpeech);

  useEffect(() => {
    fetchVoices()
      .then((r) => {
        // Only show male voices
        const male = r.voices.filter((v) => {
          const g = (v.labels?.gender ?? "").toLowerCase();
          if (g) return g === "male";
          // Fallback for the curated list (no labels): hard-coded male IDs
          const KNOWN_MALE = new Set([
            "JBFqnCBsd6RMkjVDRZzb", // George
            "TX3LPaxmHKxFdv7VOQHJ", // Liam
            "iP95p4xoKVk53GoZ742B", // Chris
            "nPczCjzI2devNBz1zQrb", // Brian
            "CwhRBWXzGAHq8TQ4Fs17", // Roger
            "IKne3meq5aSn9XLyUdCD", // Charlie
            "N2lVS1w4EtoT3dr4eOWO", // Callum
            "bIHbv24MWmeRgasZH58o", // Will
            "cjVigY5qzO86Huf0OWal", // Eric
            "onwK4e9ZLuTAKqWW03F9", // Daniel
            "pqHfZKP75CvOlQylNhV4", // Bill
          ]);
          return KNOWN_MALE.has(v.voice_id);
        });
        setVoices(male);
      })
      .catch(() => toast.error("Failed to load voices"))
      .finally(() => setLoadingVoices(false));
  }, [fetchVoices]);

  if (!settings) return <Card className="p-6">Loading…</Card>;

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
    } catch {
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

  function addCustomVoice(v: Voice) {
    setVoices((cur) => {
      if (cur.some((x) => x.voice_id === v.voice_id)) return cur;
      return [v, ...cur];
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <h2 className="text-lg font-semibold">Voice</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how the app speaks suggestions out loud. Selection is
          remembered across sessions.
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

        <VoiceDesignerPanel
          onSaved={(v) => {
            addCustomVoice(v);
            handleVoiceChange(v.voice_id);
          }}
        />
      </Card>

      <Card className="p-6">
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

      <Card className="p-6">
        <h2 className="text-lg font-semibold">Display size</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the iPad you mostly use. The home screen scales so all
          suggestions, transcript and controls fit without scrolling.
        </p>
        <div className="mt-4">
          <Select
            value={settings.ipad_model ?? "auto"}
            onValueChange={(v) =>
              updateSettings({ ipad_model: v as IPadModel }).then(() =>
                toast.success("Display size updated"),
              )
            }
          >
            <SelectTrigger className="h-12 text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (use this screen)</SelectItem>
              {Object.entries(IPAD_PRESETS).map(([key, p]) => (
                <SelectItem key={key} value={key}>
                  {p.label} — {p.width}×{p.height}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-6">
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
    </div>
  );
}

/* -------------------------- James Profile editor -------------------------- */

/* ---------------------------- Voice Designer ----------------------------- */

type Preview = {
  generatedVoiceId: string;
  audioBase64: string;
  mime: string;
};

function VoiceDesignerPanel({
  onSaved,
}: {
  onSaved: (v: Voice) => void;
}) {
  const designFn = useServerFn(designVoicePreviews);
  const saveFn = useServerFn(saveDesignedVoice);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(
    "A calm, authoritative 44-year-old middle-class New Zealand man. Warm but understated, measured pace, gentle dry humour, clearly articulated.",
  );
  const [name, setName] = useState("James");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  async function generate() {
    if (description.trim().length < 20) {
      toast.error("Description must be at least 20 characters");
      return;
    }
    setGenerating(true);
    setPreviews([]);
    setChosen(null);
    try {
      const r = await designFn({ data: { description } });
      setPreviews(r.previews);
      if (r.previews[0]) setChosen(r.previews[0].generatedVoiceId);
    } catch (e: any) {
      toast.error(e?.message ?? "Voice design failed");
    } finally {
      setGenerating(false);
    }
  }

  function play(p: Preview) {
    const audio = new Audio(`data:${p.mime};base64,${p.audioBase64}`);
    audio.play().catch(() => toast.error("Playback failed"));
  }

  async function save() {
    if (!chosen) return;
    if (!name.trim()) {
      toast.error("Give the voice a name");
      return;
    }
    setSaving(true);
    try {
      const r = await saveFn({
        data: {
          voiceName: name.trim(),
          description,
          generatedVoiceId: chosen,
        },
      });
      toast.success(`Saved "${r.name}" — now selected`);
      onSaved({
        voice_id: r.voiceId,
        name: r.name,
        labels: { gender: "male", custom: "true" },
      });
      setOpen(false);
      setPreviews([]);
      setChosen(null);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save voice");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Design a custom voice</h3>
          <p className="text-xs text-muted-foreground">
            Describe the voice you want — ElevenLabs will generate 3 candidates
            for you to choose from.
          </p>
        </div>
        <Button
          size="sm"
          variant={open ? "ghost" : "secondary"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Close" : "Open"}
        </Button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <Field
            label="Voice description"
            hint="Age, gender, accent, tone, pace, personality. The more specific, the better."
          >
            <Textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Button onClick={generate} disabled={generating}>
            {generating ? "Generating 3 previews…" : "Generate previews"}
          </Button>

          {previews.length > 0 && (
            <div className="space-y-2">
              <Label className="text-base">Pick your favourite</Label>
              {previews.map((p, i) => (
                <label
                  key={p.generatedVoiceId}
                  className={`flex items-center justify-between gap-3 rounded-lg border-2 p-3 transition cursor-pointer ${
                    chosen === p.generatedVoiceId
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-secondary"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="preview"
                      checked={chosen === p.generatedVoiceId}
                      onChange={() => setChosen(p.generatedVoiceId)}
                    />
                    <span className="font-medium">Candidate {i + 1}</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.preventDefault();
                      play(p);
                    }}
                  >
                    <Volume2 className="size-4" /> Play
                  </Button>
                </label>
              ))}

              <Field label="Save as">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Button onClick={save} disabled={saving || !chosen}>
                {saving ? "Saving…" : "Save and use this voice"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
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

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Display name">
          <Input
            value={draft.display_name}
            onChange={(e) => set("display_name", e.target.value)}
          />
        </Field>
        <Field label="Age">
          <Input
            value={draft.age ?? ""}
            onChange={(e) => set("age", e.target.value)}
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
            rows={3}
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
            rows={4}
            value={draft.current_life_context ?? ""}
            onChange={(e) => set("current_life_context", e.target.value)}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Anything else (freeform)">
            <Textarea
              rows={4}
              value={draft.freeform_notes ?? ""}
              onChange={(e) => set("freeform_notes", e.target.value)}
            />
          </Field>
        </div>
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

/* ------------------------------- People Tab ------------------------------- */

function PeopleTab() {
  const people = useLiveQuery(
    () => db.people.orderBy("name").toArray(),
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const list = people ?? [];
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.relationship ?? "").toLowerCase().includes(q),
    );
  }, [people, filter]);

  // Auto-select first person when none selected
  useEffect(() => {
    if (!selectedId && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selectedId, filtered]);

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
    setSelectedId(p.id);
    toast.success("Saved");
  }

  async function remove(id: string) {
    if (!confirm("Remove this person?")) return;
    await db.people.delete(id);
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <div className="grid gap-4 grid-cols-[260px_1fr] sm:grid-cols-[280px_1fr]">
      {/* Left: people list */}
      <Card className="p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search…"
              className="h-9 pl-7"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={startAdd}>
            <Plus className="size-4" />
          </Button>
        </div>

        <div className="space-y-1">
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-sm italic text-muted-foreground">
              {people?.length === 0
                ? "No people yet. Tap + to add, or names will be auto-added when introduced in conversation."
                : "No matches."}
            </p>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setSelectedId(p.id);
                setEditing(null);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition ${
                selectedId === p.id
                  ? "bg-primary/10 ring-1 ring-primary/40"
                  : "hover:bg-secondary"
              }`}
            >
              <div>
                <div className="font-medium">{p.name}</div>
                {p.relationship && (
                  <div className="text-xs text-muted-foreground">
                    {p.relationship}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* Right: detail */}
      <div>
        {editing ? (
          <PersonEditor
            person={editing}
            isNew={adding}
            onCancel={() => {
              setEditing(null);
              setAdding(false);
            }}
            onSave={save}
          />
        ) : selectedId ? (
          <PersonDetail
            personId={selectedId}
            onEdit={(p) => {
              setEditing(p);
              setAdding(false);
            }}
            onDelete={() => remove(selectedId)}
          />
        ) : (
          <Card className="p-10 text-center text-muted-foreground">
            Select a person from the list, or add a new one.
          </Card>
        )}
      </div>
    </div>
  );
}

function PersonDetail({
  personId,
  onEdit,
  onDelete,
}: {
  personId: string;
  onEdit: (p: Person) => void;
  onDelete: () => void;
}) {
  const person = useLiveQuery(() => db.people.get(personId), [personId]);
  const stats = useLiveQuery(() => getPersonStats(personId), [personId]);

  if (!person) return <Card className="p-6">Loading…</Card>;

  const grouped = stats ? groupMemories(stats.recentMemories) : null;

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">{person.name}</h2>
          {person.relationship && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {person.relationship}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(person)}>
            Edit
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            aria-label="Delete"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* At-a-glance metrics */}
      <div className="mt-5 grid grid-cols-3 gap-3">
        <Stat
          label="Conversations"
          value={stats ? String(stats.conversationCount) : "—"}
        />
        <Stat
          label="Last seen"
          value={
            stats?.lastSeenAt
              ? new Date(stats.lastSeenAt).toLocaleDateString()
              : "—"
          }
        />
        <Stat
          label="Memories"
          value={stats ? String(stats.recentMemories.length) : "—"}
        />
      </div>

      {/* Common locations */}
      <Section
        icon={<MapPin className="size-4" />}
        title="Common locations"
        empty="No location data yet."
      >
        {stats?.commonPlaces.length ? (
          <ul className="space-y-1 text-sm">
            {stats.commonPlaces.map((c) => (
              <li key={c.place.id} className="flex justify-between">
                <span>{c.place.name}</span>
                <span className="text-muted-foreground">
                  {c.count} chat{c.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* Interests */}
      <Section
        icon={<Sparkles className="size-4" />}
        title="Interests"
        empty="No interests recorded."
      >
        {person.interests?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {person.interests.map((i) => (
              <span
                key={i}
                className="rounded-full bg-secondary px-3 py-1 text-xs"
              >
                {i}
              </span>
            ))}
          </div>
        ) : null}
      </Section>

      {/* Notes */}
      {person.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{person.notes}</p>
        </Section>
      )}
      {person.style_notes && (
        <Section title="How James talks with them">
          <p className="whitespace-pre-wrap text-sm">{person.style_notes}</p>
        </Section>
      )}

      {/* Auto-learned memories */}
      <Section
        title="Key facts (auto-learned)"
        empty="The app will collect facts after your next chats."
      >
        {grouped && grouped.fact.length > 0 && (
          <MemoryList items={grouped.fact} />
        )}
      </Section>
      <Section title="Preferences">
        {grouped && grouped.preference.length > 0 ? (
          <MemoryList items={grouped.preference} />
        ) : null}
      </Section>
      <Section title="Recent events / topics">
        {grouped && grouped.event.length > 0 ? (
          <MemoryList items={grouped.event} />
        ) : null}
      </Section>
      <Section title="Open follow-ups">
        {stats?.followUps.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {stats.followUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : null}
      </Section>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
  empty,
}: {
  title: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  empty?: string;
}) {
  const hasChildren =
    children !== null && children !== undefined && children !== false;
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      {hasChildren ? (
        children
      ) : (
        <p className="text-sm italic text-muted-foreground">
          {empty ?? "—"}
        </p>
      )}
    </div>
  );
}

function MemoryList({ items }: { items: { id: string; text: string }[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((m) => (
        <li key={m.id}>{m.text}</li>
      ))}
    </ul>
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
    <Card className="space-y-3 border-2 border-primary/30 p-6">
      <h3 className="text-lg font-semibold">
        {isNew ? "New person" : `Edit ${person.name}`}
      </h3>
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
      <Field
        label="Notes"
        hint="Anything James would want the AI to know about them"
      >
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
    </Card>
  );
}

/* ------------------------------ Locations Tab ----------------------------- */

function PlacesTab() {
  const places = useLiveQuery(
    () => db.places.orderBy("name").toArray(),
    [],
  );
  const [editing, setEditing] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);

  function startAdd() {
    setEditing({
      id: newId(),
      name: "",
      lat: 0,
      lng: 0,
      radius_m: 75,
      notes: "",
      created_at: Date.now(),
    });
  }

  async function useCurrentLocation() {
    if (!editing) return;
    setBusy(true);
    try {
      const pos = await getCurrentPosition();
      setEditing({
        ...editing,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
      toast.success("Location captured");
    } catch {
      toast.error("Could not read GPS");
    } finally {
      setBusy(false);
    }
  }

  async function save(p: Place) {
    if (!p.name.trim()) {
      toast.error("Name is required");
      return;
    }
    await db.places.put(p);
    setEditing(null);
    toast.success("Saved");
  }

  async function remove(id: string) {
    if (!confirm("Remove this location?")) return;
    await db.places.delete(id);
    if (editing?.id === id) setEditing(null);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold">Saved locations</h2>
          <Button size="sm" variant="secondary" onClick={startAdd}>
            <Plus className="size-4" /> Add
          </Button>
        </div>
        <div className="space-y-1">
          {places?.length === 0 && (
            <p className="px-2 py-4 text-sm italic text-muted-foreground">
              No saved locations yet.
            </p>
          )}
          {places?.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-secondary"
            >
              <button
                className="flex-1 text-left"
                onClick={() => setEditing(p)}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {p.lat.toFixed(4)}, {p.lng.toFixed(4)} · {p.radius_m}m
                </div>
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
      </Card>

      <div>
        {editing ? (
          <Card className="space-y-3 border-2 border-primary/30 p-6">
            <h3 className="text-lg font-semibold">
              {editing.name ? `Edit ${editing.name}` : "New location"}
            </h3>
            <Field label="Name" hint="e.g. Home, Library, Mum's house">
              <Input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Latitude">
                <Input
                  type="number"
                  value={editing.lat}
                  onChange={(e) =>
                    setEditing({ ...editing, lat: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Longitude">
                <Input
                  type="number"
                  value={editing.lng}
                  onChange={(e) =>
                    setEditing({ ...editing, lng: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <Button
              variant="secondary"
              onClick={useCurrentLocation}
              disabled={busy}
            >
              <Crosshair className="size-4" />
              {busy ? "Reading GPS…" : "Use current location"}
            </Button>
            <Field label="Radius (metres)">
              <Input
                type="number"
                value={editing.radius_m}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    radius_m: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Notes" hint="Useful context for suggestions here">
              <Textarea
                rows={3}
                value={editing.notes ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, notes: e.target.value })
                }
              />
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => save(editing)}>Save</Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="p-10 text-center text-muted-foreground">
            Select a location to edit, or add a new one.
          </Card>
        )}
      </div>
    </div>
  );
}
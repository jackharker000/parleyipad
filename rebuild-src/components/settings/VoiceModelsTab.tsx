import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Play, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, type SettingsRecord } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { MODEL_OPTIONS, modelsForProviderTier } from "@/lib/modelCatalog";
import { speakText } from "@/lib/audio/speak-text";

/**
 * Voice & Models tab.
 *
 * - Voice section: dropdown sourced from `/api/tts/voices` (5-minute
 *   server-side cache), preview button via the shared `speakText` helper,
 *   paste-by-id fallback, and a "My voices" list bound to
 *   `settings.customVoices`.
 * - LLM section: provider + fast/smart model dropdowns filtered through
 *   `MODEL_OPTIONS`.
 * - STT/TTS provider dropdowns: passed straight through to settings.
 */

type RemoteVoice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl?: string;
};

export function VoiceModelsTab() {
  return (
    <div className="space-y-6">
      <VoiceSection />
      <ModelsSection />
      <STTSection />
    </div>
  );
}

// --------------------------------------------------------------------------

async function persistSettings(patch: Partial<SettingsRecord>) {
  const existing = await db().settings.get("singleton");
  const next: SettingsRecord = {
    id: "singleton",
    llmProvider: "anthropic",
    sttProvider: "elevenlabs-scribe",
    ttsProvider: "elevenlabs-flash",
    speakerIdWebGPU: true,
    speakerIdAcceptThreshold: 0.7,
    speakerIdAskThreshold: 0.45,
    gpsEnabled: false,
    displayPreset: "11",
    ...existing,
    ...patch,
  };
  await db().settings.put(next);
}

// --------------------------------------------------------------------------

function VoiceSection() {
  const settings = useSettings();
  const [remoteVoices, setRemoteVoices] = useState<RemoteVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pasteId, setPasteId] = useState("");
  const [newCustom, setNewCustom] = useState({ voiceId: "", name: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/tts/voices");
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Voices ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as { voices: RemoteVoice[] };
        if (!cancelled) setRemoteVoices(data.voices ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const mergedVoices = useMemo(() => {
    const seen = new Set<string>();
    const out: RemoteVoice[] = [];
    const push = (v: RemoteVoice) => {
      if (seen.has(v.voiceId)) return;
      seen.add(v.voiceId);
      out.push(v);
    };
    for (const v of settings.customVoices ?? []) {
      push({ voiceId: v.voiceId, name: v.name, category: "cloned" });
    }
    if (settings.jamesVoiceId && !seen.has(settings.jamesVoiceId)) {
      push({ voiceId: settings.jamesVoiceId, name: "Current voice", category: "cloned" });
    }
    for (const v of remoteVoices) push(v);
    return out;
  }, [remoteVoices, settings.customVoices, settings.jamesVoiceId]);

  const selectVoice = async (voiceId: string) => {
    await persistSettings({ jamesVoiceId: voiceId || undefined });
    const v = mergedVoices.find((x) => x.voiceId === voiceId);
    toast.success(v ? `Voice set to ${v.name}` : "Voice cleared");
  };

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      await speakText({
        text: "Hello, this is your voice.",
        voiceId: settings.jamesVoiceId,
        ttsProvider: settings.ttsProvider,
      });
    } catch (err) {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  const pasteVoice = async () => {
    const id = pasteId.trim();
    if (!id) return;
    await selectVoice(id);
    setPasteId("");
  };

  const addCustom = async () => {
    const id = newCustom.voiceId.trim();
    const name = newCustom.name.trim();
    if (!id || !name) {
      toast.error("Both voice ID and name are required");
      return;
    }
    const existing = settings.customVoices ?? [];
    if (existing.some((v) => v.voiceId === id)) {
      toast.error("That voice is already saved");
      return;
    }
    await persistSettings({ customVoices: [...existing, { voiceId: id, name }] });
    setNewCustom({ voiceId: "", name: "" });
    toast.success(`Saved ${name}`);
  };

  const updateCustom = async (index: number, patch: { voiceId?: string; name?: string }) => {
    const existing = settings.customVoices ?? [];
    const next = existing.map((v, i) => (i === index ? { ...v, ...patch } : v));
    await persistSettings({ customVoices: next });
  };

  const removeCustom = async (index: number) => {
    const existing = settings.customVoices ?? [];
    const next = existing.filter((_, i) => i !== index);
    await persistSettings({ customVoices: next });
    toast.success("Removed");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice</CardTitle>
        <CardDescription>
          The voice the cockpit uses for suggestions, quick phrases, and type-and-speak. James's
          cloned voice (when uploaded) lives in "My voices".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">Selected voice</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={settings.jamesVoiceId ?? ""}
              onChange={(e) => void selectVoice(e.target.value)}
              disabled={loading}
              className="min-w-[16rem] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Select a voice —</option>
              {mergedVoices.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name} · {v.category}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              onClick={preview}
              disabled={previewing || !settings.jamesVoiceId}
            >
              <Play />
              {previewing ? "Playing…" : "Preview"}
            </Button>
          </div>
          {loading && (
            <p className="text-xs text-muted-foreground">Loading voices from ElevenLabs…</p>
          )}
          {error && <p className="text-xs text-destructive">Failed to load voices: {error}</p>}
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">Paste a voice ID</label>
          <p className="text-xs text-muted-foreground">
            Useful for cloned voices that haven't surfaced in the list yet.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={pasteId}
              onChange={(e) => setPasteId(e.target.value)}
              placeholder="e.g. JBFqnCBsd6RMkjVDRZzb"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button variant="outline" onClick={pasteVoice} disabled={!pasteId.trim()}>
              Save
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">My voices</h3>
              <p className="text-xs text-muted-foreground">
                Custom voice IDs the dropdown above always surfaces.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newCustom.name}
              onChange={(e) => setNewCustom((c) => ({ ...c, name: e.target.value }))}
              placeholder="Name (e.g. James's clone)"
              className="w-full max-w-[14rem] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={newCustom.voiceId}
              onChange={(e) => setNewCustom((c) => ({ ...c, voiceId: e.target.value }))}
              placeholder="Voice ID"
              className="w-full max-w-[14rem] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button
              onClick={addCustom}
              disabled={!newCustom.voiceId.trim() || !newCustom.name.trim()}
            >
              <Plus />
              Add
            </Button>
          </div>

          {settings.customVoices && settings.customVoices.length > 0 ? (
            <ul className="space-y-2">
              {settings.customVoices.map((v, i) => (
                <li
                  key={`${v.voiceId}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-3"
                >
                  <input
                    value={v.name}
                    onChange={(e) => void updateCustom(i, { name: e.target.value })}
                    className="w-full max-w-[12rem] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <input
                    value={v.voiceId}
                    onChange={(e) => void updateCustom(i, { voiceId: e.target.value })}
                    className="w-full max-w-[16rem] flex-1 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <Button variant="ghost" size="sm" onClick={() => void selectVoice(v.voiceId)}>
                    Use
                  </Button>
                  <button
                    type="button"
                    onClick={() => void removeCustom(i)}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={`Remove ${v.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No custom voices saved.</p>
          )}
        </div>
        <VoiceDesignerPanel />
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function ModelsSection() {
  const settings = useSettings();
  const fastOptions = useMemo(
    () => modelsForProviderTier(settings.llmProvider, "fast"),
    [settings.llmProvider],
  );
  const smartOptions = useMemo(
    () => modelsForProviderTier(settings.llmProvider, "smart"),
    [settings.llmProvider],
  );

  // Default to the first available model for the current provider when the
  // saved override doesn't belong to it (e.g. user just switched providers).
  const fastModel =
    settings.fastModel && MODEL_OPTIONS.some((m) => m.id === settings.fastModel)
      ? settings.fastModel
      : (fastOptions[0]?.id ?? "");
  const smartModel =
    settings.smartModel && MODEL_OPTIONS.some((m) => m.id === settings.smartModel)
      ? settings.smartModel
      : (smartOptions[0]?.id ?? "");

  const setProvider = async (provider: SettingsRecord["llmProvider"]) => {
    // Reset the per-tier overrides so the new provider's defaults take over;
    // the server falls back to its env-var default when the override is
    // absent.
    await persistSettings({ llmProvider: provider, fastModel: undefined, smartModel: undefined });
    toast.success(`LLM provider set to ${provider}`);
  };

  const setFastModel = async (id: string) => {
    await persistSettings({ fastModel: id || undefined });
    toast.success("Fast model updated");
  };

  const setSmartModel = async (id: string) => {
    await persistSettings({ smartModel: id || undefined });
    toast.success("Smart model updated");
  };

  const setTTSProvider = async (id: SettingsRecord["ttsProvider"]) => {
    await persistSettings({ ttsProvider: id });
    toast.success(`TTS provider set to ${id}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>LLM &amp; TTS</CardTitle>
        <CardDescription>
          Selecting a provider here decides which server endpoint the cockpit calls; API keys never
          live in the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Row label="LLM provider">
          <select
            value={settings.llmProvider}
            onChange={(e) => void setProvider(e.target.value as SettingsRecord["llmProvider"])}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
          </select>
        </Row>

        <Row label="Fast model" hint="Live suggestions, expand-and-speak. Latency dominates.">
          <select
            value={fastModel}
            onChange={(e) => void setFastModel(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {fastOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Smart model" hint="Summaries, drafts, profile enrichment. Quality dominates.">
          <select
            value={smartModel}
            onChange={(e) => void setSmartModel(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {smartOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="TTS provider">
          <select
            value={settings.ttsProvider}
            onChange={(e) => void setTTSProvider(e.target.value as SettingsRecord["ttsProvider"])}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="elevenlabs-flash">ElevenLabs Flash v2.5</option>
            <option value="cartesia-sonic">Cartesia Sonic 3 (fallback)</option>
          </select>
        </Row>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function STTSection() {
  const settings = useSettings();

  const setSTT = async (id: SettingsRecord["sttProvider"]) => {
    await persistSettings({ sttProvider: id });
    toast.success(`STT provider set to ${id}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speech-to-text</CardTitle>
        <CardDescription>
          ElevenLabs Scribe is the only supported STT right now. Deepgram and on-device Apple are on
          the roadmap.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Row label="STT provider">
          <select
            value={settings.sttProvider}
            onChange={(e) => void setSTT(e.target.value as SettingsRecord["sttProvider"])}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="elevenlabs-scribe">ElevenLabs Scribe</option>
          </select>
        </Row>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// --------------------------------------------------------------------------

type DesignPreview = { generatedVoiceId: string; audioBase64: string; mime: string };

const DEFAULT_DESIGN_DESCRIPTION =
  "A calm, warm middle-aged New Zealand man. Measured pace, gentle dry humour, clearly articulated.";
const DESIGN_DESCRIPTION_MIN = 20;
const DESIGN_DESCRIPTION_MAX = 1000;

function VoiceDesignerPanel() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(DEFAULT_DESIGN_DESCRIPTION);
  const [voiceName, setVoiceName] = useState("James");
  const [previews, setPreviews] = useState<DesignPreview[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setPreviews([]);
    setChosen(null);
  };

  const generate = async () => {
    const desc = description.trim();
    if (desc.length < DESIGN_DESCRIPTION_MIN) {
      toast.error(`Description must be at least ${DESIGN_DESCRIPTION_MIN} characters`);
      return;
    }
    setGenerating(true);
    reset();
    try {
      const res = await fetch("/api/tts/design-previews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: desc }),
      });
      if (!res.ok) {
        // 402 / 403 = the user's ElevenLabs account doesn't have voice
        // design enabled. Tell them clearly so they don't think we broke
        // something — falls back to the existing voice picker above.
        const detail = await res.text();
        if (res.status === 402 || res.status === 403) {
          toast.error(
            "Voice design isn't enabled on this ElevenLabs account. Pick a voice from the catalog above instead.",
          );
        } else {
          toast.error(`Voice design failed (${res.status}): ${detail.slice(0, 200)}`);
        }
        return;
      }
      const json = (await res.json()) as { previews?: DesignPreview[] };
      const list = json.previews ?? [];
      setPreviews(list);
      if (list[0]) setChosen(list[0].generatedVoiceId);
      if (list.length === 0) toast.message("No previews returned");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const play = (p: DesignPreview) => {
    try {
      const audio = new Audio(`data:${p.mime};base64,${p.audioBase64}`);
      void audio.play();
    } catch {
      toast.error("Playback failed");
    }
  };

  const save = async () => {
    if (!chosen) return;
    const name = voiceName.trim();
    if (!name) {
      toast.error("Give the voice a name");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/tts/save-designed-voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voiceName: name,
          description: description.trim(),
          generatedVoiceId: chosen,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        toast.error(`Save failed (${res.status}): ${detail.slice(0, 200)}`);
        return;
      }
      const json = (await res.json()) as { voiceId: string; name: string };

      // Persist the new voice into customVoices + select it. Same shape as
      // the addCustom path above so the rest of the UI (dropdown, preview
      // button) picks it up without further wiring.
      const existing = settings.customVoices ?? [];
      const next = existing.some((v) => v.voiceId === json.voiceId)
        ? existing
        : [...existing, { voiceId: json.voiceId, name: json.name }];
      const current = await db().settings.get("singleton");
      await db().settings.put({
        ...(current ?? {
          id: "singleton",
          llmProvider: "anthropic",
          sttProvider: "elevenlabs-scribe",
          ttsProvider: "elevenlabs-flash",
          speakerIdWebGPU: true,
          speakerIdAcceptThreshold: 0.7,
          speakerIdAskThreshold: 0.45,
          gpsEnabled: false,
          displayPreset: "11",
        }),
        customVoices: next,
        jamesVoiceId: json.voiceId,
      });
      toast.success(`Saved "${json.name}" — now selected`);
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Design a custom voice</h3>
          <p className="text-xs text-muted-foreground">
            Describe the voice — age, accent, tone, pace, personality. ElevenLabs generates a few
            preview voices to pick from. Requires Voice Design on your ElevenLabs plan.
          </p>
        </div>
        <Button variant={open ? "ghost" : "outline"} size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Open"}
        </Button>
      </div>
      {open && (
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Voice description
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESIGN_DESCRIPTION_MAX))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              {description.trim().length} / {DESIGN_DESCRIPTION_MAX} characters
            </p>
          </div>
          <Button onClick={() => void generate()} disabled={generating}>
            {generating ? "Generating previews…" : "Generate previews"}
          </Button>
          {previews.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-foreground">Pick your favourite</p>
              <ul className="space-y-2">
                {previews.map((p, i) => {
                  const isChosen = chosen === p.generatedVoiceId;
                  return (
                    <li
                      key={p.generatedVoiceId}
                      className={`flex items-center justify-between gap-3 rounded-lg border-2 p-3 transition cursor-pointer ${
                        isChosen ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                      }`}
                      onClick={() => setChosen(p.generatedVoiceId)}
                    >
                      <div className="text-sm">Preview {i + 1}</div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            play(p);
                          }}
                        >
                          <Play className="h-4 w-4" />
                          Play
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-end gap-3">
                <div className="grow space-y-1">
                  <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Save as
                  </label>
                  <input
                    value={voiceName}
                    onChange={(e) => setVoiceName(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Voice name"
                  />
                </div>
                <Button onClick={() => void save()} disabled={!chosen || saving}>
                  {saving ? "Saving…" : "Save selected voice"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

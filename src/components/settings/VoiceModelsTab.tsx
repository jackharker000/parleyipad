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
          The voice the cockpit uses for suggestions, quick phrases, and type-and-speak. Your
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
              placeholder="Name (e.g. My clone)"
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

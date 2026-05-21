import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useSetting } from "@/lib/settings";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          One iPad, one user. Choose providers, manage James's voice clone, and tune the speaker-ID
          matcher.
        </p>
      </header>

      <ProvidersCard />
      <SpeakerIdCard />
    </div>
  );
}

function ProvidersCard() {
  const [llm, setLLM] = useSetting("llmProvider");
  const [stt, setSTT] = useSetting("sttProvider");
  const [tts, setTTS] = useSetting("ttsProvider");

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI providers</CardTitle>
        <CardDescription>
          API keys live on the server, not in the browser. Selecting a provider here just decides
          which server endpoint to call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Row label="LLM">
          <Select
            value={llm}
            onChange={setLLM}
            options={[
              { value: "anthropic", label: "Anthropic (Claude)" },
              { value: "openai", label: "OpenAI (GPT)" },
            ]}
          />
        </Row>
        <Row label="STT">
          <Select
            value={stt}
            onChange={setSTT}
            options={[{ value: "elevenlabs-scribe", label: "ElevenLabs Scribe" }]}
          />
        </Row>
        <Row label="TTS">
          <Select
            value={tts}
            onChange={setTTS}
            options={[
              { value: "elevenlabs-flash", label: "ElevenLabs Flash v2.5" },
              { value: "cartesia-sonic", label: "Cartesia Sonic 3 (fallback)" },
            ]}
          />
        </Row>
      </CardContent>
    </Card>
  );
}

function SpeakerIdCard() {
  const [useWebGPU, setUseWebGPU] = useSetting("speakerIdWebGPU");
  const [acceptThreshold, setAcceptThreshold] = useSetting("speakerIdAcceptThreshold");
  const [askThreshold, setAskThreshold] = useSetting("speakerIdAskThreshold");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker ID</CardTitle>
        <CardDescription>
          On-device neural speaker embeddings + Silero VAD + Bayesian context prior.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Row label="Use WebGPU when available">
          <Switch checked={useWebGPU} onCheckedChange={setUseWebGPU} />
        </Row>
        <Row label="Confirm threshold (posterior)">
          <NumberInput
            value={acceptThreshold}
            onChange={setAcceptThreshold}
            min={0.5}
            max={0.99}
            step={0.01}
          />
        </Row>
        <Row label="Ask-name threshold (posterior)">
          <NumberInput
            value={askThreshold}
            onChange={setAskThreshold}
            min={0.3}
            max={0.95}
            step={0.01}
          />
        </Row>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

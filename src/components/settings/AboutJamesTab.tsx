import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { FileText, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, type JamesDocument, type JamesProfile } from "@/lib/db";
import { updateJamesProfile, useJamesProfile } from "@/lib/jamesProfile";

/**
 * About-James tab. Ported from `legacy-src/routes/settings.tsx`'s
 * `JamesProfileCard` + `JamesDocumentsSection` against the rebuild's
 * `JamesProfile` shape (camelCase, `topicsLoved` as `string[]`, etc.).
 *
 * Chips use a textarea-with-CSV-split rather than a custom widget; matches
 * the legacy's textarea-of-tags pattern and keeps a single Save action
 * for the whole form. The reference-documents section caps each upload at
 * 60k chars (legacy MAX_DOC_CHARS) — anything larger is truncated client-side
 * with a toast warning.
 */

const MAX_DOC_CHARS = 60_000;

type Draft = {
  displayName: string;
  age: string;
  background: string;
  personality: string;
  humorStyle: string;
  communicationStyle: string;
  topicsLoved: string;
  topicsAvoided: string;
  signaturePhrases: string;
  currentLifeContext: string;
  notes: string;
};

function draftFromProfile(profile: JamesProfile): Draft {
  return {
    displayName: profile.displayName ?? "",
    age: profile.age ?? "",
    background: profile.background ?? "",
    personality: profile.personality ?? "",
    humorStyle: profile.humorStyle ?? "",
    communicationStyle: profile.communicationStyle ?? "",
    topicsLoved: (profile.topicsLoved ?? []).join(", "),
    topicsAvoided: (profile.topicsAvoided ?? []).join(", "),
    signaturePhrases: (profile.signaturePhrases ?? []).join(", "),
    currentLifeContext: profile.currentLifeContext ?? "",
    notes: profile.notes ?? "",
  };
}

function splitChips(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function AboutJamesTab() {
  return (
    <div className="space-y-6">
      <ProfileCard />
      <DocumentsCard />
    </div>
  );
}

function ProfileCard() {
  const profile = useJamesProfile();
  const [draft, setDraft] = useState<Draft>(() => draftFromProfile(profile));
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate the draft from the loaded profile once. Subsequent edits keep
  // local state so live-query refreshes don't clobber the user's typing.
  // We only re-hydrate after the live row has materialised (updatedAt !== 0
  // is the "real saved row" signal); an empty default profile is left as-is
  // so the form fields don't flicker between the empty default and an
  // already-typed draft.
  useEffect(() => {
    if (hydrated) return;
    if (profile.updatedAt !== 0) {
      setDraft(draftFromProfile(profile));
    }
    setHydrated(true);
  }, [profile, hydrated]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((cur) => ({ ...cur, [key]: value }));

  const save = async () => {
    if (saving) return;
    const trimmedName = draft.displayName.trim();
    if (!trimmedName) {
      toast.error("Display name is required");
      return;
    }
    setSaving(true);
    try {
      await updateJamesProfile({
        displayName: trimmedName,
        age: draft.age.trim() || undefined,
        background: draft.background.trim() || undefined,
        personality: draft.personality.trim() || undefined,
        humorStyle: draft.humorStyle.trim() || undefined,
        communicationStyle: draft.communicationStyle.trim() || undefined,
        topicsLoved: splitChips(draft.topicsLoved),
        topicsAvoided: splitChips(draft.topicsAvoided),
        signaturePhrases: splitChips(draft.signaturePhrases),
        currentLifeContext: draft.currentLifeContext.trim() || undefined,
        notes: draft.notes.trim() || undefined,
      });
      toast.success("Profile saved");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          The richer this is, the more suggestions sound like you. Edit anytime — changes apply to
          the next conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Display name">
            <TextInput
              value={draft.displayName}
              onChange={(v) => set("displayName", v)}
              placeholder="Your name"
              autoComplete="off"
            />
          </Field>
          <Field label="Age">
            <TextInput value={draft.age} onChange={(v) => set("age", v)} placeholder="e.g. 44" />
          </Field>
        </div>

        <Field label="Background" hint="Family, career, where you grew up, important life details">
          <TextareaWithCount
            rows={4}
            value={draft.background}
            onChange={(v) => set("background", v)}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Personality" hint="e.g. warm, dry-witted, hates small talk">
            <TextareaWithCount
              rows={3}
              value={draft.personality}
              onChange={(v) => set("personality", v)}
            />
          </Field>
          <Field label="Humor style" hint="e.g. loves puns, deadpan, self-deprecating">
            <TextareaWithCount
              rows={3}
              value={draft.humorStyle}
              onChange={(v) => set("humorStyle", v)}
            />
          </Field>
          <Field
            label="Communication style"
            hint="Short sentences? Asks questions back? Direct or gentle?"
          >
            <TextareaWithCount
              rows={3}
              value={draft.communicationStyle}
              onChange={(v) => set("communicationStyle", v)}
            />
          </Field>
          <Field
            label="Current life context"
            hint="What's on your mind right now — recent events, what's coming up"
          >
            <TextareaWithCount
              rows={3}
              value={draft.currentLifeContext}
              onChange={(v) => set("currentLifeContext", v)}
            />
          </Field>
        </div>

        <Field label="Topics you love" hint="Comma-separated">
          <TextInput
            value={draft.topicsLoved}
            onChange={(v) => set("topicsLoved", v)}
            placeholder="e.g. cricket, dogs, jazz"
          />
        </Field>
        <Field label="Topics you avoid" hint="Comma-separated">
          <TextInput
            value={draft.topicsAvoided}
            onChange={(v) => set("topicsAvoided", v)}
            placeholder="e.g. politics, health complaints"
          />
        </Field>
        <Field
          label="Signature phrases"
          hint="Comma-separated — actual things you'd say. The AI will reuse these verbatim."
        >
          <TextInput
            value={draft.signaturePhrases}
            onChange={(v) => set("signaturePhrases", v)}
            placeholder={`e.g. "fair dinkum", "she'll be right"`}
          />
        </Field>
        <Field label="Anything else (freeform)">
          <TextareaWithCount rows={6} value={draft.notes} onChange={(v) => set("notes", v)} />
        </Field>

        <div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

const TEXT_LIKE_RE = /^(text\/|application\/(json|xml|csv|x-yaml|x-toml|markdown))/i;
const TEXT_EXT_RE = /\.(txt|md|markdown)$/i;
const EMPTY_DOCS: JamesDocument[] = [];

function DocumentsCard() {
  const docs = useLiveQuery(
    () => db().jamesDocuments.orderBy("createdAt").toArray(),
    [],
    EMPTY_DOCS,
  );
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const isTextLike = TEXT_LIKE_RE.test(file.type) || TEXT_EXT_RE.test(file.name);
    if (!isTextLike) {
      toast.error(`${file.name}: unsupported file type. Use .txt or .md.`);
      return;
    }
    setBusy(true);
    try {
      let text = "";
      try {
        text = await file.text();
      } catch {
        toast.error(`${file.name}: could not read file`);
        return;
      }
      const trimmed = text.slice(0, MAX_DOC_CHARS);
      if (text.length > MAX_DOC_CHARS) {
        toast.warning(
          `${file.name}: truncated to first ${MAX_DOC_CHARS.toLocaleString()} characters`,
        );
      }
      await db().jamesDocuments.put({
        id: nanoid(),
        filename: file.name,
        mimeType: file.type || "text/plain",
        content: trimmed,
        createdAt: Date.now(),
      });
      toast.success(`Attached ${file.name}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this document?")) return;
    await db().jamesDocuments.delete(id);
    toast.success("Document removed");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reference documents</CardTitle>
        <CardDescription>
          Attach background docs the AI should know about you. Plain-text only (.txt, .md). Each
          file is capped at ~60k characters.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label
          className={
            "inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium hover:bg-muted" +
            (busy ? " opacity-60 pointer-events-none" : "")
          }
        >
          <Upload className="h-4 w-4" />
          {busy ? "Reading…" : "Attach a document"}
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              void handleFile(file);
              e.target.value = "";
            }}
          />
        </label>

        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents attached yet.</p>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {d.filename ?? "Untitled document"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.content.length.toLocaleString()} chars
                    {d.content.length >= MAX_DOC_CHARS ? " (truncated)" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(d.id)}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                  aria-label={`Remove ${d.filename ?? "document"}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------

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
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

function TextInput(props: TextInputProps) {
  const { value, onChange, className, ...rest } = props;
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring " +
        (className ?? "")
      }
      {...rest}
    />
  );
}

function TextareaWithCount({
  rows,
  value,
  onChange,
}: {
  rows: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-1 flex justify-end text-xs tabular-nums text-muted-foreground">
        {value.length} chars
      </div>
    </div>
  );
}

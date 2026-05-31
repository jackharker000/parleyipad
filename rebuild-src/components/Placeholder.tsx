import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PlaceholderProps = {
  title: string;
  subtitle: string;
  buildOrderStep: number;
};

export function Placeholder({ title, subtitle, buildOrderStep }: PlaceholderProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Step {buildOrderStep} · not built yet
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-prose text-muted-foreground">{subtitle}</p>
      </div>
      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Intentionally empty</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            The screen layout is locked (see <code>Parley_Screens_Annotated.pdf</code>) but the
            engine isn't ready to back it yet. Build order is in
            <code>CLAUDE.md</code> — speaker-ID first.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

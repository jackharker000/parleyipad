CREATE TABLE public.user_backups (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own backup"
  ON public.user_backups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own backup"
  ON public.user_backups FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own backup"
  ON public.user_backups FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own backup"
  ON public.user_backups FOR DELETE
  USING (auth.uid() = user_id);

-- Tier 3.1 — server-side semantic memory retrieval (pgvector).
--
-- The current client uses Dexie + brute-force cosine in `src/lib/retrieval.ts`
-- (fine for <500 memories per user). This migration provisions the
-- Supabase side so a future build can move the retrieval call server-side
-- when memory volume grows.
--
-- The schema deliberately mirrors the Dexie `Memory` shape so a row can be
-- upserted from the client's snapshot path with one extra column.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.user_memory_embeddings (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id text NOT NULL,
  person_id text,
  place_id text,
  conversation_id text,
  text text NOT NULL,
  kind text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_memory_embeddings_vec_idx
  ON public.user_memory_embeddings
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS user_memory_embeddings_user_person_idx
  ON public.user_memory_embeddings (user_id, person_id);

ALTER TABLE public.user_memory_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner-rw" ON public.user_memory_embeddings
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

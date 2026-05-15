-- Tier 2: post-conversation deep analysis.
--
-- All new schema (profile_proposals, segment_mfccs, multi-centroid voiceprints,
-- relationship_dynamics on people, etc.) lives inside the Dexie-local snapshot
-- already persisted to `public.user_backups.data` as JSONB — so no new tables
-- or columns are required server-side. This migration is a no-op marker so
-- the migration timeline is contiguous with the v8 Dexie schema introduced
-- by Tier 2.
--
-- See:
--   * src/lib/db.ts          (Dexie v8, ProfileProposal, SegmentMfcc)
--   * src/lib/cloud-sync.ts  (TABLES extended)
--   * src/lib/post-conversation.ts (orchestrators)

SELECT 1;

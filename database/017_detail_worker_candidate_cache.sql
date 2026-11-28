-- SkorHane: cache the latest-season nine-league worker cohort once per workflow run.
--
-- The old REST view recalculated season detection, player membership ranking, and
-- team sharding on every one of the 45 worker requests. This materialized snapshot
-- keeps the same endpoint and assignment semantics while making shard reads indexed.

begin;

create materialized view public.tm_detail_preseed_candidates_by_team_worker_cache as
select
  tm_id,
  name,
  team_name,
  position,
  photo_url,
  last_synced_at,
  last_felipe_synced_at,
  last_squad_seen_at,
  worker_competition_id,
  worker_shard_id,
  worker_club_id,
  worker_club_name,
  competition_team_count
from public.tm_detail_preseed_candidates_by_team_worker
with data;

-- The source view assigns each Transfermarkt player to exactly one league/team shard.
-- This unique key both asserts that invariant and supports REFRESH ... CONCURRENTLY.
create unique index tm_detail_preseed_worker_cache_tm_id_uq
  on public.tm_detail_preseed_candidates_by_team_worker_cache (tm_id);

-- Equality filters on league+shard followed by stable player ordering.
create index tm_detail_preseed_worker_cache_lookup_idx
  on public.tm_detail_preseed_candidates_by_team_worker_cache
  (worker_competition_id, worker_shard_id, tm_id);

revoke all on table public.tm_detail_preseed_candidates_by_team_worker_cache
  from public, anon, authenticated;
grant select on table public.tm_detail_preseed_candidates_by_team_worker_cache
  to service_role;

-- Keep the existing REST endpoint name and security_invoker access semantics.
create or replace view public.tm_detail_preseed_candidates_by_team_worker
with (security_invoker = true)
as
select
  tm_id,
  name,
  team_name,
  position,
  photo_url,
  last_synced_at,
  last_felipe_synced_at,
  last_squad_seen_at,
  worker_competition_id,
  worker_shard_id,
  worker_club_id,
  worker_club_name,
  competition_team_count
from public.tm_detail_preseed_candidates_by_team_worker_cache;

revoke all on public.tm_detail_preseed_candidates_by_team_worker
  from public, anon, authenticated;
grant select on public.tm_detail_preseed_candidates_by_team_worker
  to service_role;

comment on materialized view public.tm_detail_preseed_candidates_by_team_worker_cache is
  'Cached latest-season nine-league player-to-team-shard assignments. Refreshed once before each worker fan-out; readers use indexed league/shard lookup.';

-- Called once by the workflow preflight before the 45-job matrix begins.
-- Advisory locking prevents overlapping hourly/manual workflow runs from refreshing
-- the same materialized view at the same time; CONCURRENTLY keeps readers online.
create or replace function public.tm_refresh_detail_preseed_candidates_cache()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  refreshed_rows bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(90726051, 20261128);

  refresh materialized view concurrently
    public.tm_detail_preseed_candidates_by_team_worker_cache;

  select count(*) into refreshed_rows
  from public.tm_detail_preseed_candidates_by_team_worker_cache;

  return pg_catalog.jsonb_build_object(
    'row_count', refreshed_rows,
    'refreshed_at', pg_catalog.clock_timestamp()
  );
end;
$function$;

revoke all on function public.tm_refresh_detail_preseed_candidates_cache()
  from public, anon, authenticated;
grant execute on function public.tm_refresh_detail_preseed_candidates_cache()
  to service_role;

notify pgrst, 'reload schema';

commit;

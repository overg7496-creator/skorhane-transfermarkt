-- SkorHane profile-read verification.
-- This file is intentionally compact: one indexed coverage check and one
-- profile RPC call for one player. Leaderboard verification is in
-- verify_leaderboard_source_truth.sql.
-- Change these four values for another league/season/player.
with params as (
  select
    'TR1'::text as competition_id,
    'TR1'::text as competition_code,
    '2026'::text as season_id,
    '401923'::text as tm_id
),
roster as materialized (
  select distinct q.tm_id
  from public.tm_team_season_squads q
  join params p
    on q.competition_id = p.competition_id
   and q.season_id = p.season_id
),
completed_checkpoints as materialized (
  select distinct r.external_id as tm_id
  from public.tm_source_records r
  join params p on true
  where r.source = 'felipeall'
    and r.record_type = 'league_stats_player_checkpoint'
    and r.payload @> jsonb_build_object(
      'coverage_version', 2,
      'status', 'completed',
      'completed_scope_keys', jsonb_build_array(p.competition_code || ':' || p.season_id)
    )
),
coverage as (
  select
    (select count(*) from roster) as roster_players,
    (select count(*) from roster x join completed_checkpoints c using (tm_id)) as completed_players,
    (select count(*) from roster x left join completed_checkpoints c using (tm_id)
      where c.tm_id is null) as missing_players
),
target_profile as materialized (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
)
select jsonb_pretty(
  jsonb_build_object(
    'competition_id', (select competition_id from params),
    'season_id', (select season_id from params),
    'coverage_v2', (select to_jsonb(c) from coverage c),
    'target_tm_id', (select tm_id from params),
    'target_player_rows', jsonb_build_object(
      'player_profile', (select bundle->'player' is not null from target_profile),
      'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats', '[]'::jsonb)) from target_profile),
      'appearances', (select jsonb_array_length(coalesce(bundle->'appearances', '[]'::jsonb)) from target_profile),
      'transfers', (select jsonb_array_length(coalesce(bundle->'transfers', '[]'::jsonb)) from target_profile),
      'market_values', (select jsonb_array_length(coalesce(bundle->'market_values', '[]'::jsonb)) from target_profile),
      'injuries', (select jsonb_array_length(coalesce(bundle->'injuries', '[]'::jsonb)) from target_profile),
      'absences', (select jsonb_array_length(coalesce(bundle->'absences', '[]'::jsonb)) from target_profile)
    )
  )
) as skorhane_profile_read_verification;

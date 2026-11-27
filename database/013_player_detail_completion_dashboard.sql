-- SkorHane: per-league player detail completion dashboard.
-- Apply after 011_detail_preseed_scope.sql and the core schema migrations.
-- The player cohort is the same one used by the detail preseed job:
-- nine leagues, season starts 2022-2026, one row per player per league.
--
-- A section is "completed" only when its latest source snapshot is newer than
-- the worker's effective refresh cutoff and contains the expected array field.
-- Empty arrays count as a completed check (the provider was checked and had no
-- records); the separate *_with_data columns distinguish empty from populated.
-- Default freshness mirrors sync_transfermarkt.py: max(now()-7 days, repair cutoff).

begin;

create or replace function public.tm_detail_payload_has_array(
  p_payload jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then false
    else exists (
      select 1
      from unnest(coalesce(p_keys, array[]::text[])) as k(key)
      where jsonb_typeof(p_payload -> k.key) = 'array'
    )
  end;
$$;

create or replace function public.tm_detail_payload_has_items(
  p_payload jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then false
    else exists (
      select 1
      from unnest(coalesce(p_keys, array[]::text[])) as k(key)
      where jsonb_typeof(p_payload -> k.key) = 'array'
        and jsonb_array_length(p_payload -> k.key) > 0
    )
  end;
$$;

create index if not exists tm_source_records_player_detail_dashboard_idx
  on public.tm_source_records (external_id, record_type, fetched_at desc, id desc)
  where source = 'felipeall'
    and record_type in (
      'player_profile',
      'player_stats',
      'player_market_values',
      'player_transfers',
      'player_injuries',
      'player_absences',
      'current_season_matches'
    );

create or replace view public.tm_league_player_detail_sync_dashboard
with (security_invoker = true)
as
with refresh_policy as (
  select greatest(
    now() - interval '7 days',
    timestamptz '2026-11-26 12:00:00+00'
  ) as refresh_cutoff
),
league_members as materialized (
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    q.tm_id
  from public.tm_team_season_squads q
  where q.competition_id in (
    'TR1', 'TR2', 'TR3A', 'TR3B',
    'GB1', 'ES1', 'L1', 'IT1', 'FR1'
  )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
    and nullif(trim(q.tm_id), '') is not null
  group by q.competition_id, q.tm_id
),
latest_snapshots as materialized (
  select distinct on (r.external_id, r.record_type)
    r.external_id as tm_id,
    r.record_type,
    r.payload,
    r.fetched_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type in (
      'player_profile',
      'player_stats',
      'player_market_values',
      'player_transfers',
      'player_injuries',
      'player_absences',
      'current_season_matches'
    )
    and nullif(r.external_id, '') is not null
  order by r.external_id, r.record_type, r.fetched_at desc, r.id desc
),
player_snapshot_status as (
  select
    s.tm_id,

    bool_or(
      s.record_type = 'player_profile'
      and s.fetched_at >= rp.refresh_cutoff
      and jsonb_typeof(s.payload) = 'object'
      and coalesce(s.payload, '{}'::jsonb) <> '{}'::jsonb
    ) as profile_completed,

    bool_or(
      s.record_type = 'player_market_values'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(
        s.payload,
        array['marketValueHistory','market_value_history','history','marketValues','valuations','items','data']
      )
    ) as market_value_completed,
    bool_or(
      s.record_type = 'player_market_values'
      and public.tm_detail_payload_has_items(
        s.payload,
        array['marketValueHistory','market_value_history','history','marketValues','valuations','items','data']
      )
    ) as market_value_has_data,

    bool_or(
      s.record_type = 'player_stats'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(s.payload, array['stats','data','items'])
    ) as career_stats_completed,
    bool_or(
      s.record_type = 'player_stats'
      and public.tm_detail_payload_has_items(s.payload, array['stats','data','items'])
    ) as career_stats_has_data,

    bool_or(
      s.record_type = 'player_transfers'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(s.payload, array['transfers','history','items','data'])
    ) as transfers_completed,
    bool_or(
      s.record_type = 'player_transfers'
      and public.tm_detail_payload_has_items(s.payload, array['transfers','history','items','data'])
    ) as transfers_have_data,

    bool_or(
      s.record_type = 'player_injuries'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(s.payload, array['injuries','data','items'])
    ) as injuries_completed,
    bool_or(
      s.record_type = 'player_injuries'
      and public.tm_detail_payload_has_items(s.payload, array['injuries','data','items'])
    ) as injuries_have_data,

    bool_or(
      s.record_type = 'player_absences'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(s.payload, array['absences','data','items'])
    ) as absences_completed,
    bool_or(
      s.record_type = 'player_absences'
      and public.tm_detail_payload_has_items(s.payload, array['absences','data','items'])
    ) as absences_have_data,

    bool_or(
      s.record_type = 'current_season_matches'
      and s.fetched_at >= rp.refresh_cutoff
      and public.tm_detail_payload_has_array(s.payload, array['matches','matchHistory','data','items'])
    ) as current_season_matches_completed,

    max(s.fetched_at) filter (where s.record_type = 'player_profile') as profile_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'player_market_values') as market_value_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'player_stats') as career_stats_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'player_transfers') as transfers_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'player_injuries') as injuries_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'player_absences') as absences_last_checked_at,
    max(s.fetched_at) filter (where s.record_type = 'current_season_matches') as current_season_matches_last_checked_at
  from latest_snapshots s
  cross join refresh_policy rp
  group by s.tm_id
),
player_status as (
  select
    m.competition_id,
    m.competition_name,
    m.tm_id,
    coalesce(src.profile_completed, false) as profile_completed,
    coalesce(src.market_value_completed, false) as market_value_completed,
    coalesce(src.market_value_has_data, false)
      or p.current_market_value_eur is not null
      or nullif(trim(p.current_market_value_text), '') is not null as market_value_has_data,
    coalesce(src.career_stats_completed, false) as career_stats_completed,
    coalesce(src.career_stats_has_data, false) as career_stats_has_data,
    coalesce(src.transfers_completed, false) as transfers_completed,
    coalesce(src.transfers_have_data, false) as transfers_have_data,
    coalesce(src.injuries_completed, false) as injuries_completed,
    coalesce(src.injuries_have_data, false) as injuries_have_data,
    coalesce(src.absences_completed, false) as absences_completed,
    coalesce(src.absences_have_data, false) as absences_have_data,
    coalesce(src.current_season_matches_completed, false) as current_season_matches_completed,
    (p.last_felipe_synced_at >= rp.refresh_cutoff) as full_detail_sync_completed,
    src.profile_last_checked_at,
    src.market_value_last_checked_at,
    src.career_stats_last_checked_at,
    src.transfers_last_checked_at,
    src.injuries_last_checked_at,
    src.absences_last_checked_at,
    src.current_season_matches_last_checked_at
  from league_members m
  cross join refresh_policy rp
  left join public.tm_players p on p.tm_id = m.tm_id
  left join player_snapshot_status src on src.tm_id = m.tm_id
)
select
  competition_id,
  max(competition_name) as competition_name,
  count(*)::bigint as player_count,
  count(*) filter (where full_detail_sync_completed)::bigint as players_with_full_detail_sync_completed,
  (count(*) - count(*) filter (where full_detail_sync_completed))::bigint as players_remaining_full_detail_sync,

  count(*) filter (where profile_completed)::bigint as players_with_profile_completed,
  (count(*) - count(*) filter (where profile_completed))::bigint as players_remaining_profile,

  count(*) filter (where market_value_completed)::bigint as players_with_market_value_completed,
  (count(*) - count(*) filter (where market_value_completed))::bigint as players_remaining_market_value,
  count(*) filter (where market_value_has_data)::bigint as players_with_market_value_data,

  count(*) filter (where career_stats_completed)::bigint as players_with_career_stats_completed,
  (count(*) - count(*) filter (where career_stats_completed))::bigint as players_remaining_career_stats,
  count(*) filter (where career_stats_has_data)::bigint as players_with_career_stats_data,

  count(*) filter (where transfers_completed)::bigint as players_with_transfers_completed,
  (count(*) - count(*) filter (where transfers_completed))::bigint as players_remaining_transfers,
  count(*) filter (where transfers_have_data)::bigint as players_with_transfer_history_data,

  count(*) filter (where injuries_completed)::bigint as players_with_injuries_completed,
  (count(*) - count(*) filter (where injuries_completed))::bigint as players_remaining_injuries,
  count(*) filter (where injuries_have_data)::bigint as players_with_injury_records,

  count(*) filter (where absences_completed)::bigint as players_with_absences_completed,
  (count(*) - count(*) filter (where absences_completed))::bigint as players_remaining_absences,
  count(*) filter (where absences_have_data)::bigint as players_with_absence_records,

  count(*) filter (where current_season_matches_completed)::bigint as players_with_current_season_matches_completed,
  (count(*) - count(*) filter (where current_season_matches_completed))::bigint as players_remaining_current_season_matches,

  count(*) filter (
    where market_value_completed
      and career_stats_completed
      and transfers_completed
      and injuries_completed
  )::bigint as players_with_all_four_core_sections_completed,
  count(*) filter (
    where not (
      market_value_completed
      and career_stats_completed
      and transfers_completed
      and injuries_completed
    )
  )::bigint as players_missing_at_least_one_core_section,

  round(
    count(*) filter (where market_value_completed)::numeric * 100
    / nullif(count(*), 0), 1
  ) as market_value_completion_pct,
  round(
    count(*) filter (where career_stats_completed)::numeric * 100
    / nullif(count(*), 0), 1
  ) as career_stats_completion_pct,
  round(
    count(*) filter (where transfers_completed)::numeric * 100
    / nullif(count(*), 0), 1
  ) as transfers_completion_pct,
  round(
    count(*) filter (where injuries_completed)::numeric * 100
    / nullif(count(*), 0), 1
  ) as injuries_completion_pct,
  round(
    count(*) filter (
      where market_value_completed
        and career_stats_completed
        and transfers_completed
        and injuries_completed
    )::numeric * 100 / nullif(count(*), 0), 1
  ) as all_four_core_sections_completion_pct,

  max(profile_last_checked_at) as profile_last_checked_at,
  max(market_value_last_checked_at) as market_value_last_checked_at,
  max(career_stats_last_checked_at) as career_stats_last_checked_at,
  max(transfers_last_checked_at) as transfers_last_checked_at,
  max(injuries_last_checked_at) as injuries_last_checked_at,
  max(absences_last_checked_at) as absences_last_checked_at,
  max(current_season_matches_last_checked_at) as current_season_matches_last_checked_at,
  (select refresh_cutoff from refresh_policy) as refresh_cutoff
from player_status
group by competition_id;

revoke all on function public.tm_detail_payload_has_array(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.tm_detail_payload_has_array(jsonb, text[]) to service_role;
revoke all on function public.tm_detail_payload_has_items(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.tm_detail_payload_has_items(jsonb, text[]) to service_role;

revoke all on public.tm_league_player_detail_sync_dashboard from public, anon, authenticated;
grant select on public.tm_league_player_detail_sync_dashboard to service_role;

comment on view public.tm_league_player_detail_sync_dashboard is
  'Per-league count of players whose market-value, career-stats, transfers and injury endpoints have fresh, valid snapshots; counts each player once per league across seasons 2022-2026. Empty result arrays still count as checked; *_with_data columns distinguish real records from a successful empty response.';

commit;

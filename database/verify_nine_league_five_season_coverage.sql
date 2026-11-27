-- One-row-per-league/season audit for the requested 9 leagues x 5 seasons.
-- Run after database/010_indexed_league_season_cache.sql and the full sync.
with requested_matrix(competition_id, season_id) as (
  values
    ('TR1', '2022'),
    ('TR1', '2023'),
    ('TR1', '2024'),
    ('TR1', '2025'),
    ('TR1', '2026'),
    ('TR2', '2022'),
    ('TR2', '2023'),
    ('TR2', '2024'),
    ('TR2', '2025'),
    ('TR2', '2026'),
    ('TR3A', '2022'),
    ('TR3A', '2023'),
    ('TR3A', '2024'),
    ('TR3A', '2025'),
    ('TR3A', '2026'),
    ('TR3B', '2022'),
    ('TR3B', '2023'),
    ('TR3B', '2024'),
    ('TR3B', '2025'),
    ('TR3B', '2026'),
    ('GB1', '2022'),
    ('GB1', '2023'),
    ('GB1', '2024'),
    ('GB1', '2025'),
    ('GB1', '2026'),
    ('ES1', '2022'),
    ('ES1', '2023'),
    ('ES1', '2024'),
    ('ES1', '2025'),
    ('ES1', '2026'),
    ('L1', '2022'),
    ('L1', '2023'),
    ('L1', '2024'),
    ('L1', '2025'),
    ('L1', '2026'),
    ('IT1', '2022'),
    ('IT1', '2023'),
    ('IT1', '2024'),
    ('IT1', '2025'),
    ('IT1', '2026'),
    ('FR1', '2022'),
    ('FR1', '2023'),
    ('FR1', '2024'),
    ('FR1', '2025'),
    ('FR1', '2026')
),
roster_player_rows as (
  select distinct
    q.competition_id,
    public.tm_leader_season_start_year(q.season_id)::text as season_id,
    q.tm_id
  from public.tm_team_season_squads q
  join requested_matrix m
    on m.competition_id = q.competition_id
   and m.season_id = public.tm_leader_season_start_year(q.season_id)::text
  where coalesce(q.tm_id, '') <> ''
),
roster as (
  select competition_id, season_id, count(distinct tm_id)::bigint as roster_players
  from roster_player_rows
  group by competition_id, season_id
),
completed_checkpoints as (
  select
    split_part(scope_row.scope_key, ':', 1) as competition_id,
    split_part(scope_row.scope_key, ':', 2) as season_id,
    count(distinct r.external_id)::bigint as completed_players
  from public.tm_source_records r
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(r.payload->'completed_scope_keys') = 'array'
        then r.payload->'completed_scope_keys'
      else '[]'::jsonb
    end
  ) as scope_row(scope_key)
  where r.source = 'felipeall'
    and r.record_type = 'league_stats_player_checkpoint'
    and r.record_key = 'v3_TR1-TR2-TR3A-TR3B-GB1-ES1-L1-IT1-FR1_2022-2023-2024-2025-2026'
    and r.payload->>'coverage_version' = '3'
    and r.payload->>'status' = 'completed'
    and scope_row.scope_key ~ '^(TR1|TR2|TR3A|TR3B|GB1|ES1|L1|IT1|FR1):(2022|2023|2024|2025|2026)$'
  group by 1, 2
),
cache_totals as (
  select
    c.competition_id,
    c.season_id,
    count(distinct c.tm_id)::bigint as cached_players,
    count(*) filter (
      where coalesce(c.appearances, 0) = 0
        and coalesce(c.goals, 0) = 0
        and coalesce(c.assists, 0) = 0
    )::bigint as zero_appearance_players
  from public.tm_league_player_season_totals_cache c
  join requested_matrix m
    on m.competition_id = c.competition_id
   and m.season_id = c.season_id
  group by c.competition_id, c.season_id
),
cached_roster as (
  select
    r.competition_id,
    r.season_id,
    count(distinct r.tm_id) filter (where c.tm_id is not null)::bigint as cached_roster_players
  from roster_player_rows r
  left join public.tm_league_player_season_totals_cache c
    on c.competition_id = r.competition_id
   and c.season_id = r.season_id
   and c.tm_id = r.tm_id
  group by r.competition_id, r.season_id
)
select
  m.competition_id,
  m.season_id,
  coalesce(r.roster_players, 0) as roster_players,
  coalesce(k.completed_players, 0) as completed_checkpoint_players,
  greatest(coalesce(r.roster_players, 0) - coalesce(k.completed_players, 0), 0) as missing_checkpoints,
  coalesce(cr.cached_roster_players, 0) as cached_roster_players,
  greatest(coalesce(r.roster_players, 0) - coalesce(cr.cached_roster_players, 0), 0) as missing_cache_rows,
  coalesce(c.cached_players, 0) as total_cached_players,
  coalesce(c.zero_appearance_players, 0) as zero_appearance_players,
  case
    when coalesce(r.roster_players, 0) = 0 then 'KADRO BULUNAMADI'
    when greatest(coalesce(r.roster_players, 0) - coalesce(k.completed_players, 0), 0) = 0
     and greatest(coalesce(r.roster_players, 0) - coalesce(cr.cached_roster_players, 0), 0) = 0
      then 'TAMAM'
    else 'EKSİK'
  end as coverage_status
from requested_matrix m
left join roster r using (competition_id, season_id)
left join completed_checkpoints k using (competition_id, season_id)
left join cache_totals c using (competition_id, season_id)
left join cached_roster cr using (competition_id, season_id)
order by m.competition_id, m.season_id;

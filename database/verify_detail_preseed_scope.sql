-- Run after 011_detail_preseed_scope.sql and 012_leaderboard_and_detail_query_indexes.sql.
-- Optimized verification: filter the indexed roster scope once, deduplicate once,
-- then aggregate counts. Output is the same 45 league/season combinations.

select
  count(*)::bigint as scoped_unique_players,
  count(*) filter (where last_felipe_synced_at is not null)::bigint as detail_completed,
  count(*) filter (where last_felipe_synced_at is null)::bigint as detail_remaining
from public.tm_detail_preseed_candidates;

with requested_matrix(competition_id, season_id) as (
  values
    ('TR1', '2022'), ('TR1', '2023'), ('TR1', '2024'), ('TR1', '2025'), ('TR1', '2026'),
    ('TR2', '2022'), ('TR2', '2023'), ('TR2', '2024'), ('TR2', '2025'), ('TR2', '2026'),
    ('TR3A', '2022'), ('TR3A', '2023'), ('TR3A', '2024'), ('TR3A', '2025'), ('TR3A', '2026'),
    ('TR3B', '2022'), ('TR3B', '2023'), ('TR3B', '2024'), ('TR3B', '2025'), ('TR3B', '2026'),
    ('GB1', '2022'), ('GB1', '2023'), ('GB1', '2024'), ('GB1', '2025'), ('GB1', '2026'),
    ('ES1', '2022'), ('ES1', '2023'), ('ES1', '2024'), ('ES1', '2025'), ('ES1', '2026'),
    ('L1', '2022'), ('L1', '2023'), ('L1', '2024'), ('L1', '2025'), ('L1', '2026'),
    ('IT1', '2022'), ('IT1', '2023'), ('IT1', '2024'), ('IT1', '2025'), ('IT1', '2026'),
    ('FR1', '2022'), ('FR1', '2023'), ('FR1', '2024'), ('FR1', '2025'), ('FR1', '2026')
),
scoped_roster as materialized (
  select distinct
    q.competition_id,
    public.tm_leader_season_start_year(q.season_id)::text as season_id,
    q.tm_id
  from public.tm_team_season_squads q
  where q.competition_id in (
    'TR1', 'TR2', 'TR3A', 'TR3B', 'GB1', 'ES1', 'L1', 'IT1', 'FR1'
  )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
    and coalesce(q.tm_id, '') <> ''
),
coverage as (
  select
    r.competition_id,
    r.season_id,
    count(*)::bigint as unique_roster_players,
    count(*) filter (
      where p.last_felipe_synced_at is not null
    )::bigint as details_completed,
    count(*) filter (
      where p.last_felipe_synced_at is null
    )::bigint as details_remaining
  from scoped_roster r
  left join public.tm_players p on p.tm_id = r.tm_id
  group by r.competition_id, r.season_id
)
select
  m.competition_id,
  m.season_id,
  coalesce(c.unique_roster_players, 0)::bigint as unique_roster_players,
  coalesce(c.details_completed, 0)::bigint as details_completed,
  coalesce(c.details_remaining, 0)::bigint as details_remaining
from requested_matrix m
left join coverage c
  on c.competition_id = m.competition_id
 and c.season_id = m.season_id
order by m.competition_id, m.season_id;

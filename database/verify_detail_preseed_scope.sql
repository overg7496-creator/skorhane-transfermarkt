-- Run after database/011_detail_preseed_scope.sql.
-- Summary: one unique Transfermarkt player per tm_id, across the nine leagues/five seasons.
select
  count(*)::bigint as scoped_unique_players,
  count(*) filter (where last_felipe_synced_at is not null)::bigint as detail_completed,
  count(*) filter (where last_felipe_synced_at is null)::bigint as detail_remaining
from public.tm_detail_preseed_candidates;

-- Per league/season: unique rostered player IDs and their detail status.
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
scoped_roster as (
  select distinct
    q.competition_id,
    public.tm_leader_season_start_year(q.season_id)::text as season_id,
    q.tm_id
  from public.tm_team_season_squads q
  join requested_matrix m
    on m.competition_id = q.competition_id
   and m.season_id = public.tm_leader_season_start_year(q.season_id)::text
  where coalesce(q.tm_id, '') <> ''
)
select
  m.competition_id,
  m.season_id,
  count(distinct r.tm_id)::bigint as unique_roster_players,
  count(distinct r.tm_id) filter (
    where p.last_felipe_synced_at is not null
  )::bigint as details_completed,
  count(distinct r.tm_id) filter (
    where p.last_felipe_synced_at is null
  )::bigint as details_remaining
from requested_matrix m
left join scoped_roster r
  on r.competition_id = m.competition_id
 and r.season_id = m.season_id
left join public.tm_players p on p.tm_id = r.tm_id
group by m.competition_id, m.season_id
order by m.competition_id, m.season_id;

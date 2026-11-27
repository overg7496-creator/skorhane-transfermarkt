-- Assign every unique historical player to exactly one league worker.
-- Player details are global to a Transfermarkt ID, so this prevents duplicate
-- concurrent fetches when the same player appeared in more than one league.
begin;

create or replace view public.tm_detail_preseed_candidates_by_worker
with (security_invoker = true)
as
with league_members as (
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
ranked_members as (
  select
    lm.competition_id,
    lm.competition_name,
    lm.tm_id,
    row_number() over (
      partition by lm.tm_id
      order by case lm.competition_id
        when 'TR1' then 1
        when 'TR2' then 2
        when 'TR3A' then 3
        when 'TR3B' then 4
        when 'GB1' then 5
        when 'ES1' then 6
        when 'L1' then 7
        when 'IT1' then 8
        when 'FR1' then 9
        else 99
      end
    ) as worker_rank
  from league_members lm
)
select
  p.tm_id,
  p.name,
  p.team_name,
  p.position,
  p.photo_url,
  p.last_synced_at,
  p.last_felipe_synced_at,
  p.last_squad_seen_at,
  rm.competition_id as worker_competition_id
from ranked_members rm
join public.tm_players p on p.tm_id = rm.tm_id
where rm.worker_rank = 1;

revoke all on public.tm_detail_preseed_candidates_by_worker from public, anon, authenticated;
grant select on public.tm_detail_preseed_candidates_by_worker to service_role;

comment on view public.tm_detail_preseed_candidates_by_worker is
  'Unique player pool for parallel detail sync: each Transfermarkt player in the nine leagues and 2022-2026 roster seasons is assigned to exactly one deterministic league worker to prevent concurrent duplicate processing.';

commit;

-- Team allocation per league. All eligible clubs are counted, including clubs whose
-- historical players are already owned by another league's unique-player partition.
with team_pool as (
  select
    q.competition_id,
    q.club_id
  from public.tm_team_season_squads q
  where q.competition_id in (
    'TR1', 'TR2', 'TR3A', 'TR3B', 'GB1', 'ES1', 'L1', 'IT1', 'FR1'
  )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
    and nullif(trim(q.club_id), '') is not null
    and nullif(trim(q.tm_id), '') is not null
  group by q.competition_id, q.club_id
),
team_shards as (
  select
    competition_id,
    club_id,
    ntile(5) over (
      partition by competition_id
      order by club_id
    )::integer as worker_shard_id
  from team_pool
)
select
  s.competition_id,
  s.worker_shard_id,
  count(distinct s.club_id)::bigint as assigned_teams,
  count(distinct v.tm_id)::bigint as assigned_players
from team_shards s
left join public.tm_detail_preseed_candidates_by_team_worker v
  on v.worker_competition_id = s.competition_id
 and v.worker_shard_id = s.worker_shard_id
 and v.worker_club_id = s.club_id
group by s.competition_id, s.worker_shard_id
order by
  case s.competition_id
    when 'TR1' then 1 when 'TR2' then 2 when 'TR3A' then 3
    when 'TR3B' then 4 when 'GB1' then 5 when 'ES1' then 6
    when 'L1' then 7 when 'IT1' then 8 when 'FR1' then 9 else 99
  end,
  s.worker_shard_id;

-- Must return no rows: a player may be assigned to only one league/team shard.
select tm_id, count(*) as worker_count
from public.tm_detail_preseed_candidates_by_team_worker
group by tm_id
having count(*) > 1
order by tm_id;

-- Must return no rows: a club must never be split across two shards of one league.
select worker_competition_id, worker_club_id, count(distinct worker_shard_id) as shard_count
from public.tm_detail_preseed_candidates_by_team_worker
group by worker_competition_id, worker_club_id
having count(distinct worker_shard_id) > 1
order by worker_competition_id, worker_club_id;


-- Must return no rows: every league has five shards; team counts differ by at most one.
with team_pool as (
  select q.competition_id, q.club_id
  from public.tm_team_season_squads q
  where q.competition_id in (
    'TR1', 'TR2', 'TR3A', 'TR3B', 'GB1', 'ES1', 'L1', 'IT1', 'FR1'
  )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
    and nullif(trim(q.club_id), '') is not null
    and nullif(trim(q.tm_id), '') is not null
  group by q.competition_id, q.club_id
),
team_shards as (
  select competition_id, club_id,
         ntile(5) over (partition by competition_id order by club_id)::integer as worker_shard_id
  from team_pool
),
shard_sizes as (
  select competition_id, worker_shard_id, count(*)::integer as team_count
  from team_shards
  group by competition_id, worker_shard_id
)
select competition_id,
       count(*) as shard_count,
       min(team_count) as min_teams,
       max(team_count) as max_teams
from shard_sizes
group by competition_id
having count(*) <> 5 or max(team_count) - min(team_count) > 1;

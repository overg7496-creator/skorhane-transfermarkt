-- Current/latest season roster team allocation per league.
-- Every league must have exactly five balanced shards.
with latest_seasons as (
  select q.competition_id,
         max(public.tm_leader_season_start_year(q.season_id)) as latest_season_start_year
  from public.tm_team_season_squads q
  where q.competition_id in ('TR1','TR2','TR3A','TR3B','GB1','ES1','L1','IT1','FR1')
    and nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
  group by q.competition_id
),
team_pool as (
  select distinct q.competition_id, q.club_id
  from public.tm_team_season_squads q
  join latest_seasons ls
    on ls.competition_id = q.competition_id
   and public.tm_leader_season_start_year(q.season_id) = ls.latest_season_start_year
  where nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
),
team_shards as (
  select competition_id, club_id,
         ntile(5) over (partition by competition_id order by club_id)::integer as worker_shard_id
  from team_pool
)
select s.competition_id, s.worker_shard_id,
       count(distinct s.club_id)::bigint as assigned_teams,
       count(distinct v.tm_id)::bigint as assigned_players
from team_shards s
left join public.tm_detail_preseed_candidates_by_team_worker v
  on v.worker_competition_id=s.competition_id
 and v.worker_shard_id=s.worker_shard_id
 and v.worker_club_id=s.club_id
group by s.competition_id,s.worker_shard_id
order by s.competition_id,s.worker_shard_id;

-- Must return no rows: no duplicate player ownership across workers.
select tm_id,count(*) as worker_count
from public.tm_detail_preseed_candidates_by_team_worker
group by tm_id
having count(*)>1;

-- Must return no rows: every assigned player belongs to that league's latest season.
with latest_seasons as (
  select q.competition_id,
         max(public.tm_leader_season_start_year(q.season_id)) as latest_season_start_year
  from public.tm_team_season_squads q
  where q.competition_id in ('TR1','TR2','TR3A','TR3B','GB1','ES1','L1','IT1','FR1')
    and nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
  group by q.competition_id
),
latest_memberships as (
  select distinct q.tm_id,q.competition_id,q.club_id
  from public.tm_team_season_squads q
  join latest_seasons ls
    on ls.competition_id=q.competition_id
   and public.tm_leader_season_start_year(q.season_id)=ls.latest_season_start_year
  where nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
)
select v.tm_id,v.worker_competition_id,v.worker_club_id
from public.tm_detail_preseed_candidates_by_team_worker v
left join latest_memberships lm
  on lm.tm_id=v.tm_id
 and lm.competition_id=v.worker_competition_id
 and lm.club_id=v.worker_club_id
where lm.tm_id is null;

-- Must return no rows: current-season memberships must not be omitted.
with latest_seasons as (
  select q.competition_id,
         max(public.tm_leader_season_start_year(q.season_id)) as latest_season_start_year
  from public.tm_team_season_squads q
  where q.competition_id in ('TR1','TR2','TR3A','TR3B','GB1','ES1','L1','IT1','FR1')
    and nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
  group by q.competition_id
),
latest_memberships as (
  select distinct q.tm_id,q.competition_id,q.club_id
  from public.tm_team_season_squads q
  join latest_seasons ls
    on ls.competition_id=q.competition_id
   and public.tm_leader_season_start_year(q.season_id)=ls.latest_season_start_year
  where nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
)
select lm.tm_id,lm.competition_id,lm.club_id
from latest_memberships lm
left join public.tm_detail_preseed_candidates_by_team_worker v
  on v.tm_id=lm.tm_id
 and v.worker_competition_id=lm.competition_id
 and v.worker_club_id=lm.club_id
where v.tm_id is null;

-- Must return no rows: a club must never be split across two shards.
select worker_competition_id,worker_club_id,
       count(distinct worker_shard_id) as shard_count
from public.tm_detail_preseed_candidates_by_team_worker
group by worker_competition_id,worker_club_id
having count(distinct worker_shard_id)>1;

-- Must return no rows: all nine leagues have five shards, balanced within one team.
with sizes as (
  select worker_competition_id,worker_shard_id,
         count(distinct worker_club_id)::integer as teams
  from public.tm_detail_preseed_candidates_by_team_worker
  group by worker_competition_id,worker_shard_id
)
select worker_competition_id,count(*) as shard_count,
       min(teams) as min_teams,max(teams) as max_teams
from sizes
group by worker_competition_id
having count(*)<>5 or max(teams)-min(teams)>1;

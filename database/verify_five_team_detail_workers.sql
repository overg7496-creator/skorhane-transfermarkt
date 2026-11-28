-- Per-league assignment sizes. Team counts across the five shards must differ by at most one.
select
  worker_competition_id,
  worker_shard_id,
  max(competition_team_count)::integer as league_team_count,
  count(distinct worker_club_id)::bigint as assigned_teams,
  count(distinct tm_id)::bigint as assigned_players
from public.tm_detail_preseed_candidates_by_team_worker
group by worker_competition_id, worker_shard_id
order by
  case worker_competition_id
    when 'TR1' then 1 when 'TR2' then 2 when 'TR3A' then 3
    when 'TR3B' then 4 when 'GB1' then 5 when 'ES1' then 6
    when 'L1' then 7 when 'IT1' then 8 when 'FR1' then 9 else 99
  end,
  worker_shard_id;

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

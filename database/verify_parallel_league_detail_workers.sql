-- Progress by assigned league worker. Each player must appear in exactly one worker partition.
select
  worker_competition_id,
  count(*)::bigint as assigned_players,
  count(distinct tm_id)::bigint as unique_players
from public.tm_detail_preseed_candidates_by_worker
group by worker_competition_id
order by case worker_competition_id
  when 'TR1' then 1 when 'TR2' then 2 when 'TR3A' then 3
  when 'TR3B' then 4 when 'GB1' then 5 when 'ES1' then 6
  when 'L1' then 7 when 'IT1' then 8 when 'FR1' then 9 else 99
end;

-- This query must return zero rows: no player is assigned to multiple workers.
select tm_id, count(*) as worker_count
from public.tm_detail_preseed_candidates_by_worker
group by tm_id
having count(*) > 1
order by tm_id;

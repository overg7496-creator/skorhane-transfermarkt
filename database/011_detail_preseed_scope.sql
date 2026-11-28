-- Restrict historical player-detail preseed to all twelve Transfermarkt competitions
-- and the five season starts 2022..2026. The view intentionally includes
-- already-completed players so the importer can report stable total/completed/
-- pending counts; Python filters completed players before making API requests.
begin;

create or replace view public.tm_detail_preseed_candidates
with (security_invoker = true)
as
select
  p.tm_id,
  p.name,
  p.team_name,
  p.position,
  p.photo_url,
  p.last_synced_at,
  p.last_felipe_synced_at,
  p.last_squad_seen_at
from public.tm_players p
where exists (
  select 1
  from public.tm_team_season_squads q
  where q.tm_id = p.tm_id
    and q.competition_id in (
      'TR1', 'TR2', 'TR3A', 'TR3B', 'TR4A', 'TR4B', 'TR4C',
      'GB1', 'ES1', 'L1', 'IT1', 'FR1'
    )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
);

revoke all on public.tm_detail_preseed_candidates from anon, authenticated;
grant select on public.tm_detail_preseed_candidates to service_role;

comment on view public.tm_detail_preseed_candidates is
  'Unique players with roster membership in TR1, TR2, TR3A, TR3B, TR4A, TR4B, TR4C, GB1, ES1, L1, IT1 or FR1 during seasons 2022-2026; includes completed profiles so the preseed worker can report stable progress.';

commit;

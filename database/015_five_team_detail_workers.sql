-- SkorHane: split each of the nine historical detail cohorts into five balanced team shards.
-- Players remain globally unique: one Transfermarkt ID belongs to one deterministic
-- league and its latest eligible club membership. Team shards are balanced by distinct
-- club IDs across the 2022-2026 historical squad scope (not by player count).
begin;

create or replace view public.tm_detail_preseed_candidates_by_team_worker
with (security_invoker = true)
as
with eligible_members as (
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    q.season_id,
    q.club_id,
    max(q.club_name) as club_name,
    q.tm_id,
    public.tm_leader_season_start_year(q.season_id) as season_start_year
  from public.tm_team_season_squads q
  where q.competition_id in (
    'TR1', 'TR2', 'TR3A', 'TR3B', 'GB1', 'ES1', 'L1', 'IT1', 'FR1'
  )
    and public.tm_leader_season_start_year(q.season_id) between 2022 and 2026
    and nullif(trim(q.tm_id), '') is not null
    and nullif(trim(q.club_id), '') is not null
  group by q.competition_id, q.season_id, q.club_id, q.tm_id
),
team_pool as (
  select
    competition_id,
    club_id,
    max(club_name) as club_name
  from eligible_members
  group by competition_id, club_id
),
numbered_teams as (
  select
    competition_id,
    club_id,
    club_name,
    ntile(5) over (
      partition by competition_id
      order by club_id
    )::integer as worker_shard_id,
    count(*) over (partition by competition_id)::integer as competition_team_count
  from team_pool
),
ranked_player_memberships as (
  select
    em.*,
    row_number() over (
      partition by em.tm_id
      order by
        case em.competition_id
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
        end,
        em.season_start_year desc,
        em.season_id desc,
        em.club_id asc
    ) as player_rank
  from eligible_members em
),
assigned_players as (
  select *
  from ranked_player_memberships
  where player_rank = 1
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
  ap.competition_id as worker_competition_id,
  nt.worker_shard_id,
  ap.club_id as worker_club_id,
  ap.club_name as worker_club_name,
  nt.competition_team_count
from assigned_players ap
join numbered_teams nt
  on nt.competition_id = ap.competition_id
 and nt.club_id = ap.club_id
join public.tm_players p
  on p.tm_id = ap.tm_id;

revoke all on public.tm_detail_preseed_candidates_by_team_worker from public, anon, authenticated;
grant select on public.tm_detail_preseed_candidates_by_team_worker to service_role;

comment on view public.tm_detail_preseed_candidates_by_team_worker is
  'Five balanced team shards per detail league. Each player ID is assigned once globally to one league and one latest eligible club membership; clubs are partitioned by NTILE(5) across roster seasons 2022-2026.';

commit;

-- SkorHane additive season/leaderboard migration.
-- Safe to re-run. It preserves existing player history and adds a season-keyed
-- squad snapshot so historical rosters do not depend on tm_players' latest profile_payload.

create table if not exists public.tm_team_season_squads (
  id bigserial primary key,
  competition_id text not null,
  competition_name text not null default '',
  season_id text not null,
  club_id text not null,
  club_name text not null default '',
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  player_name text not null default '',
  position text,
  photo_url text,
  shirt_number integer,
  age integer,
  nationality jsonb,
  contract_expires text,
  market_value_eur numeric,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (competition_id, season_id, club_id, tm_id)
);

create index if not exists tm_team_season_squads_lookup_idx
  on public.tm_team_season_squads (competition_id, season_id, club_id);
create index if not exists tm_team_season_squads_player_idx
  on public.tm_team_season_squads (tm_id, season_id desc);

create or replace function public.tm_upsert_team_season_squad(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(p_row->>'competition_id',''), '') = ''
     or coalesce(nullif(p_row->>'season_id',''), '') = ''
     or coalesce(nullif(p_row->>'club_id',''), '') = ''
     or coalesce(nullif(p_row->>'tm_id',''), '') = '' then
    raise exception 'competition_id, season_id, club_id and tm_id are required';
  end if;

  insert into public.tm_team_season_squads (
    competition_id, competition_name, season_id, club_id, club_name,
    tm_id, player_name, position, photo_url, shirt_number, age,
    nationality, contract_expires, market_value_eur, payload
  ) values (
    p_row->>'competition_id',
    coalesce(nullif(p_row->>'competition_name',''), ''),
    p_row->>'season_id',
    p_row->>'club_id',
    coalesce(nullif(p_row->>'club_name',''), ''),
    p_row->>'tm_id',
    coalesce(nullif(p_row->>'player_name',''), p_row->>'tm_id'),
    nullif(p_row->>'position',''),
    nullif(p_row->>'photo_url',''),
    case when coalesce(p_row->>'shirt_number','') ~ '^[0-9]+$' then (p_row->>'shirt_number')::integer end,
    case when coalesce(p_row->>'age','') ~ '^[0-9]+$' then (p_row->>'age')::integer end,
    case when p_row ? 'nationality' and p_row->'nationality' <> 'null'::jsonb then p_row->'nationality' end,
    nullif(p_row->>'contract_expires',''),
    nullif(p_row->>'market_value_eur','')::numeric,
    public.tm_clean_jsonb(p_row->'payload')
  )
  on conflict (competition_id, season_id, club_id, tm_id) do update set
    competition_name = coalesce(nullif(excluded.competition_name,''), tm_team_season_squads.competition_name),
    club_name = coalesce(nullif(excluded.club_name,''), tm_team_season_squads.club_name),
    player_name = coalesce(nullif(excluded.player_name,''), tm_team_season_squads.player_name),
    position = coalesce(excluded.position, tm_team_season_squads.position),
    photo_url = coalesce(excluded.photo_url, tm_team_season_squads.photo_url),
    shirt_number = coalesce(excluded.shirt_number, tm_team_season_squads.shirt_number),
    age = coalesce(excluded.age, tm_team_season_squads.age),
    nationality = coalesce(excluded.nationality, tm_team_season_squads.nationality),
    contract_expires = coalesce(excluded.contract_expires, tm_team_season_squads.contract_expires),
    market_value_eur = coalesce(excluded.market_value_eur, tm_team_season_squads.market_value_eur),
    payload = public.tm_merge_jsonb(tm_team_season_squads.payload, excluded.payload),
    updated_at = now();
end;
$$;

-- One row per player/team/competition/season. The competition and club names are
-- matched as well as IDs so cup statistics are not accidentally added to league totals.
create or replace view public.tm_team_season_player_stats
with (security_invoker = true)
as
select
  q.competition_id, q.competition_name, q.season_id, q.club_id, q.club_name,
  q.tm_id, q.player_name, q.position, q.photo_url, q.shirt_number, q.age,
  q.nationality, q.market_value_eur,
  coalesce(sum(s.appearances), 0)::bigint as appearances,
  coalesce(sum(s.starts), 0)::bigint as starts,
  coalesce(sum(s.goals), 0)::bigint as goals,
  coalesce(sum(s.assists), 0)::bigint as assists,
  coalesce(sum(s.minutes), 0)::bigint as minutes,
  coalesce(sum(s.yellow_cards), 0)::bigint as yellow_cards,
  coalesce(sum(s.second_yellow_cards), 0)::bigint as second_yellow_cards,
  coalesce(sum(s.red_cards), 0)::bigint as red_cards,
  coalesce(sum(s.goals_conceded), 0)::bigint as goals_conceded,
  coalesce(sum(s.clean_sheets), 0)::bigint as clean_sheets
from public.tm_team_season_squads q
left join public.tm_player_season_stats s
  on s.tm_id = q.tm_id
 and (s.season_id = q.season_id or s.season_id like q.season_id || '/%' or s.season_id like q.season_id || '-%')
 and lower(trim(coalesce(s.competition_name,''))) = lower(trim(q.competition_name))
 and lower(trim(coalesce(s.club_name,''))) = lower(trim(q.club_name))
group by
  q.competition_id, q.competition_name, q.season_id, q.club_id, q.club_name,
  q.tm_id, q.player_name, q.position, q.photo_url, q.shirt_number, q.age,
  q.nationality, q.market_value_eur;

create or replace view public.tm_league_player_season_totals
with (security_invoker = true)
as
select
  competition_id, max(competition_name) as competition_name, season_id,
  tm_id, max(player_name) as player_name, max(photo_url) as photo_url,
  string_agg(distinct club_name, ' / ' order by club_name) as club_name,
  sum(appearances)::bigint as appearances,
  sum(starts)::bigint as starts,
  sum(goals)::bigint as goals,
  sum(assists)::bigint as assists,
  sum(minutes)::bigint as minutes,
  sum(yellow_cards)::bigint as yellow_cards,
  sum(second_yellow_cards)::bigint as second_yellow_cards,
  sum(red_cards)::bigint as red_cards,
  sum(goals_conceded)::bigint as goals_conceded,
  sum(clean_sheets)::bigint as clean_sheets
from public.tm_team_season_player_stats
group by competition_id, season_id, tm_id;

create or replace view public.tm_league_goal_leaders
with (security_invoker = true)
as
select
  row_number() over (
    partition by competition_id, season_id
    order by goals desc, assists desc, minutes desc, player_name
  )::integer as leader_rank,
  *
from public.tm_league_player_season_totals
where goals > 0;

create or replace view public.tm_league_assist_leaders
with (security_invoker = true)
as
select
  row_number() over (
    partition by competition_id, season_id
    order by assists desc, goals desc, minutes desc, player_name
  )::integer as leader_rank,
  *
from public.tm_league_player_season_totals
where assists > 0;

create or replace view public.tm_team_season_summary
with (security_invoker = true)
as
select
  competition_id, max(competition_name) as competition_name, season_id,
  club_id, max(club_name) as club_name,
  count(distinct tm_id)::integer as player_count,
  round(avg(age)::numeric, 1) as average_age,
  sum(coalesce(market_value_eur,0))::numeric as squad_market_value_eur,
  sum(appearances)::bigint as player_appearances,
  sum(starts)::bigint as player_starts,
  sum(goals)::bigint as goals,
  sum(assists)::bigint as assists,
  sum(minutes)::bigint as minutes,
  sum(yellow_cards)::bigint as yellow_cards,
  sum(red_cards)::bigint as red_cards,
  sum(goals_conceded)::bigint as goals_conceded,
  sum(clean_sheets)::bigint as clean_sheets
from public.tm_team_season_player_stats
group by competition_id, season_id, club_id;

-- All team/league history remains private; only the Worker service role reads these views.
alter table public.tm_team_season_squads enable row level security;
revoke all on public.tm_team_season_squads from anon, authenticated;
grant all on public.tm_team_season_squads to service_role;
grant usage, select on sequence public.tm_team_season_squads_id_seq to service_role;

revoke all on function public.tm_upsert_team_season_squad(jsonb) from public, anon, authenticated;
grant execute on function public.tm_upsert_team_season_squad(jsonb) to service_role;

revoke all on public.tm_team_season_player_stats from anon, authenticated;
revoke all on public.tm_league_player_season_totals from anon, authenticated;
revoke all on public.tm_league_goal_leaders from anon, authenticated;
revoke all on public.tm_league_assist_leaders from anon, authenticated;
revoke all on public.tm_team_season_summary from anon, authenticated;
grant select on public.tm_team_season_player_stats to service_role;
grant select on public.tm_league_player_season_totals to service_role;
grant select on public.tm_league_goal_leaders to service_role;
grant select on public.tm_league_assist_leaders to service_role;
grant select on public.tm_team_season_summary to service_role;

-- Includes inactive/former players from imported historical squads whose full
-- Transfermarkt profile snapshots have not yet been populated.
create or replace view public.tm_detail_preseed_candidates
with (security_invoker = true)
as
select
  p.tm_id, p.name, p.team_name, p.position, p.photo_url,
  p.last_synced_at, p.last_felipe_synced_at, p.last_squad_seen_at
from public.tm_players p
where p.last_felipe_synced_at is null
  and exists (
    select 1
    from public.tm_team_season_squads q
    where q.tm_id = p.tm_id
  );

revoke all on public.tm_detail_preseed_candidates from anon, authenticated;
grant select on public.tm_detail_preseed_candidates to service_role;

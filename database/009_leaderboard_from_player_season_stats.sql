-- SkorHane: build league-season player totals directly from normalized player stats.
-- Apply after the repaired 008 migration. Migration 008 provides the helper functions;
-- migration 007 is optional and may already have been applied. This migration is re-runnable.
-- Unlike the old read model, player inclusion never depends on a matching squad row.
begin;

alter table public.tm_player_season_stats
  add column if not exists competition_id text,
  add column if not exists club_id text;

create index if not exists tm_player_season_stats_leader_scope_v4_idx
  on public.tm_player_season_stats (competition_id, season_id, tm_id);

create or replace view public.tm_league_player_season_totals
with (security_invoker = true)
as
with stats_base as (
  select
    s.id,
    s.tm_id,
    public.tm_leader_season_start_year(s.season_id) as season_start_year,
    coalesce(
      nullif(trim(s.competition_id), ''),
      nullif(s.payload#>>'{league_stats_sync,competition_id}', ''),
      nullif(s.payload->>'competition_id', ''),
      nullif(s.payload->>'competitionId', ''),
      nullif(s.payload#>>'{competition,id}', '')
    ) as raw_competition_id,
    coalesce(
      nullif(trim(s.club_id), ''),
      nullif(s.payload#>>'{league_stats_sync,club_id}', ''),
      nullif(s.payload->>'club_id', ''),
      nullif(s.payload->>'clubId', ''),
      nullif(s.payload#>>'{club,id}', ''),
      nullif(s.payload#>>'{team,id}', ''),
      case when coalesce(trim(s.club_name), '') ~ '^[0-9]+$' then trim(s.club_name) end
    ) as raw_club_id,
    coalesce(nullif(trim(s.competition_name), ''), '') as competition_name,
    coalesce(nullif(trim(s.club_name), ''), '') as club_name,
    s.appearances,
    s.starts,
    s.goals,
    s.assists,
    s.minutes,
    s.yellow_cards,
    s.second_yellow_cards,
    s.red_cards,
    s.goals_conceded,
    s.clean_sheets,
    s.payload,
    s.updated_at
  from public.tm_player_season_stats s
  where public.tm_leader_season_start_year(s.season_id) is not null
),
resolved_competition as (
  select
    b.*,
    coalesce(
      comp_lookup.competition_id,
      b.raw_competition_id,
      case when b.competition_name ~ '^[0-9]+$' then b.competition_name end,
      case
        when public.tm_leader_normalize_name(b.competition_name) <> ''
          then 'name:' || public.tm_leader_normalize_name(b.competition_name)
      end
    ) as canonical_competition_id,
    coalesce(
      nullif(comp_lookup.competition_name, ''),
      b.competition_name,
      b.raw_competition_id,
      ''
    ) as canonical_competition_name
  from stats_base b
  left join lateral (
    -- Search every team row in this league/season, not only this player's row.
    select
      min(q.competition_id) as competition_id,
      min(nullif(q.competition_name, '')) as competition_name
    from public.tm_team_season_squads q
    where public.tm_leader_season_start_year(q.season_id) = b.season_start_year
      and (
        (b.raw_competition_id is not null and q.competition_id = b.raw_competition_id)
        or (
          public.tm_leader_normalize_name(q.competition_name) =
            public.tm_leader_normalize_name(b.competition_name)
          and (
            b.raw_competition_id is null
            or ((b.raw_competition_id ~ '^[0-9]+$') <> (q.competition_id ~ '^[0-9]+$'))
          )
        )
      )
    having count(distinct q.competition_id) = 1
  ) comp_lookup on true
),
resolved_team as (
  select
    b.*,
    coalesce(
      team_lookup.club_id,
      b.raw_club_id,
      case when b.club_name ~ '^[0-9]+$' then b.club_name end
    ) as canonical_club_id,
    coalesce(
      nullif(team_lookup.club_name, ''),
      case
        when b.club_name ~ '^[0-9]+$' then 'Kulüp #' || b.club_name
        when b.club_name <> '' then b.club_name
        when b.raw_club_id is not null then 'Kulüp #' || b.raw_club_id
      end,
      ''
    ) as canonical_club_name
  from resolved_competition b
  left join lateral (
    -- Club enrichment is optional: missing squad data never removes the stats row.
    select
      min(q.club_id) as club_id,
      min(nullif(q.club_name, '')) as club_name
    from public.tm_team_season_squads q
    where q.tm_id = b.tm_id
      and public.tm_leader_season_start_year(q.season_id) = b.season_start_year
      and q.competition_id = b.canonical_competition_id
      and (
        (b.raw_club_id is not null and q.club_id = b.raw_club_id)
        or (
          public.tm_leader_normalize_name(q.club_name) =
            public.tm_leader_normalize_name(b.club_name)
          and (
            b.raw_club_id is null
            or ((b.raw_club_id ~ '^[0-9]+$') <> (q.club_id ~ '^[0-9]+$'))
          )
        )
      )
    having count(distinct q.club_id) = 1
  ) team_lookup on true
),
deduplicated_team_seasons as (
  -- One row per player/competition/start-season/club stint; aliases are not summed twice.
  select distinct on (
    b.canonical_competition_id,
    b.season_start_year,
    case
      when b.canonical_club_id is not null then 'id:' || b.canonical_club_id
      else 'name:' || public.tm_leader_normalize_name(b.canonical_club_name)
    end,
    b.tm_id
  )
    b.canonical_competition_id as competition_id,
    b.canonical_competition_name as competition_name,
    b.season_start_year,
    b.tm_id,
    b.canonical_club_name as club_name,
    b.appearances,
    b.starts,
    b.goals,
    b.assists,
    b.minutes,
    b.yellow_cards,
    b.second_yellow_cards,
    b.red_cards,
    b.goals_conceded,
    b.clean_sheets
  from resolved_team b
  where coalesce(b.canonical_competition_id, '') <> ''
    and public.tm_leader_normalize_name(b.canonical_club_name) <> ''
  order by
    b.canonical_competition_id,
    b.season_start_year,
    case
      when b.canonical_club_id is not null then 'id:' || b.canonical_club_id
      else 'name:' || public.tm_leader_normalize_name(b.canonical_club_name)
    end,
    b.tm_id,
    b.updated_at desc nulls last,
    b.id desc
)
select
  d.competition_id,
  max(d.competition_name) as competition_name,
  d.season_start_year::text as season_id,
  d.tm_id,
  coalesce(max(nullif(p.name, '')), d.tm_id) as player_name,
  max(p.photo_url) as photo_url,
  string_agg(distinct d.club_name, ' / ' order by d.club_name) as club_name,
  sum(coalesce(d.appearances, 0))::bigint as appearances,
  sum(coalesce(d.starts, 0))::bigint as starts,
  sum(coalesce(d.goals, 0))::bigint as goals,
  sum(coalesce(d.assists, 0))::bigint as assists,
  sum(coalesce(d.minutes, 0))::bigint as minutes,
  sum(coalesce(d.yellow_cards, 0))::bigint as yellow_cards,
  sum(coalesce(d.second_yellow_cards, 0))::bigint as second_yellow_cards,
  sum(coalesce(d.red_cards, 0))::bigint as red_cards,
  sum(coalesce(d.goals_conceded, 0))::bigint as goals_conceded,
  sum(coalesce(d.clean_sheets, 0))::bigint as clean_sheets
from deduplicated_team_seasons d
join public.tm_players p on p.tm_id = d.tm_id
group by d.competition_id, d.season_start_year, d.tm_id;

create or replace view public.tm_league_goal_leaders
with (security_invoker = true)
as
select
  dense_rank() over (
    partition by competition_id, season_id
    order by goals desc
  )::integer as leader_rank,
  *
from public.tm_league_player_season_totals
where goals > 0;

create or replace view public.tm_league_assist_leaders
with (security_invoker = true)
as
select
  dense_rank() over (
    partition by competition_id, season_id
    order by assists desc
  )::integer as leader_rank,
  *
from public.tm_league_player_season_totals
where assists > 0;

revoke all on public.tm_league_player_season_totals from anon, authenticated;
revoke all on public.tm_league_goal_leaders from anon, authenticated;
revoke all on public.tm_league_assist_leaders from anon, authenticated;
grant select on public.tm_league_player_season_totals to service_role;
grant select on public.tm_league_goal_leaders to service_role;
grant select on public.tm_league_assist_leaders to service_role;

comment on view public.tm_league_player_season_totals is
  'One row per player/competition/start-season; built from tm_player_season_stats without requiring a squad match.';
comment on view public.tm_league_goal_leaders is
  'Complete goals leaderboard from direct normalized player-season statistics; tied values share ranks.';
comment on view public.tm_league_assist_leaders is
  'Complete assists leaderboard from direct normalized player-season statistics; tied values share ranks.';

commit;

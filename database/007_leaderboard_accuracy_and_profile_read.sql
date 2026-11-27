-- SkorHane: accurate competition/season player totals and one-call profile reads.
-- Apply after migrations 001-006 in Supabase SQL Editor. Safe to re-run.

begin;

alter table public.tm_player_season_stats
  add column if not exists competition_id text,
  add column if not exists club_id text;

-- Recover provider IDs that were already present in the raw Felipe payload but
-- were not copied into the normalized season-stat columns.
update public.tm_player_season_stats s
set
  competition_id = coalesce(
    nullif(s.competition_id, ''),
    nullif(s.payload->>'competition_id', ''),
    nullif(s.payload->>'competitionId', ''),
    nullif(s.payload->>'competitionID', ''),
    nullif(s.payload#>>'{competition,id}', ''),
    case when coalesce(s.competition_name, '') ~ '^[0-9]+$' then s.competition_name end
  ),
  club_id = coalesce(
    nullif(s.club_id, ''),
    nullif(s.payload->>'club_id', ''),
    nullif(s.payload->>'clubId', ''),
    nullif(s.payload->>'clubID', ''),
    nullif(s.payload#>>'{club,id}', ''),
    nullif(s.payload#>>'{team,id}', ''),
    case when coalesce(s.club_name, '') ~ '^[0-9]+$' then s.club_name end
  )
where s.competition_id is null or s.club_id is null;

create index if not exists tm_player_season_stats_leader_lookup_idx
  on public.tm_player_season_stats (tm_id, competition_id, club_id);

create index if not exists tm_player_season_stats_leader_season_idx
  on public.tm_player_season_stats (season_id, competition_id, club_id, tm_id);

create or replace function public.tm_leader_season_start_year(p_season text)
returns integer
language sql
immutable
parallel safe
as $$
  select case
    when substring(coalesce(p_season, '') from '((19|20)[0-9]{2})') is not null
      then substring(coalesce(p_season, '') from '((19|20)[0-9]{2})')::integer
    when substring(coalesce(p_season, '') from '([0-9]{2})[[:space:]]*[/.-]') is not null
      then case
        when substring(coalesce(p_season, '') from '([0-9]{2})[[:space:]]*[/.-]')::integer >= 50
          then 1900 + substring(coalesce(p_season, '') from '([0-9]{2})[[:space:]]*[/.-]')::integer
        else 2000 + substring(coalesce(p_season, '') from '([0-9]{2})[[:space:]]*[/.-]')::integer
      end
    else null
  end;
 $$;

create or replace function public.tm_leader_normalize_name(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
    lower(translate(coalesce(p_value, ''), 'ıİğĞüÜşŞöÖçÇ', 'iigguussoocc')),
    '[^a-z0-9]+',
    '',
    'g'
  );
$$;

-- Keep the ingestion RPC compatible with existing callers while persisting
-- competition_id and club_id. Non-null existing values are never overwritten by null.
create or replace function public.tm_upsert_season_stat(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tm_player_season_stats(
    tm_id, season_id, competition_name, club_name, competition_id, club_id,
    appearances, starts, goals, assists, minutes, yellow_cards, second_yellow_cards,
    red_cards, goals_conceded, clean_sheets, payload, source
  ) values (
    p_row->>'tm_id',
    p_row->>'season_id',
    coalesce(p_row->>'competition_name',''),
    coalesce(p_row->>'club_name',''),
    nullif(p_row->>'competition_id',''),
    nullif(p_row->>'club_id',''),
    nullif(p_row->>'appearances','')::integer,
    nullif(p_row->>'starts','')::integer,
    nullif(p_row->>'goals','')::integer,
    nullif(p_row->>'assists','')::integer,
    nullif(p_row->>'minutes','')::integer,
    nullif(p_row->>'yellow_cards','')::integer,
    nullif(p_row->>'second_yellow_cards','')::integer,
    nullif(p_row->>'red_cards','')::integer,
    nullif(p_row->>'goals_conceded','')::integer,
    nullif(p_row->>'clean_sheets','')::integer,
    public.tm_clean_jsonb(p_row->'payload'),
    coalesce(p_row->>'source','unknown')
  )
  on conflict (tm_id, season_id, competition_name, club_name) do update set
    competition_id = coalesce(excluded.competition_id, tm_player_season_stats.competition_id),
    club_id = coalesce(excluded.club_id, tm_player_season_stats.club_id),
    appearances = coalesce(excluded.appearances, tm_player_season_stats.appearances),
    starts = coalesce(excluded.starts, tm_player_season_stats.starts),
    goals = coalesce(excluded.goals, tm_player_season_stats.goals),
    assists = coalesce(excluded.assists, tm_player_season_stats.assists),
    minutes = coalesce(excluded.minutes, tm_player_season_stats.minutes),
    yellow_cards = coalesce(excluded.yellow_cards, tm_player_season_stats.yellow_cards),
    second_yellow_cards = coalesce(excluded.second_yellow_cards, tm_player_season_stats.second_yellow_cards),
    red_cards = coalesce(excluded.red_cards, tm_player_season_stats.red_cards),
    goals_conceded = coalesce(excluded.goals_conceded, tm_player_season_stats.goals_conceded),
    clean_sheets = coalesce(excluded.clean_sheets, tm_player_season_stats.clean_sheets),
    payload = public.tm_merge_jsonb(tm_player_season_stats.payload, excluded.payload),
    updated_at = now();
end;
$$;

-- One membership row per player/team/competition/season. LATERAL aggregation
-- avoids multiplying goals when equivalent season/name variants exist in the source.
-- Competition and club IDs are authoritative; normalized names are only fallback
-- matches for older rows where the corresponding ID was never supplied.
create or replace view public.tm_team_season_player_stats
with (security_invoker = true)
as
with squad_rows as (
  select
    q.*,
    public.tm_leader_season_start_year(q.season_id) as season_start_year
  from public.tm_team_season_squads q
),
canonical_squads as (
  -- One roster row for a player/team/competition/start-year, even when imports
  -- used different season labels such as 2026, 2026/27 or 26/27.
  select distinct on (competition_id, season_start_year, club_id, tm_id)
    competition_id,
    competition_name,
    season_start_year::text as season_id,
    club_id,
    club_name,
    tm_id,
    player_name,
    position,
    photo_url,
    shirt_number,
    age,
    nationality,
    market_value_eur
  from squad_rows
  where season_start_year is not null
  order by competition_id, season_start_year, club_id, tm_id, updated_at desc, id desc
)
select
  q.competition_id, q.competition_name, q.season_id, q.club_id, q.club_name,
  q.tm_id, q.player_name, q.position, q.photo_url, q.shirt_number, q.age,
  q.nationality, q.market_value_eur,
  coalesce(stats.appearances, 0)::bigint as appearances,
  coalesce(stats.starts, 0)::bigint as starts,
  coalesce(stats.goals, 0)::bigint as goals,
  coalesce(stats.assists, 0)::bigint as assists,
  coalesce(stats.minutes, 0)::bigint as minutes,
  coalesce(stats.yellow_cards, 0)::bigint as yellow_cards,
  coalesce(stats.second_yellow_cards, 0)::bigint as second_yellow_cards,
  coalesce(stats.red_cards, 0)::bigint as red_cards,
  coalesce(stats.goals_conceded, 0)::bigint as goals_conceded,
  coalesce(stats.clean_sheets, 0)::bigint as clean_sheets
from canonical_squads q
left join lateral (
  select
    max(s.appearances)::bigint as appearances,
    max(s.starts)::bigint as starts,
    max(s.goals)::bigint as goals,
    max(s.assists)::bigint as assists,
    max(s.minutes)::bigint as minutes,
    max(s.yellow_cards)::bigint as yellow_cards,
    max(s.second_yellow_cards)::bigint as second_yellow_cards,
    max(s.red_cards)::bigint as red_cards,
    max(s.goals_conceded)::bigint as goals_conceded,
    max(s.clean_sheets)::bigint as clean_sheets
  from public.tm_player_season_stats s
  where s.tm_id = q.tm_id
    and public.tm_leader_season_start_year(s.season_id) =
        public.tm_leader_season_start_year(q.season_id)
    and (
      (nullif(s.competition_id, '') is not null and s.competition_id = q.competition_id)
      or (
        (coalesce(s.competition_name, '') ~ '^[0-9]+$' and s.competition_name = q.competition_id)
        or public.tm_leader_normalize_name(s.competition_name) =
           public.tm_leader_normalize_name(q.competition_name)
      )
    )
    and (
      (nullif(s.club_id, '') is not null and s.club_id = q.club_id)
      or (
        (coalesce(s.club_name, '') ~ '^[0-9]+$' and s.club_name = q.club_id)
        or s.club_name = 'Kulüp #' || q.club_id
        or public.tm_leader_normalize_name(s.club_name) =
           public.tm_leader_normalize_name(q.club_name)
      )
    )
) stats on true;

create or replace view public.tm_league_player_season_totals
with (security_invoker = true)
as
select
  competition_id,
  max(competition_name) as competition_name,
  season_id,
  tm_id,
  max(player_name) as player_name,
  max(photo_url) as photo_url,
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

-- rank() preserves shared positions for players tied on goals/assists.
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

-- Canonical one-row-per-season/competition/club profile stats. Different string
-- forms of one season or club no longer duplicate career totals on the profile.
create or replace function public.tm_player_profile_bundle(p_tm_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with target_player as (
    select p.*
    from public.tm_players p
    where p.tm_id = p_tm_id
       or (
         regexp_replace(p.tm_id, '[^0-9]', '', 'g') <> ''
         and regexp_replace(p.tm_id, '[^0-9]', '', 'g') =
             regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         and (
           select count(*)
           from public.tm_players candidate
           where regexp_replace(candidate.tm_id, '[^0-9]', '', 'g') =
                 regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         ) = 1
       )
    order by (p.tm_id = p_tm_id) desc
    limit 1
  ),
  target_id as (
    select tm_id from target_player
  ),
  stat_rows as (
    select
      s.tm_id,
      public.tm_leader_season_start_year(s.season_id) as start_year,
      coalesce(nullif(s.competition_id, ''), public.tm_leader_normalize_name(s.competition_name)) as competition_key,
      coalesce(nullif(s.club_id, ''), public.tm_leader_normalize_name(s.club_name)) as club_key,
      max(s.season_id) as source_season_id,
      coalesce(
        max(nullif(s.competition_name, '')) filter (where coalesce(s.competition_name, '') !~ '^[0-9]+$'),
        max(s.competition_name),
        ''
      ) as competition_name,
      max(s.club_name) as club_name,
      max(s.appearances) as appearances,
      max(s.starts) as starts,
      max(s.goals) as goals,
      max(s.assists) as assists,
      max(s.minutes) as minutes,
      max(s.yellow_cards) as yellow_cards,
      max(s.second_yellow_cards) as second_yellow_cards,
      max(s.red_cards) as red_cards,
      max(s.goals_conceded) as goals_conceded,
      max(s.clean_sheets) as clean_sheets
    from public.tm_player_season_stats s
    where s.tm_id = (select tm_id from target_id)
    group by
      s.tm_id,
      public.tm_leader_season_start_year(s.season_id),
      coalesce(nullif(s.competition_id, ''), public.tm_leader_normalize_name(s.competition_name)),
      coalesce(nullif(s.club_id, ''), public.tm_leader_normalize_name(s.club_name))
  ),
  season_rows as (
    select
      tm_id,
      case when start_year is null then source_season_id
           else start_year::text || '/' || right((start_year + 1)::text, 2) end as season_id,
      competition_name,
      club_name,
      appearances,
      starts,
      goals,
      assists,
      minutes,
      yellow_cards,
      second_yellow_cards,
      red_cards,
      goals_conceded,
      clean_sheets
    from stat_rows
    union all
    select
      h.tm_id,
      h.season_id,
      h.competition_name,
      h.club_name,
      h.appearances,
      h.starts,
      h.goals,
      h.assists,
      h.minutes,
      h.yellow_cards,
      null::integer as second_yellow_cards,
      h.red_cards,
      null::integer as goals_conceded,
      null::integer as clean_sheets
    from public.tm_appearance_season_totals h
    where h.tm_id = (select tm_id from target_id)
      and not exists (
        select 1
        from stat_rows s
        where s.tm_id = h.tm_id
          and s.start_year = public.tm_leader_season_start_year(h.season_id)
          and s.club_key = coalesce(
            (select nullif(q.club_id, '') from public.tm_player_season_stats q
             where q.tm_id = h.tm_id and public.tm_leader_season_start_year(q.season_id) = public.tm_leader_season_start_year(h.season_id)
               and public.tm_leader_normalize_name(q.club_name) = public.tm_leader_normalize_name(h.club_name)
             order by q.updated_at desc, q.id desc limit 1),
            public.tm_leader_normalize_name(h.club_name)
          )
      )
  ),
  distinct_appearances as (
    select distinct on (
      coalesce(
        nullif(a.game_id, ''),
        nullif(a.payload->>'gameId', ''),
        nullif(a.payload->>'game_id', ''),
        nullif(a.payload->>'match_id', ''),
        nullif(a.source_record_key, ''),
        a.id::text
      )
    )
      a.id,
      a.game_id,
      a.played_at,
      a.competition_name,
      a.club_name,
      a.opponent_name,
      a.goals,
      a.assists,
      a.minutes,
      a.payload,
      a.updated_at,
      coalesce(
        nullif(a.game_id, ''),
        nullif(a.payload->>'gameId', ''),
        nullif(a.payload->>'game_id', ''),
        nullif(a.payload->>'match_id', ''),
        nullif(a.source_record_key, ''),
        a.id::text
      ) as match_key
    from public.tm_appearances a
    where a.tm_id = (select tm_id from target_id)
      and a.played_at is not null
    order by
      coalesce(
        nullif(a.game_id, ''),
        nullif(a.payload->>'gameId', ''),
        nullif(a.payload->>'game_id', ''),
        nullif(a.payload->>'match_id', ''),
        nullif(a.source_record_key, ''),
        a.id::text
      ),
      a.updated_at desc,
      a.id desc
  )
  select jsonb_build_object(
    'player', (select to_jsonb(p) from target_player p),
    'source_records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'record_type', r.record_type,
        'payload', r.payload,
        'fetched_at', r.fetched_at
      ) order by r.fetched_at desc)
      from public.tm_source_records r
      where r.source = 'felipeall'
        and r.external_id = (select tm_id from target_id)
        and (
          (r.record_key = '' and r.record_type in (
            'player_profile','player_stats','player_transfers',
            'player_market_values','player_injuries','player_absences'
          ))
          or r.record_type = 'current_season_matches'
        )
    ), '[]'::jsonb),
    'season_stats', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.season_id desc, s.competition_name, s.club_name)
      from season_rows s
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.transfer_date desc, t.id desc)
      from public.tm_transfers t
      where t.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'market_values', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.valuation_date desc, v.id desc)
      from public.tm_market_values v
      where v.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'injuries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'injury', i.injury,
        'from_date', i.from_date,
        'until_date', i.until_date,
        'season', i.season,
        'days', i.days,
        'games_missed', i.games_missed,
        'payload', i.payload
      ) order by i.from_date desc nulls last, i.id desc)
      from public.tm_injuries i
      where i.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'absences', coalesce((
      select public.tm_extract_json_array(p.absences_payload, array['absences','data','items'])
      from target_player p
    ), '[]'::jsonb),
    'appearances', coalesce((
      select jsonb_agg(to_jsonb(a) - 'updated_at' - 'match_key' order by a.played_at desc, a.id desc)
      from distinct_appearances a
    ), '[]'::jsonb),
    'recent_appearances', coalesce((
      select jsonb_agg(to_jsonb(a) - 'updated_at' - 'match_key' order by a.played_at desc, a.id desc)
      from (select * from distinct_appearances order by played_at desc, id desc limit 13) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.tm_upsert_season_stat(jsonb) from public, anon, authenticated;
grant execute on function public.tm_upsert_season_stat(jsonb) to service_role;
revoke all on function public.tm_player_profile_bundle(text) from public, anon, authenticated;
grant execute on function public.tm_player_profile_bundle(text) to service_role;

revoke all on public.tm_team_season_player_stats from anon, authenticated;
revoke all on public.tm_league_player_season_totals from anon, authenticated;
revoke all on public.tm_league_goal_leaders from anon, authenticated;
revoke all on public.tm_league_assist_leaders from anon, authenticated;
grant select on public.tm_team_season_player_stats to service_role;
grant select on public.tm_league_player_season_totals to service_role;
grant select on public.tm_league_goal_leaders to service_role;
grant select on public.tm_league_assist_leaders to service_role;

comment on view public.tm_league_player_season_totals is
  'One player row per competition and season, with deduplicated team-season statistics.';
comment on view public.tm_league_goal_leaders is
  'Complete deduplicated goal leaderboard per competition and season.';
comment on view public.tm_league_assist_leaders is
  'Complete deduplicated assist leaderboard per competition and season.';
comment on function public.tm_player_profile_bundle(text) is
  'One indexed read bundle for all normalized player profile sections and the full appearance archive.';

commit;

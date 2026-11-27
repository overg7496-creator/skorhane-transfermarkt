-- SkorHane v3: strict league/team identity, complete leaderboard readiness,
-- and player profile rows that retain their source competition/team IDs.
-- Apply after 001-007 in Supabase SQL Editor. Safe to re-run.
begin;

alter table public.tm_player_season_stats
  add column if not exists competition_id text,
  add column if not exists club_id text;

-- The v2 league-sync importer stored these IDs inside payload.league_stats_sync.
-- Promote them into indexed columns without overwriting existing non-empty IDs.
update public.tm_player_season_stats s
set
  competition_id = coalesce(
    nullif(s.competition_id, ''),
    nullif(s.payload#>>'{league_stats_sync,competition_id}', ''),
    nullif(s.payload->>'competition_id', ''),
    nullif(s.payload->>'competitionId', ''),
    nullif(s.payload->>'competitionID', ''),
    nullif(s.payload#>>'{competition,id}', ''),
    case when coalesce(s.competition_name, '') ~ '^[0-9]+$' then s.competition_name end
  ),
  club_id = coalesce(
    nullif(s.club_id, ''),
    nullif(s.payload#>>'{league_stats_sync,club_id}', ''),
    nullif(s.payload->>'club_id', ''),
    nullif(s.payload->>'clubId', ''),
    nullif(s.payload->>'clubID', ''),
    nullif(s.payload#>>'{club,id}', ''),
    nullif(s.payload#>>'{team,id}', ''),
    case when coalesce(s.club_name, '') ~ '^[0-9]+$' then s.club_name end
  )
where nullif(s.competition_id, '') is null
   or nullif(s.club_id, '') is null;

-- Older normalized rows may have no provider IDs in their payload. Recover IDs
-- only when the same player/season/normalized competition/club resolves to
-- exactly one non-null squad ID pair.
with unique_named_matches as (
  select
    s.id,
    max(nullif(q.competition_id, '')) as competition_id,
    max(nullif(q.club_id, '')) as club_id
  from public.tm_player_season_stats s
  join public.tm_team_season_squads q
    on q.tm_id = s.tm_id
   and public.tm_leader_season_start_year(q.season_id) =
       public.tm_leader_season_start_year(s.season_id)
   and public.tm_leader_normalize_name(q.competition_name) =
       public.tm_leader_normalize_name(s.competition_name)
   and public.tm_leader_normalize_name(q.club_name) =
       public.tm_leader_normalize_name(s.club_name)
  group by s.id
  having count(distinct nullif(q.competition_id, '')) = 1
     and count(distinct nullif(q.club_id, '')) = 1
)
update public.tm_player_season_stats s
set competition_id = coalesce(nullif(s.competition_id, ''), m.competition_id),
    club_id = coalesce(nullif(s.club_id, ''), m.club_id)
from unique_named_matches m
where s.id = m.id
  and (nullif(s.competition_id, '') is null or nullif(s.club_id, '') is null);

create index if not exists tm_player_season_stats_leader_lookup_v3_idx
  on public.tm_player_season_stats (tm_id, competition_id, club_id, season_id);

create index if not exists tm_source_records_league_stats_checkpoint_gin_idx
  on public.tm_source_records using gin (payload jsonb_path_ops)
  where source = 'felipeall'
    and record_type = 'league_stats_player_checkpoint';

-- Identity-aware canonical team membership. If IDs exist on both sides they
-- MUST match; names are only a fallback when at least one ID is missing.
-- Missing club IDs are keyed by normalized club name so separate stints do not
-- collapse into a single NULL club bucket.
create or replace view public.tm_team_season_player_stats
with (security_invoker = true)
as
with squad_rows as (
  select
    q.*,
    public.tm_leader_season_start_year(q.season_id) as season_start_year,
    case
      when nullif(q.club_id, '') is not null then 'id:' || q.club_id
      else 'name:' || public.tm_leader_normalize_name(q.club_name)
    end as club_key
  from public.tm_team_season_squads q
),
canonical_squads as (
  select distinct on (competition_id, season_start_year, club_key, tm_id)
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
    market_value_eur,
    club_key
  from squad_rows
  where season_start_year is not null
    and club_key <> 'name:'
  order by competition_id, season_start_year, club_key, tm_id, updated_at desc, id desc
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
      case
        when nullif(s.competition_id, '') is not null
         and nullif(q.competition_id, '') is not null
          then s.competition_id = q.competition_id
        else (
          (coalesce(s.competition_name, '') ~ '^[0-9]+$' and s.competition_name = q.competition_id)
          or public.tm_leader_normalize_name(s.competition_name) =
             public.tm_leader_normalize_name(q.competition_name)
        )
      end
    )
    and (
      case
        when nullif(s.club_id, '') is not null
         and nullif(q.club_id, '') is not null
          then s.club_id = q.club_id
        else (
          (coalesce(s.club_name, '') ~ '^[0-9]+$' and s.club_name = q.club_id)
          or s.club_name = 'Kulüp #' || q.club_id
          or public.tm_leader_normalize_name(s.club_name) =
             public.tm_leader_normalize_name(q.club_name)
        )
      end
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

-- Rank equal goal/assist totals equally; order within a tie is deterministic in
-- the Worker, not encoded as a false higher rank in SQL.
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
      max(nullif(s.competition_id, '')) as competition_id,
      max(nullif(s.club_id, '')) as club_id,
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
      competition_id,
      club_id,
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
      null::text as competition_id,
      null::text as club_id,
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

comment on view public.tm_team_season_player_stats is
  'One row per player/team/competition/start-year; conflicting non-null IDs never fall back to a name match.';
comment on view public.tm_league_player_season_totals is
  'One row per player/competition/season; sums unique team stints only.';
comment on view public.tm_league_goal_leaders is
  'Complete goal leaders from identity-aware player-season totals; equal goals share a rank.';
comment on view public.tm_league_assist_leaders is
  'Complete assist leaders from identity-aware player-season totals; equal assists share a rank.';
comment on function public.tm_player_profile_bundle(text) is
  'Single indexed Supabase read bundle; season rows retain competition_id and club_id for exact client grouping.';

commit;

-- SkorHane: detailed per-league and per-season ingestion coverage dashboard.
-- Apply after 001_transfermarkt_schema.sql and 002_team_seasons_and_leaderboards.sql.
-- This migration replaces only the reporting view named tm_league_sync_dashboard;
-- it does not delete or rewrite any player, squad, transfer, valuation or statistics rows.

begin;

create or replace function public.tm_dashboard_payload_item_count(p_payload jsonb)
returns bigint
language plpgsql
immutable
parallel safe
as $$
declare
  k text;
  nested_payload jsonb;
begin
  if p_payload is null or p_payload = 'null'::jsonb then
    return 0;
  end if;

  if jsonb_typeof(p_payload) = 'array' then
    return jsonb_array_length(p_payload);
  end if;

  if jsonb_typeof(p_payload) <> 'object' then
    return 0;
  end if;

  foreach k in array array[
    'injuries', 'absences', 'transfers', 'marketValueHistory',
    'market_value_history', 'marketValues', 'valuations',
    'history', 'records', 'items', 'data', 'stats', 'national',
    'career', 'matches'
  ] loop
    if p_payload ? k then
      nested_payload := p_payload->k;
      if jsonb_typeof(nested_payload) = 'array' then
        return jsonb_array_length(nested_payload);
      elsif jsonb_typeof(nested_payload) = 'object' then
        return public.tm_dashboard_payload_item_count(nested_payload);
      end if;
    end if;
  end loop;

  return 0;
end;
$$;

create or replace function public.tm_dashboard_flatten_stat_metrics(p_payload jsonb)
returns table(metric_key text, metric_value jsonb)
language sql
immutable
parallel safe
as $metric$
  with recursive walk(metric_key, metric_value) as (
    select ''::text, coalesce(p_payload, '{}'::jsonb)
    union all
    select
      case when w.metric_key = '' then child.key else w.metric_key || '.' || child.key end,
      child.value
    from walk w
    cross join lateral jsonb_each(
      case when jsonb_typeof(w.metric_value) = 'object'
           then w.metric_value else '{}'::jsonb end
    ) child
    where w.metric_key = ''
       or (w.metric_key <> 'league_stats_sync'
           and w.metric_key not like 'league_stats_sync.%')
  )
  select w.metric_key, w.metric_value
  from walk w
  where w.metric_key <> ''
    and w.metric_key <> 'league_stats_sync'
    and w.metric_key not like 'league_stats_sync.%'
    and jsonb_typeof(w.metric_value) not in ('object', 'array', 'null')
    and w.metric_value <> '""'::jsonb
    and lower(split_part(w.metric_key, '.', array_length(string_to_array(w.metric_key, '.'), 1))) not in (
      'id', 'tm_id', 'player_id', 'playerid', 'club_id', 'clubid',
      'team_id', 'teamid', 'competition_id', 'competitionid', 'season_id',
      'seasonid', 'name', 'first_name', 'last_name', 'display_name',
      'club_name', 'team_name', 'competition_name', 'season', 'photo',
      'photo_url', 'image', 'image_url', 'shirt_number', 'age',
      'nationality', 'position'
    );
$metric$;

-- Do not use CASCADE: if another database object depends on the old dashboard,
-- PostgreSQL will stop here instead of silently dropping that dependent object.
drop view if exists public.tm_league_sync_dashboard;
drop view if exists public.tm_league_sync_dashboard_seasons;

create view public.tm_league_sync_dashboard_seasons
with (security_invoker = true)
as
with season_roster as (
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    q.season_id,
    count(distinct q.club_id)::integer as team_count,
    count(distinct q.tm_id)::integer as player_count,
    count(*)::bigint as player_season_membership_count,
    count(distinct q.tm_id) filter (where q.market_value_eur is not null)::integer as players_with_market_value_snapshot,
    sum(coalesce(q.market_value_eur, 0))::numeric as squad_market_value_eur,
    round(avg(q.age)::numeric, 1) as average_age,
    count(distinct q.tm_id) filter (where nullif(trim(q.photo_url), '') is not null)::integer as players_with_photo,
    count(distinct q.tm_id) filter (where nullif(trim(q.position), '') is not null)::integer as players_with_position,
    count(distinct q.tm_id) filter (where q.age is not null)::integer as players_with_age,
    count(distinct q.tm_id) filter (
      where q.nationality is not null and q.nationality <> 'null'::jsonb
        and q.nationality <> '""'::jsonb and q.nationality <> '[]'::jsonb
    )::integer as players_with_nationality,
    count(distinct q.tm_id) filter (where nullif(trim(q.contract_expires), '') is not null)::integer as players_with_contract_expiry,
    count(distinct q.tm_id) filter (where q.shirt_number is not null)::integer as players_with_shirt_number
  from public.tm_team_season_squads q
  group by q.competition_id, q.season_id
),
matched_season_stats as (
  -- Same strict season + competition + club matching as tm_team_season_player_stats.
  -- This prevents cup or another club's statistics being counted for a league.
  select distinct
    q.competition_id,
    q.season_id,
    s.id as stat_row_id,
    s.tm_id,
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
    s.payload
  from public.tm_team_season_squads q
  join public.tm_player_season_stats s
    on s.tm_id = q.tm_id
   and (
        s.season_id = q.season_id
        or s.season_id like q.season_id || '/%'
        or s.season_id like q.season_id || '-%'
   )
   and lower(trim(coalesce(s.competition_name, ''))) = lower(trim(q.competition_name))
   and lower(trim(coalesce(s.club_name, ''))) = lower(trim(q.club_name))
),
season_stats as (
  select
    competition_id,
    season_id,
    count(distinct tm_id)::integer as players_with_season_statistics,
    count(*)::bigint as season_stat_record_count,
    count(distinct tm_id) filter (where appearances is not null)::integer as players_with_appearances_stats,
    count(distinct tm_id) filter (where starts is not null)::integer as players_with_starts_stats,
    count(distinct tm_id) filter (where goals is not null)::integer as players_with_goal_stats,
    count(distinct tm_id) filter (where assists is not null)::integer as players_with_assist_stats,
    count(distinct tm_id) filter (where minutes is not null)::integer as players_with_minutes_stats,
    count(distinct tm_id) filter (where yellow_cards is not null)::integer as players_with_yellow_card_stats,
    count(distinct tm_id) filter (where second_yellow_cards is not null)::integer as players_with_second_yellow_card_stats,
    count(distinct tm_id) filter (where red_cards is not null)::integer as players_with_red_card_stats,
    count(distinct tm_id) filter (where goals_conceded is not null)::integer as players_with_goals_conceded_stats,
    count(distinct tm_id) filter (where clean_sheets is not null)::integer as players_with_clean_sheet_stats,
    sum(coalesce(appearances, 0))::bigint as total_appearances,
    sum(coalesce(starts, 0))::bigint as total_starts,
    sum(coalesce(goals, 0))::bigint as total_goals,
    sum(coalesce(assists, 0))::bigint as total_assists,
    sum(coalesce(minutes, 0))::bigint as total_minutes,
    sum(coalesce(yellow_cards, 0))::bigint as total_yellow_cards,
    sum(coalesce(second_yellow_cards, 0))::bigint as total_second_yellow_cards,
    sum(coalesce(red_cards, 0))::bigint as total_red_cards,
    sum(coalesce(goals_conceded, 0))::bigint as total_goals_conceded,
    sum(coalesce(clean_sheets, 0))::bigint as total_clean_sheets
  from matched_season_stats
  group by competition_id, season_id
),
raw_metric_values as (
  select
    m.competition_id,
    m.season_id,
    m.tm_id,
    x.metric_key,
    case
      when x.metric_value #>> '{}' ~ '^[-+]?[0-9]+([.][0-9]+)?
  select
    competition_id,
    season_id,
    count(*)::integer as goal_leader_entry_count,
    count(distinct tm_id)::integer as goal_leader_player_count,
    max(goals)::integer as top_goal_count
  from public.tm_league_goal_leaders
  group by competition_id, season_id
),
assist_leaders as (
  select
    competition_id,
    season_id,
    count(*)::integer as assist_leader_entry_count,
    count(distinct tm_id)::integer as assist_leader_player_count,
    max(assists)::integer as top_assist_count
  from public.tm_league_assist_leaders
  group by competition_id, season_id
),
standings as (
  select
    r.external_id as competition_id,
    r.record_key as season_id,
    count(*)::integer as standings_snapshot_count,
    max(r.fetched_at) as standings_last_fetched_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type = 'competition_table'
  group by r.external_id, r.record_key
),
season_sync as (
  select
    competition_id,
    season_id,
    sync_status,
    total_clubs,
    completed_clubs,
    sync_date,
    fetched_at
  from public.tm_league_seasons
)
select
  b.competition_id,
  b.competition_name,
  b.season_id,
  b.team_count,
  b.player_count,
  b.player_season_membership_count,
  b.players_with_market_value_snapshot,
  b.squad_market_value_eur,
  b.average_age,
  b.players_with_photo,
  b.players_with_position,
  b.players_with_age,
  b.players_with_nationality,
  b.players_with_contract_expiry,
  b.players_with_shirt_number,
  coalesce(st.players_with_season_statistics, 0)::integer as players_with_season_statistics,
  coalesce(st.season_stat_record_count, 0)::bigint as season_stat_record_count,
  coalesce(st.players_with_appearances_stats, 0)::integer as players_with_appearances_stats,
  coalesce(st.players_with_starts_stats, 0)::integer as players_with_starts_stats,
  coalesce(st.players_with_goal_stats, 0)::integer as players_with_goal_stats,
  coalesce(st.players_with_assist_stats, 0)::integer as players_with_assist_stats,
  coalesce(st.players_with_minutes_stats, 0)::integer as players_with_minutes_stats,
  coalesce(st.players_with_yellow_card_stats, 0)::integer as players_with_yellow_card_stats,
  coalesce(st.players_with_second_yellow_card_stats, 0)::integer as players_with_second_yellow_card_stats,
  coalesce(st.players_with_red_card_stats, 0)::integer as players_with_red_card_stats,
  coalesce(st.players_with_goals_conceded_stats, 0)::integer as players_with_goals_conceded_stats,
  coalesce(st.players_with_clean_sheet_stats, 0)::integer as players_with_clean_sheet_stats,
  coalesce(st.total_appearances, 0)::bigint as total_appearances,
  coalesce(st.total_starts, 0)::bigint as total_starts,
  coalesce(st.total_goals, 0)::bigint as total_goals,
  coalesce(st.total_assists, 0)::bigint as total_assists,
  coalesce(st.total_minutes, 0)::bigint as total_minutes,
  coalesce(st.total_yellow_cards, 0)::bigint as total_yellow_cards,
  coalesce(st.total_second_yellow_cards, 0)::bigint as total_second_yellow_cards,
  coalesce(st.total_red_cards, 0)::bigint as total_red_cards,
  coalesce(st.total_goals_conceded, 0)::bigint as total_goals_conceded,
  coalesce(st.total_clean_sheets, 0)::bigint as total_clean_sheets,
  coalesce(rms.raw_stat_metric_coverage, '{}'::jsonb) as raw_stat_metric_coverage,
  coalesce(gl.goal_leader_entry_count, 0)::integer as goal_leader_entry_count,
  coalesce(gl.goal_leader_player_count, 0)::integer as goal_leader_player_count,
  coalesce(gl.top_goal_count, 0)::integer as top_goal_count,
  coalesce(al.assist_leader_entry_count, 0)::integer as assist_leader_entry_count,
  coalesce(al.assist_leader_player_count, 0)::integer as assist_leader_player_count,
  coalesce(al.top_assist_count, 0)::integer as top_assist_count,
  coalesce(sd.standings_snapshot_count, 0)::integer as standings_snapshot_count,
  (coalesce(sd.standings_snapshot_count, 0) > 0) as standings_available,
  coalesce(ss.sync_status, 'not_started') as squad_sync_status,
  coalesce(ss.total_clubs, b.team_count)::integer as registered_total_clubs,
  coalesce(ss.completed_clubs, 0)::integer as completed_clubs,
  case
    when coalesce(ss.total_clubs, b.team_count) > 0
      then round(coalesce(ss.completed_clubs, 0)::numeric * 100 / coalesce(ss.total_clubs, b.team_count), 1)
    else 0::numeric
  end as squad_sync_completion_pct,
  ss.sync_date,
  greatest(ss.fetched_at, sd.standings_last_fetched_at) as last_sync_or_standings_fetch_at
from season_roster b
left join season_stats st using (competition_id, season_id)
left join raw_metric_summary rms using (competition_id, season_id)
left join goal_leaders gl using (competition_id, season_id)
left join assist_leaders al using (competition_id, season_id)
left join standings sd using (competition_id, season_id)
left join season_sync ss using (competition_id, season_id);

create view public.tm_league_sync_dashboard
with (security_invoker = true)
as
with league_members as (
  select distinct competition_id, competition_name, tm_id
  from public.tm_team_season_squads
),
matched_season_stats as (
  -- Repeat the exact competition + season + club match for league-wide distinct-player metrics.
  select distinct
    q.competition_id,
    q.season_id,
    s.id as stat_row_id,
    s.tm_id,
    s.appearances,
    s.starts,
    s.goals,
    s.assists,
    s.minutes,
    s.yellow_cards,
    s.second_yellow_cards,
    s.red_cards,
    s.goals_conceded,
    s.clean_sheets
  from public.tm_team_season_squads q
  join public.tm_player_season_stats s
    on s.tm_id = q.tm_id
   and (
        s.season_id = q.season_id
        or s.season_id like q.season_id || '/%'
        or s.season_id like q.season_id || '-%'
   )
   and lower(trim(coalesce(s.competition_name, ''))) = lower(trim(q.competition_name))
   and lower(trim(coalesce(s.club_name, ''))) = lower(trim(q.club_name))
),
league_base as (
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    count(distinct q.club_id)::integer as team_count,
    count(distinct q.tm_id)::integer as player_count,
    count(*)::bigint as player_season_membership_count,
    count(distinct q.season_id)::integer as team_season_count
  from public.tm_team_season_squads q
  group by q.competition_id
),
roster_player_info as (
  select
    q.competition_id,
    q.tm_id,
    bool_or(nullif(trim(q.photo_url), '') is not null) as has_photo,
    bool_or(nullif(trim(q.position), '') is not null) as has_position,
    bool_or(q.age is not null) as has_age,
    bool_or(q.nationality is not null and q.nationality <> 'null'::jsonb
      and q.nationality <> '""'::jsonb and q.nationality <> '[]'::jsonb) as has_nationality,
    bool_or(nullif(trim(q.contract_expires), '') is not null) as has_contract_expiry,
    bool_or(q.shirt_number is not null) as has_shirt_number
  from public.tm_team_season_squads q
  group by q.competition_id, q.tm_id
),
roster_metrics as (
  select
    competition_id,
    count(*) filter (where has_photo)::integer as players_with_photo,
    count(*) filter (where has_position)::integer as players_with_position,
    count(*) filter (where has_age)::integer as players_with_age,
    count(*) filter (where has_nationality)::integer as players_with_nationality,
    count(*) filter (where has_contract_expiry)::integer as players_with_contract_expiry,
    count(*) filter (where has_shirt_number)::integer as players_with_shirt_number
  from roster_player_info
  group by competition_id
),
player_source_snapshots as (
  select
    r.external_id as tm_id,
    bool_or(r.record_type = 'player_profile') as has_profile_snapshot,
    bool_or(r.record_type = 'player_market_values') as has_market_value_snapshot,
    bool_or(r.record_type = 'player_transfers') as has_transfer_snapshot,
    bool_or(r.record_type = 'player_injuries') as has_injury_snapshot,
    bool_or(r.record_type = 'player_absences') as has_absence_snapshot,
    sum(case when r.record_type = 'player_injuries'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as injury_snapshot_items,
    sum(case when r.record_type = 'player_absences'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as absence_snapshot_items
  from public.tm_source_records r
  where r.record_type in (
    'player_profile', 'player_market_values', 'player_transfers',
    'player_injuries', 'player_absences'
  )
    and nullif(r.external_id, '') is not null
  group by r.external_id
),
league_player_detail_rows as (
  select
    m.competition_id,
    m.tm_id,
    (
      p.current_market_value_eur is not null
      or nullif(trim(p.current_market_value_text), '') is not null
    ) as has_current_market_value,
    coalesce(p.current_market_value_eur, 0)::numeric as current_market_value_eur,
    (coalesce(p.profile_payload, '{}'::jsonb) <> '{}'::jsonb) as has_profile_data,
    (coalesce(p.stats_payload, '{}'::jsonb) <> '{}'::jsonb) as has_stats_payload,
    (coalesce(p.current_season_payload, '{}'::jsonb) <> '{}'::jsonb) as has_current_season_data,
    (coalesce(p.national_career_payload, '{}'::jsonb) <> '{}'::jsonb) as has_national_career_data,
    coalesce(src.has_profile_snapshot, false) as has_profile_snapshot,
    coalesce(src.has_market_value_snapshot, false) as has_market_value_snapshot,
    coalesce(src.has_transfer_snapshot, false) as has_transfer_snapshot,
    coalesce(src.has_injury_snapshot, false) as has_injury_snapshot,
    coalesce(src.has_absence_snapshot, false) as has_absence_snapshot,
    greatest(
      public.tm_dashboard_payload_item_count(p.injuries_payload),
      coalesce(src.injury_snapshot_items, 0)
    )::bigint as injury_record_count,
    greatest(
      public.tm_dashboard_payload_item_count(p.absences_payload),
      coalesce(src.absence_snapshot_items, 0)
    )::bigint as absence_record_count
  from league_members m
  left join public.tm_players p on p.tm_id = m.tm_id
  left join player_source_snapshots src on src.tm_id = m.tm_id
),
player_detail_metrics as (
  select
    competition_id,
    count(*) filter (where has_current_market_value)::integer as players_with_current_market_value,
    sum(current_market_value_eur)::numeric as current_market_value_total_eur,
    count(*) filter (where has_profile_data)::integer as players_with_profile_data,
    count(*) filter (where has_stats_payload)::integer as players_with_stats_payload,
    count(*) filter (where has_current_season_data)::integer as players_with_current_season_data,
    count(*) filter (where has_national_career_data)::integer as players_with_national_career_data,
    count(*) filter (where has_profile_snapshot)::integer as players_with_profile_snapshot,
    count(*) filter (where has_market_value_snapshot)::integer as players_with_market_value_source_snapshot,
    count(*) filter (where has_transfer_snapshot)::integer as players_with_transfer_source_snapshot,
    count(*) filter (where has_injury_snapshot)::integer as players_with_injury_source_snapshot,
    count(*) filter (where has_absence_snapshot)::integer as players_with_absence_source_snapshot,
    count(*) filter (where injury_record_count > 0)::integer as players_with_injury_records,
    sum(injury_record_count)::bigint as injury_record_count,
    count(*) filter (where absence_record_count > 0)::integer as players_with_absence_records,
    sum(absence_record_count)::bigint as absence_record_count
  from league_player_detail_rows
  group by competition_id
),
market_value_history as (
  select
    m.competition_id,
    count(distinct v.tm_id)::integer as players_with_market_value_history,
    count(v.id)::bigint as market_value_history_record_count,
    count(v.id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::bigint as usable_market_value_history_record_count,
    count(distinct v.tm_id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::integer as players_with_usable_market_value_history
  from league_members m
  join public.tm_market_values v on v.tm_id = m.tm_id
  group by m.competition_id
),
transfer_history as (
  select
    m.competition_id,
    count(distinct t.tm_id)::integer as players_with_transfer_history,
    count(t.id)::bigint as transfer_history_record_count,
    count(distinct t.tm_id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::integer as players_with_transfer_fee,
    count(t.id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::bigint as transfer_fee_record_count,
    count(distinct t.tm_id) filter (where t.fee_eur is not null)::integer as players_with_numeric_transfer_fee,
    count(t.id) filter (where t.fee_eur is not null)::bigint as numeric_transfer_fee_record_count,
    coalesce(sum(t.fee_eur), 0)::numeric as total_transfer_fee_eur
  from league_members m
  join public.tm_transfers t on t.tm_id = m.tm_id
  group by m.competition_id
),
league_stat_players as (
  select
    competition_id,
    tm_id,
    bool_or(appearances is not null) as has_appearances,
    bool_or(starts is not null) as has_starts,
    bool_or(goals is not null) as has_goals,
    bool_or(assists is not null) as has_assists,
    bool_or(minutes is not null) as has_minutes,
    bool_or(yellow_cards is not null) as has_yellow_cards,
    bool_or(second_yellow_cards is not null) as has_second_yellow_cards,
    bool_or(red_cards is not null) as has_red_cards,
    bool_or(goals_conceded is not null) as has_goals_conceded,
    bool_or(clean_sheets is not null) as has_clean_sheets
  from matched_season_stats
  group by competition_id, tm_id
),
league_stat_metrics as (
  select
    competition_id,
    count(*)::integer as players_with_season_statistics,
    count(*) filter (where has_appearances)::integer as players_with_appearances_stats,
    count(*) filter (where has_starts)::integer as players_with_starts_stats,
    count(*) filter (where has_goals)::integer as players_with_goal_stats,
    count(*) filter (where has_assists)::integer as players_with_assist_stats,
    count(*) filter (where has_minutes)::integer as players_with_minutes_stats,
    count(*) filter (where has_yellow_cards)::integer as players_with_yellow_card_stats,
    count(*) filter (where has_second_yellow_cards)::integer as players_with_second_yellow_card_stats,
    count(*) filter (where has_red_cards)::integer as players_with_red_card_stats,
    count(*) filter (where has_goals_conceded)::integer as players_with_goals_conceded_stats,
    count(*) filter (where has_clean_sheets)::integer as players_with_clean_sheet_stats
  from league_stat_players
  group by competition_id
),
league_raw_metric_summary as (
  select
    competition_id,
    jsonb_object_agg(metric_key, jsonb_build_object(
      'players', player_count,
      'records', record_count,
      'numeric_values', numeric_value_count,
      'numeric_total', numeric_value_total
    )) as raw_stat_metric_coverage
  from (
    select
      competition_id,
      metric_key,
      count(distinct tm_id)::integer as player_count,
      count(*)::bigint as record_count,
      count(numeric_value)::bigint as numeric_value_count,
      sum(numeric_value)::numeric as numeric_value_total
    from raw_metric_values
    group by competition_id, metric_key
  ) metrics
  group by competition_id
),
league_stat_totals as (
  select
    competition_id,
    count(*)::bigint as season_stat_record_count,
    sum(coalesce(appearances, 0))::bigint as total_appearances,
    sum(coalesce(starts, 0))::bigint as total_starts,
    sum(coalesce(goals, 0))::bigint as total_goals,
    sum(coalesce(assists, 0))::bigint as total_assists,
    sum(coalesce(minutes, 0))::bigint as total_minutes,
    sum(coalesce(yellow_cards, 0))::bigint as total_yellow_cards,
    sum(coalesce(second_yellow_cards, 0))::bigint as total_second_yellow_cards,
    sum(coalesce(red_cards, 0))::bigint as total_red_cards,
    sum(coalesce(goals_conceded, 0))::bigint as total_goals_conceded,
    sum(coalesce(clean_sheets, 0))::bigint as total_clean_sheets
  from matched_season_stats
  group by competition_id
),
league_goal_leaders as (
  select
    competition_id,
    count(*)::integer as goal_leader_entry_count,
    count(distinct tm_id)::integer as players_with_goal_leader_entries,
    count(distinct season_id)::integer as seasons_with_goal_leaders,
    max(goals)::integer as highest_goal_tally
  from public.tm_league_goal_leaders
  group by competition_id
),
league_assist_leaders as (
  select
    competition_id,
    count(*)::integer as assist_leader_entry_count,
    count(distinct tm_id)::integer as players_with_assist_leader_entries,
    count(distinct season_id)::integer as seasons_with_assist_leaders,
    max(assists)::integer as highest_assist_tally
  from public.tm_league_assist_leaders
  group by competition_id
),
league_standings as (
  select
    r.external_id as competition_id,
    count(*)::integer as standings_snapshot_count,
    count(distinct r.record_key)::integer as seasons_with_standings,
    max(r.fetched_at) as latest_standings_fetch_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type = 'competition_table'
  group by r.external_id
),
league_season_metrics as (
  select
    competition_id,
    count(*)::integer as season_count,
    max(season_id) as latest_season_id,
    count(*) filter (where squad_sync_status = 'completed')::integer as completed_seasons,
    count(*) filter (where squad_sync_status = 'running')::integer as running_seasons,
    count(*) filter (where squad_sync_status = 'failed')::integer as failed_seasons,
    count(*) filter (where season_stat_record_count > 0)::integer as seasons_with_player_statistics,
    count(*) filter (where goal_leader_entry_count > 0)::integer as seasons_with_goal_leaders,
    count(*) filter (where assist_leader_entry_count > 0)::integer as seasons_with_assist_leaders,
    count(*) filter (where standings_available)::integer as seasons_with_standings,
    sum(player_season_membership_count)::bigint as player_season_membership_count,
    sum(season_stat_record_count)::bigint as season_stat_record_count,
    sum(total_appearances)::bigint as total_appearances,
    sum(total_starts)::bigint as total_starts,
    sum(total_goals)::bigint as total_goals,
    sum(total_assists)::bigint as total_assists,
    sum(total_minutes)::bigint as total_minutes,
    sum(total_yellow_cards)::bigint as total_yellow_cards,
    sum(total_second_yellow_cards)::bigint as total_second_yellow_cards,
    sum(total_red_cards)::bigint as total_red_cards,
    sum(total_goals_conceded)::bigint as total_goals_conceded,
    sum(total_clean_sheets)::bigint as total_clean_sheets,
    jsonb_agg(to_jsonb(s) order by season_id desc) as season_breakdown
  from public.tm_league_sync_dashboard_seasons s
  group by competition_id
),
latest_season as (
  select distinct on (competition_id)
    competition_id,
    team_count as latest_season_team_count,
    player_count as latest_season_player_count,
    players_with_market_value_snapshot as latest_season_players_with_market_value,
    squad_market_value_eur as latest_season_squad_market_value_eur,
    average_age as latest_season_average_age,
    squad_sync_status as latest_season_sync_status,
    squad_sync_completion_pct as latest_season_sync_completion_pct
  from public.tm_league_sync_dashboard_seasons
  order by competition_id, season_id desc
)
select
  b.competition_id,
  b.competition_name,
  b.team_count,
  b.player_count,
  b.team_season_count,
  coalesce(sm.season_count, 0)::integer as season_count,
  sm.latest_season_id,
  coalesce(sm.latest_season_id, '') as latest_season,
  coalesce(sm.completed_seasons, 0)::integer as completed_seasons,
  coalesce(sm.running_seasons, 0)::integer as running_seasons,
  coalesce(sm.failed_seasons, 0)::integer as failed_seasons,
  coalesce(b.player_season_membership_count, 0)::bigint as player_season_membership_count,
  coalesce(rm.players_with_photo, 0)::integer as players_with_photo,
  coalesce(rm.players_with_position, 0)::integer as players_with_position,
  coalesce(rm.players_with_age, 0)::integer as players_with_age,
  coalesce(rm.players_with_nationality, 0)::integer as players_with_nationality,
  coalesce(rm.players_with_contract_expiry, 0)::integer as players_with_contract_expiry,
  coalesce(rm.players_with_shirt_number, 0)::integer as players_with_shirt_number,
  coalesce(pd.players_with_current_market_value, 0)::integer as players_with_current_market_value,
  coalesce(pd.current_market_value_total_eur, 0)::numeric as current_market_value_total_eur,
  case when b.player_count > 0 then round(coalesce(pd.players_with_current_market_value, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as current_market_value_coverage_pct,
  coalesce(mvh.players_with_market_value_history, 0)::integer as players_with_market_value_history,
  coalesce(mvh.players_with_usable_market_value_history, 0)::integer as players_with_usable_market_value_history,
  coalesce(mvh.market_value_history_record_count, 0)::bigint as market_value_history_record_count,
  coalesce(mvh.usable_market_value_history_record_count, 0)::bigint as usable_market_value_history_record_count,
  case when b.player_count > 0 then round(coalesce(mvh.players_with_market_value_history, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as market_value_history_coverage_pct,
  coalesce(pd.players_with_injury_records, 0)::integer as players_with_injury_records,
  coalesce(pd.injury_record_count, 0)::bigint as injury_record_count,
  coalesce(pd.players_with_injury_source_snapshot, 0)::integer as players_with_injury_source_snapshot,
  coalesce(pd.players_with_absence_records, 0)::integer as players_with_absence_records,
  coalesce(pd.absence_record_count, 0)::bigint as absence_record_count,
  coalesce(pd.players_with_absence_source_snapshot, 0)::integer as players_with_absence_source_snapshot,
  coalesce(th.players_with_transfer_history, 0)::integer as players_with_transfer_history,
  coalesce(th.transfer_history_record_count, 0)::bigint as transfer_history_record_count,
  coalesce(th.players_with_transfer_fee, 0)::integer as players_with_transfer_fee,
  coalesce(th.transfer_fee_record_count, 0)::bigint as transfer_fee_record_count,
  coalesce(th.players_with_numeric_transfer_fee, 0)::integer as players_with_numeric_transfer_fee,
  coalesce(th.numeric_transfer_fee_record_count, 0)::bigint as numeric_transfer_fee_record_count,
  coalesce(th.total_transfer_fee_eur, 0)::numeric as total_transfer_fee_eur,
  coalesce(pd.players_with_profile_data, 0)::integer as players_with_profile_data,
  coalesce(pd.players_with_profile_snapshot, 0)::integer as players_with_profile_snapshot,
  coalesce(pd.players_with_stats_payload, 0)::integer as players_with_stats_payload,
  coalesce(pd.players_with_current_season_data, 0)::integer as players_with_current_season_data,
  coalesce(pd.players_with_national_career_data, 0)::integer as players_with_national_career_data,
  coalesce(pd.players_with_market_value_source_snapshot, 0)::integer as players_with_market_value_source_snapshot,
  coalesce(pd.players_with_transfer_source_snapshot, 0)::integer as players_with_transfer_source_snapshot,
  coalesce(sm.seasons_with_player_statistics, 0)::integer as seasons_with_player_statistics,
  coalesce(stm.players_with_season_statistics, 0)::integer as players_with_season_statistics,
  coalesce(stm.players_with_appearances_stats, 0)::integer as players_with_appearances_stats,
  coalesce(stm.players_with_starts_stats, 0)::integer as players_with_starts_stats,
  coalesce(stm.players_with_goal_stats, 0)::integer as players_with_goal_stats,
  coalesce(stm.players_with_assist_stats, 0)::integer as players_with_assist_stats,
  coalesce(stm.players_with_minutes_stats, 0)::integer as players_with_minutes_stats,
  coalesce(stm.players_with_yellow_card_stats, 0)::integer as players_with_yellow_card_stats,
  coalesce(stm.players_with_second_yellow_card_stats, 0)::integer as players_with_second_yellow_card_stats,
  coalesce(stm.players_with_red_card_stats, 0)::integer as players_with_red_card_stats,
  coalesce(stm.players_with_goals_conceded_stats, 0)::integer as players_with_goals_conceded_stats,
  coalesce(stm.players_with_clean_sheet_stats, 0)::integer as players_with_clean_sheet_stats,
  coalesce(sm.season_stat_record_count, 0)::bigint as season_stat_record_count,
  coalesce(sm.total_appearances, 0)::bigint as total_appearances,
  coalesce(sm.total_starts, 0)::bigint as total_starts,
  coalesce(sm.total_goals, 0)::bigint as total_goals,
  coalesce(sm.total_assists, 0)::bigint as total_assists,
  coalesce(sm.total_minutes, 0)::bigint as total_minutes,
  coalesce(sm.total_yellow_cards, 0)::bigint as total_yellow_cards,
  coalesce(sm.total_second_yellow_cards, 0)::bigint as total_second_yellow_cards,
  coalesce(sm.total_red_cards, 0)::bigint as total_red_cards,
  coalesce(sm.total_goals_conceded, 0)::bigint as total_goals_conceded,
  coalesce(sm.total_clean_sheets, 0)::bigint as total_clean_sheets,
  coalesce(lrm.raw_stat_metric_coverage, '{}'::jsonb) as raw_stat_metric_coverage,
  coalesce(gl.players_with_goal_leader_entries, 0)::integer as players_with_goal_leader_entries,
  coalesce(gl.goal_leader_entry_count, 0)::integer as goal_leader_entry_count,
  coalesce(gl.seasons_with_goal_leaders, 0)::integer as seasons_with_goal_leaders,
  coalesce(gl.highest_goal_tally, 0)::integer as highest_goal_tally,
  coalesce(al.players_with_assist_leader_entries, 0)::integer as players_with_assist_leader_entries,
  coalesce(al.assist_leader_entry_count, 0)::integer as assist_leader_entry_count,
  coalesce(al.seasons_with_assist_leaders, 0)::integer as seasons_with_assist_leaders,
  coalesce(al.highest_assist_tally, 0)::integer as highest_assist_tally,
  coalesce(ls.seasons_with_standings, 0)::integer as seasons_with_standings,
  coalesce(ls.standings_snapshot_count, 0)::integer as standings_snapshot_count,
  coalesce(latest.latest_season_team_count, 0)::integer as latest_season_team_count,
  coalesce(latest.latest_season_player_count, 0)::integer as latest_season_player_count,
  coalesce(latest.latest_season_players_with_market_value, 0)::integer as latest_season_players_with_market_value,
  coalesce(latest.latest_season_squad_market_value_eur, 0)::numeric as latest_season_squad_market_value_eur,
  latest.latest_season_average_age,
  latest.latest_season_sync_status,
  latest.latest_season_sync_completion_pct,
  coalesce(sm.season_breakdown, '[]'::jsonb) as season_breakdown
from league_base b
left join roster_metrics rm using (competition_id)
left join player_detail_metrics pd using (competition_id)
left join market_value_history mvh using (competition_id)
left join transfer_history th using (competition_id)
left join league_stat_metrics stm using (competition_id)
left join league_raw_metric_summary lrm using (competition_id)
left join league_season_metrics sm using (competition_id)
left join league_goal_leaders gl using (competition_id)
left join league_assist_leaders al using (competition_id)
left join league_standings ls using (competition_id)
left join latest_season latest using (competition_id);

revoke all on function public.tm_dashboard_payload_item_count(jsonb) from public, anon, authenticated;
grant execute on function public.tm_dashboard_payload_item_count(jsonb) to service_role;
revoke all on function public.tm_dashboard_flatten_stat_metrics(jsonb) from public, anon, authenticated;
grant execute on function public.tm_dashboard_flatten_stat_metrics(jsonb) to service_role;

revoke all on public.tm_league_sync_dashboard from anon, authenticated;
revoke all on public.tm_league_sync_dashboard_seasons from anon, authenticated;
grant select on public.tm_league_sync_dashboard to service_role;
grant select on public.tm_league_sync_dashboard_seasons to service_role;

commit;

        then (x.metric_value #>> '{}')::numeric
      else null
    end as numeric_value
  from matched_season_stats m
  cross join lateral public.tm_dashboard_flatten_stat_metrics(m.payload) x
),
raw_metric_summary as (
  select
    competition_id,
    season_id,
    jsonb_object_agg(metric_key, jsonb_build_object(
      'players', player_count,
      'records', record_count,
      'numeric_values', numeric_value_count,
      'numeric_total', numeric_value_total
    )) as raw_stat_metric_coverage
  from (
    select
      competition_id,
      season_id,
      metric_key,
      count(distinct tm_id)::integer as player_count,
      count(*)::bigint as record_count,
      count(numeric_value)::bigint as numeric_value_count,
      sum(numeric_value)::numeric as numeric_value_total
    from raw_metric_values
    group by competition_id, season_id, metric_key
  ) metrics
  group by competition_id, season_id
),
goal_leaders as (
  select
    competition_id,
    season_id,
    count(*)::integer as goal_leader_entry_count,
    count(distinct tm_id)::integer as goal_leader_player_count,
    max(goals)::integer as top_goal_count
  from public.tm_league_goal_leaders
  group by competition_id, season_id
),
assist_leaders as (
  select
    competition_id,
    season_id,
    count(*)::integer as assist_leader_entry_count,
    count(distinct tm_id)::integer as assist_leader_player_count,
    max(assists)::integer as top_assist_count
  from public.tm_league_assist_leaders
  group by competition_id, season_id
),
standings as (
  select
    r.external_id as competition_id,
    r.record_key as season_id,
    count(*)::integer as standings_snapshot_count,
    max(r.fetched_at) as standings_last_fetched_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type = 'competition_table'
  group by r.external_id, r.record_key
),
season_sync as (
  select
    competition_id,
    season_id,
    sync_status,
    total_clubs,
    completed_clubs,
    sync_date,
    fetched_at
  from public.tm_league_seasons
)
select
  b.competition_id,
  b.competition_name,
  b.season_id,
  b.team_count,
  b.player_count,
  b.player_season_membership_count,
  b.players_with_market_value_snapshot,
  b.squad_market_value_eur,
  b.average_age,
  b.players_with_photo,
  b.players_with_position,
  b.players_with_age,
  b.players_with_nationality,
  b.players_with_contract_expiry,
  b.players_with_shirt_number,
  coalesce(st.players_with_season_statistics, 0)::integer as players_with_season_statistics,
  coalesce(st.season_stat_record_count, 0)::bigint as season_stat_record_count,
  coalesce(st.players_with_appearances_stats, 0)::integer as players_with_appearances_stats,
  coalesce(st.players_with_starts_stats, 0)::integer as players_with_starts_stats,
  coalesce(st.players_with_goal_stats, 0)::integer as players_with_goal_stats,
  coalesce(st.players_with_assist_stats, 0)::integer as players_with_assist_stats,
  coalesce(st.players_with_minutes_stats, 0)::integer as players_with_minutes_stats,
  coalesce(st.players_with_yellow_card_stats, 0)::integer as players_with_yellow_card_stats,
  coalesce(st.players_with_second_yellow_card_stats, 0)::integer as players_with_second_yellow_card_stats,
  coalesce(st.players_with_red_card_stats, 0)::integer as players_with_red_card_stats,
  coalesce(st.players_with_goals_conceded_stats, 0)::integer as players_with_goals_conceded_stats,
  coalesce(st.players_with_clean_sheet_stats, 0)::integer as players_with_clean_sheet_stats,
  coalesce(st.total_appearances, 0)::bigint as total_appearances,
  coalesce(st.total_starts, 0)::bigint as total_starts,
  coalesce(st.total_goals, 0)::bigint as total_goals,
  coalesce(st.total_assists, 0)::bigint as total_assists,
  coalesce(st.total_minutes, 0)::bigint as total_minutes,
  coalesce(st.total_yellow_cards, 0)::bigint as total_yellow_cards,
  coalesce(st.total_second_yellow_cards, 0)::bigint as total_second_yellow_cards,
  coalesce(st.total_red_cards, 0)::bigint as total_red_cards,
  coalesce(st.total_goals_conceded, 0)::bigint as total_goals_conceded,
  coalesce(st.total_clean_sheets, 0)::bigint as total_clean_sheets,
  coalesce(gl.goal_leader_entry_count, 0)::integer as goal_leader_entry_count,
  coalesce(gl.goal_leader_player_count, 0)::integer as goal_leader_player_count,
  coalesce(gl.top_goal_count, 0)::integer as top_goal_count,
  coalesce(al.assist_leader_entry_count, 0)::integer as assist_leader_entry_count,
  coalesce(al.assist_leader_player_count, 0)::integer as assist_leader_player_count,
  coalesce(al.top_assist_count, 0)::integer as top_assist_count,
  coalesce(sd.standings_snapshot_count, 0)::integer as standings_snapshot_count,
  (coalesce(sd.standings_snapshot_count, 0) > 0) as standings_available,
  coalesce(ss.sync_status, 'not_started') as squad_sync_status,
  coalesce(ss.total_clubs, b.team_count)::integer as registered_total_clubs,
  coalesce(ss.completed_clubs, 0)::integer as completed_clubs,
  case
    when coalesce(ss.total_clubs, b.team_count) > 0
      then round(coalesce(ss.completed_clubs, 0)::numeric * 100 / coalesce(ss.total_clubs, b.team_count), 1)
    else 0::numeric
  end as squad_sync_completion_pct,
  ss.sync_date,
  greatest(ss.fetched_at, sd.standings_last_fetched_at) as last_sync_or_standings_fetch_at
from season_roster b
left join season_stats st using (competition_id, season_id)
left join goal_leaders gl using (competition_id, season_id)
left join assist_leaders al using (competition_id, season_id)
left join standings sd using (competition_id, season_id)
left join season_sync ss using (competition_id, season_id);

create view public.tm_league_sync_dashboard
with (security_invoker = true)
as
with league_members as (
  select distinct competition_id, competition_name, tm_id
  from public.tm_team_season_squads
),
matched_season_stats as (
  -- Repeat the exact competition + season + club match for league-wide distinct-player metrics.
  select distinct
    q.competition_id,
    q.season_id,
    s.id as stat_row_id,
    s.tm_id,
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
    s.payload
  from public.tm_team_season_squads q
  join public.tm_player_season_stats s
    on s.tm_id = q.tm_id
   and (
        s.season_id = q.season_id
        or s.season_id like q.season_id || '/%'
        or s.season_id like q.season_id || '-%'
   )
   and lower(trim(coalesce(s.competition_name, ''))) = lower(trim(q.competition_name))
   and lower(trim(coalesce(s.club_name, ''))) = lower(trim(q.club_name))
),
raw_metric_values as (
  select
    m.competition_id,
    m.season_id,
    m.tm_id,
    x.metric_key,
    case
      when x.metric_value #>> '{}' ~ '^[-+]?[0-9]+([.][0-9]+)?
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    count(distinct q.club_id)::integer as team_count,
    count(distinct q.tm_id)::integer as player_count,
    count(*)::bigint as player_season_membership_count,
    count(distinct q.season_id)::integer as team_season_count
  from public.tm_team_season_squads q
  group by q.competition_id
),
roster_player_info as (
  select
    q.competition_id,
    q.tm_id,
    bool_or(nullif(trim(q.photo_url), '') is not null) as has_photo,
    bool_or(nullif(trim(q.position), '') is not null) as has_position,
    bool_or(q.age is not null) as has_age,
    bool_or(q.nationality is not null and q.nationality <> 'null'::jsonb
      and q.nationality <> '""'::jsonb and q.nationality <> '[]'::jsonb) as has_nationality,
    bool_or(nullif(trim(q.contract_expires), '') is not null) as has_contract_expiry,
    bool_or(q.shirt_number is not null) as has_shirt_number
  from public.tm_team_season_squads q
  group by q.competition_id, q.tm_id
),
roster_metrics as (
  select
    competition_id,
    count(*) filter (where has_photo)::integer as players_with_photo,
    count(*) filter (where has_position)::integer as players_with_position,
    count(*) filter (where has_age)::integer as players_with_age,
    count(*) filter (where has_nationality)::integer as players_with_nationality,
    count(*) filter (where has_contract_expiry)::integer as players_with_contract_expiry,
    count(*) filter (where has_shirt_number)::integer as players_with_shirt_number
  from roster_player_info
  group by competition_id
),
player_source_snapshots as (
  select
    r.external_id as tm_id,
    bool_or(r.record_type = 'player_profile') as has_profile_snapshot,
    bool_or(r.record_type = 'player_market_values') as has_market_value_snapshot,
    bool_or(r.record_type = 'player_transfers') as has_transfer_snapshot,
    bool_or(r.record_type = 'player_injuries') as has_injury_snapshot,
    bool_or(r.record_type = 'player_absences') as has_absence_snapshot,
    sum(case when r.record_type = 'player_injuries'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as injury_snapshot_items,
    sum(case when r.record_type = 'player_absences'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as absence_snapshot_items
  from public.tm_source_records r
  where r.record_type in (
    'player_profile', 'player_market_values', 'player_transfers',
    'player_injuries', 'player_absences'
  )
    and nullif(r.external_id, '') is not null
  group by r.external_id
),
league_player_detail_rows as (
  select
    m.competition_id,
    m.tm_id,
    (
      p.current_market_value_eur is not null
      or nullif(trim(p.current_market_value_text), '') is not null
    ) as has_current_market_value,
    coalesce(p.current_market_value_eur, 0)::numeric as current_market_value_eur,
    (coalesce(p.profile_payload, '{}'::jsonb) <> '{}'::jsonb) as has_profile_data,
    (coalesce(p.stats_payload, '{}'::jsonb) <> '{}'::jsonb) as has_stats_payload,
    (coalesce(p.current_season_payload, '{}'::jsonb) <> '{}'::jsonb) as has_current_season_data,
    (coalesce(p.national_career_payload, '{}'::jsonb) <> '{}'::jsonb) as has_national_career_data,
    coalesce(src.has_profile_snapshot, false) as has_profile_snapshot,
    coalesce(src.has_market_value_snapshot, false) as has_market_value_snapshot,
    coalesce(src.has_transfer_snapshot, false) as has_transfer_snapshot,
    coalesce(src.has_injury_snapshot, false) as has_injury_snapshot,
    coalesce(src.has_absence_snapshot, false) as has_absence_snapshot,
    greatest(
      public.tm_dashboard_payload_item_count(p.injuries_payload),
      coalesce(src.injury_snapshot_items, 0)
    )::bigint as injury_record_count,
    greatest(
      public.tm_dashboard_payload_item_count(p.absences_payload),
      coalesce(src.absence_snapshot_items, 0)
    )::bigint as absence_record_count
  from league_members m
  left join public.tm_players p on p.tm_id = m.tm_id
  left join player_source_snapshots src on src.tm_id = m.tm_id
),
player_detail_metrics as (
  select
    competition_id,
    count(*) filter (where has_current_market_value)::integer as players_with_current_market_value,
    sum(current_market_value_eur)::numeric as current_market_value_total_eur,
    count(*) filter (where has_profile_data)::integer as players_with_profile_data,
    count(*) filter (where has_stats_payload)::integer as players_with_stats_payload,
    count(*) filter (where has_current_season_data)::integer as players_with_current_season_data,
    count(*) filter (where has_national_career_data)::integer as players_with_national_career_data,
    count(*) filter (where has_profile_snapshot)::integer as players_with_profile_snapshot,
    count(*) filter (where has_market_value_snapshot)::integer as players_with_market_value_source_snapshot,
    count(*) filter (where has_transfer_snapshot)::integer as players_with_transfer_source_snapshot,
    count(*) filter (where has_injury_snapshot)::integer as players_with_injury_source_snapshot,
    count(*) filter (where has_absence_snapshot)::integer as players_with_absence_source_snapshot,
    count(*) filter (where injury_record_count > 0)::integer as players_with_injury_records,
    sum(injury_record_count)::bigint as injury_record_count,
    count(*) filter (where absence_record_count > 0)::integer as players_with_absence_records,
    sum(absence_record_count)::bigint as absence_record_count
  from league_player_detail_rows
  group by competition_id
),
market_value_history as (
  select
    m.competition_id,
    count(distinct v.tm_id)::integer as players_with_market_value_history,
    count(v.id)::bigint as market_value_history_record_count,
    count(v.id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::bigint as usable_market_value_history_record_count,
    count(distinct v.tm_id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::integer as players_with_usable_market_value_history
  from league_members m
  join public.tm_market_values v on v.tm_id = m.tm_id
  group by m.competition_id
),
transfer_history as (
  select
    m.competition_id,
    count(distinct t.tm_id)::integer as players_with_transfer_history,
    count(t.id)::bigint as transfer_history_record_count,
    count(distinct t.tm_id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::integer as players_with_transfer_fee,
    count(t.id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::bigint as transfer_fee_record_count,
    count(distinct t.tm_id) filter (where t.fee_eur is not null)::integer as players_with_numeric_transfer_fee,
    count(t.id) filter (where t.fee_eur is not null)::bigint as numeric_transfer_fee_record_count,
    coalesce(sum(t.fee_eur), 0)::numeric as total_transfer_fee_eur
  from league_members m
  join public.tm_transfers t on t.tm_id = m.tm_id
  group by m.competition_id
),
league_stat_players as (
  select
    competition_id,
    tm_id,
    bool_or(appearances is not null) as has_appearances,
    bool_or(starts is not null) as has_starts,
    bool_or(goals is not null) as has_goals,
    bool_or(assists is not null) as has_assists,
    bool_or(minutes is not null) as has_minutes,
    bool_or(yellow_cards is not null) as has_yellow_cards,
    bool_or(second_yellow_cards is not null) as has_second_yellow_cards,
    bool_or(red_cards is not null) as has_red_cards,
    bool_or(goals_conceded is not null) as has_goals_conceded,
    bool_or(clean_sheets is not null) as has_clean_sheets
  from matched_season_stats
  group by competition_id, tm_id
),
league_stat_metrics as (
  select
    competition_id,
    count(*)::integer as players_with_season_statistics,
    count(*) filter (where has_appearances)::integer as players_with_appearances_stats,
    count(*) filter (where has_starts)::integer as players_with_starts_stats,
    count(*) filter (where has_goals)::integer as players_with_goal_stats,
    count(*) filter (where has_assists)::integer as players_with_assist_stats,
    count(*) filter (where has_minutes)::integer as players_with_minutes_stats,
    count(*) filter (where has_yellow_cards)::integer as players_with_yellow_card_stats,
    count(*) filter (where has_second_yellow_cards)::integer as players_with_second_yellow_card_stats,
    count(*) filter (where has_red_cards)::integer as players_with_red_card_stats,
    count(*) filter (where has_goals_conceded)::integer as players_with_goals_conceded_stats,
    count(*) filter (where has_clean_sheets)::integer as players_with_clean_sheet_stats
  from league_stat_players
  group by competition_id
),
league_stat_totals as (
  select
    competition_id,
    count(*)::bigint as season_stat_record_count,
    sum(coalesce(appearances, 0))::bigint as total_appearances,
    sum(coalesce(starts, 0))::bigint as total_starts,
    sum(coalesce(goals, 0))::bigint as total_goals,
    sum(coalesce(assists, 0))::bigint as total_assists,
    sum(coalesce(minutes, 0))::bigint as total_minutes,
    sum(coalesce(yellow_cards, 0))::bigint as total_yellow_cards,
    sum(coalesce(second_yellow_cards, 0))::bigint as total_second_yellow_cards,
    sum(coalesce(red_cards, 0))::bigint as total_red_cards,
    sum(coalesce(goals_conceded, 0))::bigint as total_goals_conceded,
    sum(coalesce(clean_sheets, 0))::bigint as total_clean_sheets
  from matched_season_stats
  group by competition_id
),
league_goal_leaders as (
  select
    competition_id,
    count(*)::integer as goal_leader_entry_count,
    count(distinct tm_id)::integer as players_with_goal_leader_entries,
    count(distinct season_id)::integer as seasons_with_goal_leaders,
    max(goals)::integer as highest_goal_tally
  from public.tm_league_goal_leaders
  group by competition_id
),
league_assist_leaders as (
  select
    competition_id,
    count(*)::integer as assist_leader_entry_count,
    count(distinct tm_id)::integer as players_with_assist_leader_entries,
    count(distinct season_id)::integer as seasons_with_assist_leaders,
    max(assists)::integer as highest_assist_tally
  from public.tm_league_assist_leaders
  group by competition_id
),
league_standings as (
  select
    r.external_id as competition_id,
    count(*)::integer as standings_snapshot_count,
    count(distinct r.record_key)::integer as seasons_with_standings,
    max(r.fetched_at) as latest_standings_fetch_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type = 'competition_table'
  group by r.external_id
),
league_season_metrics as (
  select
    competition_id,
    count(*)::integer as season_count,
    max(season_id) as latest_season_id,
    count(*) filter (where squad_sync_status = 'completed')::integer as completed_seasons,
    count(*) filter (where squad_sync_status = 'running')::integer as running_seasons,
    count(*) filter (where squad_sync_status = 'failed')::integer as failed_seasons,
    count(*) filter (where season_stat_record_count > 0)::integer as seasons_with_player_statistics,
    count(*) filter (where goal_leader_entry_count > 0)::integer as seasons_with_goal_leaders,
    count(*) filter (where assist_leader_entry_count > 0)::integer as seasons_with_assist_leaders,
    count(*) filter (where standings_available)::integer as seasons_with_standings,
    sum(player_season_membership_count)::bigint as player_season_membership_count,
    sum(season_stat_record_count)::bigint as season_stat_record_count,
    sum(total_appearances)::bigint as total_appearances,
    sum(total_starts)::bigint as total_starts,
    sum(total_goals)::bigint as total_goals,
    sum(total_assists)::bigint as total_assists,
    sum(total_minutes)::bigint as total_minutes,
    sum(total_yellow_cards)::bigint as total_yellow_cards,
    sum(total_second_yellow_cards)::bigint as total_second_yellow_cards,
    sum(total_red_cards)::bigint as total_red_cards,
    sum(total_goals_conceded)::bigint as total_goals_conceded,
    sum(total_clean_sheets)::bigint as total_clean_sheets,
    jsonb_agg(to_jsonb(s) order by season_id desc) as season_breakdown
  from public.tm_league_sync_dashboard_seasons s
  group by competition_id
),
latest_season as (
  select distinct on (competition_id)
    competition_id,
    team_count as latest_season_team_count,
    player_count as latest_season_player_count,
    players_with_market_value_snapshot as latest_season_players_with_market_value,
    squad_market_value_eur as latest_season_squad_market_value_eur,
    average_age as latest_season_average_age,
    squad_sync_status as latest_season_sync_status,
    squad_sync_completion_pct as latest_season_sync_completion_pct
  from public.tm_league_sync_dashboard_seasons
  order by competition_id, season_id desc
)
select
  b.competition_id,
  b.competition_name,
  b.team_count,
  b.player_count,
  b.team_season_count,
  coalesce(sm.season_count, 0)::integer as season_count,
  sm.latest_season_id,
  coalesce(sm.latest_season_id, '') as latest_season,
  coalesce(sm.completed_seasons, 0)::integer as completed_seasons,
  coalesce(sm.running_seasons, 0)::integer as running_seasons,
  coalesce(sm.failed_seasons, 0)::integer as failed_seasons,
  coalesce(b.player_season_membership_count, 0)::bigint as player_season_membership_count,
  coalesce(rm.players_with_photo, 0)::integer as players_with_photo,
  coalesce(rm.players_with_position, 0)::integer as players_with_position,
  coalesce(rm.players_with_age, 0)::integer as players_with_age,
  coalesce(rm.players_with_nationality, 0)::integer as players_with_nationality,
  coalesce(rm.players_with_contract_expiry, 0)::integer as players_with_contract_expiry,
  coalesce(rm.players_with_shirt_number, 0)::integer as players_with_shirt_number,
  coalesce(pd.players_with_current_market_value, 0)::integer as players_with_current_market_value,
  coalesce(pd.current_market_value_total_eur, 0)::numeric as current_market_value_total_eur,
  case when b.player_count > 0 then round(coalesce(pd.players_with_current_market_value, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as current_market_value_coverage_pct,
  coalesce(mvh.players_with_market_value_history, 0)::integer as players_with_market_value_history,
  coalesce(mvh.players_with_usable_market_value_history, 0)::integer as players_with_usable_market_value_history,
  coalesce(mvh.market_value_history_record_count, 0)::bigint as market_value_history_record_count,
  coalesce(mvh.usable_market_value_history_record_count, 0)::bigint as usable_market_value_history_record_count,
  case when b.player_count > 0 then round(coalesce(mvh.players_with_market_value_history, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as market_value_history_coverage_pct,
  coalesce(pd.players_with_injury_records, 0)::integer as players_with_injury_records,
  coalesce(pd.injury_record_count, 0)::bigint as injury_record_count,
  coalesce(pd.players_with_injury_source_snapshot, 0)::integer as players_with_injury_source_snapshot,
  coalesce(pd.players_with_absence_records, 0)::integer as players_with_absence_records,
  coalesce(pd.absence_record_count, 0)::bigint as absence_record_count,
  coalesce(pd.players_with_absence_source_snapshot, 0)::integer as players_with_absence_source_snapshot,
  coalesce(th.players_with_transfer_history, 0)::integer as players_with_transfer_history,
  coalesce(th.transfer_history_record_count, 0)::bigint as transfer_history_record_count,
  coalesce(th.players_with_transfer_fee, 0)::integer as players_with_transfer_fee,
  coalesce(th.transfer_fee_record_count, 0)::bigint as transfer_fee_record_count,
  coalesce(th.players_with_numeric_transfer_fee, 0)::integer as players_with_numeric_transfer_fee,
  coalesce(th.numeric_transfer_fee_record_count, 0)::bigint as numeric_transfer_fee_record_count,
  coalesce(th.total_transfer_fee_eur, 0)::numeric as total_transfer_fee_eur,
  coalesce(pd.players_with_profile_data, 0)::integer as players_with_profile_data,
  coalesce(pd.players_with_profile_snapshot, 0)::integer as players_with_profile_snapshot,
  coalesce(pd.players_with_stats_payload, 0)::integer as players_with_stats_payload,
  coalesce(pd.players_with_current_season_data, 0)::integer as players_with_current_season_data,
  coalesce(pd.players_with_national_career_data, 0)::integer as players_with_national_career_data,
  coalesce(pd.players_with_market_value_source_snapshot, 0)::integer as players_with_market_value_source_snapshot,
  coalesce(pd.players_with_transfer_source_snapshot, 0)::integer as players_with_transfer_source_snapshot,
  coalesce(sm.seasons_with_player_statistics, 0)::integer as seasons_with_player_statistics,
  coalesce(stm.players_with_season_statistics, 0)::integer as players_with_season_statistics,
  coalesce(stm.players_with_appearances_stats, 0)::integer as players_with_appearances_stats,
  coalesce(stm.players_with_starts_stats, 0)::integer as players_with_starts_stats,
  coalesce(stm.players_with_goal_stats, 0)::integer as players_with_goal_stats,
  coalesce(stm.players_with_assist_stats, 0)::integer as players_with_assist_stats,
  coalesce(stm.players_with_minutes_stats, 0)::integer as players_with_minutes_stats,
  coalesce(stm.players_with_yellow_card_stats, 0)::integer as players_with_yellow_card_stats,
  coalesce(stm.players_with_second_yellow_card_stats, 0)::integer as players_with_second_yellow_card_stats,
  coalesce(stm.players_with_red_card_stats, 0)::integer as players_with_red_card_stats,
  coalesce(stm.players_with_goals_conceded_stats, 0)::integer as players_with_goals_conceded_stats,
  coalesce(stm.players_with_clean_sheet_stats, 0)::integer as players_with_clean_sheet_stats,
  coalesce(sm.season_stat_record_count, 0)::bigint as season_stat_record_count,
  coalesce(sm.total_appearances, 0)::bigint as total_appearances,
  coalesce(sm.total_starts, 0)::bigint as total_starts,
  coalesce(sm.total_goals, 0)::bigint as total_goals,
  coalesce(sm.total_assists, 0)::bigint as total_assists,
  coalesce(sm.total_minutes, 0)::bigint as total_minutes,
  coalesce(sm.total_yellow_cards, 0)::bigint as total_yellow_cards,
  coalesce(sm.total_second_yellow_cards, 0)::bigint as total_second_yellow_cards,
  coalesce(sm.total_red_cards, 0)::bigint as total_red_cards,
  coalesce(sm.total_goals_conceded, 0)::bigint as total_goals_conceded,
  coalesce(sm.total_clean_sheets, 0)::bigint as total_clean_sheets,
  coalesce(gl.players_with_goal_leader_entries, 0)::integer as players_with_goal_leader_entries,
  coalesce(gl.goal_leader_entry_count, 0)::integer as goal_leader_entry_count,
  coalesce(gl.seasons_with_goal_leaders, 0)::integer as seasons_with_goal_leaders,
  coalesce(gl.highest_goal_tally, 0)::integer as highest_goal_tally,
  coalesce(al.players_with_assist_leader_entries, 0)::integer as players_with_assist_leader_entries,
  coalesce(al.assist_leader_entry_count, 0)::integer as assist_leader_entry_count,
  coalesce(al.seasons_with_assist_leaders, 0)::integer as seasons_with_assist_leaders,
  coalesce(al.highest_assist_tally, 0)::integer as highest_assist_tally,
  coalesce(ls.seasons_with_standings, 0)::integer as seasons_with_standings,
  coalesce(ls.standings_snapshot_count, 0)::integer as standings_snapshot_count,
  coalesce(latest.latest_season_team_count, 0)::integer as latest_season_team_count,
  coalesce(latest.latest_season_player_count, 0)::integer as latest_season_player_count,
  coalesce(latest.latest_season_players_with_market_value, 0)::integer as latest_season_players_with_market_value,
  coalesce(latest.latest_season_squad_market_value_eur, 0)::numeric as latest_season_squad_market_value_eur,
  latest.latest_season_average_age,
  latest.latest_season_sync_status,
  latest.latest_season_sync_completion_pct,
  coalesce(sm.season_breakdown, '[]'::jsonb) as season_breakdown
from league_base b
left join roster_metrics rm using (competition_id)
left join player_detail_metrics pd using (competition_id)
left join market_value_history mvh using (competition_id)
left join transfer_history th using (competition_id)
left join league_stat_metrics stm using (competition_id)
left join league_season_metrics sm using (competition_id)
left join league_goal_leaders gl using (competition_id)
left join league_assist_leaders al using (competition_id)
left join league_standings ls using (competition_id)
left join latest_season latest using (competition_id);

revoke all on function public.tm_dashboard_payload_item_count(jsonb) from public, anon, authenticated;
grant execute on function public.tm_dashboard_payload_item_count(jsonb) to service_role;

revoke all on public.tm_league_sync_dashboard from anon, authenticated;
revoke all on public.tm_league_sync_dashboard_seasons from anon, authenticated;
grant select on public.tm_league_sync_dashboard to service_role;
grant select on public.tm_league_sync_dashboard_seasons to service_role;

commit;

        then (x.metric_value #>> '{}')::numeric
      else null
    end as numeric_value
  from matched_season_stats m
  cross join lateral public.tm_dashboard_flatten_stat_metrics(m.payload) x
),
league_base as (
  select
    q.competition_id,
    max(q.competition_name) as competition_name,
    count(distinct q.club_id)::integer as team_count,
    count(distinct q.tm_id)::integer as player_count,
    count(*)::bigint as player_season_membership_count,
    count(distinct q.season_id)::integer as team_season_count
  from public.tm_team_season_squads q
  group by q.competition_id
),
roster_player_info as (
  select
    q.competition_id,
    q.tm_id,
    bool_or(nullif(trim(q.photo_url), '') is not null) as has_photo,
    bool_or(nullif(trim(q.position), '') is not null) as has_position,
    bool_or(q.age is not null) as has_age,
    bool_or(q.nationality is not null and q.nationality <> 'null'::jsonb
      and q.nationality <> '""'::jsonb and q.nationality <> '[]'::jsonb) as has_nationality,
    bool_or(nullif(trim(q.contract_expires), '') is not null) as has_contract_expiry,
    bool_or(q.shirt_number is not null) as has_shirt_number
  from public.tm_team_season_squads q
  group by q.competition_id, q.tm_id
),
roster_metrics as (
  select
    competition_id,
    count(*) filter (where has_photo)::integer as players_with_photo,
    count(*) filter (where has_position)::integer as players_with_position,
    count(*) filter (where has_age)::integer as players_with_age,
    count(*) filter (where has_nationality)::integer as players_with_nationality,
    count(*) filter (where has_contract_expiry)::integer as players_with_contract_expiry,
    count(*) filter (where has_shirt_number)::integer as players_with_shirt_number
  from roster_player_info
  group by competition_id
),
player_source_snapshots as (
  select
    r.external_id as tm_id,
    bool_or(r.record_type = 'player_profile') as has_profile_snapshot,
    bool_or(r.record_type = 'player_market_values') as has_market_value_snapshot,
    bool_or(r.record_type = 'player_transfers') as has_transfer_snapshot,
    bool_or(r.record_type = 'player_injuries') as has_injury_snapshot,
    bool_or(r.record_type = 'player_absences') as has_absence_snapshot,
    sum(case when r.record_type = 'player_injuries'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as injury_snapshot_items,
    sum(case when r.record_type = 'player_absences'
      then public.tm_dashboard_payload_item_count(r.payload) else 0 end)::bigint as absence_snapshot_items
  from public.tm_source_records r
  where r.record_type in (
    'player_profile', 'player_market_values', 'player_transfers',
    'player_injuries', 'player_absences'
  )
    and nullif(r.external_id, '') is not null
  group by r.external_id
),
league_player_detail_rows as (
  select
    m.competition_id,
    m.tm_id,
    (
      p.current_market_value_eur is not null
      or nullif(trim(p.current_market_value_text), '') is not null
    ) as has_current_market_value,
    coalesce(p.current_market_value_eur, 0)::numeric as current_market_value_eur,
    (coalesce(p.profile_payload, '{}'::jsonb) <> '{}'::jsonb) as has_profile_data,
    (coalesce(p.stats_payload, '{}'::jsonb) <> '{}'::jsonb) as has_stats_payload,
    (coalesce(p.current_season_payload, '{}'::jsonb) <> '{}'::jsonb) as has_current_season_data,
    (coalesce(p.national_career_payload, '{}'::jsonb) <> '{}'::jsonb) as has_national_career_data,
    coalesce(src.has_profile_snapshot, false) as has_profile_snapshot,
    coalesce(src.has_market_value_snapshot, false) as has_market_value_snapshot,
    coalesce(src.has_transfer_snapshot, false) as has_transfer_snapshot,
    coalesce(src.has_injury_snapshot, false) as has_injury_snapshot,
    coalesce(src.has_absence_snapshot, false) as has_absence_snapshot,
    greatest(
      public.tm_dashboard_payload_item_count(p.injuries_payload),
      coalesce(src.injury_snapshot_items, 0)
    )::bigint as injury_record_count,
    greatest(
      public.tm_dashboard_payload_item_count(p.absences_payload),
      coalesce(src.absence_snapshot_items, 0)
    )::bigint as absence_record_count
  from league_members m
  left join public.tm_players p on p.tm_id = m.tm_id
  left join player_source_snapshots src on src.tm_id = m.tm_id
),
player_detail_metrics as (
  select
    competition_id,
    count(*) filter (where has_current_market_value)::integer as players_with_current_market_value,
    sum(current_market_value_eur)::numeric as current_market_value_total_eur,
    count(*) filter (where has_profile_data)::integer as players_with_profile_data,
    count(*) filter (where has_stats_payload)::integer as players_with_stats_payload,
    count(*) filter (where has_current_season_data)::integer as players_with_current_season_data,
    count(*) filter (where has_national_career_data)::integer as players_with_national_career_data,
    count(*) filter (where has_profile_snapshot)::integer as players_with_profile_snapshot,
    count(*) filter (where has_market_value_snapshot)::integer as players_with_market_value_source_snapshot,
    count(*) filter (where has_transfer_snapshot)::integer as players_with_transfer_source_snapshot,
    count(*) filter (where has_injury_snapshot)::integer as players_with_injury_source_snapshot,
    count(*) filter (where has_absence_snapshot)::integer as players_with_absence_source_snapshot,
    count(*) filter (where injury_record_count > 0)::integer as players_with_injury_records,
    sum(injury_record_count)::bigint as injury_record_count,
    count(*) filter (where absence_record_count > 0)::integer as players_with_absence_records,
    sum(absence_record_count)::bigint as absence_record_count
  from league_player_detail_rows
  group by competition_id
),
market_value_history as (
  select
    m.competition_id,
    count(distinct v.tm_id)::integer as players_with_market_value_history,
    count(v.id)::bigint as market_value_history_record_count,
    count(v.id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::bigint as usable_market_value_history_record_count,
    count(distinct v.tm_id) filter (
      where v.value_eur is not null or nullif(trim(v.display_value), '') is not null
    )::integer as players_with_usable_market_value_history
  from league_members m
  join public.tm_market_values v on v.tm_id = m.tm_id
  group by m.competition_id
),
transfer_history as (
  select
    m.competition_id,
    count(distinct t.tm_id)::integer as players_with_transfer_history,
    count(t.id)::bigint as transfer_history_record_count,
    count(distinct t.tm_id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::integer as players_with_transfer_fee,
    count(t.id) filter (
      where t.fee_eur is not null
        or (
          nullif(trim(t.fee_text), '') is not null
          and lower(trim(t.fee_text)) not in ('-', '?', 'unknown', 'undisclosed', 'n/a', 'not disclosed')
        )
    )::bigint as transfer_fee_record_count,
    count(distinct t.tm_id) filter (where t.fee_eur is not null)::integer as players_with_numeric_transfer_fee,
    count(t.id) filter (where t.fee_eur is not null)::bigint as numeric_transfer_fee_record_count,
    coalesce(sum(t.fee_eur), 0)::numeric as total_transfer_fee_eur
  from league_members m
  join public.tm_transfers t on t.tm_id = m.tm_id
  group by m.competition_id
),
league_stat_players as (
  select
    competition_id,
    tm_id,
    bool_or(appearances is not null) as has_appearances,
    bool_or(starts is not null) as has_starts,
    bool_or(goals is not null) as has_goals,
    bool_or(assists is not null) as has_assists,
    bool_or(minutes is not null) as has_minutes,
    bool_or(yellow_cards is not null) as has_yellow_cards,
    bool_or(second_yellow_cards is not null) as has_second_yellow_cards,
    bool_or(red_cards is not null) as has_red_cards,
    bool_or(goals_conceded is not null) as has_goals_conceded,
    bool_or(clean_sheets is not null) as has_clean_sheets
  from matched_season_stats
  group by competition_id, tm_id
),
league_stat_metrics as (
  select
    competition_id,
    count(*)::integer as players_with_season_statistics,
    count(*) filter (where has_appearances)::integer as players_with_appearances_stats,
    count(*) filter (where has_starts)::integer as players_with_starts_stats,
    count(*) filter (where has_goals)::integer as players_with_goal_stats,
    count(*) filter (where has_assists)::integer as players_with_assist_stats,
    count(*) filter (where has_minutes)::integer as players_with_minutes_stats,
    count(*) filter (where has_yellow_cards)::integer as players_with_yellow_card_stats,
    count(*) filter (where has_second_yellow_cards)::integer as players_with_second_yellow_card_stats,
    count(*) filter (where has_red_cards)::integer as players_with_red_card_stats,
    count(*) filter (where has_goals_conceded)::integer as players_with_goals_conceded_stats,
    count(*) filter (where has_clean_sheets)::integer as players_with_clean_sheet_stats
  from league_stat_players
  group by competition_id
),
league_stat_totals as (
  select
    competition_id,
    count(*)::bigint as season_stat_record_count,
    sum(coalesce(appearances, 0))::bigint as total_appearances,
    sum(coalesce(starts, 0))::bigint as total_starts,
    sum(coalesce(goals, 0))::bigint as total_goals,
    sum(coalesce(assists, 0))::bigint as total_assists,
    sum(coalesce(minutes, 0))::bigint as total_minutes,
    sum(coalesce(yellow_cards, 0))::bigint as total_yellow_cards,
    sum(coalesce(second_yellow_cards, 0))::bigint as total_second_yellow_cards,
    sum(coalesce(red_cards, 0))::bigint as total_red_cards,
    sum(coalesce(goals_conceded, 0))::bigint as total_goals_conceded,
    sum(coalesce(clean_sheets, 0))::bigint as total_clean_sheets
  from matched_season_stats
  group by competition_id
),
league_goal_leaders as (
  select
    competition_id,
    count(*)::integer as goal_leader_entry_count,
    count(distinct tm_id)::integer as players_with_goal_leader_entries,
    count(distinct season_id)::integer as seasons_with_goal_leaders,
    max(goals)::integer as highest_goal_tally
  from public.tm_league_goal_leaders
  group by competition_id
),
league_assist_leaders as (
  select
    competition_id,
    count(*)::integer as assist_leader_entry_count,
    count(distinct tm_id)::integer as players_with_assist_leader_entries,
    count(distinct season_id)::integer as seasons_with_assist_leaders,
    max(assists)::integer as highest_assist_tally
  from public.tm_league_assist_leaders
  group by competition_id
),
league_standings as (
  select
    r.external_id as competition_id,
    count(*)::integer as standings_snapshot_count,
    count(distinct r.record_key)::integer as seasons_with_standings,
    max(r.fetched_at) as latest_standings_fetch_at
  from public.tm_source_records r
  where r.source = 'felipeall'
    and r.record_type = 'competition_table'
  group by r.external_id
),
league_season_metrics as (
  select
    competition_id,
    count(*)::integer as season_count,
    max(season_id) as latest_season_id,
    count(*) filter (where squad_sync_status = 'completed')::integer as completed_seasons,
    count(*) filter (where squad_sync_status = 'running')::integer as running_seasons,
    count(*) filter (where squad_sync_status = 'failed')::integer as failed_seasons,
    count(*) filter (where season_stat_record_count > 0)::integer as seasons_with_player_statistics,
    count(*) filter (where goal_leader_entry_count > 0)::integer as seasons_with_goal_leaders,
    count(*) filter (where assist_leader_entry_count > 0)::integer as seasons_with_assist_leaders,
    count(*) filter (where standings_available)::integer as seasons_with_standings,
    sum(player_season_membership_count)::bigint as player_season_membership_count,
    sum(season_stat_record_count)::bigint as season_stat_record_count,
    sum(total_appearances)::bigint as total_appearances,
    sum(total_starts)::bigint as total_starts,
    sum(total_goals)::bigint as total_goals,
    sum(total_assists)::bigint as total_assists,
    sum(total_minutes)::bigint as total_minutes,
    sum(total_yellow_cards)::bigint as total_yellow_cards,
    sum(total_second_yellow_cards)::bigint as total_second_yellow_cards,
    sum(total_red_cards)::bigint as total_red_cards,
    sum(total_goals_conceded)::bigint as total_goals_conceded,
    sum(total_clean_sheets)::bigint as total_clean_sheets,
    jsonb_agg(to_jsonb(s) order by season_id desc) as season_breakdown
  from public.tm_league_sync_dashboard_seasons s
  group by competition_id
),
latest_season as (
  select distinct on (competition_id)
    competition_id,
    team_count as latest_season_team_count,
    player_count as latest_season_player_count,
    players_with_market_value_snapshot as latest_season_players_with_market_value,
    squad_market_value_eur as latest_season_squad_market_value_eur,
    average_age as latest_season_average_age,
    squad_sync_status as latest_season_sync_status,
    squad_sync_completion_pct as latest_season_sync_completion_pct
  from public.tm_league_sync_dashboard_seasons
  order by competition_id, season_id desc
)
select
  b.competition_id,
  b.competition_name,
  b.team_count,
  b.player_count,
  b.team_season_count,
  coalesce(sm.season_count, 0)::integer as season_count,
  sm.latest_season_id,
  coalesce(sm.latest_season_id, '') as latest_season,
  coalesce(sm.completed_seasons, 0)::integer as completed_seasons,
  coalesce(sm.running_seasons, 0)::integer as running_seasons,
  coalesce(sm.failed_seasons, 0)::integer as failed_seasons,
  coalesce(b.player_season_membership_count, 0)::bigint as player_season_membership_count,
  coalesce(rm.players_with_photo, 0)::integer as players_with_photo,
  coalesce(rm.players_with_position, 0)::integer as players_with_position,
  coalesce(rm.players_with_age, 0)::integer as players_with_age,
  coalesce(rm.players_with_nationality, 0)::integer as players_with_nationality,
  coalesce(rm.players_with_contract_expiry, 0)::integer as players_with_contract_expiry,
  coalesce(rm.players_with_shirt_number, 0)::integer as players_with_shirt_number,
  coalesce(pd.players_with_current_market_value, 0)::integer as players_with_current_market_value,
  coalesce(pd.current_market_value_total_eur, 0)::numeric as current_market_value_total_eur,
  case when b.player_count > 0 then round(coalesce(pd.players_with_current_market_value, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as current_market_value_coverage_pct,
  coalesce(mvh.players_with_market_value_history, 0)::integer as players_with_market_value_history,
  coalesce(mvh.players_with_usable_market_value_history, 0)::integer as players_with_usable_market_value_history,
  coalesce(mvh.market_value_history_record_count, 0)::bigint as market_value_history_record_count,
  coalesce(mvh.usable_market_value_history_record_count, 0)::bigint as usable_market_value_history_record_count,
  case when b.player_count > 0 then round(coalesce(mvh.players_with_market_value_history, 0)::numeric * 100 / b.player_count, 1) else 0::numeric end as market_value_history_coverage_pct,
  coalesce(pd.players_with_injury_records, 0)::integer as players_with_injury_records,
  coalesce(pd.injury_record_count, 0)::bigint as injury_record_count,
  coalesce(pd.players_with_injury_source_snapshot, 0)::integer as players_with_injury_source_snapshot,
  coalesce(pd.players_with_absence_records, 0)::integer as players_with_absence_records,
  coalesce(pd.absence_record_count, 0)::bigint as absence_record_count,
  coalesce(pd.players_with_absence_source_snapshot, 0)::integer as players_with_absence_source_snapshot,
  coalesce(th.players_with_transfer_history, 0)::integer as players_with_transfer_history,
  coalesce(th.transfer_history_record_count, 0)::bigint as transfer_history_record_count,
  coalesce(th.players_with_transfer_fee, 0)::integer as players_with_transfer_fee,
  coalesce(th.transfer_fee_record_count, 0)::bigint as transfer_fee_record_count,
  coalesce(th.players_with_numeric_transfer_fee, 0)::integer as players_with_numeric_transfer_fee,
  coalesce(th.numeric_transfer_fee_record_count, 0)::bigint as numeric_transfer_fee_record_count,
  coalesce(th.total_transfer_fee_eur, 0)::numeric as total_transfer_fee_eur,
  coalesce(pd.players_with_profile_data, 0)::integer as players_with_profile_data,
  coalesce(pd.players_with_profile_snapshot, 0)::integer as players_with_profile_snapshot,
  coalesce(pd.players_with_stats_payload, 0)::integer as players_with_stats_payload,
  coalesce(pd.players_with_current_season_data, 0)::integer as players_with_current_season_data,
  coalesce(pd.players_with_national_career_data, 0)::integer as players_with_national_career_data,
  coalesce(pd.players_with_market_value_source_snapshot, 0)::integer as players_with_market_value_source_snapshot,
  coalesce(pd.players_with_transfer_source_snapshot, 0)::integer as players_with_transfer_source_snapshot,
  coalesce(sm.seasons_with_player_statistics, 0)::integer as seasons_with_player_statistics,
  coalesce(stm.players_with_season_statistics, 0)::integer as players_with_season_statistics,
  coalesce(stm.players_with_appearances_stats, 0)::integer as players_with_appearances_stats,
  coalesce(stm.players_with_starts_stats, 0)::integer as players_with_starts_stats,
  coalesce(stm.players_with_goal_stats, 0)::integer as players_with_goal_stats,
  coalesce(stm.players_with_assist_stats, 0)::integer as players_with_assist_stats,
  coalesce(stm.players_with_minutes_stats, 0)::integer as players_with_minutes_stats,
  coalesce(stm.players_with_yellow_card_stats, 0)::integer as players_with_yellow_card_stats,
  coalesce(stm.players_with_second_yellow_card_stats, 0)::integer as players_with_second_yellow_card_stats,
  coalesce(stm.players_with_red_card_stats, 0)::integer as players_with_red_card_stats,
  coalesce(stm.players_with_goals_conceded_stats, 0)::integer as players_with_goals_conceded_stats,
  coalesce(stm.players_with_clean_sheet_stats, 0)::integer as players_with_clean_sheet_stats,
  coalesce(sm.season_stat_record_count, 0)::bigint as season_stat_record_count,
  coalesce(sm.total_appearances, 0)::bigint as total_appearances,
  coalesce(sm.total_starts, 0)::bigint as total_starts,
  coalesce(sm.total_goals, 0)::bigint as total_goals,
  coalesce(sm.total_assists, 0)::bigint as total_assists,
  coalesce(sm.total_minutes, 0)::bigint as total_minutes,
  coalesce(sm.total_yellow_cards, 0)::bigint as total_yellow_cards,
  coalesce(sm.total_second_yellow_cards, 0)::bigint as total_second_yellow_cards,
  coalesce(sm.total_red_cards, 0)::bigint as total_red_cards,
  coalesce(sm.total_goals_conceded, 0)::bigint as total_goals_conceded,
  coalesce(sm.total_clean_sheets, 0)::bigint as total_clean_sheets,
  coalesce(gl.players_with_goal_leader_entries, 0)::integer as players_with_goal_leader_entries,
  coalesce(gl.goal_leader_entry_count, 0)::integer as goal_leader_entry_count,
  coalesce(gl.seasons_with_goal_leaders, 0)::integer as seasons_with_goal_leaders,
  coalesce(gl.highest_goal_tally, 0)::integer as highest_goal_tally,
  coalesce(al.players_with_assist_leader_entries, 0)::integer as players_with_assist_leader_entries,
  coalesce(al.assist_leader_entry_count, 0)::integer as assist_leader_entry_count,
  coalesce(al.seasons_with_assist_leaders, 0)::integer as seasons_with_assist_leaders,
  coalesce(al.highest_assist_tally, 0)::integer as highest_assist_tally,
  coalesce(ls.seasons_with_standings, 0)::integer as seasons_with_standings,
  coalesce(ls.standings_snapshot_count, 0)::integer as standings_snapshot_count,
  coalesce(latest.latest_season_team_count, 0)::integer as latest_season_team_count,
  coalesce(latest.latest_season_player_count, 0)::integer as latest_season_player_count,
  coalesce(latest.latest_season_players_with_market_value, 0)::integer as latest_season_players_with_market_value,
  coalesce(latest.latest_season_squad_market_value_eur, 0)::numeric as latest_season_squad_market_value_eur,
  latest.latest_season_average_age,
  latest.latest_season_sync_status,
  latest.latest_season_sync_completion_pct,
  coalesce(sm.season_breakdown, '[]'::jsonb) as season_breakdown
from league_base b
left join roster_metrics rm using (competition_id)
left join player_detail_metrics pd using (competition_id)
left join market_value_history mvh using (competition_id)
left join transfer_history th using (competition_id)
left join league_stat_metrics stm using (competition_id)
left join league_season_metrics sm using (competition_id)
left join league_goal_leaders gl using (competition_id)
left join league_assist_leaders al using (competition_id)
left join league_standings ls using (competition_id)
left join latest_season latest using (competition_id);

revoke all on function public.tm_dashboard_payload_item_count(jsonb) from public, anon, authenticated;
grant execute on function public.tm_dashboard_payload_item_count(jsonb) to service_role;

revoke all on public.tm_league_sync_dashboard from anon, authenticated;
revoke all on public.tm_league_sync_dashboard_seasons from anon, authenticated;
grant select on public.tm_league_sync_dashboard to service_role;
grant select on public.tm_league_sync_dashboard_seasons to service_role;

commit;

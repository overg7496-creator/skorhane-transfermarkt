-- SkorHane leaderboard source-truth verification.
-- Fast version: scopes the source view once, then performs small aggregations
-- over the selected competition/season only.
-- Change only these two values for another league/season.
with params as (
  select
    'TR1'::text as competition_id,
    '2026'::text as season_id
),
scoped_totals as materialized (
  select
    t.competition_id,
    t.competition_name,
    t.season_id,
    t.tm_id,
    t.player_name,
    t.photo_url,
    t.club_name,
    coalesce(t.goals, 0)::bigint as goals,
    coalesce(t.assists, 0)::bigint as assists,
    coalesce(t.appearances, 0)::bigint as appearances,
    coalesce(t.minutes, 0)::bigint as minutes
  from public.tm_league_player_season_totals t
  cross join params p
  where t.competition_id = p.competition_id
    and t.season_id = p.season_id
),
goal_rows as materialized (
  select *
  from scoped_totals
  where goals > 0
),
assist_rows as materialized (
  select *
  from scoped_totals
  where assists > 0
),
goal_duplicates as (
  select tm_id
  from goal_rows
  group by tm_id
  having count(*) > 1
),
assist_duplicates as (
  select tm_id
  from assist_rows
  group by tm_id
  having count(*) > 1
),
goal_top_10 as (
  select
    dense_rank() over (order by goals desc)::integer as leader_rank,
    player_name,
    tm_id,
    club_name,
    goals,
    assists
  from goal_rows
  order by goals desc, assists desc, minutes desc, player_name, tm_id
  limit 10
),
assist_top_10 as (
  select
    dense_rank() over (order by assists desc)::integer as leader_rank,
    player_name,
    tm_id,
    club_name,
    assists,
    goals
  from assist_rows
  order by assists desc, goals desc, minutes desc, player_name, tm_id
  limit 10
),
totals_summary as (
  select
    count(*)::bigint as rows,
    count(distinct tm_id)::bigint as unique_players,
    (select count(*) from (
      select tm_id from scoped_totals group by tm_id having count(*) > 1
    ) d)::bigint as duplicate_player_groups
  from scoped_totals
),
goal_summary as (
  select
    (select count(*) from goal_rows)::bigint as rows,
    (select count(distinct tm_id) from goal_rows)::bigint as unique_players,
    (select count(*) from goal_duplicates)::bigint as duplicate_player_groups,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'rank', leader_rank,
          'player', player_name,
          'tm_id', tm_id,
          'team', club_name,
          'goals', goals,
          'assists', assists
        )
        order by leader_rank, goals desc, player_name
      )
      from goal_top_10
    ), '[]'::jsonb) as top_10
),
assist_summary as (
  select
    (select count(*) from assist_rows)::bigint as rows,
    (select count(distinct tm_id) from assist_rows)::bigint as unique_players,
    (select count(*) from assist_duplicates)::bigint as duplicate_player_groups,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'rank', leader_rank,
          'player', player_name,
          'tm_id', tm_id,
          'team', club_name,
          'assists', assists,
          'goals', goals
        )
        order by leader_rank, assists desc, player_name
      )
      from assist_top_10
    ), '[]'::jsonb) as top_10
)
select jsonb_pretty(
  jsonb_build_object(
    'competition_id', (select competition_id from params),
    'season_id', (select season_id from params),
    'totals', (select to_jsonb(t) from totals_summary t),
    'goals', (select to_jsonb(g) from goal_summary g),
    'assists', (select to_jsonb(a) from assist_summary a),
    'checks', jsonb_build_object(
      'goal_duplicate_player_groups_zero',
        (select duplicate_player_groups = 0 from goal_summary),
      'assist_duplicate_player_groups_zero',
        (select duplicate_player_groups = 0 from assist_summary),
      'same_player_counted_once_in_totals',
        (select duplicate_player_groups = 0 from totals_summary)
    )
  )
) as skorhane_leaderboard_source_truth;

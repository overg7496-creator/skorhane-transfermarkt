-- SkorHane leaderboard source-truth verification.
-- Change only these two values for another league/season.
-- This query reads tm_league_player_season_totals ONCE. It deliberately does not
-- scan the goal and assist views independently (the old script made two costly
-- passes over the same derived view).

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
  join params p
    on p.competition_id = t.competition_id
   and p.season_id = t.season_id
),
goal_rows as materialized (
  select
    dense_rank() over (order by s.goals desc)::integer as leader_rank,
    row_number() over (order by s.goals desc, s.player_name, s.tm_id) as display_row,
    count(*) over (partition by s.tm_id) as rows_for_player,
    s.*
  from scoped_totals s
  where s.goals > 0
),
assist_rows as materialized (
  select
    dense_rank() over (order by s.assists desc)::integer as leader_rank,
    row_number() over (order by s.assists desc, s.player_name, s.tm_id) as display_row,
    count(*) over (partition by s.tm_id) as rows_for_player,
    s.*
  from scoped_totals s
  where s.assists > 0
),
goal_summary as (
  select
    count(*)::bigint as rows,
    count(distinct tm_id)::bigint as unique_players,
    count(distinct tm_id) filter (where rows_for_player > 1)::bigint as duplicate_player_groups,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rank', leader_rank,
          'player', player_name,
          'tm_id', tm_id,
          'team', club_name,
          'goals', goals,
          'assists', assists
        )
        order by display_row
      ) filter (where display_row <= 10),
      '[]'::jsonb
    ) as top_10
  from goal_rows
),
assist_summary as (
  select
    count(*)::bigint as rows,
    count(distinct tm_id)::bigint as unique_players,
    count(distinct tm_id) filter (where rows_for_player > 1)::bigint as duplicate_player_groups,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rank', leader_rank,
          'player', player_name,
          'tm_id', tm_id,
          'team', club_name,
          'assists', assists,
          'goals', goals
        )
        order by display_row
      ) filter (where display_row <= 10),
      '[]'::jsonb
    ) as top_10
  from assist_rows
)
select jsonb_pretty(
  jsonb_build_object(
    'competition_id', (select competition_id from params),
    'season_id', (select season_id from params),
    'totals_rows', (select count(*) from scoped_totals),
    'unique_players_in_totals', (select count(distinct tm_id) from scoped_totals),
    'goals', (select to_jsonb(g) from goal_summary g),
    'assists', (select to_jsonb(a) from assist_summary a),
    'checks', jsonb_build_object(
      'goal_duplicate_player_groups_zero',
        (select duplicate_player_groups = 0 from goal_summary),
      'assist_duplicate_player_groups_zero',
        (select duplicate_player_groups = 0 from assist_summary),
      'same_player_counted_once_in_totals',
        (select count(*) = count(distinct tm_id) from scoped_totals)
    )
  )
) as skorhane_leaderboard_source_truth;

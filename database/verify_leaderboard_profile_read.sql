-- SkorHane: leaderboard + player profile acceptance check.
-- Change the three values in params to the competition, season and player being tested.
-- Worker league codes map tur.1 -> TR1, eng.1 -> GB1, esp.1 -> ES1,
-- ger.1 -> L1, ita.1 -> IT1, fra.1 -> FR1.

with params as (
  select
    'TR1'::text as competition_id,
    '2026'::text as season_id,
    '401923'::text as tm_id
),
competition as (
  select
    p.*,
    coalesce((
      select max(q.competition_name)
      from public.tm_team_season_squads q
      where q.competition_id = p.competition_id
        and public.tm_leader_season_start_year(q.season_id) =
            public.tm_leader_season_start_year(p.season_id)
    ), '') as competition_name
  from params p
),
goal_counts as (
  select
    count(*)::integer as rows,
    count(distinct tm_id)::integer as players,
    (count(*) - count(distinct tm_id))::integer as duplicate_rows,
    coalesce(max(goals), 0)::integer as top_goals
  from public.tm_league_goal_leaders l
  join competition p using (competition_id, season_id)
),
assist_counts as (
  select
    count(*)::integer as rows,
    count(distinct tm_id)::integer as players,
    (count(*) - count(distinct tm_id))::integer as duplicate_rows,
    coalesce(max(assists), 0)::integer as top_assists
  from public.tm_league_assist_leaders l
  join competition p using (competition_id, season_id)
),
profile as (
  select public.tm_player_profile_bundle(p.tm_id) as data
  from params p
)
select jsonb_pretty(jsonb_build_object(
  'scope', jsonb_build_object(
    'competition_id', p.competition_id,
    'competition_name', p.competition_name,
    'season_id', p.season_id,
    'player_tm_id', p.tm_id
  ),
  'roster', jsonb_build_object(
    'players', (
      select count(distinct q.tm_id)::integer
      from public.tm_team_season_squads q
      where q.competition_id = p.competition_id
        and public.tm_leader_season_start_year(q.season_id) =
            public.tm_leader_season_start_year(p.season_id)
    ),
    'players_with_nonzero_stats', (
      select count(distinct s.tm_id)::integer
      from public.tm_team_season_player_stats s
      where s.competition_id = p.competition_id
        and public.tm_leader_season_start_year(s.season_id) =
            public.tm_leader_season_start_year(p.season_id)
        and (
          coalesce(s.appearances,0) > 0 or coalesce(s.goals,0) > 0
          or coalesce(s.assists,0) > 0 or coalesce(s.minutes,0) > 0
        )
    ),
    'raw_stat_rows_with_competition_id', (
      select count(*)::integer
      from public.tm_player_season_stats s
      where s.competition_id = p.competition_id
        and public.tm_leader_season_start_year(s.season_id) =
            public.tm_leader_season_start_year(p.season_id)
    ),
    'joined_player_rows', (
      select count(distinct s.tm_id)::integer
      from public.tm_team_season_player_stats s
      where s.competition_id = p.competition_id
        and public.tm_leader_season_start_year(s.season_id) =
            public.tm_leader_season_start_year(p.season_id)
        and (
          coalesce(s.appearances,0) > 0 or coalesce(s.goals,0) > 0
          or coalesce(s.assists,0) > 0 or coalesce(s.minutes,0) > 0
        )
    )
  ),
  'goal_leaders', jsonb_build_object(
    'rows', (select rows from goal_counts),
    'distinct_players', (select players from goal_counts),
    'duplicate_rows', (select duplicate_rows from goal_counts),
    'top_goals', (select top_goals from goal_counts),
    'top_15', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.leader_rank), '[]'::jsonb)
      from (
        select leader_rank, tm_id, player_name, club_name, goals, assists, appearances
        from public.tm_league_goal_leaders l
        where l.competition_id = p.competition_id and l.season_id = p.season_id
        order by leader_rank, player_name
        limit 15
      ) x
    )
  ),
  'assist_leaders', jsonb_build_object(
    'rows', (select rows from assist_counts),
    'distinct_players', (select players from assist_counts),
    'duplicate_rows', (select duplicate_rows from assist_counts),
    'top_assists', (select top_assists from assist_counts),
    'top_15', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.leader_rank), '[]'::jsonb)
      from (
        select leader_rank, tm_id, player_name, club_name, goals, assists, appearances
        from public.tm_league_assist_leaders l
        where l.competition_id = p.competition_id and l.season_id = p.season_id
        order by leader_rank, player_name
        limit 15
      ) x
    )
  ),
  'target_player_profile', (
    select jsonb_build_object(
      'resolved_tm_id', b.data#>>'{player,tm_id}',
      'name', b.data#>>'{player,name}',
      'appearance_rows', jsonb_array_length(coalesce(b.data->'appearances','[]'::jsonb)),
      'career_rows', jsonb_array_length(coalesce(b.data->'season_stats','[]'::jsonb)),
      'transfer_rows', jsonb_array_length(coalesce(b.data->'transfers','[]'::jsonb)),
      'market_value_rows', jsonb_array_length(coalesce(b.data->'market_values','[]'::jsonb)),
      'injury_rows', jsonb_array_length(coalesce(b.data->'injuries','[]'::jsonb)),
      'absence_rows', jsonb_array_length(coalesce(b.data->'absences','[]'::jsonb))
    )
    from profile b
  )
)) as verification;

-- Diagnose the incomplete TR1 2026/27 leaderboard.
-- Checks raw normalized records, the rebuilt totals view, and the exact cache
-- read by Cloudflare Worker. Includes two known 9-goal players missing from
-- the current SQL top 10 so the result identifies which layer drops them.

with target_players as materialized (
  select p.tm_id, p.name
  from public.tm_players p
  where p.name ilike '%benedyczak%'
     or p.name ilike '%shomurodov%'
),
raw_stats as materialized (
  select
    p.tm_id,
    p.name,
    s.id as stat_row_id,
    s.season_id,
    public.tm_leader_season_start_year(s.season_id) as start_year,
    s.competition_id,
    s.competition_name,
    s.club_id,
    s.club_name,
    s.appearances,
    s.goals,
    s.assists,
    s.minutes,
    s.updated_at
  from target_players p
  left join public.tm_player_season_stats s
    on s.tm_id = p.tm_id
   and public.tm_leader_season_start_year(s.season_id) = 2026
),
view_rows as materialized (
  select
    v.tm_id, v.player_name, v.competition_id, v.season_id,
    v.club_name, v.goals, v.assists, v.appearances, v.minutes
  from public.tm_league_player_season_totals v
  where v.competition_id = 'TR1'
    and v.season_id = '2026'
),
cache_rows as materialized (
  select
    c.tm_id, c.player_name, c.competition_id, c.season_id,
    c.club_name, c.goals, c.assists, c.appearances, c.minutes
  from public.tm_league_player_season_totals_cache c
  where c.competition_id = 'TR1'
    and c.season_id = '2026'
),
scope_counts as (
  select jsonb_build_object(
    'view_rows', (select count(*) from view_rows),
    'view_unique_players', (select count(distinct tm_id) from view_rows),
    'view_goal_scorers', (select count(distinct tm_id) from view_rows where goals > 0),
    'view_assist_providers', (select count(distinct tm_id) from view_rows where assists > 0),
    'cache_rows', (select count(*) from cache_rows),
    'cache_unique_players', (select count(distinct tm_id) from cache_rows),
    'cache_goal_scorers', (select count(distinct tm_id) from cache_rows where goals > 0),
    'cache_assist_providers', (select count(distinct tm_id) from cache_rows where assists > 0),
    'view_players_missing_from_cache', (
      select count(*)
      from view_rows v
      where not exists (select 1 from cache_rows c where c.tm_id = v.tm_id)
    ),
    'cache_players_missing_from_view', (
      select count(*)
      from cache_rows c
      where not exists (select 1 from view_rows v where v.tm_id = c.tm_id)
    )
  ) as counts
),
player_diagnosis as (
  select
    p.tm_id,
    p.name,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'stat_row_id', r.stat_row_id,
        'season_id', r.season_id,
        'competition_id', r.competition_id,
        'competition_name', r.competition_name,
        'club_id', r.club_id,
        'club_name', r.club_name,
        'appearances', r.appearances,
        'goals', r.goals,
        'assists', r.assists,
        'minutes', r.minutes,
        'updated_at', r.updated_at
      ) order by r.updated_at desc nulls last)
      from raw_stats r
      where r.tm_id = p.tm_id and r.stat_row_id is not null
    ), '[]'::jsonb) as normalized_source_rows,
    coalesce((
      select jsonb_agg(to_jsonb(v) order by v.goals desc)
      from view_rows v where v.tm_id = p.tm_id
    ), '[]'::jsonb) as totals_view_rows,
    coalesce((
      select jsonb_agg(to_jsonb(c) order by c.goals desc)
      from cache_rows c where c.tm_id = p.tm_id
    ), '[]'::jsonb) as worker_cache_rows
  from target_players p
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', 'TR1',
  'season_id', '2026',
  'scope_counts', (select counts from scope_counts),
  'players', coalesce((
    select jsonb_agg(to_jsonb(d) order by d.name)
    from player_diagnosis d
  ), '[]'::jsonb)
)) as tr1_2026_leaderboard_gap_diagnosis;

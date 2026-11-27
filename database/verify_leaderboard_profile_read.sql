-- SkorHane v3 verification. Edit these three values for another league/season/player.
with params as (
  select
    'TR1'::text as competition_id,
    'TR1'::text as competition_code,
    '2026'::text as season_id,
    '401923'::text as tm_id
),
roster as (
  select distinct q.tm_id
  from public.tm_team_season_squads q
  cross join params p
  where q.competition_id = p.competition_id
    and public.tm_leader_season_start_year(q.season_id) =
        public.tm_leader_season_start_year(p.season_id)
),
completed_checkpoints as (
  select distinct r.external_id as tm_id
  from public.tm_source_records r
  cross join params p
  where r.source = 'felipeall'
    and r.record_type = 'league_stats_player_checkpoint'
    and r.payload @> jsonb_build_object(
      'coverage_version', 2,
      'status', 'completed',
      'completed_scope_keys', jsonb_build_array(p.competition_code || ':' || p.season_id)
    )
),
coverage as (
  select
    (select count(*) from roster) as roster_players,
    (select count(*) from roster x join completed_checkpoints c using (tm_id)) as completed_players,
    (select count(*) from roster x left join completed_checkpoints c using (tm_id) where c.tm_id is null) as missing_players
),
duplicate_goals as (
  select count(*) as duplicate_player_groups
  from (
    select tm_id
    from public.tm_league_goal_leaders l
    cross join params p
    where l.competition_id = p.competition_id and l.season_id = p.season_id
    group by tm_id
    having count(*) > 1
  ) d
),
duplicate_assists as (
  select count(*) as duplicate_player_groups
  from (
    select tm_id
    from public.tm_league_assist_leaders l
    cross join params p
    where l.competition_id = p.competition_id and l.season_id = p.season_id
    group by tm_id
    having count(*) > 1
  ) d
),
id_conflicts as (
  select count(*) as name_match_but_id_conflict_rows
  from public.tm_player_season_stats s
  join public.tm_team_season_squads q
    on q.tm_id = s.tm_id
   and public.tm_leader_season_start_year(q.season_id) =
       public.tm_leader_season_start_year(s.season_id)
   and public.tm_leader_normalize_name(q.competition_name) =
       public.tm_leader_normalize_name(s.competition_name)
   and public.tm_leader_normalize_name(q.club_name) =
       public.tm_leader_normalize_name(s.club_name)
  cross join params p
  where q.competition_id = p.competition_id
    and public.tm_leader_season_start_year(q.season_id) =
        public.tm_leader_season_start_year(p.season_id)
    and (
      (
        nullif(s.competition_id, '') is not null
        and nullif(q.competition_id, '') is not null
        and s.competition_id <> q.competition_id
        and (
          (s.competition_id ~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
 and q.competition_id ~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
)
          or (
            s.competition_id !~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
 and q.competition_id !~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;

            and (s.competition_id ~* '^[A-Z]{2,4}[0-9]+[A-Z]?
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;

                 or q.competition_id ~* '^[A-Z]{2,4}[0-9]+[A-Z]?
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
)
          )
        )
      )
      or (
        nullif(s.club_id, '') is not null
        and nullif(q.club_id, '') is not null
        and s.club_id <> q.club_id
        and (
          (s.club_id ~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
 and q.club_id ~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
)
          or (s.club_id !~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
 and q.club_id !~ '^[0-9]+
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;
)
        )
      )
    )
),
target_profile as (
  select public.tm_player_profile_bundle(p.tm_id) as bundle
  from params p
),
leaders as (
  select
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.goals desc, x.player_name)
     from (
       select l.* from public.tm_league_goal_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.goals desc, l.assists desc, l.player_name
       limit 20
     ) x) as goal_leaders,
    (select jsonb_agg(jsonb_build_object(
      'rank', x.leader_rank, 'tm_id', x.tm_id, 'player', x.player_name,
      'team', x.club_name, 'goals', x.goals, 'assists', x.assists
    ) order by x.leader_rank, x.assists desc, x.player_name)
     from (
       select l.* from public.tm_league_assist_leaders l cross join params p
       where l.competition_id = p.competition_id and l.season_id = p.season_id
       order by l.leader_rank, l.assists desc, l.goals desc, l.player_name
       limit 20
     ) x) as assist_leaders
)
select jsonb_pretty(jsonb_build_object(
  'competition_id', (select competition_id from params),
  'season_id', (select season_id from params),
  'coverage_v2', (select to_jsonb(c) from coverage c),
  'leaderboard_duplicate_player_groups', jsonb_build_object(
    'goals', (select duplicate_player_groups from duplicate_goals),
    'assists', (select duplicate_player_groups from duplicate_assists)
  ),
  'same_name_different_id_candidates', (select name_match_but_id_conflict_rows from id_conflicts),
  'target_player_rows', jsonb_build_object(
    'player_profile', (select bundle->'player' is not null from target_profile),
    'season_stats', (select jsonb_array_length(coalesce(bundle->'season_stats','[]'::jsonb)) from target_profile),
    'appearances', (select jsonb_array_length(coalesce(bundle->'appearances','[]'::jsonb)) from target_profile),
    'transfers', (select jsonb_array_length(coalesce(bundle->'transfers','[]'::jsonb)) from target_profile),
    'market_values', (select jsonb_array_length(coalesce(bundle->'market_values','[]'::jsonb)) from target_profile),
    'injuries', (select jsonb_array_length(coalesce(bundle->'injuries','[]'::jsonb)) from target_profile),
    'absences', (select jsonb_array_length(coalesce(bundle->'absences','[]'::jsonb)) from target_profile)
  ),
  'leaders_top_20', (select to_jsonb(l) from leaders l)
)) as skorhane_v3_verification;

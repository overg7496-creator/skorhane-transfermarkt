-- SkorHane: expression indexes for fast league-season and player-stint lookups.
-- Apply after migrations 007-011. Safe to re-run.
-- These indexes make tm_leader_season_start_year(season_id) searchable instead
-- of evaluating it against every squad row during leaderboard verification.

begin;

create index if not exists tm_squads_competition_start_year_fast_idx
  on public.tm_team_season_squads (
    competition_id,
    (public.tm_leader_season_start_year(season_id)),
    tm_id
  );

create index if not exists tm_squads_player_competition_start_year_fast_idx
  on public.tm_team_season_squads (
    tm_id,
    competition_id,
    (public.tm_leader_season_start_year(season_id)),
    club_id
  );

create index if not exists tm_squads_start_year_competition_name_fast_idx
  on public.tm_team_season_squads (
    (public.tm_leader_season_start_year(season_id)),
    (public.tm_leader_normalize_name(competition_name)),
    competition_id
  );

analyze public.tm_team_season_squads;

commit;

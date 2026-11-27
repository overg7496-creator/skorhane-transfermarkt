-- Per-league completion status for player profile detail endpoints.
-- Apply 013_player_detail_completion_dashboard.sql first.
select
  competition_id,
  competition_name,
  player_count,
  players_with_full_detail_sync_completed,
  players_remaining_full_detail_sync,
  players_with_market_value_completed,
  players_remaining_market_value,
  players_with_market_value_data,
  players_with_career_stats_completed,
  players_remaining_career_stats,
  players_with_career_stats_data,
  players_with_transfers_completed,
  players_remaining_transfers,
  players_with_transfer_history_data,
  players_with_injuries_completed,
  players_remaining_injuries,
  players_with_injury_records,
  players_with_absences_completed,
  players_remaining_absences,
  players_with_absence_records,
  players_with_all_four_core_sections_completed,
  players_missing_at_least_one_core_section,
  market_value_completion_pct,
  career_stats_completion_pct,
  transfers_completion_pct,
  injuries_completion_pct,
  all_four_core_sections_completion_pct,
  refresh_cutoff
from public.tm_league_player_detail_sync_dashboard
order by competition_id;

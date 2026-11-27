import unittest
from pathlib import Path


SQL_PATH = Path(__file__).resolve().parents[1] / "database" / "004_league_sync_dashboard_detail.sql"


class LeagueSyncDashboardSqlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = SQL_PATH.read_text(encoding="utf-8").lower()

    def test_creates_both_league_and_season_views(self):
        self.assertIn("create view public.tm_league_sync_dashboard\n", self.sql)
        self.assertIn("create view public.tm_league_sync_dashboard_seasons\n", self.sql)

    def test_covers_player_value_injury_transfer_and_fee_data(self):
        for column in (
            "players_with_current_market_value",
            "players_with_market_value_history",
            "market_value_history_record_count",
            "players_with_injury_records",
            "injury_record_count",
            "players_with_transfer_history",
            "transfer_history_record_count",
            "players_with_transfer_fee",
            "transfer_fee_record_count",
            "players_with_numeric_transfer_fee",
        ):
            with self.subTest(column=column):
                self.assertIn("as " + column, self.sql)

    def test_covers_league_leaderboards_and_other_season_metrics(self):
        for column in (
            "players_with_goal_leader_entries",
            "seasons_with_goal_leaders",
            "players_with_assist_leader_entries",
            "seasons_with_assist_leaders",
            "players_with_appearances_stats",
            "players_with_starts_stats",
            "players_with_goal_stats",
            "players_with_assist_stats",
            "players_with_minutes_stats",
            "players_with_yellow_card_stats",
            "players_with_second_yellow_card_stats",
            "players_with_red_card_stats",
            "players_with_clean_sheet_stats",
        ):
            with self.subTest(column=column):
                self.assertIn("as " + column, self.sql)

    def test_reports_all_raw_numeric_stat_metrics(self):
        self.assertIn("tm_dashboard_flatten_stat_metrics", self.sql)
        self.assertIn("raw_stat_metric_coverage", self.sql)
        self.assertIn("jsonb_object_agg(metric_key", self.sql)
        self.assertIn("numeric_total", self.sql)
        self.assertIn("league_raw_metric_summary", self.sql)

    def test_statistics_are_matched_to_exact_league_season_and_club(self):
        self.assertIn("lower(trim(coalesce(s.competition_name, ''))) = lower(trim(q.competition_name))", self.sql)
        self.assertIn("lower(trim(coalesce(s.club_name, ''))) = lower(trim(q.club_name))", self.sql)
        self.assertIn("s.season_id = q.season_id", self.sql)

    def test_does_not_drop_dependent_views_with_cascade(self):
        self.assertIn("drop view if exists public.tm_league_sync_dashboard;", self.sql)
        self.assertNotIn("drop view if exists public.tm_league_sync_dashboard cascade", self.sql)


if __name__ == "__main__":
    unittest.main()

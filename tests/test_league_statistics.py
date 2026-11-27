import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sync"))
import sync_league_statistics as league_stats  # noqa: E402


class LeagueStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.target = {
            "competition_id": "TR1",
            "competition_name": "Süper Lig",
            "season_id": "2025",
            "season_start": 2025,
            "club_id": "100",
            "club_name": "Galatasaray",
        }

    def test_season_start_year_supports_full_and_short_seasons(self):
        self.assertEqual(league_stats.season_start_year("2025/26"), 2025)
        self.assertEqual(league_stats.season_start_year("2024-2025"), 2024)
        self.assertEqual(league_stats.season_start_year("23/24"), 2023)
        self.assertIsNone(league_stats.season_start_year("unknown"))

    def test_normalization_ignores_turkish_accents_and_punctuation(self):
        self.assertEqual(league_stats.norm("Süper Lig"), "super lig")
        self.assertEqual(league_stats.norm("  2. Bundesliga "), "2 bundesliga")

    def test_matches_only_same_league_season_and_club(self):
        stat = {
            "seasonID": "2025/26",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
            "goals": 12,
        }
        self.assertEqual(
            league_stats.matching_targets(stat, [self.target]),
            [self.target],
        )

    def test_does_not_mix_cup_stats_into_league_totals(self):
        stat = {
            "seasonID": "2025/26",
            "competitionName": "Türkiye Kupası",
            "club": {"id": "100", "name": "Galatasaray"},
            "goals": 4,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [])
        self.assertEqual(league_stats.map_stat_payloads("123", stat, [self.target]), [])

    def test_does_not_assign_stats_to_a_different_club(self):
        stat = {
            "seasonID": "2025/26",
            "competitionName": "Süper Lig",
            "club": {"id": "200", "name": "Fenerbahçe"},
            "goals": 9,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [])

    def test_explicit_competition_id_mismatch_never_falls_back_to_same_name(self):
        stat = {
            "seasonID": "2025/26",
            "competitionId": "TR2",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
            "goals": 8,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [])

    def test_numeric_provider_competition_id_matches_canonical_code_by_exact_name(self):
        stat = {
            "seasonID": "2025/26",
            "competitionId": "26",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
            "goals": 8,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [self.target])
        row = league_stats.map_stat_payloads("123", stat, [self.target])[0]
        self.assertEqual(row["competition_id"], "TR1")

    def test_alphanumeric_competition_id_mismatch_remains_strict(self):
        stat = {
            "seasonID": "2025/26",
            "competitionId": "TR2",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [])

    def test_explicit_club_id_mismatch_never_falls_back_to_same_name(self):
        stat = {
            "seasonID": "2025/26",
            "competitionId": "TR1",
            "competitionName": "Süper Lig",
            "club": {"id": "200", "name": "Galatasaray"},
            "goals": 8,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [])

    def test_missing_ids_use_exact_normalized_name_fallback(self):
        stat = {
            "seasonID": "2025/26",
            "competitionName": "SUPER LIG",
            "club": "Galatasaray",
            "goals": 8,
        }
        self.assertEqual(league_stats.matching_targets(stat, [self.target]), [self.target])

    def test_maps_supported_player_and_goalkeeper_metrics(self):
        stat = {
            "seasonID": "2025/26",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
            "appearances": 28,
            "starts": 24,
            "goals": 12,
            "assists": 7,
            "minutesPlayed": 2110,
            "yellowCards": 4,
            "secondYellowCards": 1,
            "redCards": 1,
            "goalsConceded": 20,
            "cleanSheets": 11,
            "totalPasses": 1100,
        }
        rows = league_stats.map_stat_payloads("123", stat, [self.target])
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["tm_id"], "123")
        self.assertEqual(row["season_id"], "2025/26")
        self.assertEqual(row["competition_id"], "TR1")
        self.assertEqual(row["club_id"], "100")
        self.assertEqual(row["competition_name"], "Süper Lig")
        self.assertEqual(row["club_name"], "Galatasaray")
        self.assertEqual(row["goals"], 12)
        self.assertEqual(row["assists"], 7)
        self.assertEqual(row["second_yellow_cards"], 1)
        self.assertEqual(row["clean_sheets"], 11)
        self.assertEqual(row["payload"]["totalPasses"], 1100)
        self.assertEqual(row["source"], "felipeall")

    def test_identity_conflicts_leave_only_that_league_season_uncovered(self):
        wrong_competition = {
            "seasonID": "2025/26",
            "competitionId": "TR2",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
        }
        self.assertEqual(
            league_stats.identity_conflict_scope_keys(wrong_competition, [self.target]),
            {"TR1:2025"},
        )
        provider_id_namespace = {
            "seasonID": "2025/26",
            "competitionId": "26",
            "competitionName": "Süper Lig",
            "club": {"id": "100", "name": "Galatasaray"},
        }
        self.assertEqual(
            league_stats.identity_conflict_scope_keys(provider_id_namespace, [self.target]),
            set(),
        )

    def test_league_stats_checkpoint_scope_is_versioned_for_id_refetch(self):
        self.assertTrue(league_stats.checkpoint_scope().startswith("v2_"))

    def test_leaderboard_views_and_team_summary_are_already_in_migration(self):
        migration = (ROOT / "database" / "002_team_seasons_and_leaderboards.sql").read_text(encoding="utf-8")
        self.assertIn("public.tm_league_goal_leaders", migration)
        self.assertIn("public.tm_league_assist_leaders", migration)
        self.assertIn("public.tm_league_player_season_totals", migration)
        self.assertIn("public.tm_team_season_summary", migration)


if __name__ == "__main__":
    unittest.main()

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PlayerProfileFinalHardeningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.squads = (ROOT / "sync" / "sync_squads_and_clubs.py").read_text(encoding="utf-8")
        cls.stats = (ROOT / "sync" / "sync_league_statistics.py").read_text(encoding="utf-8")
        cls.sql = (ROOT / "database" / "014_player_profile_clubs_and_live_appearance_rollup.sql").read_text(encoding="utf-8")
        cls.dashboard = (ROOT / "database" / "013_player_detail_completion_dashboard.sql").read_text(encoding="utf-8")
        cls.squad_workflow = (ROOT / ".github" / "workflows" / "import-missing-leagues.yml").read_text(encoding="utf-8")
        cls.stats_workflow = (ROOT / ".github" / "workflows" / "seed-league-statistics.yml").read_text(encoding="utf-8")

    def test_tff_third_tier_groups_are_in_squad_and_stats_preseed(self):
        for code in ("TR4A", "TR4B", "TR4C"):
            with self.subTest(code=code):
                self.assertIn(code, self.squads)
                self.assertIn(code, self.stats)
                self.assertIn(code, self.squad_workflow)
                self.assertIn(code, self.stats_workflow)
                self.assertIn(code, self.dashboard)

    def test_tff_second_and_third_tier_group_aliases(self):
        self.assertIn('"af-318", "tur.3", "tff2"', self.worker)
        self.assertIn('"af-321", "tur.4", "tff3"', self.worker)
        self.assertIn('return ["TR3A", "TR3B"]', self.worker)
        self.assertIn('return ["TR4A", "TR4B", "TR4C"]', self.worker)
        self.assertIn("apiFootballTurkeyLowerDivisionFixturesForDay", self.worker)

    def test_stored_standings_are_normalized_and_kept_by_ui(self):
        self.assertIn("function tmExtractTableRows(payload)", self.worker)
        self.assertIn("clubDirectoryById", self.worker)
        self.assertIn("if(Array.isArray(db.standings)&&db.standings.length)my.data.tables=db.standings;", self.html)
        self.assertIn("db&&Array.isArray(db.standings)&&db.standings.length?db.standings", self.html)

    def test_profile_bundle_includes_club_directory_and_live_stats_rollup(self):
        for token in (
            "tm_club_directory",
            "club_directory",
            "tm_live_appearance_contributions",
            "tm_rollup_live_appearance_to_player_season",
            "tm_appearances_live_season_rollup",
            "history_source",
            "tm_refresh_player_league_season_totals_cache",
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.sql)

    def test_worker_resolves_club_logos_and_keeps_match_fields(self):
        for token in (
            "resolvePlayerClub",
            "fromLogo",
            "toLogo",
            "scoreHome",
            "scoreAway",
            "tm-player-profile-bundle:v4:",
            "pf50:",
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.worker)

    def test_player_history_ui_has_seasons_badges_trend_icons_and_match_columns(self):
        for token in (
            "data-injury-season",
            "player-injury-total",
            "injury-pill",
            "player-transfer-fee",
            "playerMarketTrendIcon",
            ".market-trend-icon.down",
            "player-form-table",
            "Puan</th><th>Gol</th><th>Asist</th><th>Dakika",
            "playerRecentMatchCard",
            "TFF 1. Lig",
            "TFF 2. Lig",
            "TFF 3. Lig",
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.html)

    def test_browser_cache_migrates_without_dropping_old_instant_data(self):
        self.assertIn("skorhane.playerinfo.tm.v8.", self.html)
        self.assertIn("skorhane.playerinfo.tm.v7.", self.html)
        self.assertIn("skorhane.playerstats.tm.v15.", self.html)
        self.assertIn("skorhane.playerstats.tm.v14.", self.html)


if __name__ == "__main__":
    unittest.main()

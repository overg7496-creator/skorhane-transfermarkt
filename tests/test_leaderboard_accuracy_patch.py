import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class LeaderboardAccuracyPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "database" / "007_leaderboard_accuracy_and_profile_read.sql").read_text(encoding="utf-8").lower()
        cls.worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.sync = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")

    def test_migration_persists_provider_competition_and_club_ids(self):
        self.assertIn("add column if not exists competition_id text", self.sql)
        self.assertIn("add column if not exists club_id text", self.sql)
        self.assertIn("'competitionid'", self.sql)
        self.assertIn("'clubid'", self.sql)
        self.assertIn("p_row->>'competition_id'", self.sql)

    def test_leaderboard_join_normalizes_season_and_prefers_ids(self):
        self.assertIn("tm_leader_season_start_year(s.season_id)", self.sql)
        self.assertIn("([0-9]{2})[[:space:]]*[/.-]", self.sql)
        self.assertIn("s.competition_id = q.competition_id", self.sql)
        self.assertIn("s.club_id = q.club_id", self.sql)
        self.assertIn("left join lateral", self.sql)
        self.assertIn("max(s.goals)", self.sql)
        self.assertNotIn("sum(s.goals)", self.sql)

    def test_leaderboards_rank_ties_and_group_once_per_player(self):
        self.assertIn("group by competition_id, season_id, tm_id", self.sql)
        self.assertIn("row_number() over", self.sql)
        self.assertIn("where goals > 0", self.sql)
        self.assertIn("where assists > 0", self.sql)

    def test_profile_bundle_returns_full_archive_and_deduplicates_matches(self):
        self.assertIn("create or replace function public.tm_player_profile_bundle", self.sql)
        self.assertIn("'appearances', coalesce((", self.sql)
        self.assertIn("'recent_appearances', coalesce((", self.sql)
        self.assertIn("distinct on (", self.sql)
        self.assertIn("match_id", self.sql)
        self.assertIn("'transfers'", self.sql)
        self.assertIn("'market_values'", self.sql)
        self.assertIn("'injuries'", self.sql)
        self.assertIn("'absences'", self.sql)

    def test_worker_reads_all_pages_and_deduplicates_leader_rows(self):
        self.assertIn("async function tmDbRowsPaged", self.worker)
        self.assertIn("goalLeadersAvailable", self.worker)
        self.assertIn("assistLeadersAvailable", self.worker)
        self.assertIn("const old = unique.get(playerId)", self.worker)
        self.assertIn('"pf48:"', self.worker)
        self.assertIn('tm-league-data:v2:', self.worker)

    def test_worker_profile_refresh_warning_respects_normalized_rows(self):
        self.assertIn("normalizedCoverage && normalizedCoverage[recordType]", self.worker)
        self.assertIn("player_market_values: bundleMarketValues.length > 0", self.worker)
        self.assertIn("return { required: missing && !hasNormalizedData, stale, missing }", self.worker)

    def test_html_uses_metric_specific_db_availability_before_fallback(self):
        self.assertIn("function tmLeagueMetricRows(my,metric)", self.html)
        self.assertIn("db.goalLeadersAvailable", self.html)
        self.assertIn("db.assistLeadersAvailable", self.html)
        self.assertNotIn("if(my.tmLeagueData&&my.tmLeagueData.found)", self.html)
        self.assertIn("skorhane.playerstats.legacy.v13.", self.html)

    def test_html_fallback_merges_player_ids_by_name_and_has_no_50_row_cap(self):
        self.assertIn("pitchClientTeamKey(player)||providerId", self.html)
        self.assertNotIn(".slice(0,50).map((r,i)=>({...r,rank:i+1}))", self.html)
        self.assertIn("rows=expanded?all:all.slice(0,3)", self.html)
        self.assertIn("leaderList(goals,'goals'", self.html)
        self.assertIn("leaderList(assists,'assists'", self.html)
        self.assertNotIn(".slice(0, 50).map((row, index)", self.worker)

    def test_ingestion_persists_competition_and_club_ids_for_both_stat_feeds(self):
        self.assertIn('"competition_id": competition_id_for_stat', self.sync)
        self.assertIn('"club_id": club_id_for_stat', self.sync)
        self.assertIn('"competition_id": competition_id,', self.sync)
        self.assertIn('"competition_name": competition,', self.sync)
        self.assertIn('"club_id": club_id,', self.sync)
        self.assertIn('"club_name": club,', self.sync)


if __name__ == "__main__":
    unittest.main()

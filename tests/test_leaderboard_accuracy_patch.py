import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class LeaderboardAccuracyPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "database" / "008_profile_leaderboard_accuracy_v3.sql").read_text(encoding="utf-8").lower()
        cls.worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        cls.worker_copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.requested_worker_copy = (ROOT / "SkorHane-Worker-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.html_copy = (ROOT / "SkorHane-HTML-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.sync = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        cls.league_sync = (ROOT / "sync" / "sync_league_statistics.py").read_text(encoding="utf-8")
        cls.verify_sql = (ROOT / "database" / "verify_leaderboard_profile_read.sql").read_text(encoding="utf-8")

    def test_migration_promotes_provider_ids_and_nested_sync_ids(self):
        self.assertIn("add column if not exists competition_id text", self.sql)
        self.assertIn("add column if not exists club_id text", self.sql)
        self.assertIn("payload#>>'{league_stats_sync,competition_id}'", self.sql)
        self.assertIn("payload#>>'{league_stats_sync,club_id}'", self.sql)

    def test_leaderboard_join_is_season_and_identity_aware(self):
        self.assertIn("tm_leader_season_start_year(s.season_id)", self.sql)
        self.assertIn("then s.competition_id = q.competition_id", self.sql)
        self.assertIn("then s.club_id = q.club_id", self.sql)
        self.assertIn("s.competition_id ~ '^[0-9]+$'", self.sql)
        self.assertIn("s.club_id ~ '^[0-9]+$'", self.sql)
        self.assertIn("left join lateral", self.sql)
        self.assertIn("select distinct on (competition_id, season_start_year, club_key, tm_id)", self.sql)
        self.assertIn("max(s.goals)", self.sql)
        self.assertNotIn("sum(s.goals)", self.sql)
        self.assertIn("group by competition_id, season_id, tm_id", self.sql)

    def test_leaderboards_group_players_once_and_preserve_ties(self):
        self.assertIn("dense_rank() over", self.sql)
        self.assertIn("where goals > 0", self.sql)
        self.assertIn("where assists > 0", self.sql)
        self.assertIn("sum(goals)::bigint", self.sql)
        self.assertIn("sum(assists)::bigint", self.sql)

    def test_profile_rpc_returns_full_history_and_typed_season_ids(self):
        self.assertIn("create or replace function public.tm_player_profile_bundle", self.sql)
        self.assertIn("'appearances', coalesce((", self.sql)
        self.assertIn("'recent_appearances', coalesce((", self.sql)
        self.assertIn("distinct on (", self.sql)
        self.assertIn("match_id", self.sql)
        self.assertIn("'transfers'", self.sql)
        self.assertIn("'market_values'", self.sql)
        self.assertIn("'injuries'", self.sql)
        self.assertIn("'absences'", self.sql)
        self.assertIn("max(nullif(s.competition_id, '')) as competition_id", self.sql)
        self.assertIn("max(nullif(s.club_id, '')) as club_id", self.sql)

    def test_worker_requires_complete_roster_and_scope_checkpoints(self):
        self.assertIn("async function tmDbRowsPaged", self.worker)
        self.assertIn("tm_team_season_player_stats?select=tm_id", self.worker)
        self.assertIn("tmDbRowsPaged(env, rosterQuery", self.worker)
        self.assertIn("completed_scope_keys: [scopeKey]", self.worker)
        self.assertIn("no_matching_league_rows !== true", self.worker)
        self.assertIn("coverageComplete", self.worker)
        self.assertIn('goalLeadersAvailable = coverageComplete && goalsR.status === "fulfilled"', self.worker)
        self.assertIn('assistLeadersAvailable = coverageComplete && assistsR.status === "fulfilled"', self.worker)
        self.assertIn('coverageComplete && totalsR.status === "fulfilled"', self.worker)
        self.assertIn("tmDbRowsPaged(env, goalsQuery", self.worker)
        self.assertIn("tmDbRowsPaged(env, assistsQuery", self.worker)

    def test_worker_cache_versions_are_bumped_and_copies_match(self):
        self.assertIn('"pf49:"', self.worker)
        self.assertIn("tm-player-profile-bundle:v3:", self.worker)
        self.assertIn("tm-league-data:v3:", self.worker)
        self.assertEqual(self.worker, self.worker_copy)
        self.assertEqual(self.worker, self.requested_worker_copy)
        self.assertEqual(self.html, self.html_copy)

    def test_html_profile_cache_uses_transfermarkt_id_not_name(self):
        self.assertIn("playerCacheTmId", self.html)
        self.assertIn("skorhane.playerstats.tm.v14.", self.html)
        self.assertIn("skorhane.playerinfo.tm.v7.", self.html)
        self.assertIn("resolvedTmId", self.html)
        self.assertNotIn("playerstats.legacy.v13.", self.html)
        self.assertIn("api('/player?part=all'+qs)", self.html)

    def test_league_sync_writes_canonical_ids_and_versions_checkpoints(self):
        self.assertIn('"competition_id": str(target.get("competition_id") or "")', self.league_sync)
        self.assertIn('"club_id": str(target.get("club_id") or "")', self.league_sync)
        self.assertIn('return "v2_" + "-".join(COMPETITIONS)', self.league_sync)
        self.assertIn('"coverage_version": 2', self.league_sync)
        self.assertIn("completed_scope_keys", self.league_sync)
        self.assertIn("unmatched_scope_keys", self.league_sync)
        self.assertIn("identity_conflict_scope_keys", self.league_sync)
        self.assertIn("competition_ids_share_namespace", self.league_sync)

    def test_profile_and_leaderboard_verification_query_checks_scope_and_duplicates(self):
        self.assertIn("completed_scope_keys", self.verify_sql)
        self.assertIn("duplicate_player_groups", self.verify_sql)
        self.assertIn("same_name_different_id_candidates", self.verify_sql)
        self.assertIn("tm_player_profile_bundle", self.verify_sql)
        self.assertIn("'goals'", self.verify_sql)
        self.assertIn("'assists'", self.verify_sql)


if __name__ == "__main__":
    unittest.main()

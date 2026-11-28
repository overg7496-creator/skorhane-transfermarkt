import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class LeaderboardAccuracyPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "database" / "008_profile_leaderboard_accuracy_v3.sql").read_text(encoding="utf-8").lower()
        cls.sql007 = (ROOT / "database" / "007_leaderboard_accuracy_and_profile_read.sql").read_text(encoding="utf-8").lower()
        cls.worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        cls.worker_copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.requested_worker_copy = (ROOT / "SkorHane-Worker-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.html_copy = (ROOT / "SkorHane-HTML-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.sync = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        cls.league_sync = (ROOT / "sync" / "sync_league_statistics.py").read_text(encoding="utf-8")
        cls.verify_sql = (ROOT / "database" / "verify_leaderboard_profile_read.sql").read_text(encoding="utf-8")
        cls.source_truth_sql = (ROOT / "database" / "verify_leaderboard_source_truth.sql").read_text(encoding="utf-8")
        cls.leaderboard_sql = (ROOT / "database" / "009_leaderboard_from_player_season_stats.sql").read_text(encoding="utf-8").lower()
        cls.cache_sql = (ROOT / "database" / "010_indexed_league_season_cache.sql").read_text(encoding="utf-8").lower()
        cls.detail_dashboard_sql = (ROOT / "database" / "013_player_detail_completion_dashboard.sql").read_text(encoding="utf-8").lower()
        cls.detail_dashboard_verify_sql = (ROOT / "database" / "verify_player_detail_completion_dashboard.sql").read_text(encoding="utf-8").lower()

    def test_migration_007_has_valid_season_function_dollar_quotes(self):
        self.assertIn("as $$\n  select case", self.sql007)
        self.assertIn("\n$$;", self.sql007)
        self.assertNotIn("\nas $\n", self.sql007)
        self.assertNotIn("\n$;\n", self.sql007)

    def test_migration_008_is_self_contained_for_007_helpers(self):
        self.assertIn("create or replace function public.tm_leader_season_start_year", self.sql)
        self.assertIn("create or replace function public.tm_leader_normalize_name", self.sql)
        self.assertIn("create or replace function public.tm_upsert_season_stat", self.sql)
        self.assertIn("revoke all on function public.tm_upsert_season_stat(jsonb)", self.sql)
        self.assertIn("grant execute on function public.tm_upsert_season_stat(jsonb) to service_role", self.sql)

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
        self.assertIn("Number(row.payload.coverage_version) === 3", self.worker)
        self.assertIn("completed_scope_keys: [scopeKey]", self.worker)
        self.assertIn("coverageComplete", self.worker)
        self.assertIn("hasSupabaseLeaderboardData", self.worker)
        self.assertIn('goalLeadersAvailable = totalsR.status === "fulfilled" && goals.length > 0', self.worker)
        self.assertIn('assistLeadersAvailable = totalsR.status === "fulfilled" && assists.length > 0', self.worker)
        self.assertIn('totalsR.status === "fulfilled" && totals.length > 0', self.worker)
        self.assertIn("tmDbRowsPaged(env, totalsQuery", self.worker)
        self.assertNotIn("tm_league_goal_leaders?select=", self.worker)
        self.assertNotIn("tm_league_assist_leaders?select=", self.worker)

    def test_leaderboards_include_stats_without_requiring_a_player_squad_row(self):
        self.assertIn("from public.tm_player_season_stats s", self.leaderboard_sql)
        self.assertIn("left join lateral", self.leaderboard_sql)
        self.assertIn("tm_team_season_squads q", self.leaderboard_sql)
        self.assertIn("having count(distinct q.competition_id) = 1", self.leaderboard_sql)
        self.assertIn("select distinct on (", self.leaderboard_sql)
        self.assertIn("dense_rank() over", self.leaderboard_sql)
        self.assertNotIn("from public.tm_team_season_player_stats", self.leaderboard_sql)
        self.assertIn("hasSupabaseLeaderboardData", self.worker)
        self.assertIn("if(my.tmLeagueDataLoaded!==true)return;", self.html)
        self.assertIn("my.tmLeagueData.hasSupabaseLeaderboardData===true", self.html)

    def test_worker_cache_versions_are_bumped_and_copies_match(self):
        self.assertIn('"pf50:"', self.worker)
        self.assertIn("tm-player-profile-bundle:v4:", self.worker)
        self.assertIn("tm-league-data:v5:", self.worker)
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
        self.assertIn('return "v3_" + "-".join(COMPETITIONS)', self.league_sync)
        self.assertIn('"coverage_version": 3', self.league_sync)
        self.assertIn("completed_scope_keys", self.league_sync)
        self.assertIn("zero_stat_payload", self.league_sync)
        self.assertIn("tm_upsert_season_stats_batch", self.league_sync)
        self.assertIn("tm_refresh_player_league_season_totals_cache", self.league_sync)
        self.assertIn("unmatched_scope_keys", self.league_sync)
        self.assertIn("identity_conflict_scope_keys", self.league_sync)
        self.assertIn("competition_ids_share_namespace", self.league_sync)
        self.assertIn("def require_cache_schema_ready", self.league_sync)
        self.assertIn("tm_upsert_season_stats_batch", self.league_sync)
        self.assertIn("database/010_indexed_league_season_cache.sql", self.league_sync)


    def test_indexed_cache_migration_adds_bulk_upsert_and_player_refresh(self):
        self.assertIn("create table if not exists public.tm_league_player_season_totals_cache", self.cache_sql)
        self.assertIn("primary key (competition_id, season_id, tm_id)", self.cache_sql)
        self.assertIn("create or replace function public.tm_upsert_season_stats_batch", self.cache_sql)
        self.assertIn("create or replace function public.tm_refresh_player_league_season_totals_cache", self.cache_sql)
        self.assertIn("excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'", self.cache_sql)
        self.assertIn("grant select on public.tm_league_player_season_totals_cache to service_role", self.cache_sql)
        self.assertIn("grant execute on function public.tm_refresh_player_league_season_totals_cache(text) to service_role", self.cache_sql)

    def test_worker_reads_only_the_indexed_season_cache(self):
        self.assertIn("tm_league_player_season_totals_cache?select=", self.worker)
        self.assertNotIn("tm_league_player_season_totals?select=", self.worker)
        self.assertIn('const goals = tmLeaderRows(totals, "goals")', self.worker)
        self.assertIn('const assists = tmLeaderRows(totals, "assists")', self.worker)

    def test_profile_verification_is_compact_and_calls_profile_bundle_once(self):
        self.assertIn("completed_scope_keys", self.verify_sql)
        self.assertIn("tm_player_profile_bundle", self.verify_sql)
        self.assertEqual(self.verify_sql.count("tm_player_profile_bundle("), 1)
        self.assertLess(len(self.verify_sql.splitlines()), 100)
        self.assertNotIn("same_name_different_id_candidates", self.verify_sql)

    def test_source_truth_verification_scans_league_totals_once(self):
        self.assertIn("scoped_totals as materialized", self.source_truth_sql.lower())
        self.assertIn("from public.tm_league_player_season_totals", self.source_truth_sql.lower())
        self.assertEqual(self.source_truth_sql.lower().count("from public.tm_league_player_season_totals"), 1)
        self.assertIn("duplicate_player_groups", self.source_truth_sql)
        self.assertIn("'goals'", self.source_truth_sql)
        self.assertIn("'assists'", self.source_truth_sql)
        self.assertIn("dense_rank() over", self.source_truth_sql.lower())
        self.assertLess(len(self.source_truth_sql.splitlines()), 140)


    def test_per_league_player_detail_completion_dashboard(self):
        sql = self.detail_dashboard_sql
        self.assertIn("create or replace view public.tm_league_player_detail_sync_dashboard", sql)
        self.assertIn("tm_leader_season_start_year(q.season_id) between 2022 and 2026", sql)
        self.assertIn("'tr1', 'tr2', 'tr3a', 'tr3b'", sql)
        self.assertIn("distinct on (r.external_id, r.record_type)", sql)
        self.assertIn("player_market_values", sql)
        self.assertIn("player_stats", sql)
        self.assertIn("player_transfers", sql)
        self.assertIn("player_injuries", sql)
        self.assertIn("refresh_cutoff", sql)
        self.assertIn("players_with_all_four_core_sections_completed", sql)
        self.assertIn("players_missing_at_least_one_core_section", sql)
        self.assertIn("players_remaining_market_value", sql)
        self.assertIn("players_remaining_career_stats", sql)
        self.assertIn("players_remaining_transfers", sql)
        self.assertIn("players_remaining_injuries", sql)
        self.assertIn("grant select on public.tm_league_player_detail_sync_dashboard to service_role", sql)
        self.assertIn("from public.tm_league_player_detail_sync_dashboard", self.detail_dashboard_verify_sql)


if __name__ == "__main__":
    unittest.main()

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PlayerProfileFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "database" / "005_player_profile_fallbacks.sql").read_text(encoding="utf-8").lower()
        cls.worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        cls.sync = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        cls.workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")

    def test_migration_adds_normalized_injuries_and_profile_rpc(self):
        self.assertIn("create table if not exists public.tm_injuries", self.sql)
        self.assertIn("create or replace function public.tm_replace_player_injuries", self.sql)
        self.assertIn("create or replace function public.tm_player_profile_bundle", self.sql)
        self.assertIn("'injuries'", self.sql)
        self.assertIn("create or replace function public.tm_player_data_diagnostic", self.sql)
        self.assertIn("jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) = 0", self.sql)
        self.assertIn("an empty upstream response", self.sql)

    def test_diagnostic_reports_all_requested_database_tables(self):
        for field in (
            "exact_player_rows",
            "resolved_tm_id",
            "normalized_candidate_match_count",
            "numeric_id_format_matches",
            "appearances_rows",
            "season_stats_rows",
            "market_value_rows",
            "transfer_rows",
            "injury_rows",
            "raw_payload_counts",
            "source_records",
            "last_felipe_synced_at",
        ):
            with self.subTest(field=field):
                self.assertIn("'" + field + "'", self.sql)


    def test_profile_rpc_resolves_a_unique_numeric_id_format_match(self):
        self.assertIn("resolved_tm_id", self.sql)
        self.assertIn("select count(*)", self.sql)
        self.assertIn("regexp_replace(p.tm_id, '[^0-9]', '', 'g')", self.sql)

    def test_worker_falls_back_to_current_season_matches(self):
        self.assertIn("rawCurrentMatches", self.worker)
        self.assertIn('listPayload(currentSeason, ["matches", "matchHistory", "data", "items"])', self.worker)
        self.assertIn('recentAppearanceRows.length ? recentAppearanceRows : rawCurrentMatches', self.worker)

    def test_worker_uses_normalized_injuries_then_raw_snapshot(self):
        self.assertIn("bundleInjuries", self.worker)
        self.assertIn('listPayload(row.injuries_payload || {}, ["injuries", "data", "items", "injuryHistory"])', self.worker)

    def test_injury_sync_writes_normalized_rows(self):
        self.assertIn('rpc("tm_replace_player_injuries"', self.sync)
        self.assertIn('"p_tm_id": tm_id', self.sync)
        self.assertIn('"p_rows": injury_rows', self.sync)

    def test_preseed_is_full_felipe_refresh_not_missing_only(self):
        marker = "def sync_preseed_players("
        start = self.sync.index(marker)
        end = self.sync.index("\ndef ", start + len(marker))
        body = self.sync[start:end]
        self.assertIn("sync_felipeall(only_player=player_id, missing_only=False)", body)
        self.assertNotIn("missing_only=True", body)

    def test_batch_workflow_verifies_supabase_counts_for_all_detail_tables(self):
        self.assertIn("Verify selected player batch rows in Supabase", self.workflow)
        for table in (
            "tm_players",
            "tm_player_season_stats",
            "tm_appearances",
            "tm_market_values",
            "tm_transfers",
            "tm_injuries",
        ):
            with self.subTest(table=table):
                self.assertIn(table, self.workflow)
        self.assertIn("BATCH_SUPABASE_VERIFY_OK", self.workflow)

    def test_missing_data_is_saved_to_one_queue_even_without_dispatch_token(self):
        self.assertIn('status: token ? "queued" : "pending-config"', self.worker)
        self.assertIn('queueStatus === "pending-config" && !token', self.worker)
        self.assertIn('GITHUB_ACTIONS_TOKEN tanımlı değil; eksik oyuncu tek kuyruğa kaydedildi.', self.worker)

    def test_html_uses_short_nonblocking_empty_states(self):
        self.assertIn("function playerNoDataMessage", self.html)
        self.assertIn("Eksik alanlar oyuncu başına tek yenileme kuyruğuna alındı", self.html)
        self.assertNotIn("Transfermarkt kariyer verileri yükleniyor", self.html)


if __name__ == "__main__":
    unittest.main()

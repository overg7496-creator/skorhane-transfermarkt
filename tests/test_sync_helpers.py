import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sync"))
import sync_transfermarkt as sync  # noqa: E402


class SyncHelperTests(unittest.TestCase):
    def test_parse_money_eur(self):
        self.assertEqual(sync.parse_money_eur("€3.50m"), 3_500_000)
        self.assertEqual(sync.parse_money_eur("€250k"), 250_000)
        self.assertEqual(sync.parse_money_eur("free transfer"), None)

    def test_normalize_date(self):
        self.assertEqual(sync.normalize_date("2026-08-12T08:24:21Z"), "2026-08-12")
        self.assertEqual(sync.normalize_date("12.08.2026"), "2026-08-12")
        self.assertIsNone(sync.normalize_date("unknown"))

    def test_current_season_aggregation(self):
        rows = [
            {"competitionName": "Süper Lig", "clubName": "Galatasaray", "playerStatus": "played", "minutesPlayed": 90, "goals": 1, "assists": 0},
            {"competitionName": "Süper Lig", "clubName": "Galatasaray", "playerStatus": "played", "minutesPlayed": 30, "goals": 0, "assists": 1},
            {"competitionName": "Türkiye Kupası", "clubName": "Galatasaray", "playerStatus": "on_bench", "minutesPlayed": 0, "goals": 0},
        ]
        result = sync.build_current_season_stats(rows)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["appearances"], 2)
        self.assertEqual(result[0]["goals"], 1)
        self.assertEqual(result[0]["assists"], 1)
        self.assertEqual(result[0]["minutes"], 120)

    def test_player_id_from_profile_url(self):
        self.assertEqual(sync.player_id_from_row({"url": "https://www.transfermarkt.com/x/profil/spieler/12345"}), "12345")

    def test_query_tokens_are_redacted_from_logged_urls(self):
        self.assertEqual(
            sync.safe_url_for_log("https://api.example.test/v2/runs?token=ABC123&wait=10"),
            "https://api.example.test/v2/runs?token=[REDACTED]&wait=10",
        )

    def test_worker_has_no_direct_transfermarkt_http_origin(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        self.assertNotIn("transfermarkt-api.fly.dev", worker)
        self.assertNotIn("www.transfermarkt.com", worker)

    def test_required_player_endpoint_failure_propagates(self):
        from unittest.mock import patch

        with patch.object(sync, "json_request", side_effect=RuntimeError("HTTP 503")):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                sync.fetch_player_payload("https://api/players/1", "/profile", "1 profil")

    def test_match_endpoint_failure_propagates(self):
        from unittest.mock import patch

        with patch.object(sync, "json_request", side_effect=RuntimeError("HTTP 503")):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                sync.get_player_current_matches("https://api/players/1", "1")

    def test_injury_page_failure_does_not_become_empty_data(self):
        from unittest.mock import patch

        with patch.object(sync, "fetch_player_payload", side_effect=RuntimeError("HTTP 503")):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                sync.fetch_player_paged_rows("https://api/players/1", "/injuries", "injuries")



    def test_required_endpoint_schema_is_validated(self):
        from unittest.mock import patch

        with patch.object(sync, "json_request", return_value={"error": "unexpected"}):
            with self.assertRaisesRegex(RuntimeError, "zorunlu alan"):
                sync.fetch_player_payload(
                    "https://api/players/1", "/profile", "1 profil", ("id", "name")
                )

    def test_sync_continues_after_player_failure_and_records_retry(self):
        from unittest.mock import patch

        players = [
            {"tm_id": "1", "name": "Oyuncu 1"},
            {"tm_id": "2", "name": "Oyuncu 2"},
        ]
        with (
            patch.object(sync, "db_get", return_value=players),
            patch.object(sync, "fetch_player_payload", side_effect=RuntimeError("HTTP 503")) as fetch,
            patch.object(sync, "source_record") as save_queue,
            patch.object(sync, "db_patch") as patch_db,
        ):
            self.assertEqual(sync.sync_felipeall(), 0)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(save_queue.call_count, 2)
            patch_db.assert_not_called()

    def test_retry_checkpoint_waits_until_retry_time(self):
        from datetime import datetime, timedelta, timezone

        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        self.assertFalse(sync.detail_retry_is_due({"status": "retry", "retry_at": future}))
        self.assertFalse(sync.detail_retry_is_due({"status": "blocked"}))
        self.assertTrue(sync.detail_retry_is_due({"status": "retry", "retry_at": ""}))

    def test_backfill_queue_is_resumable_and_uses_time_guard(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn("last_felipe_synced_at=is.null", script)
        self.assertIn('"player_detail_queue"', script)
        self.assertIn("dispatch_refresh_details_continuation()", script)
        self.assertIn("TM_DETAIL_MAX_RUNTIME_SECONDS", script)

    def test_player_sync_never_uses_shared_public_api_by_default(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn('FELIPE_API_BASE = os.getenv("FELIPE_API_BASE", "http://127.0.0.1:8000")', script)
        self.assertNotIn("fetch_optional_player_payload", script)

    def test_felipe_rotation_has_independent_cursor(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn("last_felipe_synced_at.asc.nullsfirst,tm_id.asc", script)
        self.assertIn('"last_felipe_synced_at": datetime.now(timezone.utc).isoformat()', script)

    def test_source_record_snapshot_replaces_authoritative_empty_arrays(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", return_value=[{"id": 77}]),
            patch.object(sync, "db_patch") as patch_db,
        ):
            sync.source_record_snapshot(
                "felipeall", "player_injuries", "123", "",
                {"id": "123", "pageNumber": 1, "lastPageNumber": 1, "injuries": []},
            )
        self.assertEqual(patch_db.call_args.args[1]["payload"]["injuries"], [])
        self.assertEqual(patch_db.call_args.args[0], "tm_source_records?id=eq.77")

    def test_player_snapshot_columns_allow_authoritative_empty_lists(self):
        from unittest.mock import patch

        snapshot = {"injuries_payload": {"injuries": []}, "absences_payload": {"absences": []}}
        with patch.object(sync, "db_patch") as patch_db:
            sync.replace_player_snapshots("123", snapshot)
        self.assertEqual(patch_db.call_args.args[1]["injuries_payload"]["injuries"], [])
        self.assertEqual(patch_db.call_args.args[1]["absences_payload"]["absences"], [])

    def test_rotation_candidates_do_not_starve_after_retry_failures(self):
        from unittest.mock import patch

        future = "2099-01-01T00:00:00+00:00"
        states = {"1": {"status": "retry", "retry_at": future}}
        with (
            patch.object(sync, "TM_MAX_PLAYERS_PER_RUN", 1),
            patch.object(sync, "db_get", return_value=[{"tm_id": "1"}, {"tm_id": "2"}]),
        ):
            rows = sync.load_rotating_player_candidates(states)
        self.assertEqual([row["tm_id"] for row in rows], ["2"])

    def test_history_source_cannot_replace_current_market_value(self):
        schema = (ROOT / "database" / "001_transfermarkt_schema.sql").read_text(encoding="utf-8")
        self.assertIn("case when p_source = 'dcaribou' then tm_players.current_market_value_eur", schema)

    def test_historical_seed_uses_checkpoints_and_small_batches(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn("DCARIBOU_APPEARANCE_BATCH_SIZE", script)
        self.assertIn("appearances_player:", script)
        self.assertIn('run_dcaribou_crawler("players", [club]', script)
        self.assertIn("ConcurrencySettings(min_concurrency=1, max_concurrency=1, desired_concurrency=1, max_tasks_per_minute=18)", script)


if __name__ == "__main__":
    unittest.main()

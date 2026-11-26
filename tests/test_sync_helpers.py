import os
import re
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

    def test_worker_repairs_empty_transfermarkt_snapshots_and_reads_raw_sources(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, copy)
        self.assertIn('const repairCutoff = Date.parse("2026-11-26T12:00:00Z")', worker)
        self.assertIn("tm_source_records?select=record_type,payload,fetched_at", worker)
        self.assertIn("tmPayloadArray", worker)
        self.assertIn("transferClubName", worker)
        self.assertIn('"pf41:"', worker)
        self.assertIn("function tmSupabaseBase(env)", worker)
        self.assertIn("SUPABASE_URL Project URL olmalı", worker)
        self.assertIn('refreshState = await queueTmPlayerRefresh', worker)
        self.assertIn('refreshRetryAt = refreshState.retryAt', worker)
        self.assertIn('tmRefreshState:', worker)


    def test_player_profile_uses_cached_summary_and_lightweight_worker_path(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        worker_copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, worker_copy)
        self.assertIn("async function tmPlayerSummary(env, id, fallback = {})", worker)
        self.assertIn("if (!wantStats) tasks.push", worker)
        self.assertIn("if (wantInfo && coach)", worker)
        self.assertIn("else if (!coach && wantStats)", worker)
        self.assertIn("playerFields = \"tm_id,name,team_name,position,photo_url,profile_payload", worker)
        self.assertIn("readPlayerInfoCache", html)
        self.assertIn("savePlayerInfoCache(it.name,j)", html)
        self.assertIn("infoLoaded:!!cachedLegacyInfo", html)
        self.assertIn("transferResult, marketResult", worker)

    def test_single_player_workflow_uses_short_local_delay_and_dependency_cache(self):
        workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        source = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn('FELIPE_DELAY_MIN_SECONDS: "0.8"', workflow)
        self.assertIn('FELIPE_DELAY_MAX_SECONDS: "1.2"', workflow)
        self.assertIn("uses: actions/cache@v4", workflow)
        self.assertIn('os.getenv("FELIPE_DELAY_MIN_SECONDS", "0.8")', source)
        self.assertIn('os.getenv("FELIPE_DELAY_MAX_SECONDS", "1.2")', source)

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


    def test_imported_detail_queue_is_limited_to_explicit_squad_window(self):
        from unittest.mock import patch

        after = "2026-11-25T20:26:06Z"
        before = "2026-11-25T21:00:04Z"
        with patch.object(sync, "db_get", return_value=[]) as fetch:
            self.assertEqual(
                sync.load_pending_player_detail_candidates(
                    squad_seen_after=after, squad_seen_before=before
                ),
                [],
            )
        query = fetch.call_args.args[0]
        self.assertIn("last_squad_seen_at.gte.2026-11-25T20", query)
        self.assertIn("last_squad_seen_at.lt.2026-11-25T21", query)
        self.assertNotIn("last_felipe_synced_at=is.null", query)

    def test_original_backfill_can_stop_before_new_squad_import_window(self):
        from unittest.mock import patch

        after = "2026-11-12T08:00:00Z"
        before = "2026-11-25T20:26:06Z"
        with patch.object(sync, "db_get", return_value=[]) as fetch:
            self.assertEqual(
                sync.load_pending_player_detail_candidates(
                    squad_seen_after=after, squad_seen_before=before
                ),
                [],
            )
        query = fetch.call_args.args[0]
        self.assertIn("last_squad_seen_at.gte.2026-11-12T08", query)
        self.assertIn("last_squad_seen_at.lt.2026-11-25T20%3A26%3A06Z", query)

    def test_single_player_workflow_does_not_run_squad_imports(self):
        main_workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        missing_workflow = (ROOT / ".github" / "workflows" / "import-missing-leagues.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", main_workflow)
        self.assertIn("refresh-player-missing", main_workflow)
        self.assertIn("one-player-test", main_workflow)
        self.assertNotIn("TM_LEAGUES:", main_workflow)
        self.assertIn("TM_LEAGUES:", missing_workflow)
        self.assertNotRegex(main_workflow, r"(?m)^\s+(?:schedule|push):")

    def test_main_backlog_never_expands_into_imported_or_future_window(self):
        from unittest.mock import patch

        after = "2026-11-12T08:00:00Z"
        before = "2026-11-25T20:26:06Z"
        with patch.object(sync, "db_get", return_value=[]) as fetch:
            self.assertEqual(
                sync.load_pending_player_detail_candidates(
                    squad_seen_after=after, squad_seen_before=before
                ),
                [],
            )
        query = fetch.call_args.args[0]
        self.assertNotIn("or=", query)
        self.assertIn("last_squad_seen_at.gte.2026-11-12T08", query)
        self.assertIn("last_squad_seen_at.lt.2026-11-25T20", query)
        self.assertNotIn("last_squad_seen_at.gte.2026-11-25T21", query)

    def test_player_detail_upsert_does_not_claim_squad_membership(self):
        from unittest.mock import patch

        with patch.object(sync, "rpc") as call:
            sync.upsert_player(
                "123",
                "felipeall",
                {"name": "Oyuncu", "team_name": "Takım", "position": "Forvet"},
            )
        payload = call.call_args.args[1]["p_player"]
        self.assertNotIn("is_active", payload)

    def test_pending_check_uses_both_imported_cohort_boundaries(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "load_player_detail_queue_states", return_value={}),
            patch.object(sync, "db_get", return_value=[]) as fetch,
            patch.dict(
                os.environ,
                {
                    "TM_DETAIL_SQUAD_SEEN_AFTER": "2026-11-25T20:26:06Z",
                    "TM_DETAIL_SQUAD_SEEN_BEFORE": "2026-11-25T21:00:04Z",
                    "TM_DETAIL_AFTER_IMPORTED_END": "",
                },
                clear=False,
            ),
        ):
            self.assertFalse(sync.has_pending_player_details())
        query = fetch.call_args.args[0]
        self.assertIn("last_squad_seen_at.gte.2026-11-25T20", query)
        self.assertIn("last_squad_seen_at.lt.2026-11-25T21", query)

    def test_fixed_detail_cohort_size_mismatch_fails_closed(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", return_value=[{"tm_id": "1", "last_felipe_synced_at": None}]),
            patch.dict(os.environ, {"TM_DETAIL_EXPECTED_COHORT_SIZE": "2402"}),
        ):
            with self.assertRaisesRegex(RuntimeError, "beklenen 2402"):
                sync.load_pending_player_detail_candidates(
                    squad_seen_after="2026-11-12T08:00:00Z",
                    squad_seen_before="2026-11-25T20:26:06Z",
                )

    def test_fixed_detail_cohort_filters_completed_players_after_size_check(self):
        from unittest.mock import patch

        rows = [
            {"tm_id": "1", "last_felipe_synced_at": "2026-11-26T08:00:00Z"},
            {"tm_id": "2", "last_felipe_synced_at": None},
        ]
        with (
            patch.object(sync, "db_get", return_value=rows),
            patch.dict(os.environ, {"TM_DETAIL_EXPECTED_COHORT_SIZE": "2"}),
        ):
            pending = sync.load_pending_player_detail_candidates(
                squad_seen_after="2026-11-12T08:00:00Z",
                squad_seen_before="2026-11-25T20:26:06Z",
            )
        self.assertEqual([row["tm_id"] for row in pending], ["2"])


    def test_original_cohort_processes_only_unfinished_players_not_a_fixed_2402(self):
        from unittest.mock import patch

        rows = [
            {"tm_id": "1", "last_felipe_synced_at": "2026-11-26T08:00:00Z"},
            {"tm_id": "2", "last_felipe_synced_at": None},
            {"tm_id": "3", "last_felipe_synced_at": None},
        ]
        with (
            patch.object(sync, "db_get", return_value=rows),
            patch.dict(os.environ, {"TM_DETAIL_EXPECTED_COHORT_SIZE": ""}),
        ):
            with self.assertLogs(sync.LOG, level="INFO") as captured:
                pending = sync.load_pending_player_detail_candidates(
                    squad_seen_after="2026-11-12T08:00:00Z",
                    squad_seen_before="2026-11-25T20:26:06Z",
                )
        self.assertEqual([row["tm_id"] for row in pending], ["2", "3"])
        self.assertTrue(any("toplam=3" in line and "kalan=2" in line for line in captured.output))

    def test_main_workflow_is_manual_and_serializes_by_player_id(self):
        workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("skorhane-transfermarkt-player-", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+(?:schedule|push):")
        self.assertIn("required: true", workflow[workflow.index("player_id:"):workflow.index("permissions:")])
        self.assertNotIn("TM_DETAIL_EXPECTED_COHORT_SIZE", workflow)

    def test_empty_legacy_player_snapshots_are_requeued_after_repair_cutoff(self):
        from unittest.mock import patch

        player = {
            "profile_payload": {"id": "123", "name": "Oyuncu"},
            "stats_payload": {"stats": []},
            "transfers_payload": {"transfers": []},
            "market_value_payload": {"marketValueHistory": []},
            "injuries_payload": {"injuries": []},
        }
        with patch.object(sync, "db_get", return_value=[]):
            due = sync.player_detail_refresh_plan("123", player)
        self.assertEqual(due, {"profile", "market_value", "transfers", "stats", "injuries"})

    def test_post_repair_empty_provider_lists_are_accepted_when_fresh(self):
        from datetime import datetime, timezone
        from unittest.mock import patch

        player = {
            "profile_payload": {"id": "123", "name": "Oyuncu"},
            "stats_payload": {"stats": []},
            "transfers_payload": {"transfers": []},
            "market_value_payload": {"marketValueHistory": []},
            "injuries_payload": {"injuries": []},
        }
        now = datetime.now(timezone.utc).isoformat()
        records = [{"record_type": item[1], "fetched_at": now} for item in sync.DETAIL_ENDPOINTS.values()]
        with patch.object(sync, "db_get", return_value=records):
            due = sync.player_detail_refresh_plan("123", player)
        self.assertEqual(due, set())

    def test_imported_detail_queue_rejects_incomplete_or_reversed_window(self):
        with self.assertRaisesRegex(RuntimeError, "hem başlangıç hem bitiş"):
            sync.load_pending_player_detail_candidates(squad_seen_after="2026-11-25T20:26:06Z")
        with self.assertRaisesRegex(RuntimeError, "sonra olmalı"):
            sync.validate_detail_squad_window(
                "2026-11-25T21:00:04Z", "2026-11-25T20:26:06Z"
            )

    def test_imported_detail_queue_without_window_uses_recent_unprocessed_players(self):
        from unittest.mock import patch

        with patch.object(sync, "db_get", return_value=[]) as fetch:
            self.assertEqual(sync.load_pending_player_detail_candidates(), [])
        query = fetch.call_args.args[0]
        self.assertIn("last_squad_seen_at=gte.", query)
        self.assertNotIn("last_felipe_synced_at=is.null", query)

    def test_imported_detail_continuation_preserves_explicit_window(self):
        from unittest.mock import patch

        player = {"tm_id": "1", "name": "Oyuncu"}
        after = "2026-11-25T20:26:06Z"
        before = "2026-11-25T21:00:04Z"
        with (
            patch.object(sync, "db_get", side_effect=[[], [player]]),
            patch.object(sync, "dispatch_refresh_details_continuation") as dispatch,
            patch.object(sync.time, "monotonic", side_effect=[0.0, 1.0]),
            patch.dict(
                os.environ,
                {
                    "TM_DETAIL_MAX_RUNTIME_SECONDS": "0",
                    "TM_DETAIL_CONTINUATION_WORKFLOW": "refresh-imported-player-details.yml",
                    "TM_DETAIL_SQUAD_SEEN_AFTER": after,
                    "TM_DETAIL_SQUAD_SEEN_BEFORE": before,
                },
            ),
        ):
            sync.sync_felipeall(backfill_only=True)
        dispatch.assert_called_once_with(
            workflow_file="refresh-imported-player-details.yml",
            inputs={"seen_after": after, "seen_before": before},
        )

    def test_backfill_queue_is_resumable_and_uses_time_guard(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn('pending = [row for row in candidates if not row.get("last_felipe_synced_at")]', script)
        self.assertIn('"player_detail_queue"', script)
        self.assertIn("dispatch_refresh_details_continuation(", script)
        self.assertIn("TM_DETAIL_CONTINUATION_WORKFLOW", script)
        self.assertIn("otomatik devam için", script)
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
        with (
            patch.object(sync, "db_get", return_value=[]),
            patch.object(sync, "db_patch") as patch_db,
        ):
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


    def test_parse_money_eur_handles_european_and_grouped_numbers(self):
        self.assertEqual(sync.parse_money_eur("€2.500.000"), 2_500_000)
        self.assertEqual(sync.parse_money_eur("€3,5m"), 3_500_000)
        self.assertEqual(sync.parse_money_eur("€3.50m"), 3_500_000)
        self.assertEqual(sync.parse_money_eur("€250k"), 250_000)

    def test_transfermarkt_season_pivot_handles_older_seasons(self):
        self.assertEqual(sync.normalize_tm_season("22/23"), "2022/23")
        self.assertEqual(sync.normalize_tm_season("50/51"), "1950/51")
        self.assertEqual(sync.normalize_tm_season("2010/11"), "2010/11")

    def test_transfer_club_object_uses_name_or_transparent_id_label(self):
        self.assertEqual(sync.normalize_transfer_club({"id": "40", "name": "Liverpool FC"}), "Liverpool FC")
        self.assertEqual(sync.normalize_transfer_club({"id": "40"}), "Kulüp #40")
        self.assertEqual(sync.normalize_transfer_club({"id": "40"}, {"name": "Chelsea FC"}), "Chelsea FC")

    def test_current_season_does_not_invent_unknown_club(self):
        self.assertEqual(
            sync.build_current_season_stats([{"competitionName": "Lig", "minutesPlayed": 90, "goals": 1}]),
            [],
        )

    def test_worker_queue_helper_updates_status_without_secrets(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", return_value=[{"id": 99, "payload": {"status": "queued"}}]),
            patch.object(sync, "db_patch") as patch_db,
        ):
            sync.update_worker_refresh_queue("123", "completed", completed_at="2026-11-26T13:00:00+00:00")
        self.assertEqual(patch_db.call_args.args[0], "tm_source_records?id=eq.99")
        payload = patch_db.call_args.args[1]["payload"]
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["player_id"], "123")

    def test_source_empty_snapshot_preserves_existing_rows_but_marks_fresh_check(self):
        from unittest.mock import patch

        existing = {"id": 77, "payload": {"id": "123", "injuries": [{"injury": "Old"}]}}
        with (
            patch.object(sync, "db_get", return_value=[existing]),
            patch.object(sync, "db_patch") as patch_db,
        ):
            sync.source_record_snapshot(
                "felipeall", "player_injuries", "123", "",
                {"id": "123", "pageNumber": 1, "lastPageNumber": 1, "injuries": []},
            )
        payload = patch_db.call_args.args[1]["payload"]
        self.assertEqual(payload["injuries"], [{"injury": "Old"}])
        self.assertTrue(payload["_skorhane_sync"]["provider_returned_empty"])
        self.assertIn("last_checked_at", payload["_skorhane_sync"])

    def test_player_snapshot_never_erases_existing_rows_on_empty_provider_result(self):
        from unittest.mock import patch

        old = {"stats_payload": {"stats": [{"seasonId": "22/23", "goals": 2}]}}
        with (
            patch.object(sync, "db_get", return_value=[old]),
            patch.object(sync, "db_patch") as patch_db,
        ):
            sync.replace_player_snapshots("123", {"stats_payload": {"stats": []}})
        patch_db.assert_not_called()

    def test_transfermarkt_ui_silently_refreshes_all_player_sections_in_place(self):
        html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertIn("function scheduleTmRefreshProbe", html)
        self.assertIn("api('/player?part=info'+qs)", html)
        self.assertIn("api('/player?part=stats'+qs)", html)
        self.assertIn("my.info=freshInfo", html)
        self.assertIn("my.stats=freshStats", html)
        self.assertIn("attempt===0?6000:12000", html)
        self.assertIn("skorhane.playerstats.legacy.v7.", html)
        self.assertNotIn("Eksik Transfermarkt kayıtları yenileme kuyruğuna alındı", html)
        self.assertNotIn("profili kısa süre sonra yeniden aç", html)

    def test_worker_and_copyable_worker_match_and_cache_is_bumped(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, copy)
        self.assertIn('"pf41:"', worker)

    def test_database_saves_goalkeeper_season_fields(self):
        schema = (ROOT / "database" / "001_transfermarkt_schema.sql").read_text(encoding="utf-8")
        self.assertIn("goals_conceded integer", schema)
        self.assertIn("clean_sheets integer", schema)
        self.assertIn("p_row->>'goals_conceded'", schema)
        self.assertIn("p_row->>'clean_sheets'", schema)

    def test_manual_imported_cohort_requires_explicit_window(self):
        workflow = (ROOT / ".github" / "workflows" / "refresh-imported-player-details.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("required: true", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+(?:schedule|workflow_run):")

    def test_worker_does_not_invent_current_club_for_unattributed_stats(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        self.assertIn("if (!clubLabel) continue;", worker)
        self.assertNotIn('clubLabel = "Takım bilgisi yok"', worker)

    def test_worker_uses_valid_columns_for_historical_season_view(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        self.assertIn("tm_appearance_season_totals?\" + selectHistoryStats", worker)
        self.assertIn("goals_conceded,clean_sheets&tm_id=eq.", worker)
if __name__ == "__main__":
    unittest.main()

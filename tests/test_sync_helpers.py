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
        self.assertIn('tmDbRpc(env, "tm_player_profile_bundle"', worker)
        self.assertIn("tmPayloadArray", worker)
        self.assertIn("transferClubName", worker)
        self.assertIn('"pf50:"', worker)
        self.assertIn("function tmSupabaseBase(env)", worker)
        self.assertIn("SUPABASE_URL Project URL olmalı", worker)
        self.assertIn("function tmPlayerRefreshPlan(row, sourceRecords = [], normalizedCoverage = {})", worker)
        self.assertNotIn("queueTmPlayerRefresh(", worker)
        self.assertNotIn("executionCtx.waitUntil(refreshPromise)", worker)
        self.assertIn('state: refreshPlan.required ? "preload-required" : "current"', worker)
        self.assertIn('tmDbRpc(env, "tm_player_profile_bundle"', worker)
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
        self.assertIn('tmDbRpc(env, "tm_player_profile_bundle"', worker)
        self.assertIn("bundleSeasonRows", worker)
        self.assertIn("bundleTransfers", worker)
        self.assertIn("bundleMarketValues", worker)
        self.assertIn("recentAppearanceRows", worker)
        self.assertIn("readPlayerInfoCache", html)
        self.assertIn("savePlayerInfoCache(resolvedTmId,j)", html)
        self.assertIn("savePlayerStatsCache(resolvedTmId,j)", html)
        self.assertIn("playerInfoCacheKey=tmId", html)
        self.assertIn("playerStatsCacheKey=tmId", html)
        self.assertIn("infoLoaded:!!cachedLegacyInfo", html)
        self.assertIn("api('/player?part=all'+qs)", html)
        self.assertNotIn("api('/player?part=info'+qs)", html)
        self.assertNotIn("api('/player?part=stats'+qs)", html)

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
        self.assertIn('cron: "0 20 * * *"', main_workflow)
        self.assertIn("Scheduled refresh of rotating active-player details", main_workflow)
        self.assertNotRegex(main_workflow, r"(?m)^\s+push:")

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
            {"tm_id": "1", "last_felipe_synced_at": "2026-11-27T08:00:00Z"},
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
            {"tm_id": "1", "last_felipe_synced_at": "2026-11-27T08:00:00Z"},
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
        self.assertIn("skorhane-transfermarkt-", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn('cron: "0 20 * * *"', workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+push:")
        self.assertIn("required: false", workflow[workflow.index("player_id:"):workflow.index("permissions:")])
        self.assertIn("player_ids:", workflow)
        self.assertIn('TM_PRESEED_MAX_PLAYERS: "20"', workflow)
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
        self.assertEqual(due, {"profile", "market_value", "transfers", "stats", "injuries", "absences", "matches"})

    def test_post_repair_empty_provider_lists_are_accepted_when_fresh(self):
        from datetime import datetime, timezone
        from unittest.mock import patch

        player = {
            "profile_payload": {"id": "123", "name": "Oyuncu"},
            "stats_payload": {"stats": []},
            "transfers_payload": {"transfers": []},
            "market_value_payload": {"marketValueHistory": []},
            "injuries_payload": {"injuries": []},
            "absences_payload": {"absences": []},
            "current_season_payload": {"matches": []},
        }
        now = datetime.now(timezone.utc).isoformat()
        records = [
            {
                "record_type": item[1],
                "record_key": str(sync.TM_SEASON) if item[1] == "current_season_matches" else "",
                "fetched_at": now,
            }
            for item in sync.DETAIL_ENDPOINTS.values()
        ]
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

    def test_history_detail_preseed_includes_inactive_players_from_season_squads(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", return_value=[]) as fetch,
            patch.dict(os.environ, {"TM_DETAIL_PRESEED_ALL_HISTORY": "true"}),
        ):
            self.assertEqual(sync.load_pending_player_detail_candidates(), [])
        query = fetch.call_args.args[0]
        self.assertIn("tm_detail_preseed_candidates", query)
        self.assertNotIn("is_active=eq.true", query)
        self.assertNotIn("last_squad_seen_at=gte.", query)

    def test_explicit_import_window_overrides_all_history_mode_and_includes_inactive_players(self):
        from unittest.mock import patch

        after = "2026-11-25T20:26:06Z"
        before = "2026-11-25T21:00:04Z"
        with (
            patch.object(sync, "db_get", return_value=[]) as fetch,
            patch.dict(os.environ, {"TM_DETAIL_PRESEED_ALL_HISTORY": "true"}),
        ):
            self.assertEqual(
                sync.load_pending_player_detail_candidates(
                    squad_seen_after=after, squad_seen_before=before
                ),
                [],
            )
        query = fetch.call_args.args[0]
        self.assertIn("tm_detail_preseed_candidates", query)
        self.assertIn("last_squad_seen_at.gte.2026-11-25T20", query)
        self.assertIn("last_squad_seen_at.lt.2026-11-25T21", query)
        self.assertNotIn("is_active=eq.true", query)

    def test_detail_preseed_view_is_scoped_to_all_twelve_competitions_and_five_seasons(self):
        migration = (ROOT / "database" / "011_detail_preseed_scope.sql").read_text(encoding="utf-8").lower()
        for competition in ("tr1", "tr2", "tr3a", "tr3b", "tr4a", "tr4b", "tr4c", "gb1", "es1", "l1", "it1", "fr1"):
            with self.subTest(competition=competition):
                self.assertIn("'" + competition + "'", migration)
        self.assertIn("tm_leader_season_start_year(q.season_id) between 2022 and 2026", migration)
        self.assertNotIn("p.last_felipe_synced_at is null", migration)

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

    def test_detail_worker_time_limit_continuation_resumes_same_league_only(self):
        from unittest.mock import patch

        player = {"tm_id": "123", "name": "Oyuncu"}
        with (
            patch.object(sync, "load_player_detail_queue_states", return_value={}),
            patch.object(sync, "load_pending_player_detail_candidates", return_value=[player]),
            patch.object(sync, "dispatch_refresh_details_continuation") as dispatch,
            patch.object(sync.time, "monotonic", side_effect=[0.0, 1.0]),
            patch.dict(os.environ, {
                "TM_DETAIL_COMPETITION_ID": "GB1",
                "TM_DETAIL_MAX_RUNTIME_SECONDS": "0",
                "TM_DETAIL_CONTINUATION_WORKFLOW": "refresh-imported-player-details.yml",
                "TM_DETAIL_SQUAD_SEEN_AFTER": "",
                "TM_DETAIL_SQUAD_SEEN_BEFORE": "",
            }),
        ):
            sync.sync_felipeall(backfill_only=True)

        dispatch.assert_called_once_with(
            workflow_file="refresh-imported-player-details.yml",
            inputs={"competition_id": "GB1"},
        )

    def test_detail_aggregate_freshness_includes_old_and_unfinished_players(self):
        from datetime import datetime, timezone

        now = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
        self.assertFalse(sync.detail_aggregate_is_fresh(
            {"last_felipe_synced_at": None}, now
        ))
        self.assertFalse(sync.detail_aggregate_is_fresh(
            {"last_felipe_synced_at": "2026-11-26T08:00:00Z"}, now
        ))
        self.assertTrue(sync.detail_aggregate_is_fresh(
            {"last_felipe_synced_at": "2026-11-27T08:00:00Z"}, now
        ))

    def test_history_detail_worker_queries_only_its_league_partition(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", return_value=[]) as fetch,
            patch.dict(os.environ, {
                "TM_DETAIL_PRESEED_ALL_HISTORY": "true",
                "TM_DETAIL_COMPETITION_ID": "TR1",
            }),
        ):
            self.assertEqual(sync.load_pending_player_detail_candidates(), [])
        query = fetch.call_args.args[0]
        self.assertIn("tm_detail_preseed_candidates_by_worker", query)
        self.assertIn("worker_competition_id=eq.TR1", query)
        self.assertNotIn("tm_detail_preseed_candidates?select", query)

    def test_history_detail_worker_rejects_unknown_league_code(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {
            "TM_DETAIL_PRESEED_ALL_HISTORY": "true",
            "TM_DETAIL_COMPETITION_ID": "TR4A",
        }):
            with self.assertRaisesRegex(RuntimeError, "Geçersiz TM_DETAIL_COMPETITION_ID"):
                sync.load_pending_player_detail_candidates()

    def test_league_worker_migration_assigns_each_player_to_one_of_nine_leagues(self):
        migration = (
            ROOT / "database" / "014_parallel_league_detail_workers.sql"
        ).read_text(encoding="utf-8").lower()
        for competition in ("tr1", "tr2", "tr3a", "tr3b", "gb1", "es1", "l1", "it1", "fr1"):
            self.assertIn("'" + competition + "'", migration)
        self.assertIn("row_number() over", migration)
        self.assertIn("partition by lm.tm_id", migration)
        self.assertIn("where rm.worker_rank = 1", migration)

    def test_league_detail_workflow_runs_all_nine_matrix_workers(self):
        workflow = (
            ROOT / ".github" / "workflows" / "refresh-imported-player-details.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("max-parallel: 9", workflow)
        self.assertNotIn("TM_DETAIL_COMPETITION_ID: ${{ matrix.competition_id }}", workflow.split("- name: Validate detail worker and tests", 1)[1].split("- name: Start dedicated Transfermarkt API", 1)[0])
        validation_step = workflow.split("- name: Validate detail worker and tests", 1)[1].split("- name: Start dedicated Transfermarkt API", 1)[0]
        self.assertNotIn("TM_DETAIL_PRESEED_ALL_HISTORY", validation_step)
        self.assertNotIn("TM_DETAIL_SQUAD_SEEN_AFTER", validation_step)
        self.assertNotIn("TM_DETAIL_SQUAD_SEEN_BEFORE", validation_step)
        self.assertIn("fromJSON(", workflow)
        self.assertIn('["TR1","TR2","TR3A","TR3B","GB1","ES1","L1","IT1","FR1"]', workflow)
        self.assertIn("format('[\"{0}\"]'", workflow)
        self.assertIn("TM_DETAIL_COMPETITION_ID: ${{ matrix.competition_id }}", workflow)

    def test_backfill_queue_is_resumable_and_uses_time_guard(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn("same league partition", script)
        self.assertIn("saatlik otomatik kontrol", script)
        self.assertIn("for attempt in range(3):", script)
        self.assertIn("pending = [row for row in candidates if not detail_aggregate_is_fresh(row)]", script)
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

    def test_dcaribou_competition_codes_fall_back_to_country_metadata(self):
        cases = [
            ({"competition_type": "first_tier", "country_name": "Türkiye", "href": "/super-lig/startseite/wettbewerb/123"}, "TR1"),
            ({"competition_type": "first_tier", "country_name": "England", "href": "/premier-league/startseite/wettbewerb/111"}, "GB1"),
            ({"competition_type": "first_tier", "country_code": "ESP", "href": "/laliga/startseite/wettbewerb/222"}, "ES1"),
            ({"competition_type": "first_tier", "parent": {"country_name": "Germany"}}, "L1"),
            ({"competition_type": "first_tier", "country_code": "ITA"}, "IT1"),
            ({"competition_type": "first_tier", "country_name": "France"}, "FR1"),
        ]
        for item, expected in cases:
            with self.subTest(expected=expected):
                self.assertIn(expected, sync.competition_codes(item))

    def test_dcaribou_competition_code_in_href_is_preserved(self):
        self.assertIn(
            "TR1",
            sync.competition_codes({
                "competition_type": "first_tier",
                "href": "/super-lig/startseite/wettbewerb/TR1",
            }),
        )

    def test_historical_seed_uses_checkpoints_and_small_batches(self):
        script = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "seed-player-appearances.yml").read_text(encoding="utf-8")
        self.assertIn("DCARIBOU_APPEARANCE_BATCH_SIZE", script)
        self.assertIn("appearances_player:", script)
        self.assertIn('run_dcaribou_crawler("players", [club]', script)
        self.assertIn("ConcurrencySettings(min_concurrency=1, max_concurrency=1, ", script)
        self.assertIn("desired_concurrency=1, max_tasks_per_minute=18)", script)
        self.assertIn("crawler_class(**crawler_options)", script)
        self.assertIn("crawler_options['concurrency_settings']", script)
        self.assertIn("crawler.pre_navigation_hook", script)
        self.assertIn("@6c1eb59a59349f6869155164808e17c617b0e80d", workflow)


    def test_dcaribou_factory_rate_limit_patch_matches_real_upstream_line(self):
        import tempfile
        import types
        from unittest.mock import patch

        source_templates = (
            (
                "import os\nfrom crawlee import Request\n"
                "def create_crawler(crawler_class=ParselCrawler):\n"
                "    crawler_options = {'http_client': None}\n"
                "    crawler = crawler_class(**crawler_options)\n"
                "    return crawler\n",
                "crawler_options['concurrency_settings']",
            ),
            (
                "import os\nfrom crawlee import Request\n"
                "def create_crawler():\n"
                "    crawler = ParselCrawler()\n"
                "    return crawler\n",
                "ParselCrawler(concurrency_settings=",
            ),
        )

        for upstream_source, expected in source_templates:
            with self.subTest(factory=expected), tempfile.TemporaryDirectory() as directory:
                common_path = Path(directory) / "common.py"
                common_path.write_text(upstream_source, encoding="utf-8")
                package = types.ModuleType("tfmkt")
                package.__path__ = []
                common = types.ModuleType("tfmkt.common")
                common.__file__ = str(common_path)
                package.common = common

                with patch.dict(sys.modules, {"tfmkt": package, "tfmkt.common": common}):
                    sync.patch_dcaribou_rate_limit()
                    patched_source = common_path.read_text(encoding="utf-8")
                    self.assertIn(expected, patched_source)
                    self.assertIn("ConcurrencySettings(min_concurrency=1, max_concurrency=1", patched_source)
                    self.assertIn("@crawler.pre_navigation_hook", patched_source)
                    self.assertIn("await asyncio.sleep(random.uniform(1.5, 3.5))", patched_source)
                    self.assertEqual(patched_source.count("_skorhane_rate_limit"), 1)

                    # Re-running the patch must be idempotent.
                    sync.patch_dcaribou_rate_limit()
                    self.assertEqual(common_path.read_text(encoding="utf-8"), patched_source)

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
        self.assertNotIn("function scheduleTmRefreshProbe", html)
        self.assertIn("api('/player?part=all'+qs)", html)
        self.assertIn("my.info=j;my.stats=j", html)
        self.assertNotIn("api('/player?part=info'+qs)", html)
        self.assertNotIn("api('/player?part=stats'+qs)", html)
        self.assertIn("api('/pitch-player-recent?", html)
        self.assertIn("my.pitchRecentEnrichmentAttempted", html)
        self.assertNotIn("attempt===0?6000:12000", html)
        self.assertIn("skorhane.playerstats.tm.v14.", html)
        self.assertNotIn("Eksik Transfermarkt kayıtları yenileme kuyruğuna alındı", html)
        self.assertNotIn("profili kısa süre sonra yeniden aç", html)

    def test_worker_and_copyable_worker_match_and_cache_is_bumped(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, copy)
        requested_copy = (ROOT / "SkorHane-Worker-kopyalanabilir.txt").read_text(encoding="utf-8")
        html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        requested_html = (ROOT / "SkorHane-HTML-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, requested_copy)
        self.assertEqual(html, requested_html)
        self.assertIn('"pf50:"', worker)
        self.assertIn("const bundleAppearanceRows", worker)
        self.assertIn("const bundleAppearanceRows", requested_copy)

    def test_database_saves_goalkeeper_season_fields(self):
        schema = (ROOT / "database" / "001_transfermarkt_schema.sql").read_text(encoding="utf-8")
        self.assertIn("goals_conceded integer", schema)
        self.assertIn("clean_sheets integer", schema)
        self.assertIn("p_row->>'goals_conceded'", schema)
        self.assertIn("p_row->>'clean_sheets'", schema)

    def test_player_appearance_history_has_manual_checkpointed_workflow(self):
        workflow = (ROOT / ".github" / "workflows" / "seed-player-appearances.yml").read_text(encoding="utf-8")
        source = (ROOT / "sync" / "sync_transfermarkt.py").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("DCARIBOU_COMPETITIONS:", workflow)
        self.assertIn("DCARIBOU_SEASONS:", workflow)
        self.assertIn("DCARIBOU_APPEARANCE_BATCH_SIZE:", workflow)
        self.assertIn("python sync/sync_transfermarkt.py seed-history", workflow)
        self.assertIn("def seed_dcaribou_history()", source)
        self.assertIn("appearances_player:", source)
        self.assertIn("rpc(\"tm_upsert_appearance\"", source)

    def test_historical_detail_preseed_allows_optional_date_window(self):
        workflow = (ROOT / ".github" / "workflows" / "refresh-imported-player-details.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("required: false", workflow)
        self.assertIn('TM_DETAIL_PRESEED_ALL_HISTORY: "true"', workflow)
        self.assertIn('cron: "17 * * * *"', workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+workflow_run:")

    def test_worker_does_not_invent_current_club_for_unattributed_stats(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        self.assertIn("if (!clubLabel) continue;", worker)
        self.assertNotIn('clubLabel = "Takım bilgisi yok"', worker)

    def test_worker_uses_valid_columns_for_historical_season_view(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        migration = (ROOT / "database" / "003_player_profile_bundle.sql").read_text(encoding="utf-8")
        self.assertIn("from public.tm_appearance_season_totals h", migration)
        self.assertIn("s.goals_conceded, s.clean_sheets", migration)
        self.assertIn("'recent_appearances'", migration)
        self.assertIn("limit 13", migration)
    def test_single_player_id_is_used_for_preseed_and_match_verification(self):
        workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        fallback = "TM_PRESEED_PLAYER_IDS: ${{ github.event.inputs.player_ids || github.event.inputs.player_id }}"
        self.assertGreaterEqual(workflow.count(fallback), 4)
        self.assertIn("Verify selected player batch rows in Supabase", workflow)

if __name__ == "__main__":
    unittest.main()


    def test_preseed_player_ids_are_deduplicated_and_validated(self):
        self.assertEqual(
            sync.parse_preseed_player_ids("401923, 1113451;401923\n12345"),
            ["401923", "1113451", "12345"],
        )
        with self.assertRaisesRegex(RuntimeError, "Geçersiz"):
            sync.parse_preseed_player_ids("401923, abc")

    def test_preseed_player_ids_are_bounded(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {"TM_PRESEED_MAX_PLAYERS": "2"}):
            with self.assertRaisesRegex(RuntimeError, "en fazla 2"):
                sync.parse_preseed_player_ids("1,2,3")

    def test_preseed_mode_calls_missing_only_refresh_for_each_player(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "db_get", side_effect=[
                [{"tm_id": "401923", "name": "Victor Osimhen"}],
                [{"last_felipe_synced_at": "2999-01-01T00:00:00+00:00"}],
                [{"tm_id": "1113451", "name": "Kojo Peprah Oppong"}],
                [{"last_felipe_synced_at": "2999-01-01T00:00:00+00:00"}],
            ]),
            patch.object(sync, "sync_felipeall", return_value=1) as run,
        ):
            self.assertEqual(sync.sync_preseed_players("401923,1113451"), 2)
        self.assertEqual(run.call_args_list[0].kwargs, {"only_player": "401923", "missing_only": True})
        self.assertEqual(run.call_args_list[1].kwargs, {"only_player": "1113451", "missing_only": True})

    def test_player_profile_does_not_wait_for_background_dispatch(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        worker_copy = (ROOT / "SkorHane-Worker-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        self.assertEqual(worker, worker_copy)
        self.assertNotIn("executionCtx.waitUntil(refreshPromise)", worker)
        self.assertNotIn("queueTmPlayerRefresh(", worker)
        self.assertIn('"preload-required"', worker)
        self.assertIn('"pf50:"', worker)
        self.assertIn("const loading=false", html)
        self.assertIn("const freshStats=await api('/player?part=stats'+qs)", html)
        self.assertNotIn("const freshInfo=await api('/player?part=info'+qs)", html)

    def test_preseed_workflow_exposes_player_list_input(self):
        workflow = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        self.assertIn("preseed-players", workflow)
        self.assertIn("player_ids:", workflow)
        self.assertIn('python sync/sync_transfermarkt.py preseed-players --player-ids "$TM_PRESEED_PLAYER_IDS"', workflow)


    def test_targeted_player_match_seeder_parses_seasons_and_persists_rows(self):
        from unittest.mock import patch

        self.assertEqual(sync.parse_player_match_seasons("2024, 2025;2024"), ["2024", "2025"])
        with self.assertRaisesRegex(RuntimeError, "Geçersiz sezon"):
            sync.parse_player_match_seasons("2025,abc")
        match = {"gameId": "m1", "date": "2025-08-01T12:00:00Z"}
        with (
            patch.object(sync, "db_get", return_value=[{"tm_id": "401923", "name": "Victor Osimhen"}]),
            patch.object(sync, "fetch_felipe_player_season_matches", return_value=[match]) as fetch,
            patch.object(sync, "persist_felipe_history_appearances", return_value=1) as persist,
            patch.object(sync, "source_record_snapshot") as snapshot,
        ):
            saved = sync.sync_player_match_history("401923", "2025,2026")
        self.assertEqual(saved, 2)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(persist.call_count, 2)
        self.assertEqual(snapshot.call_count, 2)
        self.assertEqual(fetch.call_args_list[0].args, ("401923", "2025"))
        self.assertEqual(fetch.call_args_list[1].args, ("401923", "2026"))

    def test_detail_refresh_plan_includes_current_season_matches(self):
        from unittest.mock import patch

        player = {
            "profile_payload": {"id": "401923", "name": "Victor Osimhen"},
            "current_season_payload": {"matches": []},
        }
        with patch.object(sync, "db_get", return_value=[]):
            due = sync.player_detail_refresh_plan("401923", player)
        self.assertIn("matches", due)
        self.assertIn("matches", sync.DETAIL_ENDPOINTS)


class HistoryFallbackTests(unittest.TestCase):
    def test_dcaribou_parser_accepts_pretty_json_arrays_and_jsonl(self):
        array = '[{"href":"/wettbewerb/TR1"},{"href":"/wettbewerb/GB1"}]'
        jsonl = '{"gameId":"1"}\n{"gameId":"2"}'
        self.assertEqual(len(sync.decode_dcaribou_records(array)), 2)
        self.assertEqual(len(sync.decode_dcaribou_records(jsonl)), 2)

    def test_felipe_match_endpoint_reads_all_pages_for_requested_season(self):
        from unittest.mock import patch

        first = {
            "id": "123",
            "pageNumber": 1,
            "lastPageNumber": 2,
            "matches": [{"gameId": "m1"}],
        }
        second = {
            "id": "123",
            "pageNumber": 2,
            "lastPageNumber": 2,
            "matches": [{"gameId": "m2"}],
        }
        with (
            patch.object(sync, "FELIPE_API_BASE", "http://127.0.0.1:8000"),
            patch.object(sync, "json_request", side_effect=[first, second]) as request,
        ):
            rows = sync.fetch_felipe_player_season_matches("123", "2022")
        self.assertEqual([row["gameId"] for row in rows], ["m1", "m2"])
        self.assertIn("/players/123/matches?season_id=2022&page_number=1", request.call_args_list[0].args[0])
        self.assertIn("page_number=2", request.call_args_list[1].args[0])

    def test_felipe_appearance_persistence_maps_match_and_skips_dnp(self):
        from unittest.mock import patch

        matches = [
            {
                "gameId": "played-1",
                "date": "2022-08-01T17:00:00Z",
                "competition": {"id": "TR1", "name": "Süper Lig"},
                "club": {"id": "1", "name": "Club A"},
                "opponent": {"id": "2", "name": "Club B"},
                "participation": "played",
                "isStarting": True,
                "minutesPlayed": 90,
                "goals": 1,
                "assists": 0,
                "yellowCard": True,
            },
            {
                "gameId": "bench-1",
                "date": "2022-08-08T17:00:00Z",
                "participation": "onBench",
                "minutesPlayed": 0,
            },
        ]
        with patch.object(sync, "rpc") as rpc:
            saved = sync.persist_felipe_history_appearances("123", "2022", matches)
        self.assertEqual(saved, 1)
        rpc.assert_called_once()
        row = rpc.call_args.args[1]["p_row"]
        self.assertEqual(row["source"], "felipeall")
        self.assertEqual(row["source_record_key"], "123:2022:played-1")
        self.assertEqual(row["competition_name"], "Süper Lig")
        self.assertEqual(row["club_name"], "Club A")
        self.assertEqual(row["opponent_name"], "Club B")
        self.assertEqual(row["starts"], 1)
        self.assertEqual(row["minutes"], 90)
        self.assertEqual(row["goals"], 1)
        self.assertEqual(row["yellow_cards"], 1)

    def test_seed_history_catches_empty_dcaribou_and_calls_felipe_fallback(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "_seed_dcaribou_history_scraper", side_effect=RuntimeError("records=0")),
            patch.object(sync, "seed_felipe_history_fallback", return_value=14) as fallback,
        ):
            count = sync.seed_dcaribou_history()
        self.assertEqual(count, 14)
        fallback.assert_called_once()

    def test_felipe_fallback_uses_supabase_roster_and_checkpoints_player_season(self):
        from unittest.mock import patch

        match = {
            "gameId": "match-2022",
            "date": "2022-09-01T18:00:00Z",
            "competition": {"name": "Süper Lig"},
            "club": {"name": "Club A"},
            "opponent": {"name": "Club B"},
            "participation": "played",
            "minutesPlayed": 90,
        }
        with (
            patch.object(sync, "FELIPE_API_BASE", "http://127.0.0.1:8000"),
            patch.object(sync, "DCARIBOU_COMPETITIONS", ["TR1"]),
            patch.object(sync, "DCARIBOU_SEASONS", [2022]),
            patch.object(sync, "TM_SEASON", 2022),
            patch.object(sync, "load_supabase_history_roster", return_value=[{
                "competition_id": "TR1", "competition_name": "Süper Lig",
                "season_id": "2022", "tm_id": "123", "club_name": "Club A",
            }]),
            patch.object(sync, "load_felipe_history_checkpoints", return_value=set()),
            patch.object(sync, "fetch_felipe_player_season_matches", return_value=[match]),
            patch.object(sync, "persist_felipe_history_appearances", return_value=1) as persist,
            patch.object(sync, "mark_felipe_history_checkpoint") as checkpoint,
            patch.object(sync, "dispatch_refresh_details_continuation") as dispatch,
        ):
            count = sync.seed_felipe_history_fallback()
        self.assertEqual(count, 1)
        persist.assert_called_once()
        checkpoint.assert_called_once_with(
            "2022", "123", appearance_rows=1, source_name="felipeall_api"
        )
        dispatch.assert_not_called()

    def test_player_tab_clicks_only_switch_preloaded_supabase_data(self):
        html = (ROOT / "SkorHane-HTML-kodu-kopyalanabilir.txt").read_text(encoding="utf-8")
        click_block = html.split("const pt=e.target.closest('[data-pt]');", 1)[1].split("const pf=e.target.closest('[data-pf]');", 1)[0]
        self.assertIn("renderPlayer()", click_block)
        self.assertIn("loadPitchPlayerRecent(cur)", click_block)
        self.assertNotIn("api(", click_block)
        self.assertIn("my.stats.recentMatches", html)
        self.assertIn("playerstats.tm.v14.", html)
        self.assertIn("playerinfo.tm.v7.", html)

    def test_player_worker_history_tabs_are_supabase_only(self):
        worker = (ROOT / "SkorHane-Worker.js").read_text(encoding="utf-8")
        profile = worker.split("async function playerFull(", 1)[1].split("// ---------- PitchAPI:", 1)[0]
        self.assertIn("tmPlayer(env, id)", profile)
        self.assertNotIn("const careerLogoTask", profile)
        self.assertIn("if (coach && out.afCoach", profile)
        tm_player = worker.split("async function tmPlayer(env, id)", 1)[1].split("async function tsdbPlayer", 1)[0]
        self.assertIn('tmDbRpc(env, "tm_player_profile_bundle"', tm_player)
        self.assertNotIn("queueTmPlayerRefresh(", tm_player)

    def test_history_checkpoint_refreshes_current_season_but_keeps_old_seasons(self):
        from unittest.mock import patch
        with patch.object(sync, "TM_SEASON", 2026):
            completed = {
                sync.history_checkpoint_key("2025", "123"),
                sync.history_checkpoint_key("2026", "123"),
            }
            self.assertFalse(sync.history_appearance_needs_refresh("2025", "123", completed))
            self.assertFalse(sync.history_appearance_needs_refresh("2026", "123", completed))
            self.assertTrue(sync.history_appearance_needs_refresh(
                "2026", "123", completed, refresh_current_season=True
            ))
            self.assertTrue(sync.history_appearance_needs_refresh("2026", "999", completed))

    def test_player_data_preseed_workflows_are_scheduled(self):
        rotation = (ROOT / ".github" / "workflows" / "transfermarkt-sync.yml").read_text(encoding="utf-8")
        details = (ROOT / ".github" / "workflows" / "refresh-imported-player-details.yml").read_text(encoding="utf-8")
        matches = (ROOT / ".github" / "workflows" / "seed-player-appearances.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 20 * * *"', rotation)
        self.assertIn("refresh-rotation", rotation)
        self.assertIn('cron: "17 * * * *"', details)
        self.assertIn("TM_DETAIL_PRESEED_ALL_HISTORY: \"true\"", details)
        self.assertIn('TM_DETAIL_MAX_RUNTIME_SECONDS: "14400"', details)
        self.assertIn("timeout-minutes: 360", details)
        self.assertIn('cron: "0 10 * * 0"', matches)
        self.assertIn("python sync/sync_transfermarkt.py seed-history", matches)

    def test_history_workflow_starts_felipe_api_and_allows_auto_continuation(self):
        workflow = (
            ROOT / ".github" / "workflows" / "seed-player-appearances.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("actions: write", workflow)
        self.assertIn("Start dedicated Felipe Transfermarkt API v5.0.0", workflow)
        self.assertIn("FELIPE_API_BASE: http://127.0.0.1:8000", workflow)
        self.assertIn("continue-on-error: true", workflow)
        self.assertIn("TM_HISTORY_CONTINUATION_DEPTH", workflow)
        self.assertIn("TM_HISTORY_REFRESH_CURRENT_SEASON", workflow)
        self.assertIn("Stop local Felipe API", workflow)





    def test_empty_supabase_and_felipe_rosters_are_not_reported_as_success(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "FELIPE_API_BASE", "http://127.0.0.1:8000"),
            patch.object(sync, "DCARIBOU_COMPETITIONS", ["TR1"]),
            patch.object(sync, "DCARIBOU_SEASONS", [2025]),
            patch.object(sync, "TM_SEASON", 2026),
            patch.object(sync, "load_supabase_history_roster", return_value=[]),
            patch.object(sync, "fetch_felipe_history_roster", return_value=[]),
            self.assertRaisesRegex(RuntimeError, "oyuncu-sezon çifti bulunamadı"),
        ):
            sync.seed_felipe_history_fallback()

    def test_seed_history_does_not_swallow_felipe_database_failure(self):
        from unittest.mock import patch

        with (
            patch.object(sync, "_seed_dcaribou_history_scraper", side_effect=RuntimeError("records=0")),
            patch.object(sync, "seed_felipe_history_fallback", side_effect=OSError("Connection reset by peer")),
            self.assertRaisesRegex(RuntimeError, "tamamlanamadı"),
        ):
            sync.seed_dcaribou_history()

    def test_failed_history_pairs_dispatch_checkpointed_continuation(self):
        from unittest.mock import patch
        import os

        with (
            patch.object(sync, "FELIPE_API_BASE", "http://127.0.0.1:8000"),
            patch.object(sync, "DCARIBOU_COMPETITIONS", ["TR1"]),
            patch.object(sync, "DCARIBOU_SEASONS", [2022]),
            patch.object(sync, "TM_SEASON", 2026),
            patch.object(sync, "load_supabase_history_roster", return_value=[{
                "competition_id": "TR1", "competition_name": "Süper Lig",
                "season_id": "2022", "tm_id": "123", "club_name": "Club A",
            }]),
            patch.object(sync, "load_felipe_history_checkpoints", return_value=set()),
            patch.object(sync, "fetch_felipe_player_season_matches", side_effect=OSError("Connection reset by peer")),
            patch.object(sync, "load_supabase_current_season_matches", return_value=[]),
            patch.object(sync, "dispatch_refresh_details_continuation", return_value=True) as dispatch,
            patch.dict(os.environ, {"TM_HISTORY_CONTINUATION_DEPTH": "0"}),
        ):
            self.assertEqual(sync.seed_felipe_history_fallback(), 0)

        self.assertEqual(dispatch.call_args.kwargs["workflow_file"], "seed-player-appearances.yml")
        inputs = dispatch.call_args.kwargs["inputs"]
        self.assertEqual(inputs["continuation_depth"], "1")
        self.assertEqual(inputs["refresh_current_season"], "false")

    def test_dcaribou_parser_accepts_single_competition_object(self):
        row = {
            "id": "TR1",
            "name": "Süper Lig",
            "competition_type": "first_tier",
            "country_name": "Türkiye",
        }
        decoded = sync.decode_dcaribou_records(__import__("json").dumps(row))
        self.assertEqual(decoded, [row])

    def test_history_checkpoints_are_paginated_past_ten_thousand_limit(self):
        from unittest.mock import patch

        first_page = [{"record_key": f"player_season_appearances:2022:{i}"} for i in range(1000)]
        second_page = [{"record_key": "player_season_appearances:2023:1001"}]
        with patch.object(sync, "db_get", side_effect=[first_page, second_page]) as get:
            rows = sync.load_felipe_history_checkpoints()
        self.assertEqual(len(rows), 1001)
        self.assertIn("player_season_appearances:2023:1001", rows)
        self.assertIn("offset=0", get.call_args_list[0].args[0])
        self.assertIn("offset=1000", get.call_args_list[1].args[0])

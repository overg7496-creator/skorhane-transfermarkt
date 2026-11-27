import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sync"))
import sync_squads_and_clubs as squads  # noqa: E402


class SquadNormalizationTests(unittest.TestCase):
    def test_maps_felipe_api_camel_case_response(self):
        row = {
            "id": "1113451",
            "name": "Kojo Peprah Oppong",
            "imageUrl": "https://img.example/player.jpg",
            "position": "Centre-Forward",
            "joinedOn": "2026-07-01",
            "signedFrom": "Club A",
            "marketValue": 250000,
            "shirtNumber": 19,
            "isCaptain": False,
            "nationality": ["Ghana"],
            "height": 180,
            "foot": "right",
        }
        result = squads.normalize_squad_player(
            row,
            competition_id="TR1",
            competition_name="Süper Lig",
            club_id="123",
            club_name="Club B",
            season_id="2026",
        )
        self.assertIsNotNone(result)
        tm_id, player, transfer = result
        self.assertEqual(tm_id, "1113451")
        self.assertEqual(player["name"], "Kojo Peprah Oppong")
        self.assertEqual(player["photo_url"], "https://img.example/player.jpg")
        self.assertEqual(player["current_market_value_eur"], 250000)
        self.assertEqual(player["team_name"], "Club B")
        self.assertEqual(player["profile_payload"]["squad_import"]["shirt_number"], 19)
        self.assertFalse(player["profile_payload"]["squad_import"]["is_captain"])
        self.assertEqual(player["profile_payload"]["squad_import"]["nationality"], ["Ghana"])
        self.assertEqual(transfer["from_club"], "Club A")
        self.assertEqual(transfer["to_club"], "Club B")
        self.assertEqual(transfer["transfer_date"], "2026-07-01")
        self.assertNotIn("html", str(player).lower())

    def test_maps_snake_case_response_and_omits_missing_fields(self):
        result = squads.normalize_squad_player(
            {"id": "12345", "name": "Test Player", "image_url": None, "market_value": None},
            competition_id="GB1",
            competition_name="Premier League",
            club_id="99",
            club_name="Club",
            season_id="2026",
        )
        tm_id, player, transfer = result
        self.assertEqual(tm_id, "12345")
        self.assertNotIn("photo_url", player)
        self.assertNotIn("current_market_value_eur", player)
        self.assertIsNone(transfer)

    def test_rejects_rows_without_transfermarkt_player_id_or_name(self):
        args = {
            "competition_id": "TR1",
            "competition_name": "Süper Lig",
            "club_id": "123",
            "club_name": "Club",
            "season_id": "2026",
        }
        self.assertIsNone(squads.normalize_squad_player({"name": "No ID"}, **args))
        self.assertIsNone(squads.normalize_squad_player({"id": "12345"}, **args))


class SquadPersistenceTests(unittest.TestCase):
    def test_saves_grouped_transfermarkt_competition_table(self):
        payload = {
            "id": "GB1",
            "seasonId": "2026",
            "tables": [{
                "name": "Premier League",
                "rows": [{
                    "clubId": "281", "clubName": "Manchester City", "matches": 5,
                    "wins": 5, "draws": 0, "losses": 0, "goalsFor": 13,
                    "goalsAgainst": 5, "points": 15,
                }],
            }],
        }
        with patch.object(squads, "db_rpc") as rpc:
            squads.save_competition_table("GB1", "2026", payload)
        rpc.assert_called_once()
        self.assertEqual(rpc.call_args.args[1]["p_record_type"], "competition_table")
        self.assertEqual(rpc.call_args.args[1]["p_payload"]["tables"][0]["rows"][0]["clubId"], "281")

    def test_saves_official_club_country_and_stadium_metadata(self):
        profile = {
            "id": "281",
            "name": "Manchester City",
            "image": "https://img.example/city.png",
            "league": {"name": "Premier League", "countryName": "England", "tier": "1"},
            "squad": {"size": 25, "averageAge": 26.1, "averageMarketValue": 42000000},
            "stadium": {
                "name": "Etihad Stadium", "capacity": 53400,
                "countryName": "England", "buildYear": 2003,
                "fieldSurface": "natural grass",
            },
            "coach": {"id": "1", "name": "Manager"},
        }
        with patch.object(squads, "db_rpc") as rpc:
            squads.save_club_metadata("GB1", "Premier League", "281", "Manchester City", "2026", profile)
        payload = rpc.call_args.args[1]["p_payload"]
        self.assertEqual(payload["country"], "England")
        self.assertEqual(payload["stadium_name"], "Etihad Stadium")
        self.assertEqual(payload["stadium_capacity"], 53400)
        self.assertEqual(payload["stadium_build_year"], 2003)
        self.assertEqual(payload["squad_size"], 25)

    def test_empty_competition_table_does_not_replace_existing_payload(self):
        with patch.object(squads, "db_rpc") as rpc:
            squads.save_competition_table("GB1", "2026", {"tables": [{"rows": []}]})
        rpc.assert_not_called()

    def test_historical_squad_does_not_overwrite_current_player_profile(self):
        player = {
            "name": "Test Player",
            "team_name": "Old Club",
            "position": "Forward",
            "photo_url": "https://img.example/player.jpg",
            "is_active": True,
            "current_market_value_eur": 900000,
            "profile_payload": {
                "squad_import": {
                    "competition_id": "ES1",
                    "competition_name": "LaLiga",
                    "season_id": "2022",
                    "club_id": "77",
                    "club_name": "Old Club",
                    "shirt_number": 9,
                }
            },
        }
        with patch.object(squads, "db_rpc") as rpc:
            squads.save_player("12345", player, None, historical_only=True)

        self.assertEqual(rpc.call_args_list[0].args[0], "tm_upsert_player")
        self.assertEqual(
            rpc.call_args_list[0].args[1]["p_player"],
            {
                "name": "Test Player",
                "position": "Forward",
                "photo_url": "https://img.example/player.jpg",
            },
        )
        self.assertEqual(rpc.call_args_list[1].args[0], "tm_upsert_team_season_squad")
        roster_row = rpc.call_args_list[1].args[1]["p_row"]
        self.assertEqual(roster_row["season_id"], "2022")
        self.assertEqual(roster_row["club_name"], "Old Club")


class SquadSyncTests(unittest.TestCase):

    def test_current_default_league_list_excludes_nonexistent_2026_group_four(self):
        # TFF's 2026-2027 3. Lig has groups 01-03, not a fourth group.
        self.assertNotIn("TR4D", squads.TM_LEAGUES)


    def test_running_checkpoint_resumes_across_utc_day_boundary(self):
        state = {
            "status": "running",
            "sync_date": "2026-11-25",
            "completed_club_ids": ["10", "20"],
        }
        completed, has_checkpoint = squads.completed_club_checkpoint(
            state, today="2026-11-26"
        )
        self.assertTrue(has_checkpoint)
        self.assertEqual(completed, {"10", "20"})

    def test_completed_checkpoint_is_not_imported_again_on_next_day(self):
        state = {
            "status": "completed",
            "sync_date": "2026-11-25",
            "completed_club_ids": ["10", "20"],
        }
        completed, has_checkpoint = squads.completed_club_checkpoint(
            state, today="2026-11-26"
        )
        self.assertTrue(has_checkpoint)
        self.assertEqual(completed, {"10", "20"})

    def test_force_discards_checkpoint(self):
        state = {
            "status": "running",
            "sync_date": "2026-11-25",
            "completed_club_ids": ["10"],
        }
        completed, has_checkpoint = squads.completed_club_checkpoint(
            state, today="2026-11-26", force=True
        )
        self.assertFalse(has_checkpoint)
        self.assertEqual(completed, set())

    def test_sync_uses_competition_and_club_roster_endpoints(self):
        competition = {
            "id": "TR1",
            "name": "Süper Lig",
            "seasonId": "2026",
            "clubs": [{"id": "10", "name": "Club A"}, {"id": "20", "name": "Club B"}],
        }
        profile_a = {"id": "10", "name": "Club A", "image": "https://img.example/club-a.png"}
        profile_b = {"id": "20", "name": "Club B"}
        club_a = {"id": "10", "players": [{"id": "100", "name": "Player A"}]}
        club_b = {"id": "20", "players": [{"id": "200", "name": "Player B"}]}
        with (
            patch.object(squads, "require_config"),
            patch.object(squads, "TM_LEAGUES", ["TR1"]),
            patch.object(squads, "TM_SEASON", "2026"),
            patch.object(squads, "TM_SEASONS", ["2026"]),
            patch.object(squads, "api_get", side_effect=[
                competition, profile_a, club_a, profile_b, club_b
            ]) as api,
            patch.object(squads, "load_league_state", return_value={}),
            patch.object(squads, "save_league_state") as save_state,
            patch.object(squads, "save_club_metadata") as save_club,
            patch.object(squads, "save_player") as save_player,
        ):
            count = squads.sync_squads_and_clubs()
        self.assertEqual(count, 2)
        self.assertEqual(api.call_args_list[0].args[0], "/competitions/TR1/clubs?season_id=2026")
        self.assertEqual(api.call_args_list[1].args[0], "/clubs/10/profile")
        self.assertEqual(api.call_args_list[2].args[0], "/clubs/10/players?season_id=2026")
        self.assertEqual(api.call_args_list[3].args[0], "/clubs/20/profile")
        self.assertEqual(api.call_args_list[4].args[0], "/clubs/20/players?season_id=2026")
        self.assertEqual(save_player.call_count, 2)
        self.assertEqual(save_club.call_count, 2)
        self.assertGreaterEqual(save_state.call_count, 3)

    def test_empty_squad_is_not_checkpointed_or_written(self):
        competition = {
            "id": "TR1",
            "name": "Süper Lig",
            "seasonId": "2026",
            "clubs": [{"id": "10", "name": "Club A"}],
        }
        with (
            patch.object(squads, "require_config"),
            patch.object(squads, "TM_LEAGUES", ["TR1"]),
            patch.object(squads, "TM_SEASON", "2026"),
            patch.object(squads, "TM_SEASONS", ["2026"]),
            patch.object(squads, "api_get", side_effect=[
                competition, {"id": "10", "name": "Club A"}, {"id": "10", "players": []}
            ]),
            patch.object(squads, "load_league_state", return_value={}),
            patch.object(squads, "save_league_state") as save_state,
            patch.object(squads, "save_player") as save_player,
        ):
            with self.assertRaisesRegex(RuntimeError, "kısmi kaldı"):
                squads.sync_squads_and_clubs()
        save_player.assert_not_called()
        # Only the initial running state is saved; the empty club is not marked complete.
        self.assertEqual(save_state.call_count, 1)
        self.assertEqual(save_state.call_args.args[2]["completed_club_ids"], [])

    def test_same_day_checkpoint_skips_already_completed_club(self):
        from datetime import datetime, timezone

        today = datetime.now(timezone.utc).date().isoformat()
        competition = {
            "id": "TR1",
            "name": "Süper Lig",
            "seasonId": "2026",
            "clubs": [{"id": "10", "name": "Club A"}],
        }
        with (
            patch.object(squads, "require_config"),
            patch.object(squads, "TM_LEAGUES", ["TR1"]),
            patch.object(squads, "TM_SEASON", "2026"),
            patch.object(squads, "TM_SEASONS", ["2026"]),
            patch.object(squads, "api_get", return_value=competition) as api,
            patch.object(squads, "load_league_state", return_value={
                "sync_date": today,
                "status": "completed",
                "completed_club_ids": ["10"],
            }),
            patch.object(squads, "save_league_state"),
            patch.object(squads, "save_player") as save_player,
        ):
            count = squads.sync_squads_and_clubs()
        self.assertEqual(count, 0)
        api.assert_called_once()
        save_player.assert_not_called()


if __name__ == "__main__":
    unittest.main()

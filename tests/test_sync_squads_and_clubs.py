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


class SquadSyncTests(unittest.TestCase):
    def test_sync_uses_competition_and_club_roster_endpoints(self):
        competition = {
            "id": "TR1",
            "name": "Süper Lig",
            "seasonId": "2026",
            "clubs": [{"id": "10", "name": "Club A"}, {"id": "20", "name": "Club B"}],
        }
        club_a = {"id": "10", "players": [{"id": "100", "name": "Player A"}]}
        club_b = {"id": "20", "players": [{"id": "200", "name": "Player B"}]}
        with (
            patch.object(squads, "require_config"),
            patch.object(squads, "TM_LEAGUES", ["TR1"]),
            patch.object(squads, "TM_SEASON", "2026"),
            patch.object(squads, "api_get", side_effect=[competition, club_a, club_b]) as api,
            patch.object(squads, "load_league_state", return_value={}),
            patch.object(squads, "save_league_state") as save_state,
            patch.object(squads, "save_player") as save_player,
        ):
            count = squads.sync_squads_and_clubs()
        self.assertEqual(count, 2)
        self.assertEqual(api.call_args_list[0].args[0], "/competitions/TR1/clubs?season_id=2026")
        self.assertEqual(api.call_args_list[1].args[0], "/clubs/10/players?season_id=2026")
        self.assertEqual(api.call_args_list[2].args[0], "/clubs/20/players?season_id=2026")
        self.assertEqual(save_player.call_count, 2)
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
            patch.object(squads, "api_get", side_effect=[competition, {"id": "10", "players": []}]),
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

#!/usr/bin/env python3
"""Season-by-season league, player and team statistics pre-seed for SkorHane.

The existing database migration (002_team_seasons_and_leaderboards.sql) exposes
league goal/assist leaders, player metric leaders and team-season summaries as
views. This worker fills their source table, tm_player_season_stats, from the
season-specific Transfermarkt player statistics endpoint. All writes are
upserts; missing/empty provider data never deletes existing statistics.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sync"))
import sync_transfermarkt as tm  # noqa: E402

LOG = logging.getLogger("skorhane.league_stats")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)

DEFAULT_COMPETITIONS = ["TR1", "TR2", "TR3A", "TR3B", "GB1", "ES1", "L1", "IT1", "FR1"]
DEFAULT_SEASONS = ["2022", "2023", "2024", "2025", "2026"]
MAX_FAILURE_ATTEMPTS = max(1, int(os.getenv("TM_STATS_MAX_FAILURE_ATTEMPTS", "3")))
MAX_PLAYER_REQUESTS = max(1, int(os.getenv("TM_STATS_MAX_PLAYER_REQUESTS_PER_RUN", "1200")))
MAX_RUNTIME_SECONDS = max(60, int(os.getenv("TM_STATS_MAX_RUNTIME_SECONDS", "19800")))
CONTINUE_COUNT = max(0, int(os.getenv("TM_STATS_CONTINUE_COUNT", "0")))
FORCE_REFRESH = os.getenv("TM_STATS_FORCE_REFRESH", "false").strip().lower() in {"1", "true", "yes"}
FELIPE_API_BASE = os.getenv("FELIPE_API_BASE", "http://127.0.0.1:8000").rstrip("/")
GITHUB_WORKFLOW_FILE = "seed-league-statistics.yml"

def env_list(name: str, fallback: list[str]) -> list[str]:
    raw = os.getenv(name, "")
    values = [item.strip() for item in raw.split(",") if item.strip()] if raw else fallback
    return list(dict.fromkeys(values))

COMPETITIONS = env_list("TM_STATS_COMPETITIONS", DEFAULT_COMPETITIONS)
SEASONS = env_list("TM_STATS_SEASONS", DEFAULT_SEASONS)

def norm(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("name") or value.get("displayName") or value.get("display_name") or value.get("value")
    if value is None:
        return ""
    raw = unicodedata.normalize("NFKD", str(value).strip().casefold())
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", raw).strip()

def text_value(row: Any, *keys: str) -> str | None:
    if not isinstance(row, dict):
        return None
    for key in keys:
        value = row.get(key)
        if isinstance(value, dict):
            value = value.get("name") or value.get("displayName") or value.get("display_name")
        if value is not None and str(value).strip():
            return str(value).strip()
    return None

def season_start_year(value: Any) -> int | None:
    if value is None:
        return None
    raw = str(value).strip().replace("–", "/").replace("-", "/")
    match = re.search(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)", raw)
    if match:
        return int(match.group(1))
    short = re.search(r"(?<!\d)(\d{2})\s*/\s*\d{2}(?!\d)", raw)
    if short:
        year = int(short.group(1))
        return 2000 + year if year < 50 else 1900 + year
    return None

def stat_season_id(value: Any, fallback_year: str) -> str:
    normalized = tm.normalize_tm_season(value)
    return normalized or str(fallback_year)

def db_get_all(path: str, page_size: int = 1000) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = tm.db_get(f"{path}&limit={page_size}&offset={offset}")
        if not isinstance(page, list):
            raise RuntimeError("Supabase sayfalı sorgusu liste döndürmedi.")
        rows.extend(row for row in page if isinstance(row, dict))
        if len(page) < page_size:
            return rows
        offset += len(page)

def load_squad_state(competition_id: str, season_id: str) -> dict[str, Any]:
    rows = tm.db_get(
        "tm_source_records?select=payload"
        "&source=eq.felipeall&record_type=eq.squad_sync_state"
        f"&external_id=eq.{quote(competition_id, safe='')}"
        f"&record_key=eq.{quote(season_id, safe='')}&limit=1"
    )
    return rows[0].get("payload") if rows and isinstance(rows[0], dict) and isinstance(rows[0].get("payload"), dict) else {}

def roster_rows_for(competition_id: str, season_id: str) -> list[dict[str, Any]]:
    rows = tm.load_supabase_history_roster(competition_id, season_id)
    state = load_squad_state(competition_id, season_id)
    # A partial/running squad import is supplemented from the source API. The
    # API fallback is cached by tm.fetch_felipe_history_roster via safe upserts.
    if not rows or state.get("status") != "completed":
        try:
            api_rows = tm.fetch_felipe_history_roster(competition_id, season_id)
            known = {
                (str(row.get("club_id") or ""), str(row.get("tm_id") or ""))
                for row in rows
            }
            for row in api_rows:
                key = (str(row.get("club_id") or ""), str(row.get("tm_id") or ""))
                if key not in known:
                    rows.append(row)
                    known.add(key)
        except Exception as exc:
            LOG.warning("%s/%s kadro API yedeği alınamadı; eldeki %s satır korunuyor: %s",
                        competition_id, season_id, len(rows), tm.safe_error_for_log(exc))
    return rows

def save_competition_table_if_missing(competition_id: str, season_id: str) -> None:
    existing = tm.db_get(
        "tm_source_records?select=record_key"
        "&source=eq.felipeall&record_type=eq.competition_table"
        f"&external_id=eq.{quote(competition_id, safe='')}"
        f"&record_key=eq.{quote(season_id, safe='')}&limit=1"
    )
    if existing:
        return
    payload = tm.json_request(
        f"{FELIPE_API_BASE}/competitions/{quote(competition_id, safe='')}/table?"
        + urlencode({"season_id": season_id}),
        source=f"felipeall {competition_id}/{season_id} puan tablosu",
        delay_range=(tm.FELIPE_DELAY_MIN, tm.FELIPE_DELAY_MAX),
    )
    if not isinstance(payload, dict):
        return
    rows = []
    tables = payload.get("tables")
    if isinstance(tables, list):
        rows = [row for table in tables if isinstance(table, dict)
                for row in (table.get("rows") or []) if isinstance(row, dict)]
    if not rows:
        for key in ("table", "standings", "rows", "data"):
            value = payload.get(key)
            if isinstance(value, list) and value:
                rows = value
                break
            if isinstance(value, dict):
                for nested in ("table", "standings", "rows"):
                    if isinstance(value.get(nested), list) and value[nested]:
                        rows = value[nested]
                        break
            if rows:
                break
    if not rows:
        LOG.warning("%s/%s puan tablosu boş; mevcut kayıt değiştirilmedi.", competition_id, season_id)
        return
    tm.rpc("tm_upsert_source_record", {
        "p_source": "felipeall",
        "p_record_type": "competition_table",
        "p_external_id": competition_id,
        "p_record_key": season_id,
        "p_payload": payload,
    })

def build_player_targets() -> dict[str, list[dict[str, Any]]]:
    targets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    roster_total = 0
    for competition_id in COMPETITIONS:
        for season_id in SEASONS:
            try:
                rows = roster_rows_for(competition_id, season_id)
            except Exception as exc:
                LOG.warning("%s/%s kadrosu okunamadı: %s", competition_id, season_id, tm.safe_error_for_log(exc))
                rows = []
            if not rows:
                LOG.warning("%s/%s için kadro bulunamadı; bu kombinasyon boş bırakıldı.", competition_id, season_id)
                continue
            roster_total += len(rows)
            for row in rows:
                player_id = text_value(row, "tm_id", "player_id", "playerId")
                comp_name = text_value(row, "competition_name", "competitionName") or competition_id
                club_id = text_value(row, "club_id", "clubId") or ""
                club_name = text_value(row, "club_name", "clubName") or ""
                if not player_id or not player_id.isdigit() or not club_name:
                    continue
                target = {
                    "competition_id": competition_id,
                    "competition_name": comp_name,
                    "season_id": str(season_id),
                    "season_start": season_start_year(season_id),
                    "club_id": club_id,
                    "club_name": club_name,
                }
                identity = (competition_id, str(season_id), club_id, club_name, player_id)
                if all((x["competition_id"], x["season_id"], x["club_id"], x["club_name"], player_id) != identity for x in targets[player_id]):
                    targets[player_id].append(target)
            try:
                save_competition_table_if_missing(competition_id, season_id)
            except Exception as exc:
                LOG.warning("%s/%s puan tablosu yenilenemedi: %s", competition_id, season_id, tm.safe_error_for_log(exc))
            LOG.info("%s/%s: %s kadro satırı okundu.", competition_id, season_id, len(rows))
    LOG.info("Kadro toplamı=%s satır; istatistik isteği bekleyen benzersiz oyuncu=%s.",
             roster_total, len(targets))
    return dict(targets)

def stat_competition_name(row: dict[str, Any]) -> str:
    return text_value(row, "competition_name", "competitionName", "competition_name_display",
                      "competition", "competitionName") or ""

def stat_club_name(row: dict[str, Any]) -> str:
    return text_value(row, "club_name", "clubName", "club", "team", "teamName") or ""

def stat_competition_id(row: dict[str, Any]) -> str:
    for key in ("competition_id", "competitionId", "competitionID", "league_id", "leagueId", "leagueID"):
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    for key in ("competition", "league"):
        item = row.get(key)
        if isinstance(item, dict):
            value = item.get("id") or item.get("competitionId") or item.get("leagueId")
            if value is not None and str(value).strip():
                return str(value).strip()
    return ""

def stat_club_id(row: dict[str, Any]) -> str:
    for key in ("club_id", "clubId", "clubID", "team_id", "teamId", "teamID"):
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    for key in ("club", "team"):
        item = row.get(key)
        if isinstance(item, dict):
            value = item.get("id") or item.get("clubId") or item.get("teamId")
            if value is not None and str(value).strip():
                return str(value).strip()
    return ""

def competition_ids_share_namespace(left: str, right: str) -> bool:
    """Compare canonical Transfermarkt codes together and numeric provider IDs together."""
    if not left or not right:
        return False
    left_code = bool(re.fullmatch(r"[A-Z]{2,4}[0-9]+[A-Z]?", left, re.IGNORECASE))
    right_code = bool(re.fullmatch(r"[A-Z]{2,4}[0-9]+[A-Z]?", right, re.IGNORECASE))
    return (left_code and right_code) or (left.isdigit() and right.isdigit())

def stat_ids_share_namespace(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return left.isdigit() == right.isdigit()

def matching_targets(stat: dict[str, Any], targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    season_value = text_value(stat, "season_id", "seasonId", "seasonID", "season")
    year = season_start_year(season_value)
    competition_id = stat_competition_id(stat)
    competition = norm(stat_competition_name(stat))
    club_id = stat_club_id(stat)
    club = norm(stat_club_name(stat))
    if year is None or (not competition_id and not competition):
        return []
    matches = []
    for target in targets:
        if target.get("season_start") != year:
            continue
        target_competition_id = str(target.get("competition_id") or "").strip()
        target_competition = norm(target.get("competition_name"))
        if competition_id and target_competition_id and competition_ids_share_namespace(competition_id, target_competition_id):
            same_competition = competition_id == target_competition_id
        else:
            same_competition = bool(competition and target_competition and competition == target_competition)
        if not same_competition:
            continue
        target_club_id = str(target.get("club_id") or "").strip()
        target_club = norm(target.get("club_name"))
        if club_id and target_club_id and stat_ids_share_namespace(club_id, target_club_id):
            same_club = club_id == target_club_id
        else:
            same_club = bool(club and target_club and club == target_club)
        if same_club:
            matches.append(target)
    return matches

def identity_conflict_scope_keys(stat: dict[str, Any], targets: list[dict[str, Any]]) -> set[str]:
    """Flag provider rows that belong to this league-season but no imported club stint."""
    year = season_start_year(text_value(stat, "season_id", "seasonId", "seasonID", "season"))
    competition_id = stat_competition_id(stat)
    competition = norm(stat_competition_name(stat))
    club_id = stat_club_id(stat)
    club = norm(stat_club_name(stat))
    conflicts: set[str] = set()
    if year is None or (not competition_id and not competition):
        return conflicts

    same_scope: list[dict[str, Any]] = []
    for target in targets:
        if target.get("season_start") != year:
            continue
        target_competition_id = str(target.get("competition_id") or "").strip()
        target_competition = norm(target.get("competition_name"))
        if competition_id and target_competition_id and competition_ids_share_namespace(competition_id, target_competition_id):
            same_competition = competition_id == target_competition_id
        else:
            same_competition = bool(competition and target_competition and competition == target_competition)
        if same_competition:
            same_scope.append(target)

    if not same_scope:
        return conflicts

    scope_key = target_scope_key(same_scope[0])
    target_club_ids = {
        str(target.get("club_id") or "").strip()
        for target in same_scope
        if str(target.get("club_id") or "").strip()
    }
    comparable_ids = {
        value for value in target_club_ids
        if club_id and stat_ids_share_namespace(club_id, value)
    }
    if club_id and comparable_ids and club_id not in comparable_ids:
        # The provider reports a club in this league-season, but no imported
        # roster stint has that ID. Do not silently create a false zero row.
        conflicts.add(scope_key)
        return conflicts

    if club_id and target_club_ids and not comparable_ids:
        matching_name = any(club and club == norm(target.get("club_name")) for target in same_scope)
        if matching_name:
            conflicts.add(scope_key)
    return conflicts

def map_stat_payloads(tm_id: str, stat: dict[str, Any], targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map only exact season + competition + club matches; never mix cup/league rows."""
    mapped = []
    for target in matching_targets(stat, targets):
        season_value = text_value(stat, "season_id", "seasonId", "seasonID", "season")
        row = {
            "tm_id": str(tm_id),
            "season_id": stat_season_id(season_value, str(target["season_id"])),
            "competition_id": str(target.get("competition_id") or ""),
            "club_id": str(target.get("club_id") or ""),
            "competition_name": target["competition_name"],
            "club_name": target["club_name"],
            "appearances": tm.numeric(stat, "appearances", "matches", "gamesPlayed"),
            "starts": tm.numeric(stat, "starts"),
            "goals": tm.numeric(stat, "goals"),
            "assists": tm.numeric(stat, "assists", "goalAssists"),
            "minutes": tm.numeric(stat, "minutes_played", "minutesPlayed", "minutes", "timePlayed"),
            "yellow_cards": tm.numeric(stat, "yellow_cards", "yellowCards"),
            "second_yellow_cards": tm.numeric(stat, "second_yellow_cards", "secondYellowCards", "redCards2ndYellow"),
            "red_cards": tm.numeric(stat, "red_cards", "redCards", "straightRedCards", "totalRedCards"),
            "goals_conceded": tm.numeric(stat, "goals_conceded", "goalsConceded"),
            "clean_sheets": tm.numeric(stat, "clean_sheets", "cleanSheets"),
            "payload": {
                **stat,
                "league_stats_sync": {
                    "competition_id": target["competition_id"],
                    "season_id": target["season_id"],
                    "club_id": target["club_id"],
                    "matched_at": datetime.now(timezone.utc).isoformat(),
                },
            },
            "source": "felipeall",
        }
        if any(row[key] is not None for key in (
            "appearances", "starts", "goals", "assists", "minutes", "yellow_cards",
            "second_yellow_cards", "red_cards", "goals_conceded", "clean_sheets"
        )):
            mapped.append(row)
    return mapped

def target_identity_key(target: dict[str, Any]) -> str:
    club_id = str(target.get("club_id") or "").strip()
    club_key = "id:" + club_id if club_id else "name:" + norm(target.get("club_name"))
    return f"{target.get('competition_id')}:{target.get('season_id')}:{club_key}"


def target_scope_key(target: dict[str, Any]) -> str:
    return f"{target.get('competition_id')}:{target.get('season_id')}"


def zero_stat_payload(tm_id: str, target: dict[str, Any]) -> dict[str, Any]:
    """Represent a rostered player with no league appearance as explicit zero stats."""
    season_id = stat_season_id(target.get("season_id"), str(target.get("season_id") or ""))
    competition_id = str(target.get("competition_id") or "")
    club_id = str(target.get("club_id") or "")
    competition_name = str(target.get("competition_name") or competition_id)
    club_name = str(target.get("club_name") or ("Kulüp #" + club_id if club_id else ""))
    return {
        "tm_id": str(tm_id),
        "season_id": season_id,
        "competition_id": competition_id,
        "club_id": club_id,
        "competition_name": competition_name,
        "club_name": club_name,
        "appearances": 0,
        "starts": 0,
        "goals": 0,
        "assists": 0,
        "minutes": 0,
        "yellow_cards": 0,
        "second_yellow_cards": 0,
        "red_cards": 0,
        "goals_conceded": 0,
        "clean_sheets": 0,
        "payload": {
            "league_stats_sync": {
                "competition_id": competition_id,
                "season_id": str(target.get("season_id") or ""),
                "club_id": club_id,
                "zero_fill": True,
                "source_response_complete": True,
                "matched_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        "source": "felipeall",
    }


def fetch_player_stats(tm_id: str) -> list[dict[str, Any]]:
    payload = tm.json_request(
        f"{FELIPE_API_BASE}/players/{quote(tm_id, safe='')}/stats",
        source=f"felipeall {tm_id} sezon istatistikleri",
        delay_range=(tm.FELIPE_DELAY_MIN, tm.FELIPE_DELAY_MAX),
    )
    rows = tm.iterable_from(payload, ("stats", "data", "items"))
    if not isinstance(payload, dict) or not isinstance(rows, list):
        raise RuntimeError(f"{tm_id} istatistik yanıtında beklenen stats listesi bulunamadı.")
    return [row for row in rows if isinstance(row, dict)]

def checkpoint_scope() -> str:
    # v3 forces a one-time refetch so every roster player receives an explicit
    # league/season row (including a safe zero row when the complete stats response
    # contains no appearance record for that club stint).
    return "v3_" + "-".join(COMPETITIONS) + "_" + "-".join(SEASONS)

def load_checkpoints(scope: str) -> dict[str, dict[str, Any]]:
    query = (
        "tm_source_records?select=external_id,payload"
        "&source=eq.felipeall&record_type=eq.league_stats_player_checkpoint"
        f"&record_key=eq.{quote(scope, safe='')}&order=external_id.asc"
    )
    rows = db_get_all(query)
    result = {}
    for row in rows:
        if row.get("external_id") and isinstance(row.get("payload"), dict):
            result[str(row["external_id"])] = row["payload"]
    return result

def save_checkpoint(tm_id: str, scope: str, payload: dict[str, Any]) -> None:
    tm.rpc("tm_upsert_source_record", {
        "p_source": "felipeall",
        "p_record_type": "league_stats_player_checkpoint",
        "p_external_id": str(tm_id),
        "p_record_key": scope,
        "p_payload": payload,
    })

def update_run(run_id: Any, payload: dict[str, Any]) -> None:
    if not run_id:
        return
    try:
        tm.db_patch(f"tm_sync_runs?id=eq.{quote(str(run_id), safe='')}", payload)
    except Exception as exc:
        LOG.warning("tm_sync_runs güncellenemedi: %s", tm.safe_error_for_log(exc))

def dispatch_continuation() -> bool:
    token = os.getenv("GITHUB_TOKEN", "")
    repository = os.getenv("GITHUB_REPOSITORY", "")
    ref = os.getenv("GITHUB_REF_NAME", "main")
    if not token or not repository:
        LOG.error("Kalan oyuncular için otomatik devam yok: GitHub token/repository eksik.")
        return False
    if CONTINUE_COUNT >= 20:
        LOG.error("İstatistik otomatik devamı 20 çalışma sınırına ulaştı; kalanlar elle başlatılmalı.")
        return False
    payload = json.dumps({
        "ref": ref,
        "inputs": {
            "competitions": ",".join(COMPETITIONS),
            "seasons": ",".join(SEASONS),
            "force_refresh": "false",
            "continue_count": str(CONTINUE_COUNT + 1),
        },
    }).encode("utf-8")
    request = Request(
        f"https://api.github.com/repos/{repository}/actions/workflows/{GITHUB_WORKFLOW_FILE}/dispatches",
        data=payload,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "SkorHane-League-Statistics",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            response.read()
            LOG.info("Kalan lig oyuncu istatistikleri için devam çalışması kuyruğa alındı (HTTP %s).", response.status)
            return True
    except (HTTPError, URLError, TimeoutError) as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800] if isinstance(exc, HTTPError) else str(exc)
        LOG.error("İstatistik devam çalışması başlatılamadı: %s", detail)
        return False

def run() -> int:
    if not tm.SUPABASE_URL or not tm.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı değil.")
    if not FELIPE_API_BASE:
        raise RuntimeError("FELIPE_API_BASE tanımlı değil.")
    if not COMPETITIONS or not SEASONS:
        raise RuntimeError("TM_STATS_COMPETITIONS ve TM_STATS_SEASONS boş olamaz.")
    if any(not re.fullmatch(r"(?:19|20)\d{2}", season) for season in SEASONS):
        raise RuntimeError("Sezonlar 4 haneli başlangıç yılı olmalı; örnek: 2022,2023,2024,2025,2026.")

    run_record = None
    try:
        run_record = tm.db_insert("tm_sync_runs", {
            "source": "felipeall", "mode": "sync-league-statistics", "status": "running",
        })
    except Exception as exc:
        LOG.warning("İşlem kaydı açılamadı; istatistik aktarımı sürdürülecek: %s", tm.safe_error_for_log(exc))
    run_id = run_record.get("id") if isinstance(run_record, dict) else None

    started = time.monotonic()
    totals = {"players_fetched": 0, "stat_rows_saved": 0, "zero_rows_filled": 0, "no_stats": 0, "failed": 0, "roster_players": 0}
    try:
        targets = build_player_targets()
        totals["roster_players"] = len(targets)
        if not targets:
            raise RuntimeError("Seçilen dokuz lig/sezon için Supabase veya Felipe API kadrosu bulunamadı.")
        scope = checkpoint_scope()
        checkpoints = load_checkpoints(scope)
        pending = []
        for player_id in sorted(targets, key=lambda value: int(value)):
            state = checkpoints.get(player_id, {})
            status = state.get("status")
            attempts = int(state.get("attempts") or 0)
            if FORCE_REFRESH or status != "completed" and not (status == "failed" and attempts >= MAX_FAILURE_ATTEMPTS):
                pending.append(player_id)
        LOG.info(
            "İstatistik kapsamı: ligler=%s | sezonlar=%s | oyuncu=%s | tamamlanmış checkpoint=%s | bekleyen=%s | zorla yenile=%s",
            ",".join(COMPETITIONS), ",".join(SEASONS), len(targets),
            sum(1 for state in checkpoints.values() if state.get("status") == "completed"),
            len(pending), FORCE_REFRESH,
        )

        processed = 0
        for index, player_id in enumerate(pending, start=1):
            if processed >= MAX_PLAYER_REQUESTS or time.monotonic() - started >= MAX_RUNTIME_SECONDS:
                LOG.warning("Güvenli çalışma sınırına ulaşıldı; kalan oyuncular checkpoint ile sonraki çalışmaya bırakılıyor.")
                break
            old_state = checkpoints.get(player_id, {})
            try:
                stat_rows = fetch_player_stats(player_id)
                unmatched_scope_keys: set[str] = set()
                mapped_by_identity: dict[str, dict[str, Any]] = {}
                matched_scope_keys: set[str] = set()
                for stat in stat_rows:
                    unmatched_scope_keys.update(identity_conflict_scope_keys(stat, targets[player_id]))
                    for payload in map_stat_payloads(player_id, stat, targets[player_id]):
                        identity = target_identity_key({
                            "competition_id": payload["competition_id"],
                            "season_id": str(season_start_year(payload["season_id"]) or payload["season_id"]),
                            "club_id": payload["club_id"],
                            "club_name": payload["club_name"],
                        })
                        # The provider normally returns one aggregate per identity.
                        # Keep the most recent row if an upstream response repeats it.
                        mapped_by_identity[identity] = payload
                        matched_scope_keys.add(
                            f"{payload['competition_id']}:{season_start_year(payload['season_id']) or payload['season_id']}"
                        )

                # The stats endpoint is a complete per-player season/competition/
                # club response. Rostered stints absent from that response mean
                # zero league appearances; persist those zeros instead of leaving
                # the player invisible in the season read model.
                zero_filled_scope_keys: set[str] = set()
                zero_filled_row_count = 0
                for target in targets[player_id]:
                    scope_key = target_scope_key(target)
                    if scope_key in unmatched_scope_keys:
                        continue
                    identity = target_identity_key(target)
                    if identity not in mapped_by_identity:
                        mapped_by_identity[identity] = zero_stat_payload(player_id, target)
                        zero_filled_scope_keys.add(scope_key)
                        zero_filled_row_count += 1

                rows_to_save = list(mapped_by_identity.values())
                if rows_to_save:
                    tm.rpc("tm_upsert_season_stats_batch", {"p_rows": rows_to_save})
                    # The cache refresh is player-scoped and runs after every
                    # source row is committed; league pages read this indexed table.
                    tm.rpc("tm_refresh_player_league_season_totals_cache", {"p_tm_id": str(player_id)})

                expected_scope_keys = {
                    target_scope_key(target) for target in targets[player_id]
                }
                completed_scope_keys = sorted(expected_scope_keys - unmatched_scope_keys)
                incomplete = bool(unmatched_scope_keys)
                attempts = int(old_state.get("attempts") or 0) + (1 if incomplete else 0)
                checkpoint_status = (
                    "retryable_failed" if incomplete and attempts < MAX_FAILURE_ATTEMPTS
                    else "failed" if incomplete
                    else "completed"
                )
                now = datetime.now(timezone.utc).isoformat()
                save_checkpoint(player_id, scope, {
                    "status": checkpoint_status, "coverage_version": 3,
                    "attempts": attempts,
                    "stats_rows_seen": len(stat_rows),
                    "stats_rows_saved": len(rows_to_save),
                    "provider_stat_rows_saved": len(mapped_by_identity) - zero_filled_row_count,
                    "matched_scope_keys": sorted(matched_scope_keys),
                    "zero_filled_scope_keys": sorted(zero_filled_scope_keys),
                    "completed_scope_keys": completed_scope_keys,
                    "unmatched_scope_keys": sorted(unmatched_scope_keys),
                    "no_matching_league_rows": False,
                    "scope_competitions": COMPETITIONS, "scope_seasons": SEASONS,
                    "completed_at": now, "source": "felipeall",
                })
                checkpoints[player_id] = {
                    "status": checkpoint_status, "attempts": attempts,
                    "completed_scope_keys": completed_scope_keys,
                }
                totals["players_fetched"] += 1
                totals["stat_rows_saved"] += len(rows_to_save)
                totals["zero_rows_filled"] += zero_filled_row_count
                if not stat_rows:
                    totals["no_stats"] += 1
                if index == 1 or index % 25 == 0:
                    LOG.info(
                        "İlerleme %s/%s oyuncu; %s satır yazıldı (%s sıfır satır).",
                        index, len(pending), len(rows_to_save), len(zero_filled_scope_keys),
                    )
            except Exception as exc:
                attempts = int(old_state.get("attempts") or 0) + 1
                status = "retryable_failed" if attempts < MAX_FAILURE_ATTEMPTS else "failed"
                save_checkpoint(player_id, scope, {
                    "status": status, "coverage_version": 2, "attempts": attempts,
                    "last_error": tm.safe_error_for_log(exc),
                    "last_attempt_at": datetime.now(timezone.utc).isoformat(),
                    "scope_competitions": COMPETITIONS, "scope_seasons": SEASONS,
                    "source": "felipeall",
                })
                checkpoints[player_id] = {"status": status, "attempts": attempts}
                totals["failed"] += 1
                LOG.warning("Oyuncu istatistikleri alınamadı id=%s (%s/%s): %s",
                            player_id, attempts, MAX_FAILURE_ATTEMPTS, tm.safe_error_for_log(exc))
            processed += 1

        retryable = [
            player_id for player_id in targets
            if checkpoints.get(player_id, {}).get("status") != "completed"
            and not (checkpoints.get(player_id, {}).get("status") == "failed"
                     and int(checkpoints.get(player_id, {}).get("attempts") or 0) >= MAX_FAILURE_ATTEMPTS)
        ]
        remaining = len(retryable)
        elapsed = round(time.monotonic() - started, 2)
        LOG.info(
            "İstatistik aktarım özeti: oyuncu isteği=%s, kaydedilen satır=%s, sıfır satır=%s, boş istatistik yanıtı=%s, hatalı=%s, kalan=%s, süre=%ss.",
            processed, totals["stat_rows_saved"], totals["zero_rows_filled"], totals["no_stats"], totals["failed"], remaining, elapsed,
        )
        update_run(run_id, {
            "status": "succeeded", "finished_at": datetime.now(timezone.utc).isoformat(),
            "message": f"Lig istatistikleri tamamlandı/bölümlendi; oyuncu={totals['players_fetched']}, satır={totals['stat_rows_saved']}, kalan={remaining}",
            "details": {**totals, "processed_this_run": processed, "remaining_player_ids": remaining,
                        "scope": scope, "duration_seconds": elapsed, "competitions": COMPETITIONS, "seasons": SEASONS},
        })
        if remaining:
            if dispatch_continuation():
                LOG.info("Kalan %s oyuncu için otomatik devam planlandı.", remaining)
            else:
                LOG.warning("Kalan %s oyuncu var; workflow elle yeniden başlatılmalı.", remaining)
        return totals["stat_rows_saved"]
    except Exception as exc:
        update_run(run_id, {
            "status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(),
            "error_count": 1, "message": tm.safe_error_for_log(exc),
            "details": {**totals, "duration_seconds": round(time.monotonic() - started, 2)},
        })
        raise

if __name__ == "__main__":
    try:
        raise SystemExit(0 if run() >= 0 else 1)
    except Exception:
        LOG.exception("Lig sezon istatistik aktarımı başarısız.")
        raise SystemExit(1)

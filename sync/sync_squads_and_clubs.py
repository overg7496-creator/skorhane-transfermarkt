#!/usr/bin/env python3
"""Import current Transfermarkt club squads through the local felipeall API.

The worker stores only normalized player fields in Supabase. Each competition
keeps a small per-day checkpoint, so a failed run resumes at the first club
that was not fully written. It never deletes players or replaces useful fields
with values missing from an upstream response.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from typing import Any

LOG = logging.getLogger("skorhane.squads")
LOG.setLevel(logging.INFO)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
if not LOG.handlers:
    LOG.addHandler(_handler)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FELIPE_API_BASE = os.getenv("FELIPE_API_BASE", "http://127.0.0.1:8000").rstrip("/")
TM_LEAGUES = [x.strip().upper() for x in os.getenv(
    "TM_LEAGUES", "TR1,TR2,TR3A,TR3B,TR4A,TR4B,TR4C,GB1,ES1,L1,IT1,FR1"
).split(",") if x.strip()]
TM_SEASON = os.getenv("TM_SEASON", "2026").strip()
TM_SEASONS = list(dict.fromkeys(x.strip() for x in os.getenv("TM_SEASONS", TM_SEASON).split(",") if x.strip()))
TM_CONTINUE_COUNT = int(os.getenv("TM_CONTINUE_COUNT", "0"))
DELAY_MIN = float(os.getenv("REQUEST_DELAY_MIN_SECONDS", "1.5"))
DELAY_MAX = float(os.getenv("REQUEST_DELAY_MAX_SECONDS", "3.0"))
HTTP_TIMEOUT = int(os.getenv("HTTP_TIMEOUT_SECONDS", "45"))
MAX_RETRIES = int(os.getenv("HTTP_MAX_RETRIES", "3"))
SQUAD_SYNC_MAX_RUNTIME_SECONDS = int(os.getenv("SQUAD_SYNC_MAX_RUNTIME_SECONDS", "20400"))


def require_config() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY GitHub Secrets içinde tanımlanmalı.")
    if not FELIPE_API_BASE:
        raise RuntimeError("FELIPE_API_BASE tanımlı değil.")
    if not TM_LEAGUES:
        raise RuntimeError("TM_LEAGUES boş.")
    if not TM_SEASONS or any(not re.fullmatch(r"(?:19|20)\d{2}", season) for season in TM_SEASONS):
        raise RuntimeError("TM_SEASONS en az bir geçerli sezon başlangıç yılı içermeli (örn. 2026,2025,2024).")
    if TM_CONTINUE_COUNT < 0 or TM_CONTINUE_COUNT > 20:
        raise RuntimeError("TM_CONTINUE_COUNT 0-20 arasında olmalı.")
    if DELAY_MIN < 0 or DELAY_MAX < DELAY_MIN:
        raise RuntimeError("REQUEST_DELAY_MIN_SECONDS / REQUEST_DELAY_MAX_SECONDS geçersiz.")
    if SQUAD_SYNC_MAX_RUNTIME_SECONDS < 60:
        raise RuntimeError("SQUAD_SYNC_MAX_RUNTIME_SECONDS en az 60 saniye olmalı.")


def api_get(path: str) -> Any:
    """Sequential API request with jitter and bounded Retry-After-aware retries."""
    url = f"{FELIPE_API_BASE}{path}"
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        try:
            request = Request(url, headers={"Accept": "application/json"}, method="GET")
            with urlopen(request, timeout=HTTP_TIMEOUT) as response:
                raw = response.read()
                if not raw:
                    raise RuntimeError(f"Felipe API boş yanıt döndürdü: {path}")
                return json.loads(raw.decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:800]
            last_error = RuntimeError(f"Felipe API HTTP {exc.code} ({path}): {body or exc.reason}")
            LOG.warning("%s; deneme %s/%s", last_error, attempt + 1, MAX_RETRIES + 1)
            if exc.code not in (408, 425, 429, 500, 502, 503, 504):
                break
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            try:
                wait = float(retry_after) if retry_after else min(180, 12 * (2 ** attempt))
            except ValueError:
                wait = min(180, 12 * (2 ** attempt))
            time.sleep(max(1.0, wait) + random.uniform(1.0, 3.0))
        except (URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = exc
            LOG.warning("Felipe API bağlantı/JSON hatası (%s); deneme %s/%s",
                        str(exc)[:800], attempt + 1, MAX_RETRIES + 1)
            if attempt < MAX_RETRIES:
                time.sleep(min(120, 8 * (2 ** attempt)) + random.uniform(1.0, 3.0))
    raise RuntimeError(f"Felipe API isteği tamamlanamadı: {last_error}")


def db_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def db_get(path: str) -> Any:
    request = Request(f"{SUPABASE_URL}/rest/v1/{path}", headers=db_headers(), method="GET")
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        raw = response.read()
        return json.loads(raw.decode("utf-8")) if raw else []


def db_rpc(name: str, payload: dict[str, Any]) -> Any:
    request = Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{name}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={**db_headers(), "Prefer": "return=minimal"},
        method="POST",
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return response.read()


def db_insert(path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    request = Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={**db_headers(), "Prefer": "return=representation"},
        method="POST",
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        raw = response.read()
        rows = json.loads(raw.decode("utf-8")) if raw else []
        return rows[0] if isinstance(rows, list) and rows else None


def db_patch(path: str, payload: dict[str, Any]) -> None:
    request = Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={**db_headers(), "Prefer": "return=minimal"},
        method="PATCH",
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        response.read()


def get_value(row: Any, *keys: str) -> Any:
    if not isinstance(row, dict):
        return None
    for key in keys:
        value = row.get(key)
        if value is not None and value != "":
            return value
    return None


def as_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = get_value(value, "name", "displayName", "value")
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def normalize_date(value: Any) -> str | None:
    raw = as_text(value)
    if not raw:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return raw[:10]
    for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def money_text(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    amount = int(value)
    if amount >= 1_000_000:
        return f"€{amount / 1_000_000:.2f}m"
    if amount >= 1_000:
        return f"€{amount / 1_000:.0f}k"
    return f"€{amount:,}"


def normalize_squad_player(
    row: dict[str, Any], *, competition_id: str, competition_name: str,
    club_id: str, club_name: str, season_id: str,
) -> tuple[str, dict[str, Any], dict[str, Any] | None] | None:
    """Map the documented ClubPlayer model to existing SkorHane RPC payloads."""
    tm_id = as_text(get_value(row, "id", "playerId", "player_id", "tm_id"))
    name = as_text(get_value(row, "name", "playerName", "player_name"))
    if not tm_id or not re.fullmatch(r"\d+", tm_id) or not name:
        return None

    current_value = get_value(row, "market_value", "marketValue", "current_market_value_eur")
    if isinstance(current_value, bool) or not isinstance(current_value, (int, float)):
        current_value = None

    team_name = as_text(get_value(row, "current_club", "currentClub")) or club_name
    squad_fields: dict[str, Any] = {
        "source": "felipeall",
        "competition_id": competition_id,
        "competition_name": competition_name,
        "club_id": club_id,
        "club_name": club_name,
        "season_id": season_id,
    }
    optional_fields = {
        "shirt_number": get_value(row, "shirt_number", "shirtNumber"),
        "is_captain": get_value(row, "is_captain", "isCaptain"),
        "date_of_birth": normalize_date(get_value(row, "date_of_birth", "dateOfBirth")),
        "age": get_value(row, "age"),
        "nationality": get_value(row, "nationality"),
        "height": get_value(row, "height"),
        "foot": as_text(get_value(row, "foot")),
        "joined_on": normalize_date(get_value(row, "joined_on", "joinedOn", "joined_date", "joinedDate")),
        "signed_from": as_text(get_value(row, "signed_from", "signedFrom")),
        "contract_expires": normalize_date(get_value(row, "contract", "contract_expires", "contractExpires")),
    }
    for key, value in optional_fields.items():
        if value is None or value == "":
            continue
        if key == "nationality" and isinstance(value, list):
            squad_fields[key] = [str(item) for item in value if item]
        elif key in {"age", "height", "shirt_number"}:
            try:
                squad_fields[key] = int(value)
            except (TypeError, ValueError):
                continue
        elif key == "is_captain" and isinstance(value, bool):
            squad_fields[key] = value
        elif isinstance(value, (str, int, bool, list)):
            squad_fields[key] = value

    player: dict[str, Any] = {
        "name": name,
        "team_name": team_name,
        "profile_payload": {"squad_import": squad_fields},
        "is_active": True,
    }
    position = as_text(get_value(row, "position"))
    photo_url = as_text(get_value(row, "image_url", "imageUrl", "photo_url", "photoUrl"))
    if position:
        player["position"] = position
    if photo_url:
        player["photo_url"] = photo_url
    # Missing fields are omitted, never sent as empty values to the merge RPC.
    if current_value is not None:
        player["current_market_value_eur"] = int(current_value)
        player["current_market_value_text"] = money_text(current_value)
        player["current_market_value_observed_at"] = datetime.now(timezone.utc).isoformat()

    transfer: dict[str, Any] | None = None
    joined_on = normalize_date(get_value(row, "joined_on", "joinedOn", "joined_date", "joinedDate"))
    signed_from = as_text(get_value(row, "signed_from", "signedFrom"))
    if joined_on and signed_from:
        transfer = {
            "tm_id": tm_id,
            "transfer_date": joined_on,
            "from_club": signed_from,
            "to_club": club_name,
            "transfer_type": "transfer",
            "fee_text": None,
            "fee_eur": None,
            "payload": {
                "source": "felipeall",
                "joined_on": joined_on,
                "signed_from": signed_from,
                "club_id": club_id,
                "season_id": season_id,
            },
            "source": "felipeall",
        }
    return tm_id, player, transfer


def load_league_state(competition_id: str, season_id: str) -> dict[str, Any]:
    query = (
        "tm_source_records?select=payload"
        "&source=eq.felipeall&record_type=eq.squad_sync_state"
        f"&external_id=eq.{quote(competition_id, safe='')}"
        f"&record_key=eq.{quote(season_id, safe='')}&limit=1"
    )
    rows = db_get(query)
    if not isinstance(rows, list) or not rows or not isinstance(rows[0].get("payload"), dict):
        return {}
    return rows[0]["payload"]


def save_league_state(competition_id: str, season_id: str, payload: dict[str, Any]) -> None:
    db_rpc("tm_upsert_source_record", {
        "p_source": "felipeall",
        "p_record_type": "squad_sync_state",
        "p_external_id": competition_id,
        "p_record_key": season_id,
        "p_payload": payload,
    })


def save_player(
    tm_id: str, player: dict[str, Any], transfer: dict[str, Any] | None,
    *, historical_only: bool = False,
) -> None:
    # Older-season membership must never replace the current club/profile row.
    # For a player not yet in tm_players, create only a neutral identity stub;
    # the season-specific club association is stored below in its own table.
    stored_player = player
    if historical_only:
        stored_player = {
            key: player[key] for key in ("name", "position", "photo_url")
            if player.get(key) not in (None, "")
        }
    db_rpc("tm_upsert_player", {
        "p_tm_id": tm_id,
        "p_source": "felipeall",
        "p_player": stored_player,
    })
    if transfer:
        db_rpc("tm_upsert_transfer", {"p_row": transfer})

    # Store season-keyed roster membership separately from the latest player profile.
    squad = (player.get("profile_payload") or {}).get("squad_import") or {}
    if squad:
        db_rpc("tm_upsert_team_season_squad", {"p_row": {
            "competition_id": squad.get("competition_id"),
            "competition_name": squad.get("competition_name"),
            "season_id": squad.get("season_id"),
            "club_id": squad.get("club_id"),
            "club_name": squad.get("club_name"),
            "tm_id": tm_id,
            "player_name": player.get("name"),
            "position": player.get("position"),
            "photo_url": player.get("photo_url"),
            "shirt_number": squad.get("shirt_number"),
            "age": squad.get("age"),
            "nationality": squad.get("nationality"),
            "contract_expires": squad.get("contract_expires"),
            "market_value_eur": player.get("current_market_value_eur"),
            "payload": squad,
        }})


def save_competition_table(competition_id: str, season_id: str, payload: dict[str, Any]) -> None:
    """Persist a validated non-empty table; do not replace old data with empty responses."""
    candidates = []
    if isinstance(payload, dict):
        tables = payload.get("tables")
        if isinstance(tables, list):
            candidates = [
                row
                for table in tables if isinstance(table, dict)
                for row in (table.get("rows") or []) if isinstance(row, dict)
            ]
        if not candidates:
            for key in ("table", "standings", "rows", "data"):
                value = payload.get(key)
                if isinstance(value, list) and value:
                    candidates = value
                    break
                if isinstance(value, dict):
                    for nested in ("table", "standings", "rows"):
                        if isinstance(value.get(nested), list) and value[nested]:
                            candidates = value[nested]
                            break
                if candidates:
                    break
    if not candidates:
        LOG.warning("%s/%s puan tablosu boş/beklenmeyen biçimde; eski kayıt korunuyor.", competition_id, season_id)
        return
    db_rpc("tm_upsert_source_record", {
        "p_source": "felipeall",
        "p_record_type": "competition_table",
        "p_external_id": competition_id,
        "p_record_key": season_id,
        "p_payload": payload,
    })


def save_club_metadata(
    competition_id: str, competition_name: str, club_id: str, club_name: str,
    season_id: str, profile: dict[str, Any] | None = None,
) -> None:
    """Store compact club fields only; never persist the full upstream response."""
    squad = get_value(profile, "squad") or {}
    league = get_value(profile, "league") or {}
    stadium = get_value(profile, "stadium") or {}
    coach = get_value(profile, "coach") or {}
    payload: dict[str, Any] = {
        "club_id": club_id,
        "club_name": as_text(get_value(profile, "name")) or club_name,
        "competition_id": competition_id,
        "competition_name": competition_name,
        "season_id": season_id,
    }
    optional = {
        "official_name": as_text(get_value(profile, "official_name", "officialName")),
        "short_name": as_text(get_value(profile, "short_name", "shortName")),
        "abbreviation": as_text(get_value(profile, "abbreviation")),
        "club_code": as_text(get_value(profile, "club_code", "clubCode")),
        "logo_url": as_text(get_value(profile, "image")),
        "address_line_1": as_text(get_value(profile, "address_line_1", "addressLine1")),
        "address_line_2": as_text(get_value(profile, "address_line_2", "addressLine2")),
        "address_line_3": as_text(get_value(profile, "address_line_3", "addressLine3")),
        "colors": get_value(profile, "colors"),
        "current_market_value": get_value(profile, "current_market_value", "currentMarketValue"),
        "squad_size": get_value(squad, "size"),
        "average_age": get_value(squad, "average_age", "averageAge"),
        "average_market_value": get_value(squad, "average_market_value", "averageMarketValue"),
        "acquisition_value": get_value(squad, "acquisition_value", "acquisitionValue"),
        "top_18_players_market_value": get_value(squad, "top_18_players_market_value", "top18PlayersMarketValue"),
        "top_18_share_percentage": get_value(squad, "top_18_share_percentage", "top18SharePercentage"),
        "foreigners": get_value(squad, "foreigners"),
        "national_team_players": get_value(squad, "national_team_players", "nationalTeamPlayers"),
        "domestic_players": get_value(squad, "domestic_players", "domesticPlayers"),
        "league_name": as_text(get_value(league, "name")),
        "league_tier": as_text(get_value(league, "tier")),
        "country": as_text(get_value(league, "country_name", "countryName")),
        "country_id": as_text(get_value(league, "country_id", "countryId")),
        "coach_name": as_text(get_value(coach, "name")),
        "coach_id": as_text(get_value(coach, "id")),
        "coach_since": as_text(get_value(coach, "since")),
        "stadium_name": as_text(get_value(stadium, "name")) or as_text(get_value(profile, "stadium_name", "stadiumName")),
        "stadium_id": as_text(get_value(stadium, "id")),
        "stadium_capacity": get_value(stadium, "capacity") if get_value(stadium, "capacity") is not None else get_value(profile, "stadium_seats", "stadiumSeats"),
        "stadium_international_capacity": get_value(stadium, "international_capacity", "internationalCapacity"),
        "stadium_country": as_text(get_value(stadium, "country_name", "countryName")),
        "stadium_build_year": get_value(stadium, "build_year", "buildYear"),
        "stadium_renovation_year": get_value(stadium, "renovation_year", "renovationYear"),
        "stadium_field_surface": as_text(get_value(stadium, "field_surface", "fieldSurface")),
        "stadium_field_length": get_value(stadium, "field_length", "fieldLength"),
        "stadium_field_width": get_value(stadium, "field_width", "fieldWidth"),
        "stadium_website": as_text(get_value(stadium, "website")),
    }
    payload.update({key: value for key, value in optional.items() if value is not None and value != ""})
    db_rpc("tm_upsert_source_record", {
        "p_source": "felipeall",
        "p_record_type": "club_metadata",
        "p_external_id": club_id,
        "p_record_key": f"{competition_id}:{season_id}",
        "p_payload": payload,
    })



def completed_club_checkpoint(
    state: dict[str, Any], *, today: str, force: bool = False
) -> tuple[set[str], bool]:
    """Keep running/completed checkpoints across midnight; a new season uses a new record key."""
    if force:
        return set(), False
    status = state.get("status")
    same_day_legacy_checkpoint = state.get("sync_date") == today
    resumable = status in {"running", "completed"} or same_day_legacy_checkpoint
    if not resumable:
        return set(), False
    completed = {
        str(item) for item in state.get("completed_club_ids", [])
        if item is not None
    }
    return completed, True


def dispatch_squad_continuation() -> bool:
    """Dispatch the same workflow again so it can resume from saved club checkpoints."""
    token = os.getenv("GITHUB_TOKEN", "")
    repository = os.getenv("GITHUB_REPOSITORY", "")
    ref = os.getenv("GITHUB_REF_NAME", "main")
    if not token or not repository:
        LOG.error("Kadro aktarımında süre sınırı doldu ancak otomatik devam için GitHub token/repository yok.")
        return False
    if TM_CONTINUE_COUNT >= 20:
        LOG.error("Otomatik devam güvenlik sınırı (20 zincir) aşıldı; workflow elle yeniden başlatılmalı.")
        return False
    url = f"https://api.github.com/repos/{repository}/actions/workflows/import-missing-leagues.yml/dispatches"
    payload = json.dumps({
        "ref": ref,
        "inputs": {
            "tm_leagues": os.getenv("TM_LEAGUES", ",".join(TM_LEAGUES)),
            "tm_seasons": os.getenv("TM_SEASONS", ",".join(TM_SEASONS)),
            "continue_count": str(TM_CONTINUE_COUNT + 1),
        },
    }).encode("utf-8")
    request = Request(url, data=payload, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SkorHane-Squad-Queue",
        "Content-Type": "application/json",
    }, method="POST")
    try:
        with urlopen(request, timeout=30) as response:
            response.read()
            LOG.info("Eksik liglerde kalan kulüpler için otomatik devam çalışması kuyruğa alındı (HTTP %s).", response.status)
            return True
    except (HTTPError, URLError, TimeoutError) as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000] if isinstance(exc, HTTPError) else str(exc)
        LOG.error("Eksik lig otomatik devamı kuyruğa alınamadı; tekrar başlatılması gerekecek: %s", detail)
        return False

def sync_squads_and_clubs(*, force: bool = False) -> int:
    """Import a resumable matrix of competitions and historical seasons."""
    require_config()
    today = datetime.now(timezone.utc).date().isoformat()
    started = time.monotonic()
    total_players = 0
    failed_clubs: list[str] = []
    stopped_for_time = False
    latest_season = max(TM_SEASONS, key=int)
    LOG.info("Kadro aktarımı başlıyor: ligler=%s | sezonlar=%s",
             ",".join(TM_LEAGUES), ",".join(TM_SEASONS))

    for competition_id in TM_LEAGUES:
        for requested_season in TM_SEASONS:
            if time.monotonic() - started >= SQUAD_SYNC_MAX_RUNTIME_SECONDS:
                stopped_for_time = True
                LOG.warning("Güvenli süreye ulaşıldı; sonraki lig/sezon checkpoint'ten devam edecek.")
                break

            competition_path = f"/competitions/{quote(competition_id, safe='')}/clubs?" + urlencode({"season_id": requested_season})
            try:
                competition = api_get(competition_path)
            except Exception as exc:
                if re.search(r"HTTP\s+(?:408|425|429|500|502|503|504)", str(exc), re.IGNORECASE):
                    stopped_for_time = True
                    LOG.warning("%s/%s upstream sınırı; sonraki çalışma checkpoint'ten devam edecek: %s",
                                competition_id, requested_season, str(exc)[:500])
                    break
                raise
            clubs = get_value(competition, "clubs")
            if not isinstance(clubs, list) or not clubs:
                raise RuntimeError(
                    f"{competition_id}/{requested_season} ligi için kulüp listesi geçerli/boş değil. "
                    "Güvenlik için mevcut kayıtlar değiştirilmedi."
                )

            competition_name = as_text(get_value(competition, "name")) or competition_id
            api_season = as_text(get_value(competition, "season_id", "seasonId")) or requested_season
            state = load_league_state(competition_id, api_season)
            completed, has_checkpoint = completed_club_checkpoint(state, today=today, force=force)
            if not has_checkpoint:
                save_league_state(competition_id, api_season, {
                    "status": "running", "sync_date": today, "total_clubs": len(clubs),
                    "completed_club_ids": [], "last_error": None,
                })

            LOG.info("%s (%s) sezon %s: %s kulüp; tamamlanan=%s",
                     competition_name, competition_id, api_season, len(clubs), len(completed))
            season_players_added = 0
            for club in clubs:
                club_id = as_text(get_value(club, "id", "clubId", "club_id"))
                club_name = as_text(get_value(club, "name", "clubName", "club_name"))
                if not club_id or not club_name:
                    failed_clubs.append(f"{competition_id}/{api_season}:kimliksiz-kulüp")
                    continue
                if club_id in completed:
                    continue
                if time.monotonic() - started >= SQUAD_SYNC_MAX_RUNTIME_SECONDS:
                    stopped_for_time = True
                    LOG.warning("Süre sınırına ulaşıldı; %s kulübünde checkpoint bırakılıyor.", club_name)
                    break

                club_profile: dict[str, Any] | None = None
                try:
                    profile = api_get(f"/clubs/{quote(club_id, safe='')}/profile")
                    if isinstance(profile, dict) and as_text(get_value(profile, "id")):
                        club_profile = profile
                except Exception as exc:
                    if re.search(r"HTTP\s+(?:408|425|429|500|502|503|504)", str(exc), re.IGNORECASE):
                        stopped_for_time = True
                        LOG.warning("%s kulüp profilinde upstream sınırı; checkpoint bırakılıyor: %s",
                                    club_name, str(exc)[:500])
                        break
                    LOG.warning("%s kulüp profili alınamadı; kadro devam ediyor: %s", club_name, str(exc)[:500])

                if stopped_for_time:
                    break
                squad_path = f"/clubs/{quote(club_id, safe='')}/players?" + urlencode({"season_id": api_season})
                try:
                    squad = api_get(squad_path)
                except Exception as exc:
                    if re.search(r"HTTP\s+(?:408|425|429|500|502|503|504)", str(exc), re.IGNORECASE):
                        stopped_for_time = True
                        LOG.warning("%s kadrosunda upstream sınırı; checkpoint bırakılıyor: %s",
                                    club_name, str(exc)[:500])
                        break
                    raise
                players = get_value(squad, "players")
                if not isinstance(players, list) or not players:
                    failed_clubs.append(f"{competition_id}/{api_season}/{club_id}")
                    LOG.warning("%s kadrosu boş/geçersiz; checkpoint yazılmadı.", club_name)
                    continue

                saved_here = 0
                for row in players:
                    if not isinstance(row, dict):
                        continue
                    normalized = normalize_squad_player(
                        row, competition_id=competition_id, competition_name=competition_name,
                        club_id=club_id, club_name=club_name, season_id=api_season,
                    )
                    if not normalized:
                        LOG.warning("%s kadrosunda ID/adı eksik oyuncu atlandı.", club_name)
                        continue
                    tm_id, player_payload, transfer_payload = normalized
                    save_player(
                        tm_id, player_payload, transfer_payload,
                        historical_only=(requested_season != latest_season),
                    )
                    saved_here += 1

                if saved_here == 0:
                    failed_clubs.append(f"{competition_id}/{api_season}/{club_id}")
                    LOG.warning("%s kadrosundan kullanılabilir oyuncu çıkmadı.", club_name)
                    continue

                save_club_metadata(competition_id, competition_name, club_id, club_name, api_season, club_profile)
                completed.add(club_id)
                save_league_state(competition_id, api_season, {
                    "status": "running", "sync_date": today, "total_clubs": len(clubs),
                    "completed_club_ids": sorted(completed), "last_completed_club_id": club_id,
                    "last_error": None,
                })
                total_players += saved_here
                season_players_added += saved_here
                LOG.info("%s: %s oyuncu yazıldı (%s/%s kulüp).", club_name, saved_here, len(completed), len(clubs))

            all_club_ids = {as_text(get_value(item, "id", "clubId", "club_id")) for item in clubs}
            all_club_ids.discard(None)
            if all_club_ids.issubset(completed):
                save_league_state(competition_id, api_season, {
                    "status": "completed", "sync_date": today, "total_clubs": len(clubs),
                    "completed_club_ids": sorted(completed), "last_error": None,
                })
                if season_players_added > 0 or not has_checkpoint:
                    try:
                        table_payload = api_get(
                            f"/competitions/{quote(competition_id, safe='')}/table?"
                            + urlencode({"season_id": api_season})
                        )
                        if isinstance(table_payload, dict):
                            save_competition_table(competition_id, api_season, table_payload)
                    except Exception as exc:
                        if re.search(r"HTTP\s+(?:408|425|429|500|502|503|504)", str(exc), re.IGNORECASE):
                            stopped_for_time = True
                            LOG.warning("%s/%s tablo isteği ertelendi; sonraki çalışma deneyecek: %s",
                                        competition_id, api_season, str(exc)[:500])
                            break
                        LOG.warning("%s/%s tablosu alınamadı; kadro verisi korunuyor: %s",
                                    competition_id, api_season, str(exc)[:500])
            else:
                LOG.warning("%s/%s kısmi: %s/%s kulüp.",
                            competition_id, api_season, len(all_club_ids & completed), len(all_club_ids))

        if stopped_for_time:
            break

    if failed_clubs:
        raise RuntimeError(
            f"Kadro senkronizasyonu kısmi kaldı: {total_players} oyuncu yazıldı; "
            f"{len(failed_clubs)} kulüp tamamlanamadı: " + ", ".join(failed_clubs[:20])
        )
    if stopped_for_time:
        if dispatch_squad_continuation():
            LOG.info("Sonraki çalışma checkpoint'ten devam edecek.")
        else:
            LOG.error("Checkpoint kaydedildi ancak otomatik devam başlatılamadı.")
    LOG.info("Kadro aktarımı bu çalışmada %s oyuncu UPSERT etti.", total_players)
    return total_players


def logged_run(force: bool = False) -> int:
    run = None
    started = time.monotonic()
    try:
        run = db_insert("tm_sync_runs", {
            "source": "felipeall",
            "mode": "sync-squads-and-clubs",
            "status": "running",
        })
    except Exception as exc:
        LOG.warning("Çalışma kaydı açılamadı; kadro senkronizasyonu yine de denenecek: %s", exc)

    run_id = run.get("id") if isinstance(run, dict) else None
    try:
        count = sync_squads_and_clubs(force=force)
        if run_id:
            db_patch(f"tm_sync_runs?id=eq.{quote(str(run_id), safe='')}", {
                "status": "succeeded",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "message": f"Tamamlandı; UPSERT edilen oyuncu: {count}",
                "details": {"processed_count": count, "duration_seconds": round(time.monotonic() - started, 2)},
            })
        return count
    except Exception as exc:
        if run_id:
            try:
                db_patch(f"tm_sync_runs?id=eq.{quote(str(run_id), safe='')}", {
                    "status": "failed",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error_count": 1,
                    "message": str(exc)[:1500],
                    "details": {"duration_seconds": round(time.monotonic() - started, 2)},
                })
            except Exception:
                pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Bugünkü kulüp checkpoint'lerini yok say.")
    args = parser.parse_args()
    require_config()
    logged_run(force=args.force)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        LOG.exception("Kadro senkronizasyonu güvenli şekilde durdu: %s", exc)
        raise SystemExit(1)

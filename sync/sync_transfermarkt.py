#!/usr/bin/env python3
"""SkorHane Transfermarkt sync runner.

Modes:
  sync         Current squads + felipeall player detail refresh (scheduled).
  seed-history One-time dcaribou historical seed for selected first-tier competitions.

All provider requests are sequential. No web/mobile request invokes this file.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

LOG = logging.getLogger("skorhane.transfermarkt")
LOG.setLevel(logging.INFO)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
LOG.addHandler(_handler)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FELIPE_API_BASE = os.getenv("FELIPE_API_BASE", "https://transfermarkt-api.fly.dev").rstrip("/")
APIFY_TOKEN = os.getenv("APIFY_TOKEN", "")
APIFY_ACTOR = os.getenv("APIFY_ACTOR", "kamerozkan~transfermarkt-scraper")
TM_LEAGUES = [x.strip() for x in os.getenv("TM_LEAGUES", "TR1").split(",") if x.strip()]
TM_SEASON = int(os.getenv("TM_SEASON", str(datetime.now(timezone.utc).year)))
DCARIBOU_COMPETITIONS = [x.strip().upper() for x in os.getenv("DCARIBOU_COMPETITIONS", "TR1,GB1,ES1,L1,IT1,FR1").split(",") if x.strip()]
DCARIBOU_SEASONS = sorted({int(x.strip()) for x in os.getenv("DCARIBOU_SEASONS", "2022,2023,2024,2025").split(",") if x.strip().isdigit()})
HTTP_TIMEOUT = int(os.getenv("HTTP_TIMEOUT_SECONDS", "30"))
MAX_RETRIES = int(os.getenv("HTTP_MAX_RETRIES", "4"))
DELAY_MIN = float(os.getenv("REQUEST_DELAY_MIN_SECONDS", "1.5"))
DELAY_MAX = float(os.getenv("REQUEST_DELAY_MAX_SECONDS", "3.5"))
FELIPE_DELAY_MIN = float(os.getenv("FELIPE_DELAY_MIN_SECONDS", "3.1"))
FELIPE_DELAY_MAX = float(os.getenv("FELIPE_DELAY_MAX_SECONDS", "4.0"))
TM_MAX_PLAYERS_PER_RUN = int(os.getenv("TM_MAX_PLAYERS_PER_RUN", "80"))
TM_MAX_MATCH_PAGES = int(os.getenv("TM_MAX_MATCH_PAGES", "5"))


def require_db() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY GitHub Secrets içinde tanımlanmalı.")


def delay() -> None:
    time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))


def safe_url_for_log(url: str) -> str:
    """Redact query-string credentials before writing URLs to CI logs."""
    return re.sub(r"([?&](?:token|api_key|apikey)=)[^&]+", r"\1[REDACTED]", url, flags=re.IGNORECASE)


def safe_error_for_log(error: Any) -> str:
    message = str(error)
    if APIFY_TOKEN:
        message = message.replace(APIFY_TOKEN, "[REDACTED]")
    return message[:1500]


def json_request(url: str, *, method: str = "GET", payload: Any = None,
                 headers: dict[str, str] | None = None, retries: int = MAX_RETRIES,
                 source: str = "external", delay_range: tuple[float, float] | None = None) -> Any:
    """One-at-a-time HTTP with jitter, timeout and bounded backoff.

    403/429/5xx/timeouts are logged and retried with a growing wait. A request that
    remains blocked is returned as an exception to the caller; the current player
    is skipped and the next player continues. No null payload is written.
    """
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    base_headers = {"Accept": "application/json", "User-Agent": "SkorHaneDataSync/1.0"}
    if body is not None:
        base_headers["Content-Type"] = "application/json"
    base_headers.update(headers or {})
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        lo, hi = delay_range or (DELAY_MIN, DELAY_MAX)
        time.sleep(random.uniform(lo, hi))
        try:
            req = Request(url, data=body, headers=base_headers, method=method)
            with urlopen(req, timeout=HTTP_TIMEOUT) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except HTTPError as exc:
            last_error = exc
            code = exc.code
            LOG.warning("%s HTTP %s (%s), deneme %s/%s", source, code, safe_url_for_log(url), attempt + 1, retries + 1)
            if code not in (403, 408, 425, 429, 500, 502, 503, 504):
                break
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            wait = float(retry_after) if retry_after and retry_after.isdigit() else min(300, 15 * (2 ** attempt))
            time.sleep(wait + random.uniform(1.5, 3.5))
        except (TimeoutError, URLError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            LOG.warning("%s timeout/bağlantı/JSON hatası (%s), deneme %s/%s", source, safe_error_for_log(exc), attempt + 1, retries + 1)
            time.sleep(min(180, 10 * (2 ** attempt)) + random.uniform(1.5, 3.5))
    raise RuntimeError(f"{source} isteği başarısız: {safe_error_for_log(last_error)}")


def db_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def rpc(name: str, payload: dict[str, Any]) -> Any:
    url = f"{SUPABASE_URL}/rest/v1/rpc/{name}"
    req = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                  headers=db_headers(), method="POST")
    with urlopen(req, timeout=HTTP_TIMEOUT) as response:
        raw = response.read()
        return json.loads(raw.decode("utf-8")) if raw else None


def db_get(path: str) -> Any:
    req = Request(f"{SUPABASE_URL}/rest/v1/{path}", headers=db_headers())
    with urlopen(req, timeout=HTTP_TIMEOUT) as response:
        raw = response.read()
        return json.loads(raw.decode("utf-8")) if raw else []

def db_patch(path: str, payload: dict[str, Any]) -> None:
    req = Request(f"{SUPABASE_URL}/rest/v1/{path}", data=json.dumps(payload).encode("utf-8"),
                  headers={**db_headers(), "Prefer": "return=minimal"}, method="PATCH")
    with urlopen(req, timeout=HTTP_TIMEOUT) as response:
        response.read()

def db_insert(path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    req = Request(f"{SUPABASE_URL}/rest/v1/{path}", data=json.dumps(payload).encode("utf-8"),
                  headers={**db_headers(), "Prefer": "return=representation"}, method="POST")
    with urlopen(req, timeout=HTTP_TIMEOUT) as response:
        raw = response.read()
        rows = json.loads(raw.decode("utf-8")) if raw else []
        return rows[0] if isinstance(rows, list) and rows else None


def logged_run(source: str, mode: str, action) -> int:
    run_id = None
    try:
        record = db_insert("tm_sync_runs", {"source": source, "mode": mode, "status": "running"})
        run_id = record.get("id") if record else None
    except Exception as exc:
        LOG.warning("%s çalışma kaydı DB'ye açılamadı: %s", source, exc)
    started = time.monotonic()
    try:
        count = int(action() or 0)
        if run_id:
            db_patch(f"tm_sync_runs?id=eq.{run_id}", {
                "status": "succeeded", "finished_at": datetime.now(timezone.utc).isoformat(),
                "message": f"Tamamlandı; işlenen kayıt: {count}",
                "details": {"processed_count": count, "duration_seconds": round(time.monotonic() - started, 2)},
            })
        return count
    except Exception as exc:
        if run_id:
            try:
                db_patch(f"tm_sync_runs?id=eq.{run_id}", {
                    "status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error_count": 1, "message": str(exc)[:1500],
                    "details": {"duration_seconds": round(time.monotonic() - started, 2)},
                })
            except Exception:
                pass
        raise


def is_empty_payload(value: Any) -> bool:
    return value is None or value == {} or value == [] or value == ""


def api_payload_rows(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    rows = iterable_from(payload, keys)
    if rows:
        return rows
    if isinstance(payload, dict):
        # Some response models wrap a single object rather than a list.
        for key in ("player", "profile", "data", "result"):
            item = payload.get(key)
            if isinstance(item, dict) and any(k in item for k in ("name", "id", "playerId", "minutesPlayed")):
                return [item]
    return []


def normalize_date(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    # ISO date/timestamp: PostgreSQL date accepts the first ten characters.
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return raw[:10]
    for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def source_record(source: str, record_type: str, external_id: str, record_key: str, payload: dict[str, Any]) -> None:
    if not payload:
        return
    rpc("tm_upsert_source_record", {
        "p_source": source,
        "p_record_type": record_type,
        "p_external_id": str(external_id or ""),
        "p_record_key": str(record_key or ""),
        "p_payload": payload,
    })


def safe_text(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        if isinstance(value, dict):
            value = value.get("name") or value.get("displayName") or value.get("value")
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def player_id_from_row(row: dict[str, Any]) -> str | None:
    candidate = safe_text(row.get("playerId"), row.get("player_id"), row.get("id"), row.get("tm_id"))
    if candidate and re.fullmatch(r"\d+", candidate):
        return candidate
    link = safe_text(row.get("profileUrl"), row.get("playerUrl"), row.get("url"), row.get("href")) or ""
    match = re.search(r"/spieler/(\d+)", link)
    return match.group(1) if match else None


def upsert_player(tm_id: str, source: str, row: dict[str, Any]) -> None:
    profile = row.get("profile_payload") if isinstance(row.get("profile_payload"), dict) else {}
    player = {
        "name": safe_text(row.get("name"), row.get("player_name"), row.get("playerName"), profile.get("name")),
        "team_name": safe_text(row.get("team_name"), row.get("clubName"), row.get("club"), row.get("team")),
        "position": safe_text(row.get("position"), row.get("pos")),
        "photo_url": safe_text(row.get("photo_url"), row.get("imageUrl"), row.get("image"), row.get("photo")),
        "profile_payload": profile or row.get("payload") or {},
    }
    # is_active is intentionally omitted for sources that cannot authoritatively
    # describe current squad membership (e.g. historical dcaribou records).
    if "is_active" in row:
        player["is_active"] = bool(row["is_active"])
    for field in ("current_market_value_eur", "current_market_value_text", "current_market_value_date", "current_market_value_observed_at"):
        if row.get(field) not in (None, ""):
            player[field] = row[field]
    for field in ("stats_payload", "current_season_payload", "transfers_payload", "market_value_payload",
                  "injuries_payload", "absences_payload", "national_career_payload"):
        value = row.get(field)
        if not is_empty_payload(value):
            player[field] = value
    rpc("tm_upsert_player", {"p_tm_id": str(tm_id), "p_source": source, "p_player": player})


def sync_kamerozkan(*, required: bool = False) -> int:
    """Scheduled roster/value source. Actor uses TR1 by default; token is user-supplied."""
    if not APIFY_TOKEN:
        if required:
            raise RuntimeError("APIFY_TOKEN tanımlı değil. kamerozkan kadro içe aktarımı için Apify token gerekli.")
        LOG.warning("APIFY_TOKEN yok; kamerozkan kaynağı bu çalıştırmada atlandı.")
        return 0
     body = {
        "leagues": TM_LEAGUES,
        "season": TM_SEASON,
        "trackChanges": True,
        "proxyConfiguration": {
            "useApifyProxy": True,
            "apifyProxyGroups": ["RESIDENTIAL"],
            "apifyProxyCountry": "TR",
        },
    }
    run = json_request(
        f"https://api.apify.com/v2/acts/{APIFY_ACTOR}/runs?token={quote(APIFY_TOKEN)}",
        method="POST", payload=body, source="kamerozkan/Apify", retries=0,
    )
    run_id = ((run or {}).get("data") or {}).get("id")
    if not run_id:
        raise RuntimeError("Apify actor başlatıldı ancak run ID alınamadı.")
    run_data = (run or {}).get("data") or {}
    state = run_data.get("status")
    # The run request returns immediately; poll status separately to avoid a long POST timeout.
    for _ in range(120):
        if state in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            break
        time.sleep(15)
        status = json_request(f"https://api.apify.com/v2/actor-runs/{run_id}?token={quote(APIFY_TOKEN)}", source="Apify run status")
        run_data = (status or {}).get("data") or {}
        state = run_data.get("status")
    if state != "SUCCEEDED":
        raise RuntimeError(f"Apify actor tamamlanmadı: {state or 'unknown'}")
    dataset_id = run_data.get("defaultDatasetId")
    if not dataset_id:
        raise RuntimeError("Apify çıktısı için defaultDatasetId bulunamadı.")
    items = json_request(f"https://api.apify.com/v2/datasets/{dataset_id}/items?token={quote(APIFY_TOKEN)}&clean=true&format=json&limit=10000", source="Apify dataset")
    if not isinstance(items, list):
        raise RuntimeError("Apify dataset yanıtı liste değil; mevcut DB verisi korunuyor.")
    valid_rows = [(row, player_id_from_row(row)) for row in items if isinstance(row, dict)]
    valid_rows = [(row, tm_id) for row, tm_id in valid_rows if tm_id]
    if not valid_rows:
        raise RuntimeError("Apify çıktısında geçerli oyuncu kimliği yok; mevcut DB verisi korunuyor.")
    count = 0
    for row, tm_id in valid_rows:
        normalized = {
            "name": safe_text(row.get("name"), row.get("playerName")),
            "team_name": safe_text(row.get("club"), row.get("clubName"), row.get("team")),
            "position": safe_text(row.get("position")),
            "photo_url": safe_text(row.get("imageUrl"), row.get("photo"), row.get("image")),
            "profile_payload": row,
            "is_active": True,
            "current_market_value_eur": row.get("marketValueEur") if isinstance(row.get("marketValueEur"), (int, float)) else parse_money_eur(row.get("marketValue")),
            "current_market_value_text": safe_text(row.get("marketValue")),
            # checkedAt is only the time we observed the current value, not an
            # official valuation date. Keep those concepts separate.
            "current_market_value_date": normalize_date(row.get("marketValueDate")),
            "current_market_value_observed_at": safe_text(row.get("checkedAt")) or datetime.now(timezone.utc).isoformat(),
        }
        upsert_player(tm_id, "kamerozkan", normalized)
        source_record("kamerozkan", "player_squad", tm_id, str(row.get("clubId") or row.get("clubName") or ""), row)
        # Only add a historical valuation point when the source supplied an
        # actual valuation date. A checkedAt timestamp updates the current
        # observation, but must not masquerade as a Transfermarkt valuation.
        market_date = normalized.get("current_market_value_date")
        market_eur = normalized.get("current_market_value_eur")
        market_text = normalized.get("current_market_value_text")
        if market_date and (market_eur is not None or market_text):
            rpc("tm_upsert_market_value", {"p_row": {
                "tm_id": tm_id, "valuation_date": market_date, "value_eur": market_eur,
                "display_value": market_text, "club_name": normalized.get("team_name"),
                "payload": row, "source": "kamerozkan",
            }})
        joined = normalize_date(row.get("joinedDate"))
        from_club = safe_text(row.get("signedFrom"))
        to_club = safe_text(row.get("clubName"), row.get("club"))
        if joined and from_club and to_club:
            rpc("tm_upsert_transfer", {"p_row": {
                "tm_id": tm_id, "transfer_date": joined, "from_club": from_club, "to_club": to_club,
                "transfer_type": "transfer", "fee_text": safe_text(row.get("transferFee")),
                "fee_eur": parse_money_eur(row.get("transferFee")), "payload": row, "source": "kamerozkan",
            }})
        count += 1
    LOG.info("kamerozkan tamamlandı: %s oyuncu kaydı", count)
    return count


def value_from(obj: Any, keys: tuple[str, ...]) -> Any:
    if isinstance(obj, dict):
        for key in keys:
            if obj.get(key) is not None and obj.get(key) != "":
                return obj.get(key)
    return None


def iterable_from(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
            if isinstance(value, dict):
                for nested in ("items", "data", "stats", "transfers", "history", "marketValues", "valuations", "matches", "results", "appearances"):
                    if isinstance(value.get(nested), list):
                        return [x for x in value[nested] if isinstance(x, dict)]
    return []


def numeric(row: dict[str, Any], *keys: str) -> int | None:
    value = value_from(row, tuple(keys))
    if value is None:
        return None
    try:
        if isinstance(value, str):
            value = value.replace(",", "").strip()
        return int(float(value))
    except (TypeError, ValueError):
        return None

def parse_money_eur(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        return None
    raw = value.strip().lower().replace("€", "").replace("eur", "").replace(",", ".").replace(" ", "")
    match = re.search(r"(\d+(?:\.\d+)?)([kmb])?", raw)
    if not match:
        return None
    amount = float(match.group(1))
    suffix = match.group(2)
    multiplier = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(suffix, 1)
    return int(amount * multiplier)


def build_current_season_stats(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for match in matches:
        competition_obj = match.get("competition") or match.get("league") or {}
        club_obj = match.get("club") or match.get("team") or match.get("playerTeam") or {}
        competition = safe_text(match.get("competitionName"), match.get("competition_name"),
                                 competition_obj if isinstance(competition_obj, str) else competition_obj)
        club = safe_text(match.get("clubName"), match.get("teamName"), match.get("playerClubName"),
                         club_obj if isinstance(club_obj, str) else club_obj)
        if not competition and isinstance(competition_obj, dict):
            competition = safe_text(competition_obj.get("name"), competition_obj.get("displayName"))
        if not club and isinstance(club_obj, dict):
            club = safe_text(club_obj.get("name"), club_obj.get("displayName"))
        competition = competition or "Diğer"
        club = club or "Bilinmeyen takım"
        key = (competition, club)
        aggregate = groups.setdefault(key, {
            "seasonID": str(TM_SEASON), "competitionName": competition, "clubName": club,
            "appearances": 0, "starts": 0, "goals": 0, "assists": 0, "minutes": 0,
            "yellowCards": 0, "secondYellowCards": 0, "redCards": 0,
        })
        status = safe_text(match.get("playerStatus"), match.get("status"), match.get("participation")) or ""
        minutes = numeric(match, "minutesPlayed", "minutes", "playedMinutes")
        played = minutes is not None and minutes > 0
        if not played:
            played = status.lower() in ("played", "starting_xi", "starting xi", "substitute", "substituted")
        if played:
            aggregate["appearances"] += 1
        started = match.get("isStartingEleven") is True or match.get("started") is True or match.get("startingXI") is True
        if started:
            aggregate["starts"] += 1
        aggregate["goals"] += numeric(match, "goals", "playerGoals") or 0
        aggregate["assists"] += numeric(match, "assists", "playerAssists") or 0
        aggregate["minutes"] += minutes or 0
        aggregate["yellowCards"] += numeric(match, "yellowCards", "yellow", "bookingsYellow") or 0
        aggregate["secondYellowCards"] += numeric(match, "secondYellowCards") or 0
        aggregate["redCards"] += numeric(match, "redCards", "red") or 0
    return [v for v in groups.values() if v["appearances"] or v["goals"] or v["minutes"]]


def get_player_current_matches(base: str, tm_id: str) -> list[dict[str, Any]]:
    all_rows: list[dict[str, Any]] = []
    for page in range(1, TM_MAX_MATCH_PAGES + 1):
        try:
            payload = json_request(
                f"{base}/matches?season_id={quote(str(TM_SEASON))}&page_number={page}",
                source="felipeall current-season matches",
                delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
            )
        except Exception as exc:
            LOG.warning("felipeall %s aktif sezon maçları sayfa %s alınamadı: %s", tm_id, page, exc)
            break
        rows = api_payload_rows(payload, ("matches", "data", "items", "results"))
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < 50:
            break
    return all_rows


def sync_felipeall(only_player: str | None = None) -> int:
    """Refresh player profile and active-season matches only.

    Historical match appearances are seeded separately by dcaribou. Current
    transfers and market-value observations come from kamerozkan. Rotation is
    based on last_synced_at and excludes squads not reconfirmed within 14 days.
    """
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    if only_player:
        query = f"tm_players?select={select}&tm_id=eq.{quote(only_player)}&limit=1"
    else:
        squad_cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        # Do not order by last_synced_at: kamerozkan touches every current-squad
        # record on each run. A dedicated cursor ensures felipeall rotates players.
        query = f"tm_players?select={select}&is_active=eq.true&last_squad_seen_at=gte.{quote(squad_cutoff)}&order=last_felipe_synced_at.asc.nullsfirst&limit={TM_MAX_PLAYERS_PER_RUN}"
    players = db_get(query)
    if not isinstance(players, list):
        raise RuntimeError("DB oyuncu listesi okunamadı.")
    successful = 0
    for idx, player in enumerate(players, 1):
        tm_id = str(player.get("tm_id") or "").strip()
        if not tm_id:
            continue
        base = f"{FELIPE_API_BASE}/players/{quote(tm_id)}"
        payloads: dict[str, Any] = {}
        # Current profile refresh on each rotation.
        for kind, endpoint in (("profile", "/profile"),):
            try:
                value = json_request(base + endpoint, source=f"felipeall {kind}",
                                     delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX))
                if isinstance(value, (dict, list)) and value:
                    payloads[kind] = value
            except Exception as exc:
                LOG.warning("felipeall %s %s: %s; mevcut profil korunuyor.", tm_id, kind, exc)
        # This scheduled worker intentionally does not call historical stats,
        # transfer-history, injury-history or valuation-history endpoints.
        # Legacy/history backfill is the one-off dcaribou seed; current transfer
        # and market-value observations come from kamerozkan.
        # Only current season is checked on recurring runs. Endpoint returns 50/page.
        matches = get_player_current_matches(base, tm_id)
        current_stats = build_current_season_stats(matches)
        current_payload = {
            "season_id": str(TM_SEASON),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "matches": matches,
            "stats": current_stats,
        } if matches else {}
        profile = payloads.get("profile") or {}
        if isinstance(profile, dict):
            b = profile.get("player") or profile.get("data") or profile.get("profile") or profile
            name = safe_text(b.get("name"), b.get("playerName"), player.get("name")) if isinstance(b, dict) else player.get("name")
            club_obj = b.get("club") or {} if isinstance(b, dict) else {}
            team = safe_text(club_obj, b.get("team") if isinstance(b, dict) else None, player.get("team_name"))
            pos_obj = b.get("position") or {} if isinstance(b, dict) else {}
            pos = safe_text(pos_obj, player.get("position"))
            photo = safe_text(b.get("imageUrl"), b.get("photo"), b.get("image"), player.get("photo_url")) if isinstance(b, dict) else player.get("photo_url")
        else:
            name, team, pos, photo = player.get("name"), player.get("team_name"), player.get("position"), player.get("photo_url")
        normalized = {"team_name": team, "position": pos, "photo_url": photo}
        if name and name != tm_id:
            normalized["name"] = name
        if "profile" in payloads:
            normalized["profile_payload"] = payloads["profile"]
        if current_payload:
            normalized["current_season_payload"] = current_payload
        if normalized.get("name") or normalized.get("profile_payload") or current_payload:
            upsert_player(tm_id, "felipeall", normalized)
            if isinstance(profile, dict) and profile:
                source_record("felipeall", "player_profile", tm_id, "", profile)
        # Current-season totals only. Historical seasons are seeded separately.
        stat_batches: list[dict[str, Any]] = list(current_stats)
        seen_stats: set[tuple[str, str, str]] = set()
        for row in stat_batches:
            season = safe_text(row.get("seasonID"), row.get("seasonId"), row.get("season"), row.get("seasonName")) or ""
            competition = safe_text(row.get("competitionName"), row.get("competition"), row.get("competitionID")) or ""
            club = safe_text(row.get("clubName"), row.get("teamName"), row.get("club"), row.get("team")) or ""
            if not season:
                continue
            stat_key = (str(season), competition, club)
            if stat_key in seen_stats:
                continue
            seen_stats.add(stat_key)
            rpc("tm_upsert_season_stat", {"p_row": {
                "tm_id": tm_id, "season_id": str(season), "competition_name": competition, "club_name": club,
                "appearances": numeric(row, "appearances", "apps", "matches"),
                "starts": numeric(row, "starts", "gamesStarted", "appearancesAsStarter"),
                "goals": numeric(row, "goals"), "assists": numeric(row, "assists"),
                "minutes": numeric(row, "minutes", "minutesPlayed"),
                "yellow_cards": numeric(row, "yellowCards", "yellow"),
                "second_yellow_cards": numeric(row, "secondYellowCards"),
                "red_cards": numeric(row, "redCards", "red"), "payload": row, "source": "felipeall",
            }})
        if current_payload:
            source_record("felipeall", "current_season_matches", tm_id, str(TM_SEASON), current_payload)
        # Persist rotation progress independently from the all-source last_synced_at.
        db_patch(f"tm_players?tm_id=eq.{quote(tm_id)}", {
            "last_felipe_synced_at": datetime.now(timezone.utc).isoformat()
        })
        successful += 1
        if idx % 10 == 0:
            LOG.info("felipeall ilerleme: %s/%s oyuncu", idx, len(players))
    LOG.info("felipeall tamamlandı: %s oyuncu işlendi", successful)
    return successful


def patch_dcaribou_rate_limit() -> None:
    """Patch dcaribou's shared crawler factory after install: concurrency 1 + jitter hook.

    The public scraper creates all ParselCrawler instances via tfmkt.common.create_crawler.
    We patch only that local installed copy for this one-off seed job using Crawlee's
    documented ConcurrencySettings API, with a hard cap of one task and 18/minute.
    """
    import tfmkt.common as common  # type: ignore
    path = Path(common.__file__)
    source = path.read_text(encoding="utf-8")
    if "_skorhane_polite_delay" in source:
        return
    missing_imports = []
    if not re.search(r"(?m)^import asyncio(?:\s|$)", source):
        missing_imports.append("import asyncio")
    if not re.search(r"(?m)^import random(?:\s|$)", source):
        missing_imports.append("import random")
    if "ConcurrencySettings" not in source:
        missing_imports.append("from crawlee import ConcurrencySettings")
    if missing_imports:
        future = re.search(r"(?m)^from __future__ import [^\n]+\n", source)
        at = future.end() if future else 0
        source = source[:at] + "\n".join(missing_imports) + "\n" + source[at:]
    pattern = r"(?m)^(\s*)crawler\s*=\s*ParselCrawler\(\s*\)\s*$"
    replacement = (
        r"\1crawler = ParselCrawler(concurrency_settings=ConcurrencySettings(min_concurrency=1, max_concurrency=1, desired_concurrency=1, max_tasks_per_minute=18))\n"
        r"\1@crawler.pre_navigation_hook\n"
        r"\1async def _skorhane_polite_delay(context):\n"
        r"\1    await asyncio.sleep(random.uniform(1.5, 3.5))\n"
    )
    patched, count = re.subn(pattern, replacement, source, count=1)
    if count != 1:
        raise RuntimeError("dcaribou create_crawler() güvenli hız sınırı yaması uygulanamadı; tarama başlatılmadı.")
    path.write_text(patched, encoding="utf-8")
    LOG.info("dcaribou crawler güvenli ayarlandı: concurrency=1, max 18 istek/dk, jitter 1.5–3.5 sn")


def run_dcaribou_crawler(name: str, parents: list[dict[str, Any]] | None = None,
                         extra_args: list[str] | None = None) -> tuple[list[dict[str, Any]], bool]:
    """Run one dcaribou stage and preserve partial JSON output on interruption."""
    command = [sys.executable, "-m", "tfmkt", name, *(extra_args or [])]
    stdin = "" if parents is None else "\n".join(json.dumps(x, ensure_ascii=False) for x in parents) + "\n"
    success = False
    stdout = ""
    stderr = ""
    try:
        proc = subprocess.run(command, input=stdin, text=True, capture_output=True, timeout=4 * 60 * 60)
        stdout, stderr = proc.stdout or "", proc.stderr or ""
        success = proc.returncode == 0
        if not success:
            LOG.error("dcaribou %s eksik/hatayla tamamlandı (kod %s); bulunan kısmi kayıtlar korunacak.", name, proc.returncode)
    except subprocess.TimeoutExpired as exc:
        raw_out = exc.stdout or ""
        raw_err = exc.stderr or ""
        stdout = raw_out.decode("utf-8", errors="replace") if isinstance(raw_out, bytes) else raw_out
        stderr = raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else raw_err
        LOG.error("dcaribou %s 4 saatlik aşama sınırına ulaştı; kısmi çıktı kaydedilecek ve checkpoint tamamlandı sayılmayacak.", name)
    records: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                records.append(value)
        except json.JSONDecodeError:
            LOG.warning("dcaribou %s JSON dışı stdout satırı atlandı.", name)
    if stderr.strip():
        LOG.warning("dcaribou %s: %s", name, stderr.strip()[-1600:])
    return records, success

def competition_codes(item: dict[str, Any]) -> set[str]:
    text = " ".join(str(item.get(k) or "") for k in ("href", "competition_id", "id", "code", "competition_name"))
    return set(re.findall(r"(?<![A-Z0-9])[A-Z]{1,5}\d{1,2}(?![A-Z0-9])", text.upper()))


def seed_checkpoint_payload(record_key: str) -> dict[str, Any]:
    rows = db_get(
        "tm_source_records?select=payload&source=eq.dcaribou&record_type=eq.seed_checkpoint"
        f"&record_key=eq.{quote(record_key)}&limit=1"
    )
    return rows[0].get("payload") if rows and isinstance(rows[0].get("payload"), dict) else {}


def seed_checkpoint_done(record_key: str) -> bool:
    return seed_checkpoint_payload(record_key).get("status") == "completed"


def mark_seed_checkpoint(record_key: str, details: dict[str, Any]) -> None:
    source_record("dcaribou", "seed_checkpoint", "", record_key,
                  {"status": "completed", "completed_at": datetime.now(timezone.utc).isoformat(), **details})


def persist_dcaribou_player(row: dict[str, Any], tm_id: str, record_key: str) -> None:
    profile_row = {
        "name": safe_text(row.get("name"), row.get("player_name")),
        "team_name": safe_text(row.get("club_name"), row.get("club"), row.get("team")),
        "position": safe_text(row.get("position")),
        "photo_url": safe_text(row.get("image_url"), row.get("image"), row.get("photo")),
        "profile_payload": row,
    }
    # Historical records never set is_active=true; only the current squad actor can.
    upsert_player(tm_id, "dcaribou", profile_row)
    source_record("dcaribou", "player", tm_id, record_key, row)
    for key in ("market_value_history", "marketValueHistory", "market_values", "marketValues", "valuations"):
        values = row.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict):
                continue
            vdate = normalize_date(value.get("date") or value.get("valuation_date") or value.get("valuationDate"))
            if not vdate:
                continue
            amount = value.get("value_eur") or value.get("valueEur") or value.get("value")
            if isinstance(amount, str):
                amount = parse_money_eur(amount)
            rpc("tm_upsert_market_value", {"p_row": {
                "tm_id": tm_id, "valuation_date": vdate,
                "value_eur": amount if isinstance(amount, (int, float)) else None,
                "display_value": safe_text(value.get("display_value"), value.get("valueFormatted"), value.get("value")),
                "club_name": safe_text(value.get("club_name"), value.get("club")),
                "payload": value, "source": "dcaribou",
            }})
        break


def persist_dcaribou_appearances(appearances: list[dict[str, Any]]) -> int:
    saved = 0
    for row in appearances:
        player_id = safe_text(row.get("player_id"), row.get("playerId"), row.get("tm_id"))
        if not player_id:
            LOG.warning("dcaribou appearance oyuncu ID'si olmadan geldi; kayıt atlandı.")
            continue
        game_id = safe_text(row.get("game_id"), row.get("gameId"), row.get("match_id")) or ""
        key = safe_text(row.get("appearance_id")) or f"{player_id or 'x'}:{game_id}:{row.get('date','')}"
        if key == f"{player_id or 'x'}:{game_id}:{row.get('date','')}" and not game_id:
            key = safe_text(row.get("id")) or key
        source_record("dcaribou", "appearance", player_id or "", key, row)
        rpc("tm_upsert_appearance", {"p_row": {
            "source": "dcaribou", "source_record_key": str(key), "tm_id": player_id,
            "game_id": game_id, "played_at": normalize_date(row.get("date")),
            "competition_name": safe_text(row.get("competition_name"), row.get("competition")),
            "club_name": safe_text(row.get("player_club_name"), row.get("club_name"), row.get("club")),
            "opponent_name": safe_text(row.get("opponent_name"), row.get("opponent")),
            "appearances": row.get("appearances", 1), "starts": row.get("starts"),
            "minutes": row.get("minutes_played", row.get("minutes")), "goals": row.get("goals"),
            "assists": row.get("assists"), "yellow_cards": row.get("yellow_cards"),
            "red_cards": row.get("red_cards"), "payload": row,
        }})
        saved += 1
    return saved


def seed_dcaribou_history() -> int:
    """One-off historical seed with checkpoints; completed seasons are not crawled again."""
    try:
        import tfmkt  # type: ignore  # noqa: F401
    except Exception as exc:
        raise RuntimeError("Önce dcaribou/transfermarkt-scraper kurulmalı: pip install git+https://github.com/dcaribou/transfermarkt-scraper.git") from exc
    patch_dcaribou_rate_limit()
    confederations, conf_ok = run_dcaribou_crawler("confederations")
    if not conf_ok or not confederations:
        raise RuntimeError("dcaribou konfederasyon listesi güvenilir şekilde alınamadı; seed durduruldu.")
    competitions, competitions_ok = run_dcaribou_crawler("competitions", confederations)
    if not competitions_ok:
        raise RuntimeError("dcaribou yarışma kataloğu eksik geldi; checkpoint yazılmadı.")
    selected: list[tuple[str, dict[str, Any]]] = []
    for competition in competitions:
        if competition.get("competition_type") != "first_tier":
            continue
        for code in sorted(competition_codes(competition) & set(DCARIBOU_COMPETITIONS)):
            selected.append((code, competition))
    # One competition may carry multiple identifiers in a malformed response; dedupe it.
    selected = list({(code, safe_text(comp.get("href"), comp.get("competition_name")) or code): (code, comp)
                     for code, comp in selected}.values())
    if not selected:
        raise RuntimeError(f"dcaribou hedef ligleri bulunamadı: {','.join(DCARIBOU_COMPETITIONS)}. Hiçbir veri üzerine yazılmadı.")
    seasons = DCARIBOU_SEASONS or [TM_SEASON - 1]
    total_profiles = 0
    LOG.info("dcaribou tarihsel seed: ligler=%s sezonlar=%s",
             ", ".join(code for code, _ in selected), ",".join(map(str, seasons)))

    all_players: dict[str, dict[str, Any]] = {}
    for code, competition in selected:
        for season in seasons:
            clubs_key = f"clubs:{code}:{season}"
            clubs: list[dict[str, Any]] = []
            if seed_checkpoint_done(clubs_key):
                saved_clubs = db_get(
                    "tm_source_records?select=payload&source=eq.dcaribou&record_type=eq.seed_clubs"
                    f"&record_key=eq.{quote(clubs_key)}&limit=1"
                )
                if saved_clubs and isinstance(saved_clubs[0].get("payload"), dict):
                    candidate = saved_clubs[0]["payload"].get("clubs")
                    clubs = candidate if isinstance(candidate, list) else []
            else:
                LOG.info("dcaribou %s / %s kulüp listesi alınıyor", code, season)
                clubs, clubs_ok = run_dcaribou_crawler("clubs", [competition], ["--season", str(season)])
                if clubs_ok and clubs:
                    source_record("dcaribou", "seed_clubs", "", clubs_key, {"clubs": clubs})
                    mark_seed_checkpoint(clubs_key, {"competition": code, "season": season, "clubs": len(clubs)})
                else:
                    LOG.warning("dcaribou %s / %s kulüp listesi eksik/boş; sonraki çalıştırmada yeniden denenecek.", code, season)
                    continue

            # Crawl one club at a time. A completed club is checkpointed and will
            # not be scraped again if a later club in the season fails.
            for club_index, club in enumerate(clubs, 1):
                href = safe_text(club.get("href"), club.get("url"), club.get("clubUrl")) or ""
                club_id = safe_text(club.get("club_id"), club.get("clubId"), club.get("id"))
                if not club_id and href:
                    match = re.search(r"/(?:verein|club)/(\d+)", href)
                    club_id = match.group(1) if match else None
                if not club_id:
                    club_name = safe_text(club.get("club_name"), club.get("name"), club.get("clubName")) or f"club-{club_index}"
                    club_id = re.sub(r"[^A-Za-z0-9_-]+", "_", club_name).strip("_") or str(club_index)
                player_ck = f"players:{code}:{season}:{club_id}"
                if not seed_checkpoint_done(player_ck):
                    players, players_ok = run_dcaribou_crawler("players", [club], ["--season", str(season)])
                    written = 0
                    for row in players:
                        tm_id = player_id_from_row(row)
                        if not tm_id:
                            continue
                        persist_dcaribou_player(row, tm_id, player_ck)
                        all_players[tm_id] = row
                        written += 1
                    if players_ok:
                        mark_seed_checkpoint(player_ck, {
                            "competition": code, "season": season, "club_id": club_id, "players": written
                        })
                        total_profiles += written
                    else:
                        LOG.warning("dcaribou %s / %s / %s kulübü yarım kaldı; kısmi kayıtlar UPSERT edildi.", code, season, club_id)
                # Rehydrate complete or partial player rows written by earlier runs.
                saved_rows = db_get(
                    "tm_source_records?select=payload,external_id&source=eq.dcaribou&record_type=eq.player"
                    f"&record_key=eq.{quote(player_ck)}&limit=10000"
                )
                for saved in saved_rows if isinstance(saved_rows, list) else []:
                    payload = saved.get("payload")
                    tm_id = safe_text(saved.get("external_id"))
                    if tm_id and isinstance(payload, dict):
                        all_players[tm_id] = payload

    if not all_players:
        raise RuntimeError("dcaribou tarihsel taramasından hiçbir oyuncu profili gelmedi.")

    player_ids = sorted(all_players)
    legacy_appearance_checkpoint = seed_checkpoint_payload("appearances:all")
    legacy_done = set(str(x) for x in legacy_appearance_checkpoint.get("players", []) if str(x).isdigit())
    checkpoint_rows = db_get(
        "tm_source_records?select=record_key&source=eq.dcaribou&record_type=eq.seed_checkpoint"
        "&record_key=like.appearances_player:*&limit=10000"
    )
    individually_done = {
        str(row.get("record_key", "")).split(":", 1)[1]
        for row in checkpoint_rows if str(row.get("record_key", "")).startswith("appearances_player:")
    } if isinstance(checkpoint_rows, list) else set()
    already_seeded = legacy_done | individually_done
    pending_ids = [player_id for player_id in player_ids if player_id not in already_seeded]
    total_appearance_rows = int(legacy_appearance_checkpoint.get("appearances", 0) or 0)
    # Bounded batches make the large historical seed resumable. Successful
    # player IDs get durable checkpoints; a failed batch alone is retried.
    batch_size = max(1, int(os.getenv("DCARIBOU_APPEARANCE_BATCH_SIZE", "25")))
    for offset in range(0, len(pending_ids), batch_size):
        batch_ids = pending_ids[offset:offset + batch_size]
        batch_profiles = [all_players[player_id] for player_id in batch_ids]
        LOG.info("dcaribou tarihsel maç performansı: %s–%s / %s oyuncu", offset + 1, offset + len(batch_ids), len(pending_ids))
        appearances, appearances_ok = run_dcaribou_crawler("appearances", batch_profiles)
        saved_appearances = persist_dcaribou_appearances(appearances)
        total_appearance_rows += saved_appearances
        if appearances_ok:
            for player_id in batch_ids:
                mark_seed_checkpoint(f"appearances_player:{player_id}", {"tm_id": player_id})
            LOG.info("dcaribou tarihsel maç batch'i tamamlandı: %s oyuncu", len(batch_ids))
        else:
            LOG.warning("dcaribou tarihsel maç batch'i tamamlanmadı; %s kısmi maç satırı UPSERT edildi. Bu batch sonraki çalıştırmada tekrar denenir.", saved_appearances)

    refreshed_checkpoints = db_get(
        "tm_source_records?select=record_key&source=eq.dcaribou&record_type=eq.seed_checkpoint"
        "&record_key=like.appearances_player:*&limit=10000"
    )
    final_done = legacy_done | {
        str(row.get("record_key", "")).split(":", 1)[1]
        for row in refreshed_checkpoints if str(row.get("record_key", "")).startswith("appearances_player:")
    } if isinstance(refreshed_checkpoints, list) else legacy_done
    if set(player_ids).issubset(final_done):
        mark_seed_checkpoint("appearances:all", {
            "players": player_ids, "appearances": total_appearance_rows,
        })
    else:
        LOG.warning("dcaribou historical appearances halen kısmi: %s/%s oyuncu tamamlandı.", len(set(player_ids) & final_done), len(player_ids))

    LOG.info("dcaribou seed çalışması tamamlandı/kısmi: %s yeni oyuncu profili işlendi, %s toplam tekil oyuncu biriktirildi.", total_profiles, len(all_players))
    return total_profiles

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("sync", "import-squads", "seed-history", "one-player-test"))
    parser.add_argument("--player-id", default=os.getenv("TM_TEST_PLAYER_ID", ""))
    args = parser.parse_args()
    require_db()
    if args.mode == "seed-history":
        logged_run("dcaribou", "seed-history", seed_dcaribou_history)
        return 0
    if args.mode == "import-squads":
        logged_run("kamerozkan", "import-squads", lambda: sync_kamerozkan(required=True))
        return 0
    if args.mode == "one-player-test":
        if not re.fullmatch(r"\d+", str(args.player_id or "")):
            raise RuntimeError("one-player-test için --player-id veya TM_TEST_PLAYER_ID olarak Transfermarkt oyuncu ID'si gerekli.")
        if not db_get(f"tm_players?select=tm_id&tm_id=eq.{quote(str(args.player_id))}&limit=1"):
            raise RuntimeError("Test oyuncusu önce kadro senkronizasyonuyla tm_players tablosuna eklenmeli.")
        logged_run("felipeall", "one-player-test", lambda: sync_felipeall(only_player=str(args.player_id)))
        return 0
    # Current-only workflow: no historical season loop.
    try:
        logged_run("kamerozkan", "sync", sync_kamerozkan)
    except Exception as exc:
        LOG.exception("kamerozkan kaynağı başarısız; önceki kayıtlar korunuyor: %s", exc)
    try:
        logged_run("felipeall", "sync", sync_felipeall)
    except Exception as exc:
        LOG.exception("felipeall kaynağı başarısız; önceki kayıtlar korunuyor: %s", exc)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        LOG.exception("Senkronizasyon görevi güvenli şekilde sonlandı: %s", exc)
        raise SystemExit(1)

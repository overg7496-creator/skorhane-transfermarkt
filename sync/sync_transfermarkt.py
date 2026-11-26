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
FELIPE_API_BASE = os.getenv("FELIPE_API_BASE", "http://127.0.0.1:8000").rstrip("/")
TM_LEAGUES = [x.strip() for x in os.getenv("TM_LEAGUES", "TR1").split(",") if x.strip()]
TM_SEASON = int(os.getenv("TM_SEASON", str(datetime.now(timezone.utc).year)))
DCARIBOU_COMPETITIONS = [x.strip().upper() for x in os.getenv("DCARIBOU_COMPETITIONS", "TR1,GB1,ES1,L1,IT1,FR1").split(",") if x.strip()]
DCARIBOU_SEASONS = sorted({int(x.strip()) for x in os.getenv("DCARIBOU_SEASONS", "2022,2023,2024,2025").split(",") if x.strip().isdigit()})
HTTP_TIMEOUT = int(os.getenv("HTTP_TIMEOUT_SECONDS", "30"))
MAX_RETRIES = int(os.getenv("HTTP_MAX_RETRIES", "4"))
DELAY_MIN = float(os.getenv("REQUEST_DELAY_MIN_SECONDS", "1.5"))
DELAY_MAX = float(os.getenv("REQUEST_DELAY_MAX_SECONDS", "3.5"))
FELIPE_DELAY_MIN = float(os.getenv("FELIPE_DELAY_MIN_SECONDS", "5.5"))
FELIPE_DELAY_MAX = float(os.getenv("FELIPE_DELAY_MAX_SECONDS", "7.0"))
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
    return message[:1500]


def json_request(url: str, *, method: str = "GET", payload: Any = None,
                 headers: dict[str, str] | None = None, retries: int = MAX_RETRIES,
                 source: str = "external", delay_range: tuple[float, float] | None = None) -> Any:
    """One-at-a-time HTTP with jitter, timeout and bounded backoff.

    Transient 403/429/5xx/timeouts are retried. If a required request still fails,
    the exception propagates and the current player remains pending for the next run.
    A player is never marked fully synced with a missing endpoint response.
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
                    LOG.warning("%s HTTP %s: boş yanıt (%s)", source, response.status, safe_url_for_log(url))
                    return None
                parsed = json.loads(raw.decode("utf-8"))
                LOG.info("%s HTTP %s başarılı (%s)", source, response.status, safe_url_for_log(url))
                return parsed
        except HTTPError as exc:
            code = exc.code
            error_body = exc.read().decode("utf-8", errors="replace").strip()
            detail = safe_error_for_log(error_body[:1000]) if error_body else ""
            last_error = RuntimeError(f"HTTP {code}: {detail}" if detail else f"HTTP {code}: {exc.reason}")
            LOG.warning(
                "%s HTTP %s (%s), deneme %s/%s%s",
                source, code, safe_url_for_log(url), attempt + 1, retries + 1,
                f", yanıt={detail}" if detail else "",
            )
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

def db_delete(path: str) -> None:
    req = Request(f"{SUPABASE_URL}/rest/v1/{path}", headers={**db_headers(), "Prefer": "return=minimal"}, method="DELETE")
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


def source_record_snapshot(
    source: str, record_type: str, external_id: str, record_key: str, payload: dict[str, Any]
) -> None:
    """Replace a fully fetched source snapshot, including authoritative empty lists."""
    if not isinstance(payload, dict):
        raise RuntimeError(f"{record_type} anlık görüntüsü JSON nesnesi değil.")
    external_id, record_key = str(external_id or ""), str(record_key or "")
    query = (
        "tm_source_records?select=id"
        f"&source=eq.{quote(source)}&record_type=eq.{quote(record_type)}"
        f"&external_id=eq.{quote(external_id)}&record_key=eq.{quote(record_key)}&limit=1"
    )
    rows = db_get(query)
    snapshot = {"payload": payload, "fetched_at": datetime.now(timezone.utc).isoformat()}
    if rows:
        row_id = rows[0].get("id")
        if row_id is None:
            raise RuntimeError(f"{record_type} anlık görüntüsünün DB kimliği okunamadı.")
        db_patch(f"tm_source_records?id=eq.{quote(str(row_id))}", snapshot)
    else:
        db_insert("tm_source_records", {
            "source": source, "record_type": record_type,
            "external_id": external_id, "record_key": record_key, **snapshot,
        })


PLAYER_SNAPSHOT_FIELDS = {
    "stats_payload", "current_season_payload", "transfers_payload",
    "market_value_payload", "injuries_payload", "absences_payload", "national_career_payload",
}


def replace_player_snapshots(tm_id: str, snapshots: dict[str, Any]) -> None:
    """Replace endpoint columns only after all pages of those endpoints succeeded."""
    unknown = set(snapshots) - PLAYER_SNAPSHOT_FIELDS
    if unknown:
        raise ValueError(f"İzin verilmeyen oyuncu anlık görüntüsü alanları: {', '.join(sorted(unknown))}")
    if any(not isinstance(value, dict) for value in snapshots.values()):
        raise ValueError("Oyuncu anlık görüntüleri JSON nesnesi olmalı.")
    if snapshots:
        db_patch(
            f"tm_players?tm_id=eq.{quote(str(tm_id))}",
            {**snapshots, "updated_at": datetime.now(timezone.utc).isoformat()},
        )


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
                for nested in ("items", "data", "stats", "transfers", "history", "marketValues", "market_value_history", "valuations", "matches", "results", "appearances", "injuries", "absences"):
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
        started = (
            match.get("isStarting") is True
            or match.get("isStartingEleven") is True
            or match.get("started") is True
            or match.get("startingXI") is True
        )
        if started:
            aggregate["starts"] += 1
        aggregate["goals"] += numeric(match, "goals", "playerGoals") or 0
        aggregate["assists"] += numeric(match, "assists", "playerAssists") or 0
        aggregate["minutes"] += minutes or 0
        aggregate["yellowCards"] += numeric(match, "yellowCard", "yellowCards", "yellow", "bookingsYellow") or 0
        aggregate["secondYellowCards"] += numeric(match, "secondYellowCard", "secondYellowCards") or 0
        aggregate["redCards"] += numeric(match, "redCard", "redCards", "red") or 0
    return [v for v in groups.values() if v["appearances"] or v["goals"] or v["minutes"]]


def get_player_current_matches(base: str, tm_id: str) -> list[dict[str, Any]]:
    """Fetch every page reported by the API; never mark a capped result as complete."""
    first = json_request(
        f"{base}/matches?season_id={quote(str(TM_SEASON))}&page_number=1",
        source=f"felipeall {tm_id} aktif sezon maçları",
        delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
    )
    if not isinstance(first, dict) or not isinstance(first.get("matches"), list):
        raise RuntimeError(
            f"felipeall {tm_id} maçlar: beklenen 'matches' listesi yok; oyuncu tamamlanmadı."
        )

    last_page = numeric(first, "lastPageNumber", "last_page_number")
    if last_page is None or last_page < 1:
        raise RuntimeError(f"felipeall {tm_id} maçlar: lastPageNumber eksik/geçersiz; oyuncu tamamlanmadı.")
    if last_page > TM_MAX_MATCH_PAGES:
        raise RuntimeError(
            f"felipeall {tm_id} maçlar: {last_page} sayfa bulundu fakat TM_MAX_MATCH_PAGES="
            f"{TM_MAX_MATCH_PAGES}; eksik veriyi tamamlandı saymamak için işlem durduruldu."
        )

    all_rows: list[dict[str, Any]] = []
    for page in range(1, last_page + 1):
        payload = first if page == 1 else json_request(
            f"{base}/matches?season_id={quote(str(TM_SEASON))}&page_number={page}",
            source=f"felipeall {tm_id} aktif sezon maçları",
            delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
            raise RuntimeError(
                f"felipeall {tm_id} maçlar sayfa {page}: beklenen 'matches' listesi yok; oyuncu tamamlanmadı."
            )
        page_last = numeric(payload, "lastPageNumber", "last_page_number")
        if page_last != last_page:
            raise RuntimeError(
                f"felipeall {tm_id} maçlar sayfa {page}: sayfa sayısı değişti "
                f"({last_page} -> {page_last}); oyuncu yeniden denenmeli."
            )
        rows = [row for row in payload["matches"] if isinstance(row, dict)]
        if page < last_page and not rows:
            raise RuntimeError(
                f"felipeall {tm_id} maçlar sayfa {page}: beklenen sayfada kayıt yok; oyuncu tamamlanmadı."
            )
        all_rows.extend(rows)
    return all_rows


def fetch_player_payload(
    base: str,
    endpoint: str,
    label: str,
    required_keys: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Fetch and validate a required player endpoint; failures must block completion."""
    payload = json_request(
        base + endpoint,
        source=f"felipeall {label}",
        delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
    )
    if not isinstance(payload, dict) or not payload:
        raise RuntimeError(
            f"felipeall {label}: beklenen JSON nesnesi yerine "
            f"{type(payload).__name__} / boş yanıt geldi; oyuncu tamamlanmadı."
        )
    missing = [key for key in required_keys if key not in payload]
    if missing:
        raise RuntimeError(
            f"felipeall {label}: API yanıtında zorunlu alan(lar) yok: {', '.join(missing)}; "
            f"gelen alanlar={', '.join(sorted(payload.keys()))}; oyuncu tamamlanmadı."
        )
    return payload


def fetch_player_paged_rows(base: str, endpoint: str, key: str) -> dict[str, Any]:
    """Fetch every available Transfermarkt injury/absence page, with a safe page cap."""
    first = fetch_player_payload(base, f"{endpoint}?page_number=1", key)
    rows_raw = first.get(key)
    if not isinstance(rows_raw, list):
        raise RuntimeError(f"felipeall {key}: '{key}' listesi yanıtta yok; oyuncu tamamlanmadı.")
    rows = [row for row in rows_raw if isinstance(row, dict)]

    last_page = numeric(first, "lastPageNumber", "last_page_number")
    first_page = numeric(first, "pageNumber", "page_number")
    if last_page is None or last_page < 1 or first_page != 1:
        raise RuntimeError(
            f"felipeall {key}: sayfalama metadata eksik/geçersiz "
            f"(pageNumber={first_page}, lastPageNumber={last_page}); oyuncu tamamlanmadı."
        )
    if last_page > 30:
        raise RuntimeError(
            f"felipeall {key}: {last_page} sayfa bulundu; güvenli üst sınır 30. "
            "Veri kesilmesin diye oyuncu tamamlandı sayılmadı."
        )
    loaded_pages = 1
    for page in range(2, last_page + 1):
        payload = fetch_player_payload(base, f"{endpoint}?page_number={page}", f"{key} sayfa {page}")
        page_rows_raw = payload.get(key)
        if not isinstance(page_rows_raw, list):
            raise RuntimeError(f"felipeall {key} sayfa {page}: '{key}' listesi yok; oyuncu tamamlanmadı.")
        page_last = numeric(payload, "lastPageNumber", "last_page_number")
        current_page = numeric(payload, "pageNumber", "page_number")
        if page_last != last_page or current_page != page:
            raise RuntimeError(
                f"felipeall {key} sayfa {page}: sayfalama tutarsız "
                f"(pageNumber={current_page}, lastPageNumber={page_last}, beklenen son sayfa={last_page})."
            )
        page_rows = [row for row in page_rows_raw if isinstance(row, dict)]
        if not page_rows:
            raise RuntimeError(
                f"felipeall {key} sayfa {page}: beklenen sayfada kayıt gelmedi; "
                "sayfalama eksik kabul edilerek oyuncu tamamlanmadı."
            )
        rows.extend(page_rows)
        loaded_pages += 1
    result = dict(first)
    result[key] = rows
    result["pages_loaded"] = loaded_pages
    result["last_page_number"] = last_page
    return result


def load_player_detail_queue_states() -> dict[str, dict[str, Any]]:
    """Load durable per-player retry/checkpoint state from tm_source_records."""
    states: dict[str, dict[str, Any]] = {}
    offset = 0
    page_size = 1000
    while True:
        rows = db_get(
            "tm_source_records?select=external_id,payload"
            "&source=eq.felipeall&record_type=eq.player_detail_queue&record_key=eq.details"
            f"&order=external_id.asc&limit={page_size}&offset={offset}"
        )
        if not isinstance(rows, list):
            raise RuntimeError("Oyuncu detay kuyruğu kayıtları okunamadı.")
        for row in rows:
            tm_id = str(row.get("external_id") or "").strip()
            payload = row.get("payload")
            if tm_id and isinstance(payload, dict):
                states[tm_id] = payload
        if len(rows) < page_size:
            break
        offset += len(rows)
    return states


def validate_detail_squad_window(seen_after: str, seen_before: str) -> tuple[str, str]:
    """Validate an explicit UTC timestamp window for one immutable player cohort."""
    try:
        after_dt = datetime.fromisoformat(seen_after.replace("Z", "+00:00"))
        before_dt = datetime.fromisoformat(seen_before.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise RuntimeError("Detay kuyruğu için geçerli seen_after/seen_before ISO tarihleri gerekli.") from exc
    if after_dt.tzinfo is None or before_dt.tzinfo is None:
        raise RuntimeError("Detay kuyruğu tarihleri saat dilimi içermeli (UTC/Z).")
    if before_dt <= after_dt:
        raise RuntimeError("Detay kuyruğunda seen_before, seen_after tarihinden sonra olmalı.")
    return seen_after, seen_before


def load_pending_player_detail_candidates(
    *,
    squad_seen_after: str | None = None,
    squad_seen_before: str | None = None,
) -> list[dict[str, Any]]:
    """Load unprocessed players only from the exact configured cohort window."""
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    candidates: list[dict[str, Any]] = []
    offset = 0
    page_size = 1000
    has_explicit_window = bool(squad_seen_after or squad_seen_before)
    if has_explicit_window:
        if not squad_seen_after or not squad_seen_before:
            raise RuntimeError("Detay kuyruğu için hem başlangıç hem bitiş zamanı gerekli.")
        squad_seen_after, squad_seen_before = validate_detail_squad_window(
            squad_seen_after, squad_seen_before
        )
        window = (
            f"and=(last_squad_seen_at.gte.{squad_seen_after},"
            f"last_squad_seen_at.lt.{squad_seen_before})"
        )
        squad_filter = "&" + quote(window, safe="=.")
    else:
        squad_cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        squad_filter = f"&last_squad_seen_at=gte.{quote(squad_cutoff, safe='')}"
    while True:
        # Count the full cohort, not only pending rows, so the size stays stable
        # as successfully completed players are removed from the work list.
        query = (
            f"tm_players?select={select}&is_active=eq.true"
            f"{squad_filter}&order=tm_id.asc"
            f"&limit={page_size}&offset={offset}"
        )
        rows = db_get(query)
        if not isinstance(rows, list):
            raise RuntimeError("Oyuncu detay kohortu okunamadı.")
        candidates.extend(row for row in rows if isinstance(row, dict))
        if len(rows) < page_size:
            break
        offset += len(rows)

    expected_size_text = os.getenv("TM_DETAIL_EXPECTED_COHORT_SIZE", "").strip()
    if has_explicit_window and expected_size_text:
        try:
            expected_size = int(expected_size_text)
        except ValueError as exc:
            raise RuntimeError("TM_DETAIL_EXPECTED_COHORT_SIZE tam sayı olmalı.") from exc
        if expected_size < 1 or len(candidates) != expected_size:
            raise RuntimeError(
                f"Detay kuyruğu güvenlik kontrolü durduruldu: sabit kohortta "
                f"beklenen {expected_size}, veritabanında bulunan {len(candidates)} aktif oyuncu. "
                "Yanlış gruba taşmamak için hiçbir oyuncu işlenmedi."
            )
    pending = [row for row in candidates if not row.get("last_felipe_synced_at")]
    LOG.info(
        "Sabit kadro aralığı detay kuyruğu: toplam=%s, daha önce tamamlanan=%s, kalan=%s",
        len(candidates), len(candidates) - len(pending), len(pending),
    )
    return pending


def detail_retry_is_due(state: dict[str, Any], now: datetime | None = None) -> bool:
    status = str(state.get("status") or "pending")
    if status in ("completed", "blocked"):
        return False
    retry_at = str(state.get("retry_at") or "").strip()
    if not retry_at:
        return True
    try:
        parsed = datetime.fromisoformat(retry_at.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed <= (now or datetime.now(timezone.utc))
    except ValueError:
        return True


def load_rotating_player_candidates(states: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Pick oldest eligible active players; retry backoff must not starve the rotation."""
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
    page_size, offset = 1000, 0
    selected: list[dict[str, Any]] = []
    now, target = datetime.now(timezone.utc), max(1, TM_MAX_PLAYERS_PER_RUN)
    while True:
        query = (
            f"tm_players?select={select}&is_active=eq.true"
            f"&last_squad_seen_at=gte.{quote(cutoff)}"
            "&order=last_felipe_synced_at.asc.nullsfirst,tm_id.asc"
            f"&limit={page_size}&offset={offset}"
        )
        rows = db_get(query)
        if not isinstance(rows, list):
            raise RuntimeError("Döngüsel oyuncu yenileme listesi okunamadı.")
        for player in rows:
            tm_id = str(player.get("tm_id") or "").strip()
            if not tm_id:
                continue
            state = states.get(tm_id, {})
            if state.get("status") == "blocked":
                continue
            if state.get("status") == "retry" and not detail_retry_is_due(state, now):
                continue
            selected.append(player)
            if len(selected) >= target:
                return selected
        if len(rows) < page_size:
            break
        offset += len(rows)
    return selected


def has_pending_player_details() -> bool:
    states = load_player_detail_queue_states()
    seen_after = os.getenv("TM_DETAIL_SQUAD_SEEN_AFTER", "").strip() or None
    seen_before = os.getenv("TM_DETAIL_SQUAD_SEEN_BEFORE", "").strip() or None
    candidates = load_pending_player_detail_candidates(
        squad_seen_after=seen_after,
        squad_seen_before=seen_before,
    )
    now = datetime.now(timezone.utc)
    return any(
        str(player.get("tm_id") or "").strip()
        and detail_retry_is_due(states.get(str(player.get("tm_id") or "").strip(), {}), now)
        for player in candidates
    )


def dispatch_refresh_details_continuation(
    *, workflow_file: str = "transfermarkt-sync.yml", inputs: dict[str, str] | None = None
) -> bool:
    """Queue the next run with the workflow's GITHUB_TOKEN and preserve its queue scope."""
    token = os.getenv("GITHUB_TOKEN", "")
    repository = os.getenv("GITHUB_REPOSITORY", "")
    ref = os.getenv("GITHUB_REF_NAME", "main")
    if not token or not repository:
        LOG.warning("Kalan detay kuyruğu var ancak GITHUB_TOKEN/GITHUB_REPOSITORY yok; otomatik devam atlandı.")
        return False
    url = f"https://api.github.com/repos/{repository}/actions/workflows/{workflow_file}/dispatches"
    dispatch_inputs = dict(inputs) if inputs is not None else {"mode": "refresh-details"}
    seen_after = os.getenv("TM_DETAIL_SQUAD_SEEN_AFTER", "").strip()
    seen_before = os.getenv("TM_DETAIL_SQUAD_SEEN_BEFORE", "").strip()
    if inputs is None and seen_after and seen_before:
        dispatch_inputs["seen_after"] = seen_after
        dispatch_inputs["seen_before"] = seen_before
    payload = json.dumps({"ref": ref, "inputs": dispatch_inputs}).encode("utf-8")
    request = Request(url, data=payload, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SkorHane-Transfermarkt-Queue",
        "Content-Type": "application/json",
    }, method="POST")
    try:
        with urlopen(request, timeout=30) as response:
            response.read()
            LOG.info("Kalan oyuncular için otomatik devam çalışması kuyruğa alındı (HTTP %s).", response.status)
            return True
    except (HTTPError, URLError, TimeoutError) as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000] if isinstance(exc, HTTPError) else str(exc)
        LOG.error("GitHub otomatik devam şu an kuyruğa alınamadı; zamanlanmış kontrol devam edecek: %s", detail)
        return False


def sync_felipeall(
    only_player: str | None = None, *, backfill_only: bool = False,
    squad_seen_after: str | None = None, squad_seen_before: str | None = None,
) -> int:
    """Refresh player details; backfill_only drains the initial queue safely across batches."""
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    if only_player:
        query = f"tm_players?select={select}&tm_id=eq.{quote(only_player)}&limit=1"
        players = db_get(query)
        states: dict[str, dict[str, Any]] = {}
    elif backfill_only:
        states = load_player_detail_queue_states()
        squad_seen_after = squad_seen_after or os.getenv("TM_DETAIL_SQUAD_SEEN_AFTER", "").strip() or None
        squad_seen_before = squad_seen_before or os.getenv("TM_DETAIL_SQUAD_SEEN_BEFORE", "").strip() or None
        players = load_pending_player_detail_candidates(
            squad_seen_after=squad_seen_after,
            squad_seen_before=squad_seen_before,
        )
    else:
        states = load_player_detail_queue_states()
        players = load_rotating_player_candidates(states)
    if not isinstance(players, list):
        raise RuntimeError("DB oyuncu listesi okunamadı.")

    now = datetime.now(timezone.utc)
    work = []
    for player in players:
        tm_id = str(player.get("tm_id") or "").strip()
        if not tm_id:
            raise RuntimeError("tm_players kaydında oyuncu ID'si boş; kuyruk güvenli şekilde durduruldu.")
        state = states.get(tm_id, {})
        if backfill_only and not detail_retry_is_due(state, now):
            continue
        if not backfill_only and not only_player:
            if state.get("status") == "blocked":
                continue
            if state.get("status") == "retry" and not detail_retry_is_due(state, now):
                continue
        work.append(player)

    players = work
    max_runtime = int(os.getenv("TM_DETAIL_MAX_RUNTIME_SECONDS", "20400"))
    started = time.monotonic()
    successful = 0
    attempted = 0
    stopped_for_time = False
    LOG.info("felipeall detay kuyruğu başladı: çalışılabilir=%s, grup boyutu=%s, süre sınırı=%s dakika", len(players), TM_MAX_PLAYERS_PER_RUN, round(max_runtime / 60))
    for idx, player in enumerate(players, 1):
        tm_id = str(player.get("tm_id") or "").strip()
        previous = states.get(tm_id, {})
        attempts = int(previous.get("attempts") or 0) + 1
        progress = {"endpoint": "starting"}
        if backfill_only and time.monotonic() - started >= max_runtime:
            stopped_for_time = True
            LOG.warning("Güvenli çalışma süresine ulaşıldı; kalan oyuncular kalıcı kuyrukta bırakılıyor.")
            break
        attempted += 1
        try:
            tm_id = str(player.get("tm_id") or "").strip()
            if not tm_id:
                raise RuntimeError(f"tm_players kaydında oyuncu ID'si boş; liste {idx}/{len(players)} noktasında durduruldu.")
            base = f"{FELIPE_API_BASE}/players/{quote(tm_id)}"
            LOG.info(
                "felipeall oyuncu başlıyor: %s/%s | %s | ID=%s",
                idx, len(players), player.get("name") or "İsimsiz", tm_id,
            )
    
            progress["endpoint"] = "profile"
            profile = fetch_player_payload(base, "/profile", f"{tm_id} profil", ("id", "name"))
            progress["endpoint"] = "market_value"
            market_payload = fetch_player_payload(base, "/market_value", f"{tm_id} piyasa değeri geçmişi", ("id", "marketValueHistory"))
            progress["endpoint"] = "transfers"
            transfer_payload = fetch_player_payload(base, "/transfers", f"{tm_id} transfer geçmişi", ("id", "transfers"))
            progress["endpoint"] = "stats"
            stats_payload = fetch_player_payload(base, "/stats", f"{tm_id} sezon istatistikleri", ("id", "stats"))
            progress["endpoint"] = "injuries"
            injuries_payload = fetch_player_paged_rows(base, "/injuries", "injuries")
            progress["endpoint"] = "absences"
            absences_payload = fetch_player_paged_rows(base, "/absences", "absences")
    
            # Transfermarkt'ın maç sayfası da güncel sezonun maç bazlı verilerini sağlar.
            progress["endpoint"] = "matches"
            matches = get_player_current_matches(base, tm_id)
            current_stats = build_current_season_stats(matches)
            current_payload = {
                "season_id": str(TM_SEASON),
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "matches": matches,
                "stats": current_stats,
            }
    
            profile_obj = profile if isinstance(profile, dict) else {}
            profile_player = profile_obj.get("player") or profile_obj.get("data") or profile_obj.get("profile") or profile_obj
            if not isinstance(profile_player, dict):
                profile_player = {}
    
            club_obj = profile_player.get("club") or {}
            if isinstance(club_obj, str):
                club_name = club_obj
                club_id = ""
            elif isinstance(club_obj, dict):
                club_name = safe_text(club_obj.get("name"), club_obj.get("display_name"), player.get("team_name"))
                club_id = safe_text(club_obj.get("id")) or ""
            else:
                club_name, club_id = player.get("team_name"), ""
    
            position_obj = profile_player.get("position") or {}
            position = safe_text(
                position_obj.get("main") if isinstance(position_obj, dict) else position_obj,
                position_obj.get("name") if isinstance(position_obj, dict) else None,
                player.get("position"),
            )
            name = safe_text(profile_player.get("name"), profile_player.get("full_name"), player.get("name"))
            photo = safe_text(profile_player.get("image_url"), profile_player.get("imageUrl"),
                              profile_player.get("photo"), player.get("photo_url"))
    
            market_obj = market_payload if isinstance(market_payload, dict) else {}
            current_value = value_from(profile_player, ("market_value", "marketValue"))
            if current_value is None:
                current_value = value_from(market_obj, ("market_value", "marketValue"))
            current_value_eur = parse_money_eur(current_value)
            market_history = iterable_from(
                market_payload, ("market_value_history", "marketValueHistory", "history", "marketValues", "valuations")
            )
            latest_market_date = normalize_date(
                value_from(market_obj, ("last_updated", "lastUpdated"))
                or (market_history[0].get("date") if market_history else None)
            )
    
            normalized: dict[str, Any] = {
                "team_name": club_name or player.get("team_name"),
                "position": position,
                "photo_url": photo,
            }
            # Detail refresh is not a squad-membership event. Do not pass is_active
            # here: tm_upsert_player updates last_squad_seen_at when that field is set.
            # Only the squad importer may advance the cohort timestamp.
            if name and name != tm_id:
                normalized["name"] = name
            if profile:
                normalized["profile_payload"] = profile
            if market_payload:
                normalized["market_value_payload"] = market_payload
            if transfer_payload:
                normalized["transfers_payload"] = transfer_payload
            if stats_payload:
                normalized["stats_payload"] = stats_payload
            if injuries_payload:
                normalized["injuries_payload"] = injuries_payload
            if absences_payload:
                normalized["absences_payload"] = absences_payload
            if current_payload:
                normalized["current_season_payload"] = current_payload
            if current_value_eur is not None:
                normalized["current_market_value_eur"] = current_value_eur
                normalized["current_market_value_text"] = safe_text(current_value)
                normalized["current_market_value_observed_at"] = datetime.now(timezone.utc).isoformat()
            if latest_market_date:
                normalized["current_market_value_date"] = latest_market_date
    
            progress["endpoint"] = "database_upsert_player"
            upsert_player(tm_id, "felipeall", normalized)

            # All seven detail endpoints were validated and fully paginated.
            # Empty injury/absence arrays are authoritative only after this point.
            replace_player_snapshots(tm_id, {
                "market_value_payload": market_payload,
                "transfers_payload": transfer_payload,
                "stats_payload": stats_payload,
                "injuries_payload": injuries_payload,
                "absences_payload": absences_payload,
                "current_season_payload": current_payload,
            })
            source_record_snapshot("felipeall", "player_profile", tm_id, "", profile)
            source_record_snapshot("felipeall", "player_market_values", tm_id, "", market_payload)
            source_record_snapshot("felipeall", "player_transfers", tm_id, "", transfer_payload)
            source_record_snapshot("felipeall", "player_stats", tm_id, "", stats_payload)
            source_record_snapshot("felipeall", "player_injuries", tm_id, "", injuries_payload)
            source_record_snapshot("felipeall", "player_absences", tm_id, "", absences_payload)
            source_record_snapshot("felipeall", "current_season_matches", tm_id, str(TM_SEASON), current_payload)
    
            # Resolve club IDs in Transfermarkt season-stat rows using profile and
            # the player's own transfer history, avoiding guesses from other providers.
            club_names: dict[str, str] = {}
            if club_id and club_name:
                club_names[club_id] = club_name
            transfer_rows = iterable_from(transfer_payload, ("transfers",))
            for transfer in transfer_rows:
                for key in ("club_from", "club_to", "from_club", "to_club", "clubFrom", "clubTo"):
                    club = transfer.get(key)
                    if isinstance(club, dict):
                        cid = safe_text(club.get("id"))
                        cname = safe_text(club.get("name"), club.get("display_name"))
                        if cid and cname:
                            club_names[cid] = cname
    
            # All transfer rows (not only the current squad's joinedDate) are persisted.
            for transfer in transfer_rows:
                from_club = safe_text(transfer.get("club_from"), transfer.get("from_club"), transfer.get("clubFrom"))
                to_club = safe_text(transfer.get("club_to"), transfer.get("to_club"), transfer.get("clubTo"))
                transfer_date = normalize_date(value_from(transfer, ("date", "transfer_date", "transferDate"))) or ""
                fee = value_from(transfer, ("fee", "fee_eur", "transfer_fee"))
                fee_text = safe_text(transfer.get("fee_text"), transfer.get("feeText"), fee)
                if not from_club and not to_club:
                    continue
                rpc("tm_upsert_transfer", {"p_row": {
                    "tm_id": tm_id,
                    "transfer_date": transfer_date,
                    "from_club": from_club or "",
                    "to_club": to_club or "",
                    "transfer_type": safe_text(transfer.get("transfer_type"), transfer.get("transferType")),
                    "fee_text": fee_text,
                    "fee_eur": parse_money_eur(fee),
                    "payload": transfer,
                    "source": "felipeall",
                }})
    
            # Save valuation history as dated rows as well as the raw player payload.
            for item in market_history:
                valuation_date = normalize_date(item.get("date") or item.get("valuation_date"))
                if not valuation_date:
                    continue
                value = value_from(item, ("market_value", "marketValue", "value_eur", "value"))
                club = safe_text(item.get("club_name"), item.get("clubName"), item.get("club"))
                rpc("tm_upsert_market_value", {"p_row": {
                    "tm_id": tm_id,
                    "valuation_date": valuation_date,
                    "value_eur": parse_money_eur(value),
                    "display_value": safe_text(item.get("display_value"), value),
                    "club_name": club,
                    "payload": item,
                    "source": "felipeall",
                }})
    
            # Normalize Transfermarkt's stats endpoint to the same DB shape used by
            # the career screen. PlayerStats identifies clubs by ID; transfer history
            # supplies those IDs' official Transfermarkt names.
            raw_stat_rows = iterable_from(stats_payload, ("stats",))
            normalized_stats: list[dict[str, Any]] = []
            for row in raw_stat_rows:
                season = safe_text(row.get("season_id"), row.get("seasonId"), row.get("seasonID"), row.get("season"))
                competition = safe_text(row.get("competition_name"), row.get("competitionName"), row.get("competition"))
                club_id_for_stat = safe_text(row.get("club_id"), row.get("clubId"), row.get("clubID")) or ""
                stat_club = safe_text(row.get("club_name"), row.get("clubName"), club_names.get(club_id_for_stat))
                if not season or not stat_club:
                    continue
                mapped = {
                    "seasonID": season,
                    "competitionName": competition or "",
                    "clubName": stat_club,
                    "appearances": numeric(row, "appearances", "matches"),
                    "starts": numeric(row, "starts"),
                    "goals": numeric(row, "goals"),
                    "assists": numeric(row, "assists"),
                    "minutes": numeric(row, "minutes_played", "minutesPlayed", "minutes"),
                    "yellowCards": numeric(row, "yellow_cards", "yellowCards"),
                    "secondYellowCards": numeric(row, "second_yellow_cards", "secondYellowCards"),
                    "redCards": numeric(row, "red_cards", "redCards"),
                }
                normalized_stats.append(mapped)
                rpc("tm_upsert_season_stat", {"p_row": {
                    "tm_id": tm_id,
                    "season_id": season,
                    "competition_name": competition or "",
                    "club_name": stat_club,
                    "appearances": mapped["appearances"],
                    "starts": mapped["starts"],
                    "goals": mapped["goals"],
                    "assists": mapped["assists"],
                    "minutes": mapped["minutes"],
                    "yellow_cards": mapped["yellowCards"],
                    "second_yellow_cards": mapped["secondYellowCards"],
                    "red_cards": mapped["redCards"],
                    "payload": row,
                    "source": "felipeall",
                }})
    
            # Preserve current-season match-derived totals when they add fields that
            # the season summary endpoint does not expose (for example starts/minutes).
            stat_batches: list[dict[str, Any]] = list(current_stats)
            seen_stats: set[tuple[str, str, str]] = set()
            for row in stat_batches:
                season = safe_text(row.get("seasonID"), row.get("seasonId"), row.get("season"), row.get("seasonName")) or ""
                competition = safe_text(row.get("competitionName"), row.get("competition"), row.get("competitionID")) or ""
                club = safe_text(row.get("clubName"), row.get("teamName"), row.get("club"), row.get("team")) or ""
                if not season or not club:
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
    
            progress["endpoint"] = "mark_synced"
            db_patch(f"tm_players?tm_id=eq.{quote(tm_id)}", {
                "last_felipe_synced_at": datetime.now(timezone.utc).isoformat()
            })
            successful += 1
            LOG.info("felipeall oyuncu tamamen tamamlandı: %s/%s | ID=%s", idx, len(players), tm_id)
    
    
            if previous:
                db_delete(
                    f"tm_source_records?source=eq.felipeall&record_type=eq.player_detail_queue"
                    f"&external_id=eq.{quote(tm_id)}&record_key=eq.details"
                )
                states.pop(tm_id, None)
        except Exception as exc:
            message = safe_error_for_log(exc)
            status_match = re.search(r"HTTP\s+(\d{3})", message, re.IGNORECASE)
            http_status = int(status_match.group(1)) if status_match else None
            permanent = http_status in (400, 404, 410, 422) or attempts >= 8
            retry_delays = (15 * 60, 60 * 60, 3 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60)
            retry_at = "" if permanent else (datetime.now(timezone.utc) + timedelta(seconds=retry_delays[min(attempts - 1, len(retry_delays) - 1)])).isoformat()
            state = {"status": "blocked" if permanent else "retry", "attempts": attempts, "last_endpoint": progress.get("endpoint", "unknown"), "last_error": message, "http_status": http_status or 0, "retry_at": retry_at, "last_failed_at": datetime.now(timezone.utc).isoformat()}
            source_record("felipeall", "player_detail_queue", tm_id, "details", state)
            states[tm_id] = state
            LOG.error("Oyuncu detay hatası; sıradaki oyuncuya geçiliyor: ID=%s, endpoint=%s, HTTP=%s, deneme=%s, durum=%s, hata=%s", tm_id, state["last_endpoint"], http_status or "bilinmiyor", attempts, state["status"], message)
    remaining_due = [
        player for player in players
        if str(player.get("tm_id") or "").strip()
        and detail_retry_is_due(states.get(str(player.get("tm_id") or "").strip(), {}), datetime.now(timezone.utc))
    ] if backfill_only else []
    LOG.info(
        "felipeall detay çalışması bitti: başarılı=%s, denenen=%s, uygun-bekleyen=%s, engelli=%s",
        successful, attempted, len(remaining_due),
        sum(1 for state in states.values() if state.get("status") == "blocked"),
    )
    if backfill_only and stopped_for_time and remaining_due:
        continuation_workflow = os.getenv("TM_DETAIL_CONTINUATION_WORKFLOW", "").strip()
        if continuation_workflow:
            if squad_seen_after and squad_seen_before:
                continuation_inputs = {
                    "seen_after": squad_seen_after,
                    "seen_before": squad_seen_before,
                }
            else:
                # The dedicated imported-player workflow accepts an empty dispatch
                # and resumes the durable, recent-unprocessed cohort from Supabase.
                continuation_inputs = {}
            dispatch_refresh_details_continuation(
                workflow_file=continuation_workflow,
                inputs=continuation_inputs,
            )
        else:
            dispatch_refresh_details_continuation()
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
    parser.add_argument("mode", choices=("sync", "import-squads", "refresh-details", "refresh-imported-details", "refresh-rotation", "seed-history", "one-player-test", "has-pending-details"))
    parser.add_argument("--player-id", default=os.getenv("TM_TEST_PLAYER_ID", ""))
    args = parser.parse_args()
    require_db()
    if args.mode == "has-pending-details":
        pending = has_pending_player_details()
        output_path = os.getenv("GITHUB_OUTPUT", "")
        if output_path:
            with open(output_path, "a", encoding="utf-8") as output:
                output.write(f"has_pending={str(pending).lower()}\n")
        print(f"has_pending={str(pending).lower()}")
        return 0
    if args.mode == "seed-history":
        logged_run("dcaribou", "seed-history", seed_dcaribou_history)
        return 0
    if args.mode == "import-squads":
        from sync_squads_and_clubs import logged_run as run_squad_sync
        run_squad_sync()
        return 0
    if args.mode == "refresh-details":
        seen_after = os.getenv("TM_DETAIL_SQUAD_SEEN_AFTER", "").strip()
        seen_before = os.getenv("TM_DETAIL_SQUAD_SEEN_BEFORE", "").strip()
        logged_run(
            "felipeall", "refresh-details",
            lambda: sync_felipeall(
                backfill_only=True,
                squad_seen_after=seen_after or None,
                squad_seen_before=seen_before or None,
            ),
        )
        return 0
    if args.mode == "refresh-imported-details":
        seen_after = os.getenv("TM_DETAIL_SQUAD_SEEN_AFTER", "").strip()
        seen_before = os.getenv("TM_DETAIL_SQUAD_SEEN_BEFORE", "").strip()
        if bool(seen_after) != bool(seen_before):
            validate_detail_squad_window(seen_after, seen_before)
        elif seen_after and seen_before:
            validate_detail_squad_window(seen_after, seen_before)
        else:
            LOG.info(
                "Kadro detay kurtarma modu: son 14 gündeki henüz detayları alınmamış "
                "oyuncular kalıcı kuyruktan taranacak."
            )
        logged_run(
            "felipeall", "refresh-imported-details",
            lambda: sync_felipeall(
                backfill_only=True,
                squad_seen_after=seen_after or None,
                squad_seen_before=seen_before or None,
            ),
        )
        return 0
    if args.mode == "refresh-rotation":
        logged_run("felipeall", "refresh-rotation", sync_felipeall)
        return 0
    if args.mode == "one-player-test":
        if not re.fullmatch(r"\d+", str(args.player_id or "")):
            raise RuntimeError("one-player-test için --player-id veya TM_TEST_PLAYER_ID olarak Transfermarkt oyuncu ID'si gerekli.")
        if not db_get(f"tm_players?select=tm_id&tm_id=eq.{quote(str(args.player_id))}&limit=1"):
            raise RuntimeError("Test oyuncusu önce kadro senkronizasyonuyla tm_players tablosuna eklenmeli.")
        logged_run("felipeall", "one-player-test", lambda: sync_felipeall(only_player=str(args.player_id)))
        return 0
    # Current-only workflow: squad import and detail refresh are independent,
    # idempotent jobs that write through the existing Supabase merge RPCs.
    failures: list[str] = []
    try:
        from sync_squads_and_clubs import logged_run as run_squad_sync
        run_squad_sync()
    except Exception as exc:
        LOG.exception("felipeall kadro kaynağı başarısız; önceki kayıtlar korunuyor: %s", exc)
        failures.append(f"felipeall squads: {safe_error_for_log(exc)}")
    try:
        logged_run("felipeall", "sync", sync_felipeall)
    except Exception as exc:
        LOG.exception("felipeall oyuncu detay kaynağı başarısız; önceki kayıtlar korunuyor: %s", exc)
        failures.append(f"felipeall details: {safe_error_for_log(exc)}")
    if failures:
        raise RuntimeError("Senkronizasyon kaynak hataları: " + " | ".join(failures))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        LOG.exception("Senkronizasyon görevi güvenli şekilde sonlandı: %s", exc)
        raise SystemExit(1)

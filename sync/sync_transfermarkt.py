#!/usr/bin/env python3
"""SkorHane Transfermarkt sync runner.

Modes:
  refresh-player-missing  Refresh only missing/stale fields for one Transfermarkt player.
  one-player-test         Full integration refresh for one player.
  sync / import-squads / refresh-details / refresh-rotation remain explicit admin CLI modes.
  seed-history            One-time dcaribou historical seed for selected competitions.

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
# Pause only separates calls to the local API; upstream scrape concurrency stays at 1.
FELIPE_DELAY_MIN = float(os.getenv("FELIPE_DELAY_MIN_SECONDS", "0.8"))
FELIPE_DELAY_MAX = float(os.getenv("FELIPE_DELAY_MAX_SECONDS", "1.2"))
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


def supabase_http_request(
    request_factory,
    *,
    operation: str,
    parse_json: bool = False,
    empty_value: Any = None,
) -> Any:
    """Retry idempotent Supabase reads/RPC writes after transient connection loss."""
    attempts = max(1, int(os.getenv("SUPABASE_HTTP_MAX_ATTEMPTS", "5")))
    transient_statuses = {408, 425, 429, 500, 502, 503, 504}
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            req = request_factory()
            with urlopen(req, timeout=HTTP_TIMEOUT) as response:
                raw = response.read()
                if not raw:
                    return empty_value
                return json.loads(raw.decode("utf-8")) if parse_json else None
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()[:1000]
            last_error = RuntimeError(f"HTTP {exc.code}: {detail or exc.reason}")
            if exc.code not in transient_statuses:
                raise last_error from exc
        except (TimeoutError, URLError, OSError, json.JSONDecodeError) as exc:
            last_error = exc

        if attempt + 1 < attempts:
            wait_seconds = min(45, 3 * (2 ** attempt))
            LOG.warning(
                "Supabase %s bağlantı/yanıt hatası; %s/%s deneme sonrası tekrar deneniyor: %s",
                operation, attempt + 1, attempts, safe_error_for_log(last_error),
            )
            time.sleep(wait_seconds + random.uniform(0.2, 1.0))

    raise RuntimeError(
        f"Supabase {operation} {attempts} denemede başarısız: {safe_error_for_log(last_error)}"
    ) from last_error


def rpc(name: str, payload: dict[str, Any]) -> Any:
    url = f"{SUPABASE_URL}/rest/v1/rpc/{name}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return supabase_http_request(
        lambda: Request(url, data=body, headers=db_headers(), method="POST"),
        operation=f"RPC {name}", parse_json=True,
    )


def db_get(path: str) -> Any:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    return supabase_http_request(
        lambda: Request(url, headers=db_headers()),
        operation="GET", parse_json=True, empty_value=[],
    )


def db_patch(path: str, payload: dict[str, Any]) -> None:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    body = json.dumps(payload).encode("utf-8")
    supabase_http_request(
        lambda: Request(url, data=body,
                        headers={**db_headers(), "Prefer": "return=minimal"}, method="PATCH"),
        operation="PATCH",
    )


def db_delete(path: str) -> None:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    supabase_http_request(
        lambda: Request(url, headers={**db_headers(), "Prefer": "return=minimal"}, method="DELETE"),
        operation="DELETE",
    )


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


def normalize_tm_season(value: Any) -> str | None:
    """Normalize Transfermarkt API seasons such as 22/23 to 2022/23."""
    if value is None:
        return None
    raw = str(value).strip().replace("–", "/").replace("-", "/")
    match = re.search(r"(?<!\d)(\d{2,4})\s*/\s*(\d{2,4})(?!\d)", raw)
    if match:
        first, second = int(match.group(1)), int(match.group(2))
        start_year = first if first >= 1000 else (1900 + first if first >= 50 else 2000 + first)
        end_year = second if second >= 1000 else (start_year // 100) * 100 + second
        if end_year < start_year:
            end_year += 100
        return f"{start_year}/{end_year % 100:02d}"
    year_match = re.search(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)", raw)
    if year_match:
        start_year = int(year_match.group(1))
        return f"{start_year}/{(start_year + 1) % 100:02d}"
    return raw or None


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


SNAPSHOT_ROW_KEYS = {
    "stats_payload": ("stats", "data", "items"),
    "current_season_payload": ("matches", "stats", "data", "items"),
    "transfers_payload": ("transfers", "history", "items", "data"),
    "market_value_payload": ("marketValueHistory", "market_value_history", "history", "marketValues", "valuations", "items", "data"),
    "injuries_payload": ("injuries", "data", "items"),
    "absences_payload": ("absences", "data", "items"),
    "national_career_payload": ("national", "career", "stats", "data", "items"),
}
SOURCE_RECORD_ROW_KEYS = {
    "player_market_values": SNAPSHOT_ROW_KEYS["market_value_payload"],
    "player_transfers": SNAPSHOT_ROW_KEYS["transfers_payload"],
    "player_stats": SNAPSHOT_ROW_KEYS["stats_payload"],
    "player_injuries": SNAPSHOT_ROW_KEYS["injuries_payload"],
    "player_absences": SNAPSHOT_ROW_KEYS["absences_payload"],
    "current_season_matches": SNAPSHOT_ROW_KEYS["current_season_payload"],
}


def snapshot_has_rows(payload: Any, keys: tuple[str, ...]) -> bool:
    return bool(iterable_from(payload, keys))


DETAIL_ENDPOINTS = {
    "profile": ("profile_payload", "player_profile", ()),
    "market_value": ("market_value_payload", "player_market_values",
                     ("marketValueHistory", "market_value_history", "history", "marketValues", "valuations")),
    "transfers": ("transfers_payload", "player_transfers", ("transfers", "history", "items", "data")),
    "stats": ("stats_payload", "player_stats", ("stats", "data", "items")),
    "injuries": ("injuries_payload", "player_injuries", ("injuries", "data", "items")),
    "absences": ("absences_payload", "player_absences", ("absences", "data", "items")),
    "matches": ("current_season_payload", "current_season_matches", ("matches", "matchHistory", "data", "items")),
}


# One-time repair boundary: snapshots fetched before this code fix must be
# rechecked, because older code treated empty arrays as proof that data existed.
DETAIL_REPAIR_CUTOFF = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)
DETAIL_WORKER_COMPETITIONS = ("TR1", "TR2", "TR3A", "TR3B", "GB1", "ES1", "L1", "IT1", "FR1")


def detail_aggregate_is_fresh(player: dict[str, Any], now: datetime | None = None) -> bool:
    """True only when the aggregate marker is inside the active detail-refresh window."""
    stamp = player.get("last_felipe_synced_at")
    if not stamp:
        return False
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    current = now or datetime.now(timezone.utc)
    stale_days = max(1, int(os.getenv("TM_DETAIL_STALE_DAYS", "7")))
    cutoff = max(current - timedelta(days=stale_days), DETAIL_REPAIR_CUTOFF)
    return parsed >= cutoff


def player_detail_refresh_plan(tm_id: str, player: dict[str, Any]) -> set[str]:
    """Return only missing or stale Felipe endpoint names for one player."""
    record_types = ",".join(item[1] for endpoint, item in DETAIL_ENDPOINTS.items())
    rows = db_get(
        "tm_source_records?select=record_type,record_key,fetched_at"
        f"&source=eq.felipeall&external_id=eq.{quote(str(tm_id))}"
        f"&record_type=in.({record_types})&order=fetched_at.desc&limit=100"
    )
    fetched: dict[str, Any] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        record_type = str(row.get("record_type") or "")
        # Current-season snapshots are keyed by season; ignore historical season keys.
        if record_type == "current_season_matches" and str(row.get("record_key") or "") != str(TM_SEASON):
            continue
        # Query is newest-first; keep the latest checked snapshot per endpoint.
        if record_type and record_type not in fetched:
            fetched[record_type] = row.get("fetched_at")
    stale_days = max(1, int(os.getenv("TM_DETAIL_STALE_DAYS", "7")))
    cutoff = max(datetime.now(timezone.utc) - timedelta(days=stale_days), DETAIL_REPAIR_CUTOFF)
    due: set[str] = set()
    for endpoint, (column, record_type, keys) in DETAIL_ENDPOINTS.items():
        payload = player.get(column)
        stamp = fetched.get(record_type)
        fresh = False
        if stamp:
            try:
                parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                fresh = parsed >= cutoff
            except ValueError:
                fresh = False
        if endpoint == "profile":
            has_payload = isinstance(payload, dict) and bool(payload)
        else:
            arrays = [payload.get(key) for key in keys] if isinstance(payload, dict) else []
            has_schema = any(isinstance(value, list) for value in arrays)
            has_rows = any(isinstance(value, list) and len(value) > 0 for value in arrays)
            # A genuinely empty endpoint is accepted only after a fresh,
            # post-repair source fetch. Old [] values are treated as missing.
            has_payload = has_rows or (fresh and has_schema)
        if not has_payload or not fresh:
            due.add(endpoint)
    return due


def source_record_snapshot(
    source: str, record_type: str, external_id: str, record_key: str, payload: dict[str, Any]
) -> None:
    """Store provider responses without replacing a populated snapshot with an empty one."""
    if not isinstance(payload, dict):
        raise RuntimeError(f"{record_type} anlık görüntüsü JSON nesnesi değil.")
    external_id, record_key = str(external_id or ""), str(record_key or "")
    query = (
        "tm_source_records?select=id,payload"
        f"&source=eq.{quote(source)}&record_type=eq.{quote(record_type)}"
        f"&external_id=eq.{quote(external_id)}&record_key=eq.{quote(record_key)}&limit=1"
    )
    rows = db_get(query)
    row_keys = SOURCE_RECORD_ROW_KEYS.get(record_type)
    now = datetime.now(timezone.utc).isoformat()
    if rows and row_keys and snapshot_has_rows(rows[0].get("payload"), row_keys) and not snapshot_has_rows(payload, row_keys):
        # Preserve useful historical rows but record that this endpoint was checked
        # successfully and returned empty, avoiding an endless re-fetch loop.
        old_payload = rows[0].get("payload") if isinstance(rows[0].get("payload"), dict) else {}
        preserved = {
            **old_payload,
            "_skorhane_sync": {"last_checked_at": now, "provider_returned_empty": True},
        }
        row_id = rows[0].get("id")
        if row_id is None:
            raise RuntimeError(f"{record_type} anlık görüntüsünün DB kimliği okunamadı.")
        db_patch(f"tm_source_records?id=eq.{quote(str(row_id))}",
                 {"payload": preserved, "fetched_at": now})
        LOG.warning("%s boş yanıtı mevcut dolu kaynak anlık görüntüsünü korudu; kontrol zamanı yenilendi (ID=%s).", record_type, external_id)
        return
    snapshot = {"payload": payload, "fetched_at": now}
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


PLAYER_SNAPSHOT_FIELDS = set(SNAPSHOT_ROW_KEYS)


def replace_player_snapshots(tm_id: str, snapshots: dict[str, Any]) -> None:
    """Refresh snapshots only after successful fetches; an empty response never erases useful rows."""
    unknown = set(snapshots) - PLAYER_SNAPSHOT_FIELDS
    if unknown:
        raise ValueError(f"İzin verilmeyen oyuncu anlık görüntüsü alanları: {', '.join(sorted(unknown))}")
    if any(not isinstance(value, dict) for value in snapshots.values()):
        raise ValueError("Oyuncu anlık görüntüleri JSON nesnesi olmalı.")
    if not snapshots:
        return
    fields = ",".join(sorted(snapshots))
    rows = db_get(f"tm_players?select={fields}&tm_id=eq.{quote(str(tm_id))}&limit=1")
    existing = rows[0] if rows else {}
    safe_updates: dict[str, Any] = {}
    for field, payload in snapshots.items():
        keys = SNAPSHOT_ROW_KEYS[field]
        if snapshot_has_rows(payload, keys) or not snapshot_has_rows(existing.get(field), keys):
            safe_updates[field] = payload
        else:
            LOG.warning("%s boş yanıtı mevcut dolu oyuncu kaydını ezmedi (ID=%s).", field, tm_id)
    if safe_updates:
        db_patch(
            f"tm_players?tm_id=eq.{quote(str(tm_id))}",
            {**safe_updates, "updated_at": datetime.now(timezone.utc).isoformat()},
        )


def safe_text(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        if isinstance(value, dict):
            value = (value.get("name") or value.get("displayName") or value.get("display_name")
                     or value.get("shortName") or value.get("displayValue") or value.get("display_value")
                     or value.get("value") or value.get("text"))
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def normalize_transfer_club(*values: Any) -> str | None:
    """Prefer any available official club name; use an ID label only as a last resort."""
    for value in values:
        if isinstance(value, dict):
            name = safe_text(value.get("name"), value.get("displayName"), value.get("display_name"),
                             value.get("shortName"), value.get("clubName"))
        else:
            name = safe_text(value)
        if name:
            return name
    for value in values:
        if isinstance(value, dict):
            club_id = safe_text(value.get("id"), value.get("clubId"), value.get("club_id"))
            if club_id:
                return f"Kulüp #{club_id}"
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
                for nested in ("items", "data", "stats", "statistics", "playerStats", "transfers", "history", "marketValues", "market_value_history", "marketValueHistory", "valuations", "matches", "matchHistory", "results", "appearances", "injuries", "injuryHistory", "absences"):
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
    """Parse EUR values without mistaking thousands separators for decimals."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if not isinstance(value, str):
        return None
    raw = value.strip().lower().replace("€", "").replace("eur", "").replace(" ", "").replace("\u00a0", "")
    match = re.search(r"([+-]?\d[\d.,]*)([kmb])?", raw)
    if not match:
        return None
    number_text, suffix = match.group(1), match.group(2)

    def normalize_separators(text: str) -> str:
        if "," in text and "." in text:
            decimal_sep = "," if text.rfind(",") > text.rfind(".") else "."
            thousands_sep = "." if decimal_sep == "," else ","
            return text.replace(thousands_sep, "").replace(decimal_sep, ".")
        if "," in text or "." in text:
            sep = "," if "," in text else "."
            chunks = text.split(sep)
            if len(chunks) > 1 and all(len(chunk) == 3 for chunk in chunks[1:]):
                return "".join(chunks)
            return "".join(chunks[:-1]) + "." + chunks[-1]
        return text

    try:
        amount = float(normalize_separators(number_text))
    except ValueError:
        return None
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
        # Never invent a club or competition label when the upstream row is incomplete.
        # Without a club, the appearance cannot be safely attributed to a season row.
        if not club:
            continue
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


def load_player_detail_queue_states(tm_id: str | None = None) -> dict[str, dict[str, Any]]:
    """Load durable per-player retry/checkpoint state from tm_source_records."""
    states: dict[str, dict[str, Any]] = {}
    if tm_id:
        rows = db_get(
            "tm_source_records?select=external_id,payload"
            "&source=eq.felipeall&record_type=eq.player_detail_queue&record_key=eq.details"
            f"&external_id=eq.{quote(str(tm_id))}&limit=1"
        )
        if not isinstance(rows, list):
            raise RuntimeError("Oyuncu detay kuyruğu kayıtları okunamadı.")
        for row in rows:
            key = str(row.get("external_id") or "").strip()
            payload = row.get("payload")
            if key and isinstance(payload, dict):
                states[key] = payload
        return states
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


def update_worker_refresh_queue(tm_id: str, status: str, **details: Any) -> None:
    """Mirror the per-player Felipe result into the Worker-owned refresh lock."""
    query = (
        "tm_source_records?select=id,payload"
        "&source=eq.skorhane_worker&record_type=eq.player_detail_refresh"
        f"&external_id=eq.{quote(str(tm_id))}&record_key=eq.details&limit=1"
    )
    rows = db_get(query)
    if not rows:
        return
    row = rows[0]
    current = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    now = datetime.now(timezone.utc).isoformat()
    payload = {**current, "status": status, "player_id": str(tm_id), "updated_at": now, **details}
    row_id = row.get("id")
    if row_id is None:
        raise RuntimeError(f"Worker yenileme kuyruğunun DB kimliği okunamadı (ID={tm_id}).")
    db_patch(f"tm_source_records?id=eq.{quote(str(row_id))}",
             {"payload": payload, "fetched_at": now})


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
    """Load unfinished players from the exact nine-league/five-season roster scope."""
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    candidates: list[dict[str, Any]] = []
    offset = 0
    page_size = 1000
    all_history_requested = os.getenv("TM_DETAIL_PRESEED_ALL_HISTORY", "").strip().lower() in {"1", "true", "yes"}
    worker_competition = os.getenv("TM_DETAIL_COMPETITION_ID", "").strip().upper()
    if worker_competition and worker_competition not in DETAIL_WORKER_COMPETITIONS:
        raise RuntimeError(
            f"Geçersiz TM_DETAIL_COMPETITION_ID: {worker_competition}. "
            f"İzin verilen ligler: {', '.join(DETAIL_WORKER_COMPETITIONS)}"
        )
    worker_view = False
    has_explicit_window = bool(squad_seen_after or squad_seen_before)

    # An explicit import window always wins over all-history mode. The squad
    # importer dispatches this workflow with exact UTC boundaries; ignoring
    # those boundaries would silently expand a small import into the whole backlog.
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
        use_preseed_view = True
        cohort_label = "açık kadro aktarım aralığı"
    elif worker_competition:
        # Every historical player is assigned to exactly one league worker.
        # This prevents two concurrent league jobs from fetching/upserting the
        # same Transfermarkt player at the same time.
        squad_filter = ""
        use_preseed_view = True
        worker_view = True
        cohort_label = f"{worker_competition} işçisine atanmış tarihî oyuncular"
    elif all_history_requested:
        # The SQL view limits this to TR1/TR2/TR3A/TR3B/GB1/ES1/L1/IT1/FR1
        # and season starts 2022-2026; it includes completed rows for accurate
        # total/completed/pending counts. No inactive-player filter is applied.
        squad_filter = ""
        use_preseed_view = True
        cohort_label = "9 lig x 2022-2026 tarihî kadro kapsamı"
    else:
        squad_cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        squad_filter = f"&last_squad_seen_at=gte.{quote(squad_cutoff, safe='')}"
        use_preseed_view = False
        cohort_label = "son 14 günlük aktif kadro"

    while True:
        if worker_view:
            query = (
                f"tm_detail_preseed_candidates_by_worker?select={select}"
                f"&worker_competition_id=eq.{quote(worker_competition, safe='')}"
                f"&order=tm_id.asc&limit={page_size}&offset={offset}"
            )
        elif use_preseed_view:
            query = (
                f"tm_detail_preseed_candidates?select={select}"
                f"{squad_filter}&order=tm_id.asc&limit={page_size}&offset={offset}"
            )
        else:
            query = (
                f"tm_players?select={select}&is_active=eq.true"
                f"{squad_filter}&order=tm_id.asc&limit={page_size}&offset={offset}"
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
                f"beklenen {expected_size}, veritabanında bulunan {len(candidates)} oyuncu. "
                "Yanlış gruba taşmamak için hiçbir oyuncu işlenmedi."
            )

    pending = [row for row in candidates if not detail_aggregate_is_fresh(row)]
    LOG.info(
        "Detay ön-doldurma kohortu (%s): toplam=%s, daha önce tamamlanan=%s, kalan=%s",
        cohort_label, len(candidates), len(candidates) - len(pending), len(pending),
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
    # GitHub API can transiently reject workflow_dispatch. Retry a few times;
    # the hourly sweep is an independent fallback if dispatch remains unavailable.
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                response.read()
                LOG.info(
                    "Kalan oyuncular için otomatik devam çalışması kuyruğa alındı "
                    "(HTTP %s, deneme %s/3).",
                    response.status, attempt + 1,
                )
                return True
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            transient = exc.code in (408, 425, 429, 500, 502, 503, 504)
            if not transient or attempt == 2:
                LOG.error(
                    "GitHub otomatik devam kuyruğa alınamadı (HTTP %s). "
                    "Saatlik otomatik kontrol kalan oyuncuları yeniden tarayacak: %s",
                    exc.code, detail or exc.reason,
                )
                return False
        except (URLError, TimeoutError, OSError) as exc:
            if attempt == 2:
                LOG.error(
                    "GitHub otomatik devam 3 denemede kuyruğa alınamadı. "
                    "Saatlik otomatik kontrol kalan oyuncuları yeniden tarayacak: %s",
                    exc,
                )
                return False
        wait_seconds = min(30, 5 * (2 ** attempt))
        LOG.warning(
            "GitHub otomatik devam isteği geçici hata aldı; %s saniye sonra tekrar denenecek (%s/3).",
            wait_seconds, attempt + 1,
        )
        time.sleep(wait_seconds)
    return False


def sync_felipeall(
    only_player: str | None = None, *, backfill_only: bool = False, missing_only: bool = False,
    squad_seen_after: str | None = None, squad_seen_before: str | None = None,
) -> int:
    """Refresh details; missing_only updates only this player's missing or stale endpoints."""
    select = "tm_id,name,team_name,position,photo_url,last_synced_at,last_felipe_synced_at,last_squad_seen_at"
    if only_player:
        query = f"tm_players?select=*&tm_id=eq.{quote(only_player)}&limit=1" if missing_only else f"tm_players?select={select}&tm_id=eq.{quote(only_player)}&limit=1"
        players = db_get(query)
        states = load_player_detail_queue_states(only_player) if missing_only else {}
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
        if missing_only:
            if not detail_retry_is_due(state, now):
                update_worker_refresh_queue(
                    tm_id, "blocked" if state.get("status") == "blocked" else "retry",
                    attempts=int(state.get("attempts") or 0),
                    retry_at=state.get("retry_at") or "",
                    last_error=state.get("last_error") or "",
                    last_endpoint=state.get("last_endpoint") or "",
                )
                LOG.info("Oyuncu yeniden deneme bekleme süresinde; API çağrısı yapılmadı (ID=%s).", tm_id)
                continue
            due = player_detail_refresh_plan(tm_id, player)
            if not due:
                # All per-endpoint snapshots are fresh. Align the aggregate marker too,
                # otherwise Worker would enqueue this same player on every profile open.
                db_patch(f"tm_players?tm_id=eq.{quote(tm_id)}", {
                    "last_felipe_synced_at": datetime.now(timezone.utc).isoformat()
                })
                if state:
                    db_delete(
                        f"tm_source_records?source=eq.felipeall&record_type=eq.player_detail_queue"
                        f"&external_id=eq.{quote(tm_id)}&record_key=eq.details"
                    )
                    states.pop(tm_id, None)
                update_worker_refresh_queue(tm_id, "completed",
                                            completed_at=datetime.now(timezone.utc).isoformat())
                LOG.info("Oyuncunun Transfermarkt detayları güncel; API çağrısı yapılmadı (ID=%s).", tm_id)
                continue
            player["_refresh_endpoints"] = sorted(due)
            update_worker_refresh_queue(tm_id, "running", endpoint="starting",
                                         attempts=int(state.get("attempts") or 0) + 1)
            LOG.info("Oyuncu eksik/eski uç noktaları: %s (ID=%s)", ",".join(sorted(due)), tm_id)
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
    
            refresh_endpoints = set(player.get("_refresh_endpoints") or
                                    ("profile", "market_value", "transfers", "stats", "injuries", "absences", "matches"))
            existing_profile = player.get("profile_payload") if isinstance(player.get("profile_payload"), dict) else {}
            existing_market = player.get("market_value_payload") if isinstance(player.get("market_value_payload"), dict) else {}
            existing_transfers = player.get("transfers_payload") if isinstance(player.get("transfers_payload"), dict) else {}
            existing_stats = player.get("stats_payload") if isinstance(player.get("stats_payload"), dict) else {}
            existing_injuries = player.get("injuries_payload") if isinstance(player.get("injuries_payload"), dict) else {}
            existing_absences = player.get("absences_payload") if isinstance(player.get("absences_payload"), dict) else {}
            existing_current = player.get("current_season_payload") if isinstance(player.get("current_season_payload"), dict) else {}

            progress["endpoint"] = "profile"
            profile = (fetch_player_payload(base, "/profile", f"{tm_id} profil", ("id", "name"))
                       if "profile" in refresh_endpoints else existing_profile)
            progress["endpoint"] = "market_value"
            market_payload = (fetch_player_payload(base, "/market_value", f"{tm_id} piyasa değeri geçmişi", ("id", "marketValueHistory"))
                              if "market_value" in refresh_endpoints else existing_market)
            progress["endpoint"] = "transfers"
            transfer_payload = (fetch_player_payload(base, "/transfers", f"{tm_id} transfer geçmişi", ("id", "transfers"))
                                if "transfers" in refresh_endpoints else existing_transfers)
            progress["endpoint"] = "stats"
            stats_payload = (fetch_player_payload(base, "/stats", f"{tm_id} sezon istatistikleri", ("id", "stats"))
                             if "stats" in refresh_endpoints else existing_stats)
            progress["endpoint"] = "injuries"
            injuries_payload = (fetch_player_paged_rows(base, "/injuries", "injuries")
                                if "injuries" in refresh_endpoints else existing_injuries)
            absences_payload = (
                fetch_player_paged_rows(base, "/absences", "absences")
                if "absences" in refresh_endpoints else existing_absences
            )

            if "matches" in refresh_endpoints:
                progress["endpoint"] = "matches"
                matches = get_player_current_matches(base, tm_id)
                current_stats = build_current_season_stats(matches)
                current_payload = {
                    "season_id": str(TM_SEASON),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "matches": matches,
                    "stats": current_stats,
                }
            else:
                current_payload = existing_current
                current_stats = current_payload.get("stats", []) if isinstance(current_payload.get("stats"), list) else []
                matches = current_payload.get("matches", []) if isinstance(current_payload.get("matches"), list) else []

            profile_obj = profile if isinstance(profile, dict) else {}
            profile_player = profile_obj.get("player") or profile_obj.get("data") or profile_obj.get("profile") or profile_obj
            if not isinstance(profile_player, dict):
                profile_player = {}
    
            club_obj = profile_player.get("currentClub") or profile_player.get("club") or {}
            if isinstance(club_obj, str):
                club_id = club_obj if club_obj.isdigit() else ""
                club_name = (player.get("team_name") or f"Kulüp #{club_id}") if club_id else club_obj
            elif isinstance(club_obj, dict):
                club_name = safe_text(club_obj.get("name"), club_obj.get("displayName"),
                                      club_obj.get("display_name"), player.get("team_name"))
                club_id = safe_text(club_obj.get("id")) or ""
                if not club_name and club_id:
                    club_name = f"Kulüp #{club_id}"
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
            if isinstance(current_value, dict):
                current_value = safe_text(current_value)
            current_value_eur = parse_money_eur(current_value)
            market_history = iterable_from(
                market_payload, ("market_value_history", "marketValueHistory", "history", "marketValues", "valuations")
            )
            latest_market_date = normalize_date(
                value_from(market_obj, ("last_updated", "lastUpdated"))
                or value_from(market_obj, ("updatedAt", "updated_at"))
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
            if current_value_eur is not None and ({"profile", "market_value"} & refresh_endpoints):
                normalized["current_market_value_eur"] = current_value_eur
                normalized["current_market_value_text"] = safe_text(current_value)
                normalized["current_market_value_observed_at"] = datetime.now(timezone.utc).isoformat()
            if latest_market_date:
                normalized["current_market_value_date"] = latest_market_date
    
            progress["endpoint"] = "database_upsert_player"
            upsert_player(tm_id, "felipeall", normalized)

            # All seven detail endpoints were validated and fully paginated.
            # Empty injury/absence arrays are authoritative only after this point.
            snapshot_updates = {}
            if "market_value" in refresh_endpoints:
                snapshot_updates["market_value_payload"] = market_payload
            if "transfers" in refresh_endpoints:
                snapshot_updates["transfers_payload"] = transfer_payload
            if "stats" in refresh_endpoints:
                snapshot_updates["stats_payload"] = stats_payload
            if "injuries" in refresh_endpoints:
                snapshot_updates["injuries_payload"] = injuries_payload
            if "absences" in refresh_endpoints:
                snapshot_updates["absences_payload"] = absences_payload
            if "matches" in refresh_endpoints:
                snapshot_updates["current_season_payload"] = current_payload
            replace_player_snapshots(tm_id, snapshot_updates)
            if "profile" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_profile", tm_id, "", profile)
            if "market_value" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_market_values", tm_id, "", market_payload)
            if "transfers" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_transfers", tm_id, "", transfer_payload)
            if "stats" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_stats", tm_id, "", stats_payload)
            if "injuries" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_injuries", tm_id, "", injuries_payload)
                injury_rows = iterable_from(injuries_payload, SNAPSHOT_ROW_KEYS["injuries_payload"])
                replaced_injuries = rpc("tm_replace_player_injuries", {
                    "p_tm_id": tm_id,
                    "p_source": "felipeall",
                    "p_rows": injury_rows,
                })
                LOG.info("Normalize sakatlık kayıtları: ID=%s | satır=%s", tm_id, replaced_injuries)
            if "absences" in refresh_endpoints:
                source_record_snapshot("felipeall", "player_absences", tm_id, "", absences_payload)
            if "matches" in refresh_endpoints:
                source_record_snapshot("felipeall", "current_season_matches", tm_id, str(TM_SEASON), current_payload)
                saved_appearances = persist_felipe_history_appearances(tm_id, str(TM_SEASON), matches)
                LOG.info(
                    "Güncel sezon maçları appearance tablosuna işlendi: ID=%s | API satırı=%s | oynanmış maç=%s",
                    tm_id, len(matches), saved_appearances,
                )

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
                        cname = safe_text(club.get("name"), club.get("displayName"), club.get("display_name"))
                        if cid:
                            club_names[cid] = cname or f"Kulüp #{cid}"
    
            # All transfer rows (not only the current squad's joinedDate) are persisted.
            for transfer in transfer_rows:
                from_club = normalize_transfer_club(
                    transfer.get("club_from"), transfer.get("from_club"), transfer.get("clubFrom")
                )
                to_club = normalize_transfer_club(
                    transfer.get("club_to"), transfer.get("to_club"), transfer.get("clubTo")
                )
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
                    "fee_eur": parse_money_eur(fee_text or fee),
                    "payload": transfer,
                    "source": "felipeall",
                }})
    
            # Save valuation history as dated rows as well as the raw player payload.
            for item in market_history:
                valuation_date = normalize_date(item.get("date") or item.get("valuation_date"))
                if not valuation_date:
                    continue
                value = value_from(item, ("market_value", "marketValue", "value_eur", "value"))
                if isinstance(value, dict):
                    value = safe_text(value)
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
                season = normalize_tm_season(safe_text(
                    row.get("season_id"), row.get("seasonId"), row.get("seasonID"), row.get("season")
                ))
                raw_competition = row.get("competition")
                if isinstance(raw_competition, dict):
                    raw_competition_id = safe_text(
                        raw_competition.get("id"), raw_competition.get("competitionId"),
                        raw_competition.get("competition_id")
                    ) or ""
                    raw_competition_name = safe_text(
                        raw_competition.get("name"), raw_competition.get("displayName")
                    )
                else:
                    raw_competition_id = ""
                    raw_competition_name = raw_competition if isinstance(raw_competition, str) else None
                competition_id_for_stat = safe_text(
                    row.get("competition_id"), row.get("competitionId"), row.get("competitionID"),
                    raw_competition_id
                ) or ""
                competition = safe_text(
                    row.get("competition_name"), row.get("competitionName"),
                    raw_competition_name,
                    raw_competition if isinstance(raw_competition, str) else None
                )
                raw_club = row.get("club")
                if isinstance(raw_club, dict):
                    raw_club_id = safe_text(raw_club.get("id"), raw_club.get("clubId")) or ""
                    raw_club_name = safe_text(raw_club.get("name"), raw_club.get("displayName"))
                else:
                    raw_club_id = str(raw_club).strip() if raw_club is not None and str(raw_club).strip().isdigit() else ""
                    raw_club_name = str(raw_club).strip() if raw_club is not None and not raw_club_id else None
                club_id_for_stat = safe_text(row.get("club_id"), row.get("clubId"), row.get("clubID"), raw_club_id) or ""
                stat_club = safe_text(row.get("club_name"), row.get("clubName"), raw_club_name,
                                      club_names.get(club_id_for_stat))
                if not stat_club and club_id_for_stat:
                    stat_club = f"Kulüp #{club_id_for_stat}"
                if not season or not stat_club:
                    continue
                mapped = {
                    "seasonID": season,
                    "competitionID": competition_id_for_stat,
                    "competitionName": competition or "",
                    "clubID": club_id_for_stat,
                    "clubName": stat_club,
                    "appearances": numeric(row, "appearances", "matches"),
                    "starts": numeric(row, "starts"),
                    "goals": numeric(row, "goals"),
                    "assists": numeric(row, "assists"),
                    "minutes": numeric(row, "minutes_played", "minutesPlayed", "minutes"),
                    "yellowCards": numeric(row, "yellow_cards", "yellowCards"),
                    "secondYellowCards": numeric(row, "second_yellow_cards", "secondYellowCards"),
                    "redCards": numeric(row, "red_cards", "redCards"),
                    "goalsConceded": numeric(row, "goals_conceded", "goalsConceded"),
                    "cleanSheets": numeric(row, "clean_sheets", "cleanSheets"),
                }
                normalized_stats.append(mapped)
                rpc("tm_upsert_season_stat", {"p_row": {
                    "tm_id": tm_id,
                    "season_id": season,
                    "competition_id": competition_id_for_stat,
                    "competition_name": competition or "",
                    "club_id": club_id_for_stat,
                    "club_name": stat_club,
                    "appearances": mapped["appearances"],
                    "starts": mapped["starts"],
                    "goals": mapped["goals"],
                    "assists": mapped["assists"],
                    "minutes": mapped["minutes"],
                    "yellow_cards": mapped["yellowCards"],
                    "second_yellow_cards": mapped["secondYellowCards"],
                    "red_cards": mapped["redCards"],
                    "goals_conceded": mapped["goalsConceded"],
                    "clean_sheets": mapped["cleanSheets"],
                    "payload": row,
                    "source": "felipeall",
                }})
    
            # Preserve current-season match-derived totals when they add fields that
            # the season summary endpoint does not expose (for example starts/minutes).
            stat_batches: list[dict[str, Any]] = list(current_stats)
            seen_stats: set[tuple[str, str, str, str]] = set()
            for row in stat_batches:
                season = safe_text(row.get("seasonID"), row.get("seasonId"), row.get("season"), row.get("seasonName")) or ""
                raw_competition = row.get("competition")
                competition_object = raw_competition if isinstance(raw_competition, dict) else {}
                competition_id = safe_text(
                    row.get("competition_id"), row.get("competitionID"), row.get("competitionId"),
                    competition_object.get("id"), competition_object.get("competitionId")
                ) or ""
                competition = safe_text(
                    row.get("competitionName"),
                    competition_object.get("name"), competition_object.get("displayName"),
                    raw_competition if isinstance(raw_competition, str) else None,
                    row.get("competitionID"), row.get("competitionId")
                ) or ""
                raw_club = row.get("club")
                club_object = raw_club if isinstance(raw_club, dict) else {}
                club_id = safe_text(
                    row.get("club_id"), row.get("clubID"), row.get("clubId"),
                    club_object.get("id"), club_object.get("clubId")
                ) or ""
                club = safe_text(
                    row.get("clubName"), row.get("teamName"),
                    club_object.get("name"), club_object.get("displayName"),
                    raw_club if isinstance(raw_club, str) else None,
                    row.get("team") if isinstance(row.get("team"), str) else None
                ) or ""
                if not season or not club:
                    continue
                stat_key = (str(season), competition_id or competition, club_id or club)
                if stat_key in seen_stats:
                    continue
                seen_stats.add(stat_key)
                rpc("tm_upsert_season_stat", {"p_row": {
                    "tm_id": tm_id, "season_id": str(season),
                    "competition_id": competition_id, "competition_name": competition,
                    "club_id": club_id, "club_name": club,
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
            if missing_only:
                update_worker_refresh_queue(tm_id, "completed",
                                            completed_at=datetime.now(timezone.utc).isoformat())
            LOG.info("felipeall oyuncu tamamen tamamlandı: %s/%s | ID=%s", idx, len(players), tm_id)
    
    
            if previous:
                db_delete(
                    f"tm_source_records?source=eq.felipeall&record_type=eq.player_detail_queue"
                    f"&external_id=eq.{quote(tm_id)}&record_key=eq.details"
                )
                states.pop(tm_id, None)
            if backfill_only:
                # Keep the in-memory completion marker so the time-limit continuation
                # does not re-dispatch players already processed in this same run.
                states[tm_id] = {"status": "completed"}
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
            if missing_only:
                update_worker_refresh_queue(
                    tm_id, state["status"], attempts=attempts, retry_at=retry_at,
                    last_error=message, http_status=http_status or 0,
                    last_endpoint=state["last_endpoint"],
                )
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
                # Resume the same league partition; never restart all nine workers
                # when a single league reaches its safe runtime limit.
                worker_competition = os.getenv("TM_DETAIL_COMPETITION_ID", "").strip().upper()
                continuation_inputs = (
                    {"competition_id": worker_competition} if worker_competition else {}
                )
            dispatched = dispatch_refresh_details_continuation(
                workflow_file=continuation_workflow,
                inputs=continuation_inputs,
            )
            if not dispatched:
                LOG.error(
                    "Kalan %s oyuncu için anlık devam tetiklenemedi; "
                    "saatlik otomatik kontrol aynı lig kuyruğunu yeniden tarayacak.",
                    len(remaining_due),
                )
        else:
            LOG.warning(
                "Kalan detay oyuncuları kuyrukta bırakıldı; otomatik devam için "
                "TM_DETAIL_CONTINUATION_WORKFLOW açıkça tanımlanmalı."
            )
    return successful

def patch_dcaribou_rate_limit() -> None:
    """Patch dcaribou's crawler factory with a strict, low request rate.

    The upstream factory's actual construction line is matched literally.
    This avoids regex-escaping errors and fails closed on unknown layouts.
    """
    import tfmkt.common as common  # type: ignore

    path = Path(common.__file__)
    source = path.read_text(encoding="utf-8")
    if "_skorhane_rate_limit" in source:
        LOG.info("dcaribou crawler güvenli hız sınırı zaten uygulanmış.")
        return

    if "import asyncio\n" not in source:
        if "import os\n" not in source:
            raise RuntimeError("dcaribou common.py import bölümü tanınmadı; tarama başlatılmadı.")
        source = source.replace("import os\n", "import asyncio\nimport random\nimport os\n", 1)
    elif "import random\n" not in source:
        source = source.replace("import asyncio\n", "import asyncio\nimport random\n", 1)

    if "from crawlee import ConcurrencySettings" not in source:
        request_import = "from crawlee import Request\n"
        if request_import not in source:
            raise RuntimeError("dcaribou common.py Crawlee import satırı tanınmadı; tarama başlatılmadı.")
        source = source.replace(
            request_import,
            "from crawlee import ConcurrencySettings, Request\n",
            1,
        )

    settings = (
        "ConcurrencySettings(min_concurrency=1, max_concurrency=1, "
        "desired_concurrency=1, max_tasks_per_minute=18)"
    )
    hook = (
        "    crawler_options['concurrency_settings'] = " + settings + "\n"
        "    crawler = crawler_class(**crawler_options)  # _skorhane_rate_limit\n"
        "    @crawler.pre_navigation_hook\n"
        "    async def _skorhane_polite_delay(context):\n"
        "        await asyncio.sleep(random.uniform(1.5, 3.5))\n"
    )
    generic_factory_line = "    crawler = crawler_class(**crawler_options)\n"
    legacy_factory_line = "    crawler = ParselCrawler()\n"

    if generic_factory_line in source:
        source = source.replace(generic_factory_line, hook, 1)
    elif legacy_factory_line in source:
        legacy_hook = (
            "    crawler = ParselCrawler(concurrency_settings=" + settings + ")"
            "  # _skorhane_rate_limit\n"
            "    @crawler.pre_navigation_hook\n"
            "    async def _skorhane_polite_delay(context):\n"
            "        await asyncio.sleep(random.uniform(1.5, 3.5))\n"
        )
        source = source.replace(legacy_factory_line, legacy_hook, 1)
    else:
        raise RuntimeError(
            "dcaribou create_crawler() factory satırı tanınmadı; "
            "hiçbir tarama başlatılmadı. Scraper factory yapısı kontrol edilmeli."
        )

    path.write_text(source, encoding="utf-8")
    LOG.info(
        "dcaribou crawler güvenli ayarlandı: concurrency=1, max 18 istek/dk, jitter 1.5–3.5 sn"
    )

def decode_dcaribou_records(stdout: str) -> list[dict[str, Any]]:
    """Decode JSONL and the JSON array/object formats used by scraper CLI versions."""
    records: list[dict[str, Any]] = []
    list_keys = ("data", "results", "items", "competitions", "clubs", "players", "appearances")

    def add_value(value: Any) -> None:
        if isinstance(value, list):
            records.extend(item for item in value if isinstance(item, dict))
        elif isinstance(value, dict):
            for key in list_keys:
                nested = value.get(key)
                if isinstance(nested, list):
                    records.extend(item for item in nested if isinstance(item, dict))
                    return
            is_named_entity = "id" in value and any(
                key in value for key in ("name", "displayName", "competition_name", "club_name")
            )
            if is_named_entity or any(key in value for key in (
                "href", "url", "competition_name", "competition_type", "competitionType",
                "club_id", "clubId", "player_id", "playerId", "game_id", "gameId",
                "appearance_id",
            )):
                records.append(value)

    try:
        add_value(json.loads(stdout))
    except (json.JSONDecodeError, TypeError):
        pass
    if records:
        return records
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate or candidate.startswith(("[", "]")):
            continue
        try:
            add_value(json.loads(candidate))
        except json.JSONDecodeError:
            continue
    if records:
        return records
    decoder = json.JSONDecoder()
    position = 0
    while position < len(stdout):
        while position < len(stdout) and (stdout[position].isspace() or stdout[position] in ",;"):
            position += 1
        if position >= len(stdout):
            break
        try:
            value, end = decoder.raw_decode(stdout, position)
        except json.JSONDecodeError:
            position += 1
            continue
        add_value(value)
        position = end
    return records


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
    records = decode_dcaribou_records(stdout)
    if not records:
        preview = [line.strip()[:350] for line in stdout.splitlines() if line.strip()][:6]
        LOG.warning(
            "dcaribou %s JSON çıktısı çözümlenemedi: stdout_lines=%s stdout_chars=%s stdout_preview=%s",
            name, len(stdout.splitlines()), len(stdout),
            json.dumps(preview, ensure_ascii=False),
        )
    else:
        LOG.info("dcaribou %s çıktısı çözümlendi: %s JSON kayıt.", name, len(records))
    if stderr.strip():
        LOG.warning("dcaribou %s stderr: %s", name, stderr.strip()[-2400:])
    return records, success

def competition_codes(item: dict[str, Any]) -> set[str]:
    """Extract exact Transfermarkt competition codes from the full nested row."""
    searchable: list[str] = []

    def collect(value: Any, depth: int = 0) -> None:
        if depth > 4 or value is None:
            return
        if isinstance(value, dict):
            for child in value.values():
                collect(child, depth + 1)
        elif isinstance(value, (list, tuple)):
            for child in value:
                collect(child, depth + 1)
        elif isinstance(value, (str, int, float)):
            searchable.append(str(value))

    collect(item)
    joined = " ".join(searchable).upper()
    codes = set(re.findall(r"(?<![A-Z0-9])[A-Z]{1,5}\d{1,2}(?![A-Z0-9])", joined))

    # The scraper's canonical competition rows often put the league's country
    # code/name on the parent country and use a numeric ID in the competition URL.
    def compact(value: str) -> str:
        import unicodedata
        return re.sub(
            r"[^A-Z0-9]",
            "",
            unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").upper(),
        )

    country_aliases = {
        "TR1": {"TR", "TUR", "TURKEY", "TURKIYE"},
        "GB1": {"GB", "GBR", "ENG", "UK", "UNITEDKINGDOM", "ENGLAND"},
        "ES1": {"ES", "ESP", "SPAIN", "ESPANA"},
        "L1": {"DE", "DEU", "GER", "GERMANY", "DEUTSCHLAND"},
        "IT1": {"IT", "ITA", "ITALY", "ITALIA"},
        "FR1": {"FR", "FRA", "FRANCE"},
    }
    country_values: list[str] = []
    def collect_country(value: Any, depth: int = 0) -> None:
        if depth > 4 or value is None:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in {"country_code", "countrycode", "country_name", "countryname", "country"}:
                    if isinstance(child, (str, int, float)):
                        country_values.append(str(child))
                collect_country(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                collect_country(child, depth + 1)
    collect_country(item)
    normalized_countries = {compact(value) for value in country_values if value}
    for league_code, aliases in country_aliases.items():
        if normalized_countries & aliases:
            codes.add(league_code)

    return codes


def is_dcaribou_first_tier(item: dict[str, Any], wanted_codes: set[str]) -> bool:
    """Accept canonical first_tier metadata or an unambiguous /wettbewerb/CODE URL.

    Some scraper releases omit/rename competition_type. The URL path is the
    authoritative discriminator: /wettbewerb/ is a league, while
    /pokalwettbewerb/ is a cup and must never be treated as a league.
    """
    raw_type = safe_text(
        item.get("competition_type"), item.get("competitionType"),
        item.get("sub_type"), item.get("subType"),
    ) or ""
    normalized_type = re.sub(r"[^a-z]", "", raw_type.lower())
    if normalized_type in {"firsttier", "firstdivision", "topdivision"}:
        return True

    href = safe_text(item.get("href"), item.get("url"), item.get("competition_url")) or ""
    path = href.lower().split("?", 1)[0].rstrip("/")
    if "/pokalwettbewerb/" in path or "/pokalwettbewerb" in path:
        return False
    if "/wettbewerb/" in path:
        return bool(competition_codes(item) & wanted_codes)
    return False



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


def _seed_dcaribou_history_scraper() -> int:
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
    wanted_codes = set(DCARIBOU_COMPETITIONS)
    first_tier_count = 0
    code_match_count = 0
    for competition in competitions:
        if is_dcaribou_first_tier(competition, wanted_codes):
            first_tier_count += 1
            matched_codes = competition_codes(competition) & wanted_codes
            if matched_codes:
                code_match_count += 1
                for code in sorted(matched_codes):
                    selected.append((code, competition))
    if not selected:
        samples = [
            {
                "type": row.get("type"),
                "competition_type": row.get("competition_type"),
                "href": row.get("href"),
                "competition_name": row.get("competition_name"),
                "country_code": row.get("country_code"),
                "country_name": row.get("country_name"),
                "keys": sorted(row.keys()),
            }
            for row in competitions[:8]
        ]
        LOG.error(
            "dcaribou yarışma kataloğu eşleşmedi: records=%d first_tier=%d code_matches=%d "
            "wanted=%s sample=%s",
            len(competitions), first_tier_count, code_match_count,
            ",".join(DCARIBOU_COMPETITIONS), json.dumps(samples, ensure_ascii=False),
        )
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



def history_checkpoint_key(season_id: str, tm_id: str) -> str:
    return f"player_season_appearances:{season_id}:{tm_id}"


def load_felipe_history_checkpoints() -> set[str]:
    """Read all completed history checkpoints, not just PostgREST's first 10k rows."""
    completed: set[str] = set()
    page_size = 1000
    offset = 0
    while True:
        rows = db_get(
            "tm_source_records?select=record_key&source=eq.felipeall"
            "&record_type=eq.history_appearance_checkpoint"
            "&record_key=like.player_season_appearances:*"
            f"&order=record_key.asc&limit={page_size}&offset={offset}"
        )
        if not isinstance(rows, list):
            raise RuntimeError("Felipe geçmiş maç checkpoint kayıtları okunamadı.")
        completed.update(
            str(row.get("record_key") or "")
            for row in rows
            if isinstance(row, dict) and row.get("record_key")
        )
        if len(rows) < page_size:
            break
        offset += len(rows)
    return completed


def history_appearance_needs_refresh(
    season_id: str, tm_id: str, completed: set[str], *, refresh_current_season: bool = False
) -> bool:
    """Use checkpoints during continuation; scheduled refreshes may force the active season."""
    key = history_checkpoint_key(season_id, tm_id)
    if str(season_id) == str(TM_SEASON) and refresh_current_season:
        return True
    return key not in completed


def mark_felipe_history_checkpoint(
    season_id: str, tm_id: str, *, appearance_rows: int, source_name: str
) -> None:
    source_record(
        "felipeall", "history_appearance_checkpoint", tm_id,
        history_checkpoint_key(season_id, tm_id),
        {
            "status": "completed",
            "season_id": str(season_id),
            "tm_id": str(tm_id),
            "appearance_rows": int(appearance_rows),
            "source": source_name,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        },
    )


def load_supabase_history_roster(competition_id: str, season_id: str) -> list[dict[str, Any]]:
    """Read imported historical squad membership before requesting new roster data."""
    collected: list[dict[str, Any]] = []
    offset = 0
    page_size = 1000
    while True:
        query = (
            "tm_team_season_squads?select=competition_id,competition_name,season_id,"
            "club_id,club_name,tm_id,player_name,position,photo_url"
            f"&competition_id=eq.{quote(str(competition_id), safe='')}"
            f"&season_id=eq.{quote(str(season_id), safe='')}"
            f"&order=tm_id.asc&limit={page_size}&offset={offset}"
        )
        rows = db_get(query)
        if not isinstance(rows, list):
            raise RuntimeError(
                f"Supabase geçmiş kadro yanıtı liste değil ({competition_id}/{season_id})."
            )
        collected.extend(row for row in rows if isinstance(row, dict) and row.get("tm_id"))
        if len(rows) < page_size:
            break
        offset += len(rows)
    return collected


def fetch_felipe_history_roster(competition_id: str, season_id: str) -> list[dict[str, Any]]:
    """Fallback roster discovery using Felipe API v5 competition and club endpoints."""
    base = FELIPE_API_BASE.rstrip("/")
    if not base:
        raise RuntimeError("FELIPE_API_BASE tanımlı değil.")
    comp = quote(str(competition_id), safe="")
    season = quote(str(season_id), safe="")
    competition_payload = json_request(
        f"{base}/competitions/{comp}/clubs?season_id={season}",
        source=f"felipeall {competition_id}/{season_id} kulüp listesi",
        delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
    )
    if not isinstance(competition_payload, dict) or not isinstance(competition_payload.get("clubs"), list):
        raise RuntimeError(
            f"Felipe API {competition_id}/{season_id}: competition clubs yanıtında clubs listesi yok."
        )
    competition_name = safe_text(competition_payload.get("name")) or competition_id
    clubs = [row for row in competition_payload["clubs"] if isinstance(row, dict)]
    if not clubs:
        LOG.warning(
            "Felipe API %s/%s için kulüp listesi boş döndü; Supabase kayıtları korundu.",
            competition_id, season_id,
        )
        return []

    collected: list[dict[str, Any]] = []
    for club in clubs:
        club_id = safe_text(club.get("id"), club.get("clubId"))
        club_name = safe_text(club.get("name"), club.get("clubName"))
        if not club_id:
            LOG.warning(
                "Felipe API %s/%s kulüp satırında ID yok; satır atlandı.",
                competition_id, season_id,
            )
            continue
        club_payload = json_request(
            f"{base}/clubs/{quote(club_id, safe='')}/players?season_id={season}",
            source=f"felipeall {club_name or club_id} {season_id} kadrosu",
            delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
        )
        if not isinstance(club_payload, dict) or not isinstance(club_payload.get("players"), list):
            LOG.warning(
                "Felipe API %s/%s/%s oyuncu listesi eksik; kulüp atlandı.",
                competition_id, season_id, club_id,
            )
            continue
        for player in club_payload["players"]:
            if not isinstance(player, dict):
                continue
            tm_id = safe_text(player.get("id"), player.get("playerId"), player.get("player_id"))
            if not tm_id:
                tm_id = player_id_from_row(player)
            if not tm_id or not str(tm_id).isdigit():
                continue
            player_name = safe_text(player.get("name"), player.get("playerName")) or str(tm_id)
            position = safe_text(player.get("position"))
            photo = safe_text(player.get("imageUrl"), player.get("image_url"), player.get("photoUrl"))
            roster_row = {
                "competition_id": competition_id,
                "competition_name": competition_name,
                "season_id": str(season_id),
                "club_id": club_id,
                "club_name": club_name or "",
                "tm_id": str(tm_id),
                "player_name": player_name,
                "position": position,
                "photo_url": photo,
            }
            collected.append(roster_row)

            # Cache recovered roster data where the season-squad migration exists.
            # In-memory processing still continues if this optional cache write fails.
            try:
                upsert_player(str(tm_id), "felipeall", {
                    "name": player_name, "position": position, "photo_url": photo,
                })
                rpc("tm_upsert_team_season_squad", {"p_row": {
                    **roster_row,
                    "shirt_number": player.get("shirtNumber"),
                    "age": player.get("age"),
                    "nationality": player.get("nationality"),
                    "market_value_eur": numeric(player, "marketValue", "market_value"),
                    "payload": player,
                }})
            except Exception as exc:
                LOG.warning(
                    "Felipe API kadro satırı RAM'de tutuldu; Supabase kadro cache yazılamadı "
                    "(%s/%s/%s): %s",
                    competition_id, season_id, club_id, safe_error_for_log(exc),
                )
    return collected


def fetch_felipe_player_season_matches(tm_id: str, season_id: str) -> list[dict[str, Any]]:
    """Fetch all pages of one player's matches in one Transfermarkt season."""
    base = FELIPE_API_BASE.rstrip("/")
    if not base:
        raise RuntimeError("FELIPE_API_BASE tanımlı değil.")
    player = quote(str(tm_id), safe="")
    season = quote(str(season_id), safe="")
    first = json_request(
        f"{base}/players/{player}/matches?season_id={season}&page_number=1",
        source=f"felipeall {tm_id}/{season_id} tarihsel maçları",
        delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
    )
    if not isinstance(first, dict) or not isinstance(first.get("matches"), list):
        raise RuntimeError(
            f"Felipe API {tm_id}/{season_id}: matches listesi olmayan/geçersiz yanıt."
        )
    last_page = numeric(first, "lastPageNumber", "last_page_number")
    first_page = numeric(first, "pageNumber", "page_number")
    if last_page is None or last_page < 1 or first_page != 1:
        raise RuntimeError(
            f"Felipe API {tm_id}/{season_id}: sayfalama metadata geçersiz "
            f"(page={first_page}, last={last_page})."
        )
    max_pages = max(1, int(os.getenv("TM_MAX_HISTORY_MATCH_PAGES", "20")))
    if last_page > max_pages:
        raise RuntimeError(
            f"Felipe API {tm_id}/{season_id}: {last_page} sayfa bulundu; "
            f"TM_MAX_HISTORY_MATCH_PAGES={max_pages}. Eksik veri tamamlandı sayılmadı."
        )
    all_rows = [row for row in first["matches"] if isinstance(row, dict)]
    for page in range(2, last_page + 1):
        payload = json_request(
            f"{base}/players/{player}/matches?season_id={season}&page_number={page}",
            source=f"felipeall {tm_id}/{season_id} maç sayfa {page}",
            delay_range=(FELIPE_DELAY_MIN, FELIPE_DELAY_MAX),
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
            raise RuntimeError(
                f"Felipe API {tm_id}/{season_id} sayfa {page}: matches listesi yok."
            )
        page_number = numeric(payload, "pageNumber", "page_number")
        page_last = numeric(payload, "lastPageNumber", "last_page_number")
        if page_number != page or page_last != last_page:
            raise RuntimeError(
                f"Felipe API {tm_id}/{season_id} sayfa tutarsızlığı: "
                f"page={page_number}, last={page_last}, beklenen={page}/{last_page}."
            )
        page_rows = [row for row in payload["matches"] if isinstance(row, dict)]
        if page < last_page and not page_rows:
            raise RuntimeError(
                f"Felipe API {tm_id}/{season_id} sayfa {page} boş; eksik sayfalama kabul edildi."
            )
        all_rows.extend(page_rows)
    return all_rows


def persist_felipe_history_appearances(
    tm_id: str, season_id: str, matches: list[dict[str, Any]],
    fallback_competition_name: str | None = None,
) -> int:
    """Persist actual player appearances; never invent ratings or match facts."""
    saved = 0
    for match in matches:
        game_id = safe_text(match.get("gameId"), match.get("game_id"), match.get("match_id"))
        played_at = normalize_date(match.get("date"))
        if not game_id or not played_at:
            LOG.warning(
                "Felipe maç satırı ID/tarih olmadan geldi; oyuncu=%s sezon=%s atlandı.",
                tm_id, season_id,
            )
            continue
        participation = (
            safe_text(match.get("participation"), match.get("playerStatus"), match.get("status")) or ""
        ).lower()
        minutes = numeric(match, "minutesPlayed", "minutes", "playedMinutes") or 0
        played = minutes > 0 or participation in {
            "played", "starting_xi", "starting xi", "substitute", "substituted",
        }
        if not played:
            # Felipe also returns missed/injured/on-bench games. They are not appearances.
            continue
        competition_name = safe_text(match.get("competition")) or fallback_competition_name
        club_name = safe_text(match.get("club"), match.get("playerClubName"), match.get("clubName"))
        opponent_name = safe_text(match.get("opponent"), match.get("opponentName"))
        is_starting = match.get("isStarting") is True or match.get("is_starting") is True
        yellow = match.get("yellowCard") is True or match.get("yellow_card") is True
        second_yellow = (
            match.get("secondYellowCard") is True or match.get("second_yellow_card") is True
        )
        red = match.get("redCard") is True or match.get("red_card") is True
        source_key = f"{tm_id}:{season_id}:{game_id}"
        raw_payload = {**match, "season_id": str(season_id), "history_source": "felipeall"}
        rpc("tm_upsert_appearance", {"p_row": {
            "source": "felipeall",
            "source_record_key": source_key,
            "tm_id": str(tm_id),
            "game_id": str(game_id),
            "played_at": played_at,
            "competition_name": competition_name,
            "club_name": club_name,
            "opponent_name": opponent_name,
            "appearances": 1,
            "starts": 1 if is_starting else 0,
            "minutes": minutes,
            "goals": numeric(match, "goals", "playerGoals") or 0,
            "assists": numeric(match, "assists", "playerAssists") or 0,
            "yellow_cards": 1 if yellow or second_yellow else 0,
            "red_cards": 1 if red or second_yellow else 0,
            "payload": raw_payload,
        }})
        saved += 1
    return saved


def load_supabase_current_season_matches(tm_id: str, season_id: str) -> list[dict[str, Any]]:
    """Use an existing current-season Felipe snapshot only for the matching season."""
    if str(season_id) != str(TM_SEASON):
        return []
    rows = db_get(
        "tm_players?select=current_season_payload"
        f"&tm_id=eq.{quote(str(tm_id), safe='')}&limit=1"
    )
    if not rows or not isinstance(rows[0].get("current_season_payload"), dict):
        return []
    matches = rows[0]["current_season_payload"].get("matches")
    return [row for row in matches if isinstance(row, dict)] if isinstance(matches, list) else []


def seed_felipe_history_fallback() -> int:
    """Continue from Supabase season squads, using Felipe API for roster and match gaps."""
    if not FELIPE_API_BASE:
        LOG.warning("Felipe API fallback atlandı: FELIPE_API_BASE tanımlı değil.")
        return 0

    wanted = list(dict.fromkeys(DCARIBOU_COMPETITIONS))
    seasons = list(dict.fromkeys(str(value) for value in (DCARIBOU_SEASONS or [])))
    if str(TM_SEASON) not in seasons:
        seasons.append(str(TM_SEASON))
    players_by_season: dict[tuple[str, str], dict[str, Any]] = {}
    supabase_roster_rows = 0
    api_roster_rows = 0
    roster_failures: list[str] = []

    for competition_id in wanted:
        for season_id in seasons:
            try:
                roster_rows = load_supabase_history_roster(competition_id, season_id)
            except Exception as exc:
                LOG.warning(
                    "Supabase geçmiş kadro okunamadı (%s/%s); Felipe API denenecek: %s",
                    competition_id, season_id, safe_error_for_log(exc),
                )
                roster_rows = []
            if roster_rows:
                supabase_roster_rows += len(roster_rows)
                LOG.info(
                    "Geçmiş kadro kaynağı=Supabase: %s/%s oyuncu-kulüp satırı=%s",
                    competition_id, season_id, len(roster_rows),
                )
            else:
                LOG.info(
                    "Supabase geçmiş kadrosu yok (%s/%s); Felipe API competition/clubs/players fallback başlıyor.",
                    competition_id, season_id,
                )
                try:
                    roster_rows = fetch_felipe_history_roster(competition_id, season_id)
                except Exception as exc:
                    roster_failures.append(f"{competition_id}/{season_id}: {safe_error_for_log(exc)}")
                    LOG.warning(
                        "Felipe API geçmiş kadro fallback başarısız (%s/%s): %s",
                        competition_id, season_id, safe_error_for_log(exc),
                    )
                    continue
                api_roster_rows += len(roster_rows)
                if not roster_rows:
                    roster_failures.append(
                        f"{competition_id}/{season_id}: Supabase ve Felipe API boş kadro döndürdü"
                    )
                    LOG.warning(
                        "%s/%s için Supabase veya Felipe API oyuncu kadrosu bulunamadı; mevcut veriler korundu ve devam kuyruğuna bırakıldı.",
                        competition_id, season_id,
                    )
                    continue

            for row in roster_rows:
                tm_id = safe_text(row.get("tm_id"), row.get("player_id"), row.get("playerId"))
                season = safe_text(row.get("season_id"), row.get("seasonId")) or str(season_id)
                if not tm_id or not str(tm_id).isdigit():
                    continue
                key = (str(tm_id), season)
                current = players_by_season.setdefault(key, {
                    "tm_id": str(tm_id),
                    "season_id": season,
                    "competition_name": safe_text(row.get("competition_name"), row.get("competitionName")),
                })
                if not current.get("competition_name"):
                    current["competition_name"] = safe_text(row.get("competition_name"), row.get("competitionName"))

    if not players_by_season:
        message = (
            "Felipe/Supabase fallback için oyuncu-sezon çifti bulunamadı. "
            "dcaribou boş sonucu hiçbir mevcut kaydı silmedi."
        )
        if roster_failures:
            raise RuntimeError(message + " Kadro kaynak hataları: " + " | ".join(roster_failures[:8]))
        LOG.warning(message)
        return 0

    completed = load_felipe_history_checkpoints()
    refresh_current_season = os.getenv("TM_HISTORY_REFRESH_CURRENT_SEASON", "false").strip().lower() in {
        "1", "true", "yes", "on"
    }
    pending = [
        (tm_id, season_id, player)
        for (tm_id, season_id), player in sorted(
            players_by_season.items(), key=lambda item: (item[0][1], item[0][0])
        )
        if history_appearance_needs_refresh(
            season_id, tm_id, completed, refresh_current_season=refresh_current_season
        )
    ]
    max_pairs = max(1, int(os.getenv("FELIPE_HISTORY_MAX_PLAYER_SEASONS_PER_RUN", "1200")))
    max_runtime = max(60, int(os.getenv("FELIPE_HISTORY_MAX_RUNTIME_SECONDS", "19800")))
    started = time.monotonic()
    saved_rows = 0
    completed_pairs = 0
    failed_pairs = 0
    stopped_for_limit = False

    LOG.info(
        "Felipe tarihsel maç fallback: Supabase kadro satırı=%s, API kadro satırı=%s, "
        "tekil oyuncu-sezon=%s, checkpoint tamamlanan=%s, bekleyen=%s",
        supabase_roster_rows, api_roster_rows, len(players_by_season),
        len(completed), len(pending),
    )

    for index, (tm_id, season_id, player) in enumerate(pending, 1):
        if completed_pairs >= max_pairs or time.monotonic() - started >= max_runtime:
            stopped_for_limit = True
            break
        try:
            matches = fetch_felipe_player_season_matches(tm_id, season_id)
            source_name = "felipeall_api"
        except Exception as api_exc:
            try:
                matches = load_supabase_current_season_matches(tm_id, season_id)
            except Exception as db_exc:
                matches = []
                LOG.warning(
                    "Oyuncu %s/%s: Felipe API hatası=%s; Supabase maç snapshot hatası=%s",
                    tm_id, season_id, safe_error_for_log(api_exc), safe_error_for_log(db_exc),
                )
            if not matches:
                failed_pairs += 1
                LOG.warning(
                    "Oyuncu %s/%s maç geçmişi alınamadı; checkpoint yazılmadı ve sonraki çalışmada tekrar denenecek: %s",
                    tm_id, season_id, safe_error_for_log(api_exc),
                )
                continue
            source_name = "supabase_current_season_snapshot"
            LOG.warning(
                "Oyuncu %s/%s maçları mevcut Supabase snapshot'ından alındı; API yanıtı kullanılamadı.",
                tm_id, season_id,
            )

        saved = persist_felipe_history_appearances(
            tm_id, season_id, matches, player.get("competition_name")
        )
        saved_rows += saved
        mark_felipe_history_checkpoint(
            season_id, tm_id, appearance_rows=saved, source_name=source_name
        )
        completed.add(history_checkpoint_key(season_id, tm_id))
        completed_pairs += 1
        if index == 1 or index % 50 == 0:
            LOG.info(
                "Felipe tarihsel maç ilerleme: %s/%s oyuncu-sezon | yeni maç satırı=%s",
                index, len(pending), saved_rows,
            )

    remaining = max(0, len(pending) - completed_pairs)
    LOG.info(
        "Felipe tarihsel maç fallback sonucu: tamamlanan=%s, başarısız/tekrar bekleyen=%s, "
        "kalan=%s, yeni maç satırı=%s, kadro-kaynak-hatası=%s",
        completed_pairs, failed_pairs, remaining, saved_rows, len(roster_failures),
    )

    # Only finish green when any remaining work has a confirmed continuation.
    # A continuation does not force-refresh the active season again; checkpoints
    # therefore move monotonically through the season/competition backlog.
    continuation_required = remaining > 0 or bool(roster_failures)
    if continuation_required:
        depth = int(os.getenv("TM_HISTORY_CONTINUATION_DEPTH", "0") or "0")
        max_depth = max(1, int(os.getenv("TM_HISTORY_MAX_CONTINUATIONS", "20")))
        if depth >= max_depth:
            raise RuntimeError(
                f"Maç geçmişi ön-doldurması {depth} devam çalışmasına ulaştı; "
                f"kalan oyuncu-sezon={remaining}, API hatası={failed_pairs}, "
                f"kadro hatası={len(roster_failures)}. Checkpoint'ler korundu; manuel yeniden başlatma gerekiyor."
            )
        continuation_inputs = {
            "competitions": ",".join(wanted),
            "seasons": ",".join(seasons),
            "continuation_depth": str(depth + 1),
            "refresh_current_season": "false",
        }
        queued = dispatch_refresh_details_continuation(
            workflow_file="seed-player-appearances.yml",
            inputs=continuation_inputs,
        )
        if not queued:
            raise RuntimeError(
                f"Maç geçmişinde {remaining} oyuncu-sezon işi kaldı ancak GitHub devam çalışmasını kuyruğa alamadı. "
                "Mevcut checkpoint'ler korundu; Actions üzerinden aynı workflow yeniden başlatılabilir."
            )
        LOG.warning(
            "Maç geçmişi bu parçada kısmi işlendi; devam çalışması kabul edildi. "
            "Tamamlanan=%s, tekrar bekleyen=%s, kalan=%s, devam derinliği=%s.",
            completed_pairs, failed_pairs, remaining, depth + 1,
        )
    else:
        LOG.info("Maç geçmişi ön-doldurma kuyruğu tamamlandı; bekleyen oyuncu-sezon kaydı yok.")

    return saved_rows


def seed_dcaribou_history() -> int:
    """Try dcaribou first; Felipe API/Supabase is mandatory fallback."""
    dcaribou_count = 0
    try:
        dcaribou_count = _seed_dcaribou_history_scraper()
        LOG.info("dcaribou seed tamamlandı: işlenen yeni oyuncu profili=%s", dcaribou_count)
    except Exception as exc:
        LOG.warning(
            "dcaribou geçmiş kaynağı kullanılamadı; Felipe API/Supabase fallback ile devam ediliyor: %s",
            safe_error_for_log(exc),
        )

    # Do not swallow a failed API/Supabase pass. logged_run must mark the run
    # failed instead of converting a connection reset into a false green check.
    try:
        felipe_count = seed_felipe_history_fallback()
    except Exception as exc:
        LOG.error(
            "Felipe API/Supabase geçmiş ön-doldurması başarısız; checkpoint'ler ve mevcut kayıtlar korundu: %s",
            safe_error_for_log(exc),
        )
        raise RuntimeError(
            "Felipe API/Supabase geçmiş ön-doldurması tamamlanamadı; güvenli şekilde yeniden çalıştırılmalı."
        ) from exc

    LOG.info(
        "seed-history bu parçada tamamlandı: dcaribou profilleri=%s, Felipe/Supabase maç satırları=%s",
        dcaribou_count, felipe_count,
    )
    return dcaribou_count + felipe_count



def parse_preseed_player_ids(raw: str | None) -> list[str]:
    """Parse a comma/semicolon/whitespace-separated Transfermarkt player ID list."""
    tokens = [item for item in re.split(r"[\s,;]+", str(raw or "").strip()) if item]
    invalid = [item for item in tokens if not re.fullmatch(r"\d+", item)]
    if invalid:
        raise RuntimeError("Geçersiz Transfermarkt oyuncu ID'si: " + ", ".join(invalid[:10]))
    ids = list(dict.fromkeys(tokens))
    maximum = max(1, int(os.getenv("TM_PRESEED_MAX_PLAYERS", "20")))
    if len(ids) > maximum:
        raise RuntimeError(
            f"Tek ön doldurma çalışmasında en fazla {maximum} oyuncu destekleniyor; "
            f"gelen={len(ids)}. Listeyi birkaç çalışmaya bölün."
        )
    return ids


def parse_player_match_seasons(raw_seasons: str | None) -> list[str]:
    """Parse a bounded list of Felipe season IDs for targeted match-history seeding."""
    raw = str(raw_seasons or TM_SEASON).strip()
    tokens = [item for item in re.split(r"[\s,;]+", raw) if item]
    if not tokens:
        tokens = [str(TM_SEASON)]
    invalid = [item for item in tokens if not re.fullmatch(r"\d{4}", item)]
    if invalid:
        raise RuntimeError("Geçersiz sezon ID'si: " + ", ".join(invalid[:10]))
    seasons = list(dict.fromkeys(tokens))
    if len(seasons) > 12:
        raise RuntimeError("Tek çalışmada en fazla 12 sezon destekleniyor.")
    if any(int(season) < 1900 or int(season) > 9999 for season in seasons):
        raise RuntimeError("Sezon ID'leri dört basamaklı yıl olmalı.")
    return seasons


def sync_player_match_history(raw_player_ids: str | None, raw_seasons: str | None) -> int:
    """Fetch explicit Felipe player/season match lists and persist played appearances."""
    player_ids = parse_preseed_player_ids(raw_player_ids)
    seasons = parse_player_match_seasons(raw_seasons)
    if not player_ids:
        raise RuntimeError(
            "Maç geçmişi için --player-ids veya TM_PRESEED_PLAYER_IDS ile oyuncu ID'leri verin."
        )
    total_saved = 0
    missing_ids: list[str] = []
    for index, player_id in enumerate(player_ids, 1):
        rows = db_get(
            f"tm_players?select=tm_id,name&tm_id=eq.{quote(player_id)}&limit=1"
        )
        if not rows:
            missing_ids.append(player_id)
            LOG.warning("Maç geçmişi atlandı: oyuncu tm_players tablosunda yok (ID=%s).", player_id)
            continue
        player_name = rows[0].get("name") or player_id
        for season_id in seasons:
            LOG.info(
                "Felipe oyuncu maç geçmişi: %s/%s | %s | ID=%s | sezon=%s",
                index, len(player_ids), player_name, player_id, season_id,
            )
            matches = fetch_felipe_player_season_matches(player_id, season_id)
            saved = persist_felipe_history_appearances(player_id, season_id, matches)
            total_saved += saved
            source_record_snapshot(
                "felipeall", "player_season_matches", player_id, season_id,
                {
                    "season_id": season_id,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "matches": matches,
                },
            )
            LOG.info(
                "Felipe oyuncu sezonu tamamlandı: ID=%s | sezon=%s | API maç satırı=%s | oynanmış maç=%s",
                player_id, season_id, len(matches), saved,
            )
    if missing_ids:
        raise RuntimeError("tm_players içinde bulunmayan oyuncular: " + ", ".join(missing_ids))
    return total_saved


def sync_preseed_players(raw_player_ids: str | None) -> int:
    """Force-refresh full Felipe player details; also seeds current-season appearances."""
    player_ids = parse_preseed_player_ids(raw_player_ids)
    if not player_ids:
        raise RuntimeError(
            "Ön doldurma için --player-ids veya TM_PRESEED_PLAYER_IDS ile "
            "virgülle ayrılmış Transfermarkt oyuncu ID'leri verin."
        )
    successful = 0
    missing_ids: list[str] = []
    failed_ids: list[str] = []
    for index, player_id in enumerate(player_ids, 1):
        rows = db_get(
            f"tm_players?select=tm_id,name&tm_id=eq.{quote(player_id)}&limit=1"
        )
        if not rows:
            missing_ids.append(player_id)
            LOG.warning(
                "Ön doldurma atlandı: oyuncu tm_players tablosunda yok (%s/%s, ID=%s).",
                index, len(player_ids), player_id,
            )
            continue
        player_name = rows[0].get("name") or player_id
        LOG.info(
            "Ön doldurma başlıyor: %s/%s | %s | Transfermarkt ID=%s",
            index, len(player_ids), player_name, player_id,
        )
        sync_started = datetime.now(timezone.utc) - timedelta(seconds=5)
        sync_felipeall(only_player=player_id, missing_only=False)
        latest = db_get(
            f"tm_players?select=last_felipe_synced_at&tm_id=eq.{quote(player_id)}&limit=1"
        )
        stamp = latest[0].get("last_felipe_synced_at") if latest else None
        try:
            parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")) if stamp else None
            if parsed and parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            parsed = None
        if parsed and parsed >= sync_started:
            successful += 1
            LOG.info("Ön doldurma doğrulandı: %s (ID=%s).", player_name, player_id)
        else:
            failed_ids.append(player_id)
            LOG.error(
                "Ön doldurma tamamlanamadı/doğrulanamadı: %s (ID=%s).",
                player_name, player_id,
            )
    LOG.info(
        "Ön doldurma tamamlandı: listede=%s, hazır/doğrulanmış=%s, bulunmayan=%s, başarısız=%s.",
        len(player_ids), successful, len(missing_ids), len(failed_ids),
    )
    if missing_ids or failed_ids:
        parts = []
        if missing_ids:
            parts.append("tm_players içinde bulunmayan: " + ", ".join(missing_ids))
        if failed_ids:
            parts.append("detayları doğrulanamayan: " + ", ".join(failed_ids))
        raise RuntimeError("Ön doldurma kısmi tamamlandı; " + " | ".join(parts))
    return successful


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("sync", "import-squads", "refresh-details", "refresh-imported-details", "refresh-rotation", "seed-history", "one-player-test", "refresh-player-missing", "preseed-players", "seed-player-matches", "has-pending-details"))
    parser.add_argument("--player-id", default=os.getenv("TM_TEST_PLAYER_ID", ""))
    parser.add_argument("--player-ids", default=os.getenv("TM_PRESEED_PLAYER_IDS", ""))
    parser.add_argument("--seasons", default=os.getenv("TM_PRESEED_SEASONS", str(TM_SEASON)))
    args = parser.parse_args()
    require_db()
    if args.mode == "preseed-players":
        logged_run(
            "felipeall", "preseed-players",
            lambda: sync_preseed_players(args.player_ids or args.player_id),
        )
        return 0
    if args.mode == "seed-player-matches":
        logged_run(
            "felipeall", "seed-player-matches",
            lambda: sync_player_match_history(args.player_ids or args.player_id, args.seasons),
        )
        return 0
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
                missing_only=bool(os.getenv("TM_DETAIL_COMPETITION_ID", "").strip()),
                squad_seen_after=seen_after or None,
                squad_seen_before=seen_before or None,
            ),
        )
        return 0
    if args.mode == "refresh-rotation":
        logged_run("felipeall", "refresh-rotation", sync_felipeall)
        return 0
    if args.mode in ("one-player-test", "refresh-player-missing"):
        if not re.fullmatch(r"\d+", str(args.player_id or "")):
            raise RuntimeError(f"{args.mode} için --player-id veya TM_TEST_PLAYER_ID olarak Transfermarkt oyuncu ID'si gerekli.")
        if not db_get(f"tm_players?select=tm_id&tm_id=eq.{quote(str(args.player_id))}&limit=1"):
            raise RuntimeError("Oyuncu önce tm_players tablosuna aktarılmalı.")
        if args.mode == "refresh-player-missing":
            logged_run("felipeall", "refresh-player-missing",
                       lambda: sync_felipeall(only_player=str(args.player_id), missing_only=True))
        else:
            logged_run("felipeall", "one-player-test",
                       lambda: sync_felipeall(only_player=str(args.player_id)))
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

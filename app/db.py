"""Asynchronous SQLite store using aiosqlite. Multi-report model.

- `reports`: named report containers. Rows are soft-deleted only; no automatic
  pruning removes report data beyond MAX_REPORTS (25).
- `inventory`: running weight balance per (report, tovar turi). Each new report
  starts every type at 0.
- `activity`: append-only log of every reys/adjust, scoped to a report.
- `entry_photos`: photo metadata with Cloudflare R2 key/url and local storage fallback.
- `send_queue`: durable outbox for Telegram channel sends.

All database queries are non-blocking async with WAL mode and asyncio serialization.
"""
from __future__ import annotations

import asyncio
import math
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import aiosqlite

from . import config

_DB = config.DATA_DIR / "reys.db"
_LOCK: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _LOCK
    if _LOCK is None:
        _LOCK = asyncio.Lock()
    return _LOCK


DEFAULT_TYPES = [
    "akb", "triton", "izi", "navo", "xabib", "jet", "jon", "top", "uztez", "mandarin",
    "oneway", "x637", "x517", "redwing",
]
DEFAULT_TYPE_SET = {t.lower() for t in DEFAULT_TYPES}
MAX_REPORTS = config.MAX_REPORTS


class InsufficientStock(Exception):
    def __init__(self, tovar_turi: str, have: float, need: float):
        self.tovar_turi = tovar_turi
        self.have = have
        self.need = need
        super().__init__(f"insufficient stock in {tovar_turi}: have {have}, need {need}")


class DuplicateName(Exception):
    pass


class MaxReportsReached(Exception):
    pass


class ReportNotFound(Exception):
    pass


class ActivityNotFound(Exception):
    pass


OBSHIY_ACTIONS = {"top", "topchiqgan", "bizda", "chiqgan"}


def _clean_type(name: str) -> str:
    return str(name or "").strip().lower()


def _is_default_type(name: str) -> bool:
    return _clean_type(name) in DEFAULT_TYPE_SET


async def _ensure_custom_type(c: aiosqlite.Connection, name: str) -> str:
    name = _clean_type(name)
    if name and not _is_default_type(name):
        now = int(time.time())
        await c.execute(
            """INSERT INTO custom_types(name, created_at, deleted_at)
               VALUES(?, ?, NULL)
               ON CONFLICT(name) DO UPDATE SET deleted_at = NULL""",
            (name, now),
        )
    return name


async def _active_custom_types(c: aiosqlite.Connection) -> list[str]:
    async with c.execute("SELECT name FROM custom_types WHERE deleted_at IS NULL ORDER BY name") as cur:
        rows = await cur.fetchall()
        return [r["name"] for r in rows]


async def _all_type_names(c: aiosqlite.Connection) -> list[str]:
    out = list(DEFAULT_TYPES)
    seen = {_clean_type(t) for t in out}
    for name in await _active_custom_types(c):
        if name not in seen:
            out.append(name)
            seen.add(name)
    return out


@asynccontextmanager
async def _db() -> AsyncGenerator[aiosqlite.Connection, None]:
    async with _get_lock():
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(_DB)
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA synchronous=NORMAL")
        await conn.execute("PRAGMA busy_timeout=5000")
        await conn.execute("PRAGMA cache_size=-64000")
        await conn.execute("PRAGMA temp_store=MEMORY")
        try:
            yield conn
            await conn.commit()
        finally:
            await conn.close()


async def _columns(c: aiosqlite.Connection, table: str) -> set[str]:
    async with c.execute(f"PRAGMA table_info({table})") as cur:
        rows = await cur.fetchall()
        return {r[1] for r in rows}


async def _add_column(c: aiosqlite.Connection, table: str, name: str, decl: str) -> None:
    cols = await _columns(c, table)
    if name not in cols:
        await c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


async def _backfill_photo_blobs(c: aiosqlite.Connection) -> None:
    async with c.execute("SELECT entry_id, idx FROM entry_photos WHERE data IS NULL ORDER BY entry_id, idx") as cur:
        rows = await cur.fetchall()
    for r in rows:
        p = _entry_dir(r["entry_id"]) / str(r["idx"])
        if p.exists():
            try:
                await c.execute(
                    "UPDATE entry_photos SET data = ? WHERE entry_id = ? AND idx = ?",
                    (p.read_bytes(), r["entry_id"], r["idx"]),
                )
            except OSError:
                pass


async def init() -> None:
    async with _db() as c:
        for tbl in ("inventory", "activity"):
            cols = await _columns(c, tbl)
            if cols and "report_id" not in cols:
                backup = f"{tbl}_legacy_{int(time.time())}"
                await c.execute(f"ALTER TABLE {tbl} RENAME TO {backup}")

        await c.execute(
            """CREATE TABLE IF NOT EXISTS reports(
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 name       TEXT NOT NULL UNIQUE,
                 created_at INTEGER NOT NULL,
                 deleted_at INTEGER)"""
        )
        await c.execute(
            """CREATE TABLE IF NOT EXISTS inventory(
                 report_id  INTEGER NOT NULL,
                 tovar_turi TEXT NOT NULL,
                 weight     REAL NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (report_id, tovar_turi))"""
        )
        await c.execute(
            """CREATE TABLE IF NOT EXISTS activity(
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 report_id   INTEGER NOT NULL,
                 ts          INTEGER NOT NULL,
                 actor       TEXT NOT NULL,
                 action      TEXT NOT NULL,
                 tovar_turi  TEXT,
                 from_type   TEXT,
                 to_type     TEXT,
                 weight      REAL,
                 coefficient REAL,
                 net         REAL,
                 photos      INTEGER,
                 edited_at   INTEGER,
                 deleted_at  INTEGER)"""
        )
        await c.execute(
            """CREATE TABLE IF NOT EXISTS custom_types(
                 name       TEXT PRIMARY KEY,
                 created_at INTEGER NOT NULL,
                 deleted_at INTEGER)"""
        )
        await _add_column(c, "reports", "deleted_at", "INTEGER")
        await _add_column(c, "reports", "special_name", "TEXT")
        await _add_column(c, "activity", "edited_at", "INTEGER")
        await _add_column(c, "activity", "deleted_at", "INTEGER")
        await _add_column(c, "activity", "box_weight", "REAL")
        await c.execute("CREATE INDEX IF NOT EXISTS idx_activity_report ON activity(report_id, id)")
        await c.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations(
                 name       TEXT PRIMARY KEY,
                 applied_at INTEGER NOT NULL)"""
        )

        await c.execute(
            """CREATE TABLE IF NOT EXISTS entry_photos(
                 entry_id INTEGER NOT NULL,
                 idx      INTEGER NOT NULL,
                 mime     TEXT NOT NULL,
                 data     BLOB,
                 telegram_file_id TEXT,
                 telegram_unique_id TEXT,
                 telegram_message_id INTEGER,
                 telegram_sent_at INTEGER,
                 r2_key   TEXT,
                 r2_url   TEXT,
                 PRIMARY KEY (entry_id, idx))"""
        )
        await _add_column(c, "entry_photos", "data", "BLOB")
        await _add_column(c, "entry_photos", "telegram_file_id", "TEXT")
        await _add_column(c, "entry_photos", "telegram_unique_id", "TEXT")
        await _add_column(c, "entry_photos", "telegram_message_id", "INTEGER")
        await _add_column(c, "entry_photos", "telegram_sent_at", "INTEGER")
        await _add_column(c, "entry_photos", "r2_key", "TEXT")
        await _add_column(c, "entry_photos", "r2_url", "TEXT")
        await _backfill_photo_blobs(c)

        await c.execute(
            """CREATE TABLE IF NOT EXISTS send_queue(
                 entry_id   INTEGER PRIMARY KEY,
                 status     TEXT NOT NULL DEFAULT 'pending',
                 attempts   INTEGER NOT NULL DEFAULT 0,
                 next_at    INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 last_attempt_at INTEGER,
                 last_error_at INTEGER,
                 created_at INTEGER NOT NULL)"""
        )
        await _add_column(c, "send_queue", "last_attempt_at", "INTEGER")
        await _add_column(c, "send_queue", "last_error_at", "INTEGER")
        await c.execute("CREATE INDEX IF NOT EXISTS idx_queue_pending ON send_queue(status, next_at)")
        await c.execute(
            """CREATE TABLE IF NOT EXISTS app_settings(
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL)"""
        )

        fin = "({c} IS NOT NULL AND {c} > -1e308 AND {c} < 1e308)"
        await c.execute(f"UPDATE inventory SET weight = 0 WHERE NOT {fin.format(c='weight')}")
        for col in ("weight", "coefficient", "net", "box_weight"):
            await c.execute(
                f"UPDATE activity SET {col} = 0 "
                f"WHERE {col} IS NOT NULL AND NOT {fin.format(c=col)}"
            )

        top_restore = "restore_top_obshiy_net_20260704"
        async with c.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (top_restore,)) as cur:
            if await cur.fetchone() is None:
                await c.execute(
                    """UPDATE activity
                       SET coefficient = 0,
                           net = weight
                       WHERE action = 'top'
                         AND weight IS NOT NULL
                         AND (coefficient IS NOT NULL OR net IS NOT NULL)"""
                )
                await c.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)",
                    (top_restore, int(time.time())),
                )

        obshiy_box_restore = "restore_obshiy_box_weight_20260709"
        async with c.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (obshiy_box_restore,)) as cur:
            if await cur.fetchone() is None:
                await c.execute(
                    """UPDATE activity
                       SET box_weight = CASE
                             WHEN COALESCE(box_weight, 0) > 0 THEN box_weight
                             ELSE COALESCE(coefficient, 0)
                           END,
                           coefficient = 0,
                           net = weight
                       WHERE action IN ('top', 'topchiqgan', 'bizda', 'chiqgan')
                         AND weight IS NOT NULL
                         AND (
                           COALESCE(coefficient, 0) <> 0
                           OR COALESCE(net, weight) <> weight
                         )"""
                )
                await c.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)",
                    (obshiy_box_restore, int(time.time())),
                )

        custom_backfill = "custom_types_backfill_20260708"
        async with c.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (custom_backfill,)) as cur:
            if await cur.fetchone() is None:
                async with c.execute(
                    """SELECT tovar_turi AS name FROM activity WHERE action = 'reys' AND tovar_turi IS NOT NULL
                       UNION SELECT from_type FROM activity WHERE action = 'adjust' AND from_type IS NOT NULL
                       UNION SELECT to_type FROM activity WHERE action = 'adjust' AND to_type IS NOT NULL"""
                ) as rcur:
                    rows = await rcur.fetchall()
                for row in rows:
                    await _ensure_custom_type(c, row["name"])
                await c.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)",
                    (custom_backfill, int(time.time())),
                )

        custom_prune = "custom_types_prune_obshiy_codes_20260708"
        async with c.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (custom_prune,)) as cur:
            if await cur.fetchone() is None:
                async with c.execute(
                    """SELECT tovar_turi AS name FROM activity WHERE action = 'reys' AND tovar_turi IS NOT NULL
                       UNION SELECT from_type FROM activity WHERE action = 'adjust' AND from_type IS NOT NULL
                       UNION SELECT to_type FROM activity WHERE action = 'adjust' AND to_type IS NOT NULL
                       UNION SELECT tovar_turi FROM inventory WHERE ABS(COALESCE(weight, 0)) > 0.0001"""
                ) as pcur:
                    product_rows = await pcur.fetchall()
                product_names = {_clean_type(r["name"]) for r in product_rows if _clean_type(r["name"])}
                async with c.execute("SELECT name FROM custom_types WHERE deleted_at IS NULL") as ccur:
                    crows = await ccur.fetchall()
                for row in crows:
                    name = _clean_type(row["name"])
                    if name and not _is_default_type(name) and name not in product_names:
                        await c.execute("UPDATE custom_types SET deleted_at = ? WHERE name = ?", (int(time.time()), name))
                        await c.execute(
                            "DELETE FROM inventory WHERE tovar_turi = ? AND ABS(COALESCE(weight, 0)) <= 0.0001",
                            (name,),
                        )
                await c.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)",
                    (custom_prune, int(time.time())),
                )

        now = int(time.time())
        async with c.execute("SELECT id FROM reports") as rcur:
            report_rows = await rcur.fetchall()
        for report in report_rows:
            for tovar_turi in await _all_type_names(c):
                await c.execute(
                    "INSERT OR IGNORE INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
                    (report["id"], tovar_turi, now),
                )


async def get_setting(key: str, default: str = "") -> str:
    async with _db() as c:
        async with c.execute("SELECT value FROM app_settings WHERE key = ?", (key,)) as cur:
            row = await cur.fetchone()
            return str(row["value"]) if row else default


async def set_setting(key: str, value: str) -> None:
    async with _db() as c:
        await c.execute(
            """INSERT INTO app_settings(key, value)
               VALUES(?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (key, str(value)),
        )


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------
async def _prune(c: aiosqlite.Connection) -> None:
    """Keep only newest MAX_REPORTS reports, hard-deleting older ones."""
    async with c.execute(
        """SELECT id FROM reports
           WHERE deleted_at IS NULL
           ORDER BY created_at ASC, id ASC"""
    ) as cur:
        rows = await cur.fetchall()
    excess = len(rows) - MAX_REPORTS
    if excess <= 0:
        return
    old_ids = [r["id"] for r in rows[:excess]]
    placeholders = ",".join("?" for _ in old_ids)
    async with c.execute(
        f"SELECT id FROM activity WHERE report_id IN ({placeholders})",
        old_ids,
    ) as ecur:
        entry_rows = await ecur.fetchall()
    entry_ids = [r["id"] for r in entry_rows]
    if entry_ids:
        entry_placeholders = ",".join("?" for _ in entry_ids)
        # Gather R2 keys for deletion
        async with c.execute(
            f"SELECT r2_key FROM entry_photos WHERE entry_id IN ({entry_placeholders}) AND r2_key IS NOT NULL",
            entry_ids,
        ) as kcur:
            key_rows = await kcur.fetchall()
            r2_keys = [k["r2_key"] for k in key_rows if k["r2_key"]]
        if r2_keys:
            from . import storage
            asyncio.create_task(storage.delete_photos(r2_keys))

        await c.execute(f"DELETE FROM send_queue WHERE entry_id IN ({entry_placeholders})", entry_ids)
        await c.execute(f"DELETE FROM entry_photos WHERE entry_id IN ({entry_placeholders})", entry_ids)
        for entry_id in entry_ids:
            _rmtree_photos(entry_id)
    await c.execute(f"DELETE FROM activity WHERE report_id IN ({placeholders})", old_ids)
    await c.execute(f"DELETE FROM inventory WHERE report_id IN ({placeholders})", old_ids)
    await c.execute(f"DELETE FROM reports WHERE id IN ({placeholders})", old_ids)


async def create_report(name: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("empty name")
    now = int(time.time())
    async with _db() as c:
        async with c.execute("SELECT 1 FROM reports WHERE name = ? COLLATE NOCASE", (name,)) as cur:
            exists = await cur.fetchone()
        if exists:
            raise DuplicateName(name)
        cur = await c.execute("INSERT INTO reports(name, created_at) VALUES(?, ?)", (name, now))
        rid = cur.lastrowid
        for t in await _all_type_names(c):
            await c.execute(
                "INSERT INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
                (rid, t, now),
            )
        await _prune(c)
        return {"id": rid, "name": name, "created_at": now}


async def list_reports() -> list[dict]:
    async with _db() as c:
        async with c.execute(
            """SELECT r.id, r.name, r.created_at, r.special_name,
                      (SELECT COUNT(*) FROM activity a
                       WHERE a.report_id = r.id AND a.deleted_at IS NULL) AS entries
               FROM reports r WHERE r.deleted_at IS NULL ORDER BY r.id DESC"""
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def report_exists(report_id: int) -> bool:
    async with _db() as c:
        async with c.execute(
            "SELECT 1 FROM reports WHERE id = ? AND deleted_at IS NULL", (report_id,)
        ) as cur:
            return (await cur.fetchone()) is not None


async def delete_report(report_id: int) -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute("UPDATE reports SET deleted_at = ? WHERE id = ?", (now, report_id))
        await c.execute(
            """UPDATE send_queue
               SET status = 'canceled',
                   last_error = 'report soft-deleted',
                   last_attempt_at = ?,
                   last_error_at = ?
               WHERE entry_id IN (SELECT id FROM activity WHERE report_id = ?)
                 AND status = 'pending'""",
            (now, now, report_id),
        )


async def rename_report(report_id: int, new_name: str) -> dict:
    new_name = new_name.strip()
    if not new_name:
        raise ValueError("empty name")
    if len(new_name) > 60:
        raise ValueError("name too long")
    async with _db() as c:
        async with c.execute("SELECT id, name FROM reports WHERE id = ? AND deleted_at IS NULL", (report_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise ReportNotFound(f"report {report_id} not found")
        if row["name"] == new_name:
            return {"id": report_id, "name": new_name}
        async with c.execute(
            "SELECT 1 FROM reports WHERE name = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL",
            (new_name, report_id),
        ) as cur:
            exists = await cur.fetchone()
        if exists:
            raise DuplicateName(new_name)
        await c.execute("UPDATE reports SET name = ? WHERE id = ?", (new_name, report_id))
        return {"id": report_id, "name": new_name}


async def set_report_special_name(report_id: int, special_name: str | None) -> dict:
    clean = (special_name or "").strip()
    if len(clean) > 60:
        raise ValueError("maxsus reys nomi 60 ta belgidan oshmasligi kerak")
    val = clean if clean else None
    async with _db() as c:
        async with c.execute("SELECT id, name FROM reports WHERE id = ? AND deleted_at IS NULL", (report_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise ReportNotFound(f"report {report_id} not found")
        await c.execute("UPDATE reports SET special_name = ? WHERE id = ?", (val, report_id))
        return {"id": report_id, "special_name": val}


async def list_types() -> dict:
    async with _db() as c:
        custom = await _active_custom_types(c)
    return {"default": list(DEFAULT_TYPES), "custom": custom, "types": list(DEFAULT_TYPES) + custom}


async def add_custom_type(name: str) -> str:
    name = _clean_type(name)
    if not name:
        raise ValueError("empty type")
    now = int(time.time())
    async with _db() as c:
        if _is_default_type(name):
            return name
        await c.execute(
            """INSERT INTO custom_types(name, created_at, deleted_at)
               VALUES(?, ?, NULL)
               ON CONFLICT(name) DO UPDATE SET deleted_at = NULL""",
            (name, now),
        )
        async with c.execute("SELECT id FROM reports WHERE deleted_at IS NULL") as cur:
            reports = await cur.fetchall()
        for report in reports:
            await c.execute(
                "INSERT OR IGNORE INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
                (report["id"], name, now),
            )
    return name


async def delete_custom_type(name: str) -> None:
    name = _clean_type(name)
    if not name:
        raise ValueError("empty type")
    if _is_default_type(name):
        raise ValueError("default type")
    async with _db() as c:
        await c.execute(
            "UPDATE custom_types SET deleted_at = ? WHERE name = ?",
            (int(time.time()), name),
        )


# --------------------------------------------------------------------------
# Inventory / operations (all scoped to a report)
# --------------------------------------------------------------------------
async def _ensure_type(c: aiosqlite.Connection, report_id: int, t: str) -> None:
    t = await _ensure_custom_type(c, t)
    await c.execute(
        "INSERT OR IGNORE INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
        (report_id, t, int(time.time())),
    )


async def _inventory(c: aiosqlite.Connection, report_id: int) -> dict[str, float]:
    async with c.execute(
        "SELECT tovar_turi, weight FROM inventory WHERE report_id = ? ORDER BY tovar_turi", (report_id,)
    ) as cur:
        rows = await cur.fetchall()
        return {r["tovar_turi"]: r["weight"] for r in rows}


async def get_inventory(report_id: int) -> dict[str, float]:
    async with _db() as c:
        return await _inventory(c, report_id)


async def add_reys(report_id: int, actor: str, tovar_turi: str, weight: float,
                   coefficient: float, net: float, photos: int, box_weight: float = 0) -> dict:
    if not (
        math.isfinite(weight)
        and math.isfinite(coefficient)
        and math.isfinite(net)
        and math.isfinite(box_weight)
    ):
        raise ValueError("non-finite value")
    now = int(time.time())
    async with _db() as c:
        await _ensure_type(c, report_id, tovar_turi)
        await c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (net, now, report_id, tovar_turi),
        )
        cur = await c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, tovar_turi, weight, coefficient, net, photos, box_weight)
               VALUES(?, ?, ?, 'reys', ?, ?, ?, ?, ?, ?)""",
            (report_id, now, actor, tovar_turi, weight, coefficient, net, photos, box_weight),
        )
        async with c.execute(
            "SELECT weight FROM inventory WHERE report_id = ? AND tovar_turi = ?",
            (report_id, tovar_turi),
        ) as bcur:
            bal = (await bcur.fetchone())["weight"]
        inv = await _inventory(c, report_id)
        return {"tovar_turi": tovar_turi, "balance": bal, "inventory": inv, "entry_id": cur.lastrowid}


async def adjust(report_id: int, actor: str, from_type: str, to_type: str, weight: float,
                 photos: int = 0) -> dict:
    if not (math.isfinite(weight) and weight > 0):
        raise ValueError("non-finite value")
    now = int(time.time())
    async with _db() as c:
        await _ensure_type(c, report_id, from_type)
        await _ensure_type(c, report_id, to_type)
        async with c.execute(
            "SELECT weight FROM inventory WHERE report_id = ? AND tovar_turi = ?",
            (report_id, from_type),
        ) as hcur:
            have = (await hcur.fetchone())["weight"]
        if have < weight:
            raise InsufficientStock(from_type, have, weight)
        await c.execute(
            "UPDATE inventory SET weight = weight - ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (weight, now, report_id, from_type),
        )
        await c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (weight, now, report_id, to_type),
        )
        cur = await c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, from_type, to_type, weight, photos)
               VALUES(?, ?, ?, 'adjust', ?, ?, ?, ?)""",
            (report_id, now, actor, from_type, to_type, weight, photos),
        )
        return {"balances": await _inventory(c, report_id), "entry_id": cur.lastrowid}


async def add_obshiy(report_id: int, actor: str, action: str, code: str,
                     weight: float, coefficient: float = 0, net: float | None = None,
                     photos: int = 0, box_weight: float = 0) -> dict:
    if action not in OBSHIY_ACTIONS:
        raise ValueError("bad obshiy action")
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(box_weight) and weight > 0):
        raise ValueError("non-finite value")
    if box_weight <= 0 and coefficient > 0:
        box_weight = coefficient
    coefficient = 0
    net = round(weight, 4)
    now = int(time.time())
    async with _db() as c:
        cur = await c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, tovar_turi, weight, coefficient, net, photos, box_weight)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (report_id, now, actor, action, (code or "").strip(), weight, coefficient, net, photos, box_weight),
        )
        return {"entry_id": cur.lastrowid}


async def fix_report_kg(report_id: int, actor: str, tovar_turi: str, weight_delta: float, note: str = "") -> dict:
    """Manually adjust kg (+/-) for a product type in a report, recording actor in activity audit."""
    if not math.isfinite(weight_delta) or weight_delta == 0:
        raise ValueError("weight delta must be a non-zero finite number")
    raw_type = str(tovar_turi or "").strip().lower()
    if not raw_type:
        raise ValueError("tovar_turi required")
    now = int(time.time())
    clean_note = (note or "").strip()

    async with _db() as c:
        async with c.execute("SELECT id FROM reports WHERE id = ? AND deleted_at IS NULL", (report_id,)) as cur:
            if not await cur.fetchone():
                raise ReportNotFound()

        await c.execute(
            """INSERT INTO inventory(report_id, tovar_turi, weight, updated_at)
               VALUES(?, ?, ?, ?)
               ON CONFLICT(report_id, tovar_turi)
               DO UPDATE SET weight = weight + excluded.weight, updated_at = excluded.updated_at""",
            (report_id, raw_type, weight_delta, now),
        )

        cur = await c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, tovar_turi, from_type, to_type, weight, coefficient, net, photos)
               VALUES(?, ?, ?, 'kg_fix', ?, ?, ?, ?, 0, ?, 0)""",
            (report_id, now, actor, raw_type, clean_note, raw_type, weight_delta, weight_delta),
        )
        entry_id = cur.lastrowid
        new_inv = await _inventory(c, report_id)

    return {"entry_id": entry_id, "balances": new_inv}


# --------------------------------------------------------------------------
# Entry edit / delete (inventory compensated)
# --------------------------------------------------------------------------
_EPS = 1e-9


def _same_num(a, b) -> bool:
    return abs(float(a or 0) - float(b or 0)) <= 1e-9


async def _get_entry(c: aiosqlite.Connection, report_id: int, entry_id: int, action: str):
    async with c.execute(
        "SELECT * FROM activity WHERE id = ? AND report_id = ? AND action = ? AND deleted_at IS NULL",
        (entry_id, report_id, action),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise ActivityNotFound(entry_id)
    return row


async def _apply_balances(c: aiosqlite.Connection, report_id: int, deltas: dict[str, float]) -> dict[str, float]:
    now = int(time.time())
    for t in deltas:
        await _ensure_type(c, report_id, t)
    inv = await _inventory(c, report_id)
    for t, d in deltas.items():
        if inv.get(t, 0) + d < -_EPS:
            raise InsufficientStock(t, inv.get(t, 0), -d)
    for t, d in deltas.items():
        if d:
            await c.execute(
                "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
                (d, now, report_id, t),
            )
    return await _inventory(c, report_id)


async def edit_reys(report_id: int, entry_id: int, tovar_turi: str, weight: float,
                    coefficient: float, net: float, box_weight: float = 0) -> dict:
    if not (
        math.isfinite(weight)
        and math.isfinite(coefficient)
        and math.isfinite(net)
        and math.isfinite(box_weight)
    ):
        raise ValueError("non-finite value")
    now = int(time.time())
    async with _db() as c:
        old = await _get_entry(c, report_id, entry_id, "reys")
        changed = (
            str(old["tovar_turi"] or "") != str(tovar_turi or "")
            or not _same_num(old["weight"], weight)
            or not _same_num(old["coefficient"], coefficient)
            or not _same_num(old["net"], net)
            or not _same_num(old["box_weight"], box_weight)
        )
        inv = await _inventory(c, report_id)
        if not changed:
            return {"balance": inv.get(tovar_turi, 0), "inventory": inv, "edited": False}
        deltas: dict[str, float] = {}
        deltas[old["tovar_turi"]] = deltas.get(old["tovar_turi"], 0) - (old["net"] or 0)
        deltas[tovar_turi] = deltas.get(tovar_turi, 0) + net
        balances = await _apply_balances(c, report_id, deltas)
        await c.execute(
            "UPDATE activity SET tovar_turi = ?, weight = ?, coefficient = ?, net = ?, box_weight = ?, edited_at = ? WHERE id = ?",
            (tovar_turi, weight, coefficient, net, box_weight, now, entry_id),
        )
        return {"balance": balances.get(tovar_turi, 0), "inventory": balances, "edited": True}


async def edit_adjust(report_id: int, entry_id: int, from_type: str, to_type: str,
                      weight: float) -> dict:
    if not (math.isfinite(weight) and weight > 0):
        raise ValueError("non-finite value")
    now = int(time.time())
    async with _db() as c:
        old = await _get_entry(c, report_id, entry_id, "adjust")
        changed = (
            str(old["from_type"] or "") != str(from_type or "")
            or str(old["to_type"] or "") != str(to_type or "")
            or not _same_num(old["weight"], weight)
        )
        if not changed:
            return {"balances": await _inventory(c, report_id), "edited": False}
        deltas: dict[str, float] = {}
        for t, d in ((old["from_type"], old["weight"] or 0), (old["to_type"], -(old["weight"] or 0)),
                     (from_type, -weight), (to_type, weight)):
            deltas[t] = deltas.get(t, 0) + d
        balances = await _apply_balances(c, report_id, deltas)
        await c.execute(
            "UPDATE activity SET from_type = ?, to_type = ?, weight = ?, edited_at = ? WHERE id = ?",
            (from_type, to_type, weight, now, entry_id),
        )
        return {"balances": balances, "edited": True}


async def edit_obshiy(report_id: int, entry_id: int, action: str, code: str,
                      weight: float, coefficient: float = 0, net: float | None = None,
                      box_weight: float = 0) -> dict:
    if action not in OBSHIY_ACTIONS:
        raise ValueError("bad obshiy action")
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(box_weight) and weight > 0):
        raise ValueError("non-finite value")
    if box_weight <= 0 and coefficient > 0:
        box_weight = coefficient
    coefficient = 0
    net = round(weight, 4)
    now = int(time.time())
    async with _db() as c:
        old = await _get_entry(c, report_id, entry_id, action)
        code = (code or "").strip()
        changed = (
            str(old["tovar_turi"] or "") != code
            or not _same_num(old["weight"], weight)
            or not _same_num(old["coefficient"], coefficient)
            or not _same_num(old["net"], net)
            or not _same_num(old["box_weight"], box_weight)
        )
        if not changed:
            return {"entry_id": entry_id, "edited": False}
        await c.execute(
            "UPDATE activity SET tovar_turi = ?, weight = ?, coefficient = ?, net = ?, box_weight = ?, edited_at = ? WHERE id = ?",
            (code, weight, coefficient, net, box_weight, now, entry_id),
        )
        return {"entry_id": entry_id, "edited": True}


async def zero_top_coefficients(report_id: int) -> int:
    now = int(time.time())
    async with _db() as c:
        cur = await c.execute(
            """UPDATE activity
               SET coefficient = 0,
                   net = weight,
                   edited_at = ?
               WHERE report_id = ?
                 AND deleted_at IS NULL
                 AND action = 'top'
                 AND weight IS NOT NULL
                 AND (COALESCE(coefficient, 0) <> 0 OR COALESCE(net, weight) <> weight)""",
            (now, report_id),
        )
        return cur.rowcount or 0


async def delete_entry(report_id: int, entry_id: int) -> dict:
    now = int(time.time())
    async with _db() as c:
        async with c.execute(
            "SELECT * FROM activity WHERE id = ? AND report_id = ? AND deleted_at IS NULL",
            (entry_id, report_id),
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            raise ActivityNotFound(entry_id)
        if row["action"] == "reys":
            deltas = {row["tovar_turi"]: -(row["net"] or 0)}
        elif row["action"] == "adjust":
            deltas = {row["from_type"]: row["weight"] or 0, row["to_type"]: -(row["weight"] or 0)}
        else:
            deltas = {}
        balances = await _apply_balances(c, report_id, deltas) if deltas else await _inventory(c, report_id)
        await c.execute("UPDATE activity SET deleted_at = ? WHERE id = ?", (now, entry_id))
        await c.execute(
            """UPDATE send_queue
               SET status = 'canceled',
                   last_error = 'entry soft-deleted',
                   last_attempt_at = ?,
                   last_error_at = ?
               WHERE entry_id = ? AND status = 'pending'""",
            (now, now, entry_id),
        )
        return {"balances": balances}


async def get_activity(report_id: int, actor: str | None = None, limit: int = 500,
                       ts_from: int | None = None, ts_to: int | None = None) -> list[dict]:
    limit = max(1, min(int(limit), 1000))
    q = "SELECT * FROM activity WHERE report_id = ? AND deleted_at IS NULL"
    params: list = [report_id]
    if actor:
        q += " AND actor = ?"
        params.append(actor)
    if ts_from is not None:
        q += " AND ts >= ?"
        params.append(int(ts_from))
    if ts_to is not None:
        q += " AND ts < ?"
        params.append(int(ts_to))
    q += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    async with _db() as c:
        async with c.execute(q, params) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


# --------------------------------------------------------------------------
# Photos (Disk + R2)
# --------------------------------------------------------------------------
_PHOTO_DIR = config.DATA_DIR / "photos"


def _entry_dir(entry_id: int):
    return _PHOTO_DIR / str(entry_id)


def _rmtree_photos(entry_id: int) -> None:
    d = _entry_dir(entry_id)
    if d.exists():
        for f in d.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        try:
            d.rmdir()
        except OSError:
            pass


async def save_photos(entry_id: int, photos: list[tuple[bytes, str]],
                      r2_meta: list[tuple[str, str]] | None = None) -> None:
    """Persist photos to SQLite, local disk, and record R2 key/url."""
    d = _entry_dir(entry_id)
    d.mkdir(parents=True, exist_ok=True)
    async with _db() as c:
        for idx, (data, mime) in enumerate(photos):
            r2_key, r2_url = r2_meta[idx] if r2_meta and idx < len(r2_meta) else (None, None)
            await c.execute(
                """INSERT INTO entry_photos(entry_id, idx, mime, data, r2_key, r2_url)
                   VALUES(?, ?, ?, ?, ?, ?)
                   ON CONFLICT(entry_id, idx) DO UPDATE SET
                     mime = excluded.mime,
                     data = excluded.data,
                     r2_key = excluded.r2_key,
                     r2_url = excluded.r2_url""",
                (entry_id, idx, mime or "image/jpeg", data, r2_key, r2_url),
            )
            try:
                (d / str(idx)).write_bytes(data)
            except OSError:
                pass


async def photo_idxs(entry_id: int) -> list[int]:
    async with _db() as c:
        async with c.execute(
            "SELECT idx FROM entry_photos WHERE entry_id = ? ORDER BY idx", (entry_id,)
        ) as cur:
            rows = await cur.fetchall()
            return [r["idx"] for r in rows]


async def photo_file(entry_id: int, idx: int):
    """Return (path, mime) for one photo, or None if absent."""
    async with _db() as c:
        async with c.execute(
            "SELECT mime, data FROM entry_photos WHERE entry_id = ? AND idx = ?",
            (entry_id, idx),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    p = _entry_dir(entry_id) / str(idx)
    if not p.exists():
        data = row["data"]
        if data is None:
            return None
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            p.write_bytes(data)
        except OSError:
            return None
    return p, row["mime"]


async def photo_data(entry_id: int, idx: int):
    """Return (bytes, mime, r2_key, r2_url) for one photo."""
    async with _db() as c:
        async with c.execute(
            "SELECT data, mime, r2_key, r2_url FROM entry_photos WHERE entry_id = ? AND idx = ?",
            (entry_id, idx),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    return row["data"], row["mime"], row["r2_key"], row["r2_url"]


async def list_unmigrated_photos(limit: int = 2000) -> list[dict]:
    """Return rows from entry_photos that do not have an r2_key."""
    async with _db() as c:
        async with c.execute(
            """SELECT ep.entry_id, ep.idx, ep.mime, ep.data, a.report_id, a.action
               FROM entry_photos ep
               LEFT JOIN activity a ON a.id = ep.entry_id
               WHERE ep.r2_key IS NULL OR ep.r2_key = ''
               ORDER BY ep.entry_id, ep.idx
               LIMIT ?""",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def update_photo_r2(entry_id: int, idx: int, r2_key: str, r2_url: str) -> None:
    """Safely record R2 key and URL for a verified uploaded photo."""
    async with _db() as c:
        await c.execute(
            """UPDATE entry_photos
               SET r2_key = ?, r2_url = ?
               WHERE entry_id = ? AND idx = ?""",
            (r2_key, r2_url, entry_id, idx),
        )



async def photo_blobs(entry_id: int) -> list[tuple[bytes, str]]:
    """Return [(bytes, mime), ...] in order (for channel sending)."""
    out = []
    async with _db() as c:
        async with c.execute(
            "SELECT idx, mime, data, r2_key FROM entry_photos WHERE entry_id = ? ORDER BY idx", (entry_id,)
        ) as cur:
            rows = await cur.fetchall()
    for r in rows:
        p = _entry_dir(entry_id) / str(r["idx"])
        if p.exists():
            out.append((p.read_bytes(), r["mime"]))
            continue
        if r["data"] is not None:
            out.append((r["data"], r["mime"]))
            continue
        if r["r2_key"]:
            from . import storage
            content = await storage.get_photo_bytes(r["r2_key"], entry_id, r["idx"])
            if content:
                out.append(content)
    return out


def normalize_type_key(tovar_turi: str) -> str:
    key = str(tovar_turi or "").strip().lower()
    if key == "one":
        return "oneway"
    if key == "uztez":
        return "uzt"
    return key


async def get_report_type_photos(report_id: int, tovar_turi: str) -> list[tuple[bytes, str]]:
    """Return [(photo_bytes, mime), ...] for a given report and product type."""
    target_key = normalize_type_key(tovar_turi)
    raw_key = str(tovar_turi or "").strip().lower()
    async with _db() as c:
        async with c.execute(
            """SELECT id, action, tovar_turi, to_type, photos
               FROM activity
               WHERE report_id = ? AND deleted_at IS NULL AND photos > 0
               ORDER BY id ASC""",
            (report_id,),
        ) as cur:
            rows = await cur.fetchall()

    matching_entry_ids = []
    for r in rows:
        action = r["action"]
        if target_key in ("top", "bizda") or raw_key in ("top", "bizda"):
            if action in ("bizda", "top"):
                matching_entry_ids.append(r["id"])
                continue
        act_type = str(r["tovar_turi"] or "").strip().lower() if action == "reys" else str(r["to_type"] or "").strip().lower()
        if not act_type:
            continue
        if act_type == raw_key or normalize_type_key(act_type) == target_key:
            matching_entry_ids.append(r["id"])

    photos: list[tuple[bytes, str]] = []
    for entry_id in matching_entry_ids:
        blobs = await photo_blobs(entry_id)
        photos.extend(blobs)
    return photos


async def get_matching_type_entries(report_ids: list[int], tovar_turi: str) -> list[dict]:
    """Retrieve all activity entries matching tovar_turi across the specified reports."""
    if not report_ids:
        return []
    clean_ids = [int(rid) for rid in report_ids]
    target_key = normalize_type_key(tovar_turi)
    raw_key = str(tovar_turi or "").strip().lower()

    placeholders = ",".join("?" for _ in clean_ids)
    async with _db() as c:
        async with c.execute(
            f"""SELECT a.*, r.name AS report_name
                FROM activity a
                JOIN reports r ON r.id = a.report_id
                WHERE a.report_id IN ({placeholders})
                  AND a.deleted_at IS NULL
                  AND r.deleted_at IS NULL
                ORDER BY a.report_id ASC, a.id ASC""",
            clean_ids,
        ) as cur:
            rows = await cur.fetchall()

    matched = []
    for r in rows:
        action = r["action"]
        if target_key in ("top", "bizda") or raw_key in ("top", "bizda"):
            if action in ("bizda", "top"):
                matched.append(dict(r))
                continue
        if action == "adjust":
            act_type = str(r["to_type"] or "").strip().lower()
        else:
            act_type = str(r["tovar_turi"] or "").strip().lower()
        if not act_type:
            continue
        if act_type == raw_key or normalize_type_key(act_type) == target_key:
            matched.append(dict(r))
    return matched


async def mark_photo_telegram(entry_id: int, idx: int, file_id: str | None,
                              unique_id: str | None, message_id: int | None) -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute(
            """UPDATE entry_photos
               SET telegram_file_id = ?,
                   telegram_unique_id = ?,
                   telegram_message_id = ?,
                   telegram_sent_at = ?
               WHERE entry_id = ? AND idx = ?""",
            (file_id, unique_id, message_id, now, entry_id, idx),
        )


# --------------------------------------------------------------------------
# Entry lookups + outbox
# --------------------------------------------------------------------------
async def get_entry_any(entry_id: int) -> dict | None:
    async with _db() as c:
        async with c.execute(
            "SELECT * FROM activity WHERE id = ? AND deleted_at IS NULL", (entry_id,)
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def report_name(report_id: int) -> str | None:
    async with _db() as c:
        async with c.execute("SELECT name FROM reports WHERE id = ?", (report_id,)) as cur:
            row = await cur.fetchone()
    return row["name"] if row else None


async def list_entries(report_id: int, action: str, limit: int = 1000) -> list[dict]:
    limit = max(1, min(int(limit), 2000))
    async with _db() as c:
        async with c.execute(
            """SELECT a.*,
                      q.status AS send_status,
                      q.last_error AS send_error,
                      q.last_attempt_at AS send_last_attempt_at,
                      q.last_error_at AS send_error_at,
                      q.attempts AS send_attempts,
                      q.next_at AS send_next_at
               FROM activity a
               LEFT JOIN send_queue q ON q.entry_id = a.id
               WHERE a.report_id = ? AND a.action = ? AND a.deleted_at IS NULL
               ORDER BY a.id DESC LIMIT ?""",
            (report_id, action, limit),
        ) as acur:
            rows = await acur.fetchall()
        if not rows:
            return []

        entry_ids = [r["id"] for r in rows]
        placeholders = ",".join("?" for _ in entry_ids)
        async with c.execute(
            f"""SELECT entry_id, idx, telegram_file_id, r2_url
                FROM entry_photos
                WHERE entry_id IN ({placeholders})
                ORDER BY entry_id, idx""",
            entry_ids,
        ) as pcur:
            photo_rows = await pcur.fetchall()

        photos_by_entry: dict[int, list[dict]] = {}
        for p in photo_rows:
            photos_by_entry.setdefault(p["entry_id"], []).append(dict(p))

        out = []
        for r in rows:
            d = dict(r)
            photos = photos_by_entry.get(r["id"], [])
            d["photo_idxs"] = [p["idx"] for p in photos]
            d["photo_file_ids"] = [p["telegram_file_id"] for p in photos]
            d["photo_urls"] = [p.get("r2_url") or f"/api/entry/{r['id']}/photo/{p['idx']}" for p in photos]
            out.append(d)
    return out


async def list_entry_statuses(report_id: int, action: str) -> list[dict]:
    async with _db() as c:
        async with c.execute(
            """SELECT a.id, q.status AS send_status, q.last_error AS send_error,
                      q.last_attempt_at AS send_last_attempt_at,
                      q.last_error_at AS send_error_at,
                      q.attempts AS send_attempts,
                      q.next_at AS send_next_at
               FROM activity a
               LEFT JOIN send_queue q ON q.entry_id = a.id
               WHERE a.report_id = ? AND a.action = ? AND a.deleted_at IS NULL
               ORDER BY a.id DESC""",
            (report_id, action),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def enqueue_send(entry_id: int) -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute(
            "INSERT OR REPLACE INTO send_queue(entry_id, status, attempts, next_at, last_error, created_at) "
            "VALUES(?, 'pending', 0, 0, NULL, ?)",
            (entry_id, now),
        )


async def enqueue_bulk_send(report_id: int, action: str, mode: str = "unsent") -> int:
    now = int(time.time())
    if mode == "sent":
        status_filter = "q.status = 'sent'"
    else:
        status_filter = "(q.entry_id IS NULL OR q.status != 'sent')"
    async with _db() as c:
        async with c.execute(
            """SELECT a.id
               FROM activity a
               LEFT JOIN send_queue q ON q.entry_id = a.id
               WHERE a.report_id = ? AND a.action = ?
                 AND a.deleted_at IS NULL
                 AND {status_filter}
               ORDER BY a.id""".format(status_filter=status_filter),
            (report_id, action),
        ) as cur:
            rows = await cur.fetchall()
        for r in rows:
            await c.execute(
                "INSERT OR REPLACE INTO send_queue(entry_id, status, attempts, next_at, last_error, created_at) "
                "VALUES(?, 'pending', 0, 0, NULL, ?)",
                (r["id"], now),
            )
    return len(rows)


async def enqueue_selected_send(report_id: int, action: str, entry_ids: list[int]) -> int:
    ids = []
    seen = set()
    for raw in entry_ids:
        try:
            eid = int(raw)
        except (TypeError, ValueError):
            continue
        if eid > 0 and eid not in seen:
            seen.add(eid)
            ids.append(eid)
    if not ids:
        return 0
    now = int(time.time())
    placeholders = ",".join("?" for _ in ids)
    async with _db() as c:
        async with c.execute(
            f"""SELECT id FROM activity
                WHERE report_id = ? AND action = ? AND deleted_at IS NULL
                  AND id IN ({placeholders})
                ORDER BY id""",
            [report_id, action, *ids],
        ) as cur:
            rows = await cur.fetchall()
        for r in rows:
            await c.execute(
                "INSERT OR REPLACE INTO send_queue(entry_id, status, attempts, next_at, last_error, created_at) "
                "VALUES(?, 'pending', 0, 0, NULL, ?)",
                (r["id"], now),
            )
    return len(rows)


async def next_send_job(now: int) -> dict | None:
    async with _db() as c:
        async with c.execute(
            "SELECT * FROM send_queue WHERE status = 'pending' AND next_at <= ? ORDER BY created_at, entry_id LIMIT 1",
            (now,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def mark_sent(entry_id: int) -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute(
            """UPDATE send_queue
               SET status = 'sent',
                   last_error = NULL,
                   last_attempt_at = ?,
                   last_error_at = NULL
               WHERE entry_id = ?""",
            (now, entry_id),
        )


async def mark_send_canceled(entry_id: int, error: str = "entry unavailable") -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute(
            """UPDATE send_queue
               SET status = 'canceled',
                   last_error = ?,
                   last_attempt_at = ?,
                   last_error_at = ?
               WHERE entry_id = ?""",
            ((error or "")[:500], now, now, entry_id),
        )


async def mark_send_retry(entry_id: int, attempts: int, next_at: int, error: str) -> None:
    now = int(time.time())
    async with _db() as c:
        await c.execute(
            """UPDATE send_queue
               SET attempts = ?,
                   next_at = ?,
                   last_error = ?,
                   last_attempt_at = ?,
                   last_error_at = ?
               WHERE entry_id = ?""",
            (attempts, next_at, (error or "")[:500], now, now, entry_id),
        )


async def send_status(entry_id: int) -> str | None:
    async with _db() as c:
        async with c.execute("SELECT status FROM send_queue WHERE entry_id = ?", (entry_id,)) as cur:
            row = await cur.fetchone()
    return row["status"] if row else None


async def pending_send_count() -> int:
    async with _db() as c:
        async with c.execute("SELECT COUNT(*) AS n FROM send_queue WHERE status = 'pending'") as cur:
            res = await cur.fetchone()
            return res["n"] if res else 0

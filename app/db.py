"""SQLite store. Multi-report model.

- `reports`: named report containers (max 5; oldest auto-pruned).
- `inventory`: running weight balance per (report, tovar turi). Each new report
  starts every type at 0.
- `activity`: append-only log of every reys/adjust, scoped to a report.

Single-process app, low volume: one serialized connection guarded by a lock.
"""
from __future__ import annotations

import math
import sqlite3
import threading
import time
from contextlib import contextmanager

from . import config

_DB = config.DATA_DIR / "reys.db"
_LOCK = threading.Lock()

DEFAULT_TYPES = ["akb", "triton", "izi", "navo", "xabib", "jet", "jon"]
MAX_REPORTS = 5


class InsufficientStock(Exception):
    def __init__(self, tovar_turi: str, have: float, need: float):
        self.tovar_turi = tovar_turi
        self.have = have
        self.need = need
        super().__init__(f"insufficient stock in {tovar_turi}: have {have}, need {need}")


class DuplicateName(Exception):
    pass


class ReportNotFound(Exception):
    pass


def _connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def _db():
    with _LOCK:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init() -> None:
    with _db() as c:
        # Migration: the pre-multi-report schema had global inventory/activity
        # (no report_id). Those rows can't map to the per-report model, so drop
        # the incompatible tables and recreate them fresh.
        for tbl in ("inventory", "activity"):
            cols = {r[1] for r in c.execute(f"PRAGMA table_info({tbl})")}
            if cols and "report_id" not in cols:
                c.execute(f"DROP TABLE {tbl}")

        c.execute(
            """CREATE TABLE IF NOT EXISTS reports(
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 name       TEXT NOT NULL UNIQUE,
                 created_at INTEGER NOT NULL)"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS inventory(
                 report_id  INTEGER NOT NULL,
                 tovar_turi TEXT NOT NULL,
                 weight     REAL NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (report_id, tovar_turi))"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS activity(
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 report_id   INTEGER NOT NULL,
                 ts          INTEGER NOT NULL,
                 actor       TEXT NOT NULL,
                 action      TEXT NOT NULL,       -- 'reys' | 'adjust'
                 tovar_turi  TEXT,
                 from_type   TEXT,
                 to_type     TEXT,
                 weight      REAL,
                 coefficient REAL,
                 net         REAL,
                 photos      INTEGER)"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_activity_report ON activity(report_id, id)")

        # Self-heal any non-finite (inf/nan/null) values from before the guards.
        fin = "({c} IS NOT NULL AND {c} > -1e308 AND {c} < 1e308)"
        c.execute(f"UPDATE inventory SET weight = 0 WHERE NOT {fin.format(c='weight')}")
        for col in ("weight", "coefficient", "net"):
            c.execute(
                f"UPDATE activity SET {col} = 0 "
                f"WHERE {col} IS NOT NULL AND NOT {fin.format(c=col)}"
            )


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------
def _prune(c: sqlite3.Connection) -> None:
    """Keep only the newest MAX_REPORTS reports; drop the rest + their data."""
    old = [
        r["id"] for r in c.execute(
            "SELECT id FROM reports ORDER BY id DESC LIMIT -1 OFFSET ?", (MAX_REPORTS,)
        )
    ]
    for rid in old:
        c.execute("DELETE FROM inventory WHERE report_id = ?", (rid,))
        c.execute("DELETE FROM activity WHERE report_id = ?", (rid,))
        c.execute("DELETE FROM reports WHERE id = ?", (rid,))


def create_report(name: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("empty name")
    now = int(time.time())
    with _db() as c:
        exists = c.execute("SELECT 1 FROM reports WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if exists:
            raise DuplicateName(name)
        cur = c.execute("INSERT INTO reports(name, created_at) VALUES(?, ?)", (name, now))
        rid = cur.lastrowid
        for t in DEFAULT_TYPES:
            c.execute(
                "INSERT INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
                (rid, t, now),
            )
        _prune(c)
        return {"id": rid, "name": name, "created_at": now}


def list_reports() -> list[dict]:
    with _db() as c:
        rows = c.execute(
            """SELECT r.id, r.name, r.created_at,
                      (SELECT COUNT(*) FROM activity a WHERE a.report_id = r.id) AS entries
               FROM reports r ORDER BY r.id DESC"""
        )
        return [dict(r) for r in rows]


def report_exists(report_id: int) -> bool:
    with _db() as c:
        return c.execute("SELECT 1 FROM reports WHERE id = ?", (report_id,)).fetchone() is not None


def delete_report(report_id: int) -> None:
    with _db() as c:
        c.execute("DELETE FROM inventory WHERE report_id = ?", (report_id,))
        c.execute("DELETE FROM activity WHERE report_id = ?", (report_id,))
        c.execute("DELETE FROM reports WHERE id = ?", (report_id,))


# --------------------------------------------------------------------------
# Inventory / operations (all scoped to a report)
# --------------------------------------------------------------------------
def _ensure_type(c: sqlite3.Connection, report_id: int, t: str) -> None:
    c.execute(
        "INSERT OR IGNORE INTO inventory(report_id, tovar_turi, weight, updated_at) VALUES(?, ?, 0, ?)",
        (report_id, t, int(time.time())),
    )


def _inventory(c: sqlite3.Connection, report_id: int) -> dict[str, float]:
    return {r["tovar_turi"]: r["weight"] for r in c.execute(
        "SELECT tovar_turi, weight FROM inventory WHERE report_id = ? ORDER BY tovar_turi", (report_id,))}


def get_inventory(report_id: int) -> dict[str, float]:
    with _db() as c:
        return _inventory(c, report_id)


def add_reys(report_id: int, actor: str, tovar_turi: str, weight: float,
             coefficient: float, net: float, photos: int) -> dict:
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(net)):
        raise ValueError("non-finite value")
    now = int(time.time())
    with _db() as c:
        _ensure_type(c, report_id, tovar_turi)
        c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (net, now, report_id, tovar_turi),
        )
        c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, tovar_turi, weight, coefficient, net, photos)
               VALUES(?, ?, ?, 'reys', ?, ?, ?, ?, ?)""",
            (report_id, now, actor, tovar_turi, weight, coefficient, net, photos),
        )
        bal = c.execute(
            "SELECT weight FROM inventory WHERE report_id = ? AND tovar_turi = ?",
            (report_id, tovar_turi),
        ).fetchone()["weight"]
        return {"tovar_turi": tovar_turi, "balance": bal, "inventory": _inventory(c, report_id)}


def adjust(report_id: int, actor: str, from_type: str, to_type: str, weight: float,
           photos: int = 0) -> dict:
    if not (math.isfinite(weight) and weight > 0):
        raise ValueError("non-finite value")
    now = int(time.time())
    with _db() as c:
        _ensure_type(c, report_id, from_type)
        _ensure_type(c, report_id, to_type)
        have = c.execute(
            "SELECT weight FROM inventory WHERE report_id = ? AND tovar_turi = ?",
            (report_id, from_type),
        ).fetchone()["weight"]
        if have < weight:
            raise InsufficientStock(from_type, have, weight)
        c.execute(
            "UPDATE inventory SET weight = weight - ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (weight, now, report_id, from_type),
        )
        c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
            (weight, now, report_id, to_type),
        )
        c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, from_type, to_type, weight, photos)
               VALUES(?, ?, ?, 'adjust', ?, ?, ?, ?)""",
            (report_id, now, actor, from_type, to_type, weight, photos),
        )
        return {"balances": _inventory(c, report_id)}


def get_activity(report_id: int, actor: str | None = None, limit: int = 500,
                 ts_from: int | None = None, ts_to: int | None = None) -> list[dict]:
    limit = max(1, min(int(limit), 1000))
    q = "SELECT * FROM activity WHERE report_id = ?"
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
    with _db() as c:
        return [dict(r) for r in c.execute(q, params)]

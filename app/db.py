"""SQLite store shared by both tabs.

- `inventory`: running weight balance per tovar turi (one row per type).
- `activity`: append-only log of every action (reys report / adashgan adjust).

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


class InsufficientStock(Exception):
    def __init__(self, tovar_turi: str, have: float, need: float):
        self.tovar_turi = tovar_turi
        self.have = have
        self.need = need
        super().__init__(f"insufficient stock in {tovar_turi}: have {have}, need {need}")


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
        c.execute(
            """CREATE TABLE IF NOT EXISTS inventory(
                 tovar_turi TEXT PRIMARY KEY,
                 weight     REAL NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0)"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS activity(
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
        c.execute("CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity(actor, id)")
        now = int(time.time())
        for t in DEFAULT_TYPES:
            c.execute(
                "INSERT OR IGNORE INTO inventory(tovar_turi, weight, updated_at) VALUES(?, 0, ?)",
                (t, now),
            )


def _ensure_type(c: sqlite3.Connection, t: str) -> None:
    c.execute(
        "INSERT OR IGNORE INTO inventory(tovar_turi, weight, updated_at) VALUES(?, 0, ?)",
        (t, int(time.time())),
    )


def _inventory(c: sqlite3.Connection) -> dict[str, float]:
    return {r["tovar_turi"]: r["weight"] for r in c.execute(
        "SELECT tovar_turi, weight FROM inventory ORDER BY tovar_turi")}


def get_inventory() -> dict[str, float]:
    with _db() as c:
        return _inventory(c)


def add_reys(actor: str, tovar_turi: str, weight: float, coefficient: float,
             net: float, photos: int) -> dict:
    """Add `net` weight to a type's balance and log it. Returns new balance."""
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(net)):
        raise ValueError("non-finite value")
    now = int(time.time())
    with _db() as c:
        _ensure_type(c, tovar_turi)
        c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE tovar_turi = ?",
            (net, now, tovar_turi),
        )
        c.execute(
            """INSERT INTO activity(ts, actor, action, tovar_turi, weight, coefficient, net, photos)
               VALUES(?, ?, 'reys', ?, ?, ?, ?, ?)""",
            (now, actor, tovar_turi, weight, coefficient, net, photos),
        )
        bal = c.execute("SELECT weight FROM inventory WHERE tovar_turi = ?", (tovar_turi,)).fetchone()["weight"]
        return {"tovar_turi": tovar_turi, "balance": bal}


def adjust(actor: str, from_type: str, to_type: str, weight: float) -> dict:
    """Move `weight` from one type to another. Raises InsufficientStock if blocked."""
    if not (math.isfinite(weight) and weight > 0):
        raise ValueError("non-finite value")
    now = int(time.time())
    with _db() as c:
        _ensure_type(c, from_type)
        _ensure_type(c, to_type)
        have = c.execute("SELECT weight FROM inventory WHERE tovar_turi = ?", (from_type,)).fetchone()["weight"]
        if have < weight:
            raise InsufficientStock(from_type, have, weight)
        c.execute(
            "UPDATE inventory SET weight = weight - ?, updated_at = ? WHERE tovar_turi = ?",
            (weight, now, from_type),
        )
        c.execute(
            "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE tovar_turi = ?",
            (weight, now, to_type),
        )
        c.execute(
            """INSERT INTO activity(ts, actor, action, from_type, to_type, weight)
               VALUES(?, ?, 'adjust', ?, ?, ?)""",
            (now, actor, from_type, to_type, weight),
        )
        return {"balances": _inventory(c)}


def get_activity(actor: str | None = None, limit: int = 200,
                 ts_from: int | None = None, ts_to: int | None = None) -> list[dict]:
    limit = max(1, min(int(limit), 1000))
    q = "SELECT * FROM activity WHERE 1=1"
    params: list = []
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

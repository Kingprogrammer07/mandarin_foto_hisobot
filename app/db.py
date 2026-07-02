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

DEFAULT_TYPES = ["akb", "triton", "izi", "navo", "xabib", "jet", "jon", "top", "uztez", "mandarin"]
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


class ActivityNotFound(Exception):
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

        # Photos persisted to disk (data/photos/<entry_id>/<idx>); this table
        # records their order + mime so nothing is lost across a restart.
        c.execute(
            """CREATE TABLE IF NOT EXISTS entry_photos(
                 entry_id INTEGER NOT NULL,
                 idx      INTEGER NOT NULL,
                 mime     TEXT NOT NULL,
                 PRIMARY KEY (entry_id, idx))"""
        )
        # Durable outbox for the Telegram channel forward. A pending row survives
        # a process restart; the send worker drains it with retry/backoff.
        c.execute(
            """CREATE TABLE IF NOT EXISTS send_queue(
                 entry_id   INTEGER PRIMARY KEY,
                 status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
                 attempts   INTEGER NOT NULL DEFAULT 0,
                 next_at    INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 created_at INTEGER NOT NULL)"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_queue_pending ON send_queue(status, next_at)")

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
        cur = c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, tovar_turi, weight, coefficient, net, photos)
               VALUES(?, ?, ?, 'reys', ?, ?, ?, ?, ?)""",
            (report_id, now, actor, tovar_turi, weight, coefficient, net, photos),
        )
        bal = c.execute(
            "SELECT weight FROM inventory WHERE report_id = ? AND tovar_turi = ?",
            (report_id, tovar_turi),
        ).fetchone()["weight"]
        return {"tovar_turi": tovar_turi, "balance": bal, "inventory": _inventory(c, report_id),
                "entry_id": cur.lastrowid}


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
        cur = c.execute(
            """INSERT INTO activity(report_id, ts, actor, action, from_type, to_type, weight, photos)
               VALUES(?, ?, ?, 'adjust', ?, ?, ?, ?)""",
            (report_id, now, actor, from_type, to_type, weight, photos),
        )
        return {"balances": _inventory(c, report_id), "entry_id": cur.lastrowid}


# --------------------------------------------------------------------------
# Entry edit / delete (fix a saved reys/adjust; inventory is compensated)
# --------------------------------------------------------------------------
_EPS = 1e-9  # float compensation slack: don't 409 on rounding dust


def _get_entry(c: sqlite3.Connection, report_id: int, entry_id: int, action: str):
    row = c.execute(
        "SELECT * FROM activity WHERE id = ? AND report_id = ? AND action = ?",
        (entry_id, report_id, action),
    ).fetchone()
    if row is None:
        raise ActivityNotFound(entry_id)
    return row


def _apply_balances(c: sqlite3.Connection, report_id: int, deltas: dict[str, float]) -> dict[str, float]:
    """Apply per-type deltas; raise InsufficientStock if any balance would go
    negative. All-or-nothing (checked before any write)."""
    now = int(time.time())
    for t in deltas:
        _ensure_type(c, report_id, t)
    inv = _inventory(c, report_id)
    for t, d in deltas.items():
        if inv.get(t, 0) + d < -_EPS:
            raise InsufficientStock(t, inv.get(t, 0), -d)
    for t, d in deltas.items():
        if d:
            c.execute(
                "UPDATE inventory SET weight = weight + ?, updated_at = ? WHERE report_id = ? AND tovar_turi = ?",
                (d, now, report_id, t),
            )
    return _inventory(c, report_id)


# Edits change numbers only; photos are immutable after the initial save, so the
# stored `photos` count is left untouched.
def edit_reys(report_id: int, entry_id: int, tovar_turi: str, weight: float,
              coefficient: float, net: float) -> dict:
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(net)):
        raise ValueError("non-finite value")
    with _db() as c:
        old = _get_entry(c, report_id, entry_id, "reys")
        deltas: dict[str, float] = {}
        deltas[old["tovar_turi"]] = deltas.get(old["tovar_turi"], 0) - (old["net"] or 0)
        deltas[tovar_turi] = deltas.get(tovar_turi, 0) + net
        balances = _apply_balances(c, report_id, deltas)
        c.execute(
            "UPDATE activity SET tovar_turi = ?, weight = ?, coefficient = ?, net = ? WHERE id = ?",
            (tovar_turi, weight, coefficient, net, entry_id),
        )
        return {"balance": balances.get(tovar_turi, 0), "inventory": balances}


def edit_adjust(report_id: int, entry_id: int, from_type: str, to_type: str,
                weight: float) -> dict:
    if not (math.isfinite(weight) and weight > 0):
        raise ValueError("non-finite value")
    with _db() as c:
        old = _get_entry(c, report_id, entry_id, "adjust")
        deltas: dict[str, float] = {}
        # Reverse the old transfer, then apply the new one.
        for t, d in ((old["from_type"], old["weight"] or 0), (old["to_type"], -(old["weight"] or 0)),
                     (from_type, -weight), (to_type, weight)):
            deltas[t] = deltas.get(t, 0) + d
        balances = _apply_balances(c, report_id, deltas)
        c.execute(
            "UPDATE activity SET from_type = ?, to_type = ?, weight = ? WHERE id = ?",
            (from_type, to_type, weight, entry_id),
        )
        return {"balances": balances}


def delete_entry(report_id: int, entry_id: int) -> dict:
    """Delete a reys/adjust entry and undo its inventory effect (also removes its
    photos + any pending channel-send job)."""
    with _db() as c:
        row = c.execute(
            "SELECT * FROM activity WHERE id = ? AND report_id = ?", (entry_id, report_id)
        ).fetchone()
        if row is None:
            raise ActivityNotFound(entry_id)
        if row["action"] == "reys":
            deltas = {row["tovar_turi"]: -(row["net"] or 0)}
        else:  # adjust: give the weight back to from_type, take it from to_type
            deltas = {row["from_type"]: row["weight"] or 0, row["to_type"]: -(row["weight"] or 0)}
        balances = _apply_balances(c, report_id, deltas)
        c.execute("DELETE FROM activity WHERE id = ?", (entry_id,))
        c.execute("DELETE FROM entry_photos WHERE entry_id = ?", (entry_id,))
        c.execute("DELETE FROM send_queue WHERE entry_id = ?", (entry_id,))
        _rmtree_photos(entry_id)
        return {"balances": balances}


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


# --------------------------------------------------------------------------
# Photos on disk (data/photos/<entry_id>/<idx>) — persisted so nothing is lost
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


def save_photos(entry_id: int, photos: list) -> None:
    """Persist [(bytes, mime), …] to disk and record their order + mime."""
    d = _entry_dir(entry_id)
    d.mkdir(parents=True, exist_ok=True)
    with _db() as c:
        c.execute("DELETE FROM entry_photos WHERE entry_id = ?", (entry_id,))
        for idx, (data, mime) in enumerate(photos):
            (d / str(idx)).write_bytes(data)
            c.execute(
                "INSERT INTO entry_photos(entry_id, idx, mime) VALUES(?, ?, ?)",
                (entry_id, idx, mime or "image/jpeg"),
            )


def photo_idxs(entry_id: int) -> list[int]:
    with _db() as c:
        return [r["idx"] for r in c.execute(
            "SELECT idx FROM entry_photos WHERE entry_id = ? ORDER BY idx", (entry_id,))]


def photo_file(entry_id: int, idx: int):
    """Return (path, mime) for one photo, or None if absent."""
    with _db() as c:
        row = c.execute(
            "SELECT mime FROM entry_photos WHERE entry_id = ? AND idx = ?", (entry_id, idx)
        ).fetchone()
    if row is None:
        return None
    p = _entry_dir(entry_id) / str(idx)
    if not p.exists():
        return None
    return p, row["mime"]


def photo_blobs(entry_id: int) -> list:
    """Return [(bytes, mime), …] in order (for the Telegram send)."""
    out = []
    with _db() as c:
        rows = c.execute(
            "SELECT idx, mime FROM entry_photos WHERE entry_id = ? ORDER BY idx", (entry_id,)
        ).fetchall()
    for r in rows:
        p = _entry_dir(entry_id) / str(r["idx"])
        if p.exists():
            out.append((p.read_bytes(), r["mime"]))
    return out


# --------------------------------------------------------------------------
# Entry lookups + channel-send outbox
# --------------------------------------------------------------------------
def get_entry_any(entry_id: int) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT * FROM activity WHERE id = ?", (entry_id,)).fetchone()
    return dict(row) if row else None


def report_name(report_id: int) -> str | None:
    with _db() as c:
        row = c.execute("SELECT name FROM reports WHERE id = ?", (report_id,)).fetchone()
    return row["name"] if row else None


def list_entries(report_id: int, action: str, limit: int = 1000) -> list[dict]:
    """Saved reys/adjust rows (newest first) with their photo indexes + send status."""
    limit = max(1, min(int(limit), 2000))
    with _db() as c:
        rows = c.execute(
            "SELECT * FROM activity WHERE report_id = ? AND action = ? ORDER BY id DESC LIMIT ?",
            (report_id, action, limit),
        ).fetchall()
        out = []
        for r in rows:
            idxs = [p["idx"] for p in c.execute(
                "SELECT idx FROM entry_photos WHERE entry_id = ? ORDER BY idx", (r["id"],))]
            sq = c.execute("SELECT status FROM send_queue WHERE entry_id = ?", (r["id"],)).fetchone()
            d = dict(r)
            d["photo_idxs"] = idxs
            d["send_status"] = sq["status"] if sq else None
            out.append(d)
    return out


def enqueue_send(entry_id: int) -> None:
    now = int(time.time())
    with _db() as c:
        c.execute(
            "INSERT OR REPLACE INTO send_queue(entry_id, status, attempts, next_at, last_error, created_at) "
            "VALUES(?, 'pending', 0, 0, NULL, ?)",
            (entry_id, now),
        )


def enqueue_bulk_send(report_id: int, action: str, mode: str = "unsent") -> int:
    """Queue entries for one report/action in entry order.

    mode='unsent' queues rows never sent or currently retryable; mode='sent'
    queues only rows already delivered, for an explicit resend.
    """
    now = int(time.time())
    if mode == "sent":
        status_filter = "q.status = 'sent'"
    else:
        status_filter = "(q.entry_id IS NULL OR q.status != 'sent')"
    with _db() as c:
        rows = c.execute(
            """SELECT a.id
               FROM activity a
               LEFT JOIN send_queue q ON q.entry_id = a.id
               WHERE a.report_id = ? AND a.action = ?
                 AND {status_filter}
               ORDER BY a.id""".format(status_filter=status_filter),
            (report_id, action),
        ).fetchall()
        for r in rows:
            c.execute(
                "INSERT OR REPLACE INTO send_queue(entry_id, status, attempts, next_at, last_error, created_at) "
                "VALUES(?, 'pending', 0, 0, NULL, ?)",
                (r["id"], now),
            )
    return len(rows)


def next_send_job(now: int) -> dict | None:
    with _db() as c:
        row = c.execute(
            "SELECT * FROM send_queue WHERE status = 'pending' AND next_at <= ? ORDER BY created_at, entry_id LIMIT 1",
            (now,),
        ).fetchone()
    return dict(row) if row else None


def mark_sent(entry_id: int) -> None:
    with _db() as c:
        c.execute("UPDATE send_queue SET status = 'sent', last_error = NULL WHERE entry_id = ?", (entry_id,))


def mark_send_retry(entry_id: int, attempts: int, next_at: int, error: str) -> None:
    with _db() as c:
        c.execute(
            "UPDATE send_queue SET attempts = ?, next_at = ?, last_error = ? WHERE entry_id = ?",
            (attempts, next_at, (error or "")[:500], entry_id),
        )


def send_status(entry_id: int) -> str | None:
    with _db() as c:
        row = c.execute("SELECT status FROM send_queue WHERE entry_id = ?", (entry_id,)).fetchone()
    return row["status"] if row else None


def pending_send_count() -> int:
    with _db() as c:
        return c.execute("SELECT COUNT(*) AS n FROM send_queue WHERE status = 'pending'").fetchone()["n"]

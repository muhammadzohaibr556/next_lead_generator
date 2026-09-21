import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .engine import TERMINAL, classify, digest, normalize, score
from .sources import SOURCES


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def database_path():
    return Path(os.getenv("DATABASE_PATH", "data/permits.db"))


@contextmanager
def connect():
    connection = sqlite3.connect(database_path(), timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init():
    database_path().parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
            coverage_since TEXT NOT NULL, last_started TEXT, last_success TEXT,
            newest_record TEXT, error TEXT, next_run TEXT
        );
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
            status TEXT NOT NULL DEFAULT 'queued', queued_at TEXT NOT NULL,
            started_at TEXT, finished_at TEXT, fetched INTEGER NOT NULL DEFAULT 0,
            new_permits INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
            duplicates INTEGER NOT NULL DEFAULT 0, leads_created INTEGER NOT NULL DEFAULT 0,
            error TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(source_id)
            WHERE status IN ('queued','running');
        CREATE TABLE IF NOT EXISTS projects (
            project_key TEXT PRIMARY KEY, first_seen TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS permits (
            id INTEGER PRIMARY KEY, jurisdiction TEXT NOT NULL, permit_number TEXT NOT NULL,
            project_key TEXT NOT NULL REFERENCES projects(project_key), payload TEXT NOT NULL,
            payload_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
            UNIQUE(jurisdiction, permit_number)
        );
        CREATE INDEX IF NOT EXISTS permit_project ON permits(project_key);
        CREATE TABLE IF NOT EXISTS raw_events (
            id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
            permit_id INTEGER NOT NULL REFERENCES permits(id), payload_hash TEXT NOT NULL,
            fetched_at TEXT NOT NULL, payload TEXT NOT NULL,
            UNIQUE(source_id, permit_id, payload_hash)
        );
        CREATE INDEX IF NOT EXISTS event_permit ON raw_events(permit_id);
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key),
            trade TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL,
            first_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'New', saved INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '', assigned_to TEXT NOT NULL DEFAULT '',
            city TEXT GENERATED ALWAYS AS (json_extract(payload,'$.city')) VIRTUAL,
            state TEXT GENERATED ALWAYS AS (json_extract(payload,'$.state')) VIRTUAL,
            stage TEXT GENERATED ALWAYS AS (json_extract(payload,'$.stage')) VIRTUAL,
            signal_date TEXT GENERATED ALWAYS AS (json_extract(payload,'$.signal_date')) VIRTUAL,
            UNIQUE(project_key, trade)
        );
        CREATE INDEX IF NOT EXISTS lead_filters ON leads(active, trade, state, city, signal_date);
        CREATE TABLE IF NOT EXISTS property_enrichment (
            apn TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, payload TEXT NOT NULL
        );
        """)
        since = (
            (
                datetime.now(timezone.utc)
                - timedelta(days=int(os.getenv("INITIAL_LOOKBACK_DAYS", "30")))
            )
            .date()
            .isoformat()
        )
        db.executemany(
            "INSERT OR IGNORE INTO sources(id,coverage_since) VALUES(?,?)",
            [(key, since) for key in SOURCES],
        )


def refresh_project(db, project_key):
    rows = db.execute(
        "SELECT payload,first_seen FROM permits WHERE project_key=?", (project_key,)
    ).fetchall()
    permits = [json.loads(row["payload"]) for row in rows]
    grouped = {}
    for permit in permits:
        for trade, match in classify(
            permit["description"], permit["permit_type"]
        ).items():
            grouped.setdefault(trade, []).append((permit, match))
    created = 0
    db.execute("UPDATE leads SET active=0 WHERE project_key=?", (project_key,))
    for trade, candidates in grouped.items():
        # Prefer a still-active trade permit over a closed sibling approval.
        candidates.sort(
            key=lambda item: (
                item[0]["stage"] not in TERMINAL,
                item[0]["activity_date"],
                item[1]["kind"] == "Direct",
            ),
            reverse=True,
        )
        permit, match = candidates[0]
        payload = {
            **permit,
            "match": match,
            "permit_count": len(permits),
            "trade_permit_count": len(candidates),
        }
        _, parts = score(permit, match)
        payload["score_base"] = sum(v for k, v in parts.items() if k != "Recency")
        payload["grouping"] = (
            "Official project reference"
            if permit["project_ref"]
            else "Permit identity · related jobs require review"
        )
        old = db.execute(
            "SELECT id,payload FROM leads WHERE project_key=? AND trade=?",
            (project_key, trade),
        ).fetchone()
        encoded = json.dumps(payload, sort_keys=True)
        if old:
            db.execute(
                "UPDATE leads SET active=1,payload=?,updated_at=CASE WHEN payload<>? THEN ? ELSE updated_at END WHERE id=?",
                (encoded, encoded, now(), old["id"]),
            )
        else:
            db.execute(
                "INSERT INTO leads(project_key,trade,payload,first_seen,updated_at) VALUES(?,?,?,?,?)",
                (project_key, trade, encoded, now(), now()),
            )
            created += 1
    return created


def ingest_batch(source_id, rows):
    counts = dict(
        fetched=len(rows), new_permits=0, changed=0, duplicates=0, leads_created=0
    )
    touched = set()
    newest = ""
    # The transaction includes raw evidence, canonical records and leads. Failed
    # batches roll back together; a failed run never advances its watermark.
    with connect() as db:
        for raw in rows:
            permit = normalize(raw, source_id)
            today = datetime.now(timezone.utc).date().isoformat()
            valid_dates = [
                permit[key]
                for key in [
                    "activity_date",
                    "issue_date",
                    "applied_date",
                    "completed_date",
                ]
                if permit[key] <= today
            ]
            newest = max([newest, *valid_dates])
            canonical_hash = digest(
                {
                    k: v
                    for k, v in permit.items()
                    if k not in {"source_id", "source_url"}
                }
            )
            old = db.execute(
                "SELECT * FROM permits WHERE jurisdiction=? AND permit_number=?",
                (permit["jurisdiction"], permit["permit_number"]),
            ).fetchone()
            if old:
                permit_id = old["id"]
                prior = json.loads(old["payload"])
                # Do not downgrade an issued/completed permit using an older feed.
                ranks = {
                    "Application": 0,
                    "In review": 1,
                    "Active · stage unknown": 1,
                    "Issued": 2,
                    "In progress": 3,
                    "Completed": 4,
                    "Expired": 4,
                    "Cancelled": 4,
                }
                incoming = (permit["activity_date"], ranks[permit["stage"]])
                previous = (prior["activity_date"], ranks[prior["stage"]])
                if canonical_hash != old["payload_hash"] and incoming >= previous:
                    permit["project_key"] = old["project_key"]
                    db.execute(
                        "UPDATE permits SET payload=?,payload_hash=?,last_seen=? WHERE id=?",
                        (json.dumps(permit), canonical_hash, now(), permit_id),
                    )
                    touched.add(old["project_key"])
                    counts["changed"] += 1
                else:
                    db.execute(
                        "UPDATE permits SET last_seen=? WHERE id=?", (now(), permit_id)
                    )
                    counts["duplicates"] += 1
            else:
                db.execute(
                    "INSERT OR IGNORE INTO projects VALUES(?,?)",
                    (permit["project_key"], now()),
                )
                permit_id = db.execute(
                    "INSERT INTO permits(jurisdiction,permit_number,project_key,payload,payload_hash,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)",
                    (
                        permit["jurisdiction"],
                        permit["permit_number"],
                        permit["project_key"],
                        json.dumps(permit),
                        canonical_hash,
                        now(),
                        now(),
                    ),
                ).lastrowid
                touched.add(permit["project_key"])
                counts["new_permits"] += 1
            stable_raw = {
                k: v
                for k, v in raw.items()
                if k.lower()
                not in {":id", ":updated_at", ":created_at", "refresh_time", "objectid"}
            }
            db.execute(
                "INSERT OR IGNORE INTO raw_events(source_id,permit_id,payload_hash,fetched_at,payload) VALUES(?,?,?,?,?)",
                (source_id, permit_id, digest(stable_raw), now(), json.dumps(raw)),
            )
        for project_key in touched:
            counts["leads_created"] += refresh_project(db, project_key)
    return counts, newest


# Compute recency at query time, so scores decay even when the source is offline.
SCORE_SQL = """min(CASE WHEN stage IN ('Completed','Cancelled','Expired') THEN 10 WHEN json_extract(payload,'$.date_warning') THEN 25 ELSE 100 END,
    max(0, json_extract(payload,'$.score_base') + CASE
    WHEN julianday(date('now'))-julianday(signal_date) BETWEEN 0 AND 3 THEN 30
    WHEN julianday(date('now'))-julianday(signal_date) BETWEEN 0 AND 7 THEN 22
    WHEN julianday(date('now'))-julianday(signal_date) BETWEEN 0 AND 30 THEN 14
    WHEN julianday(date('now'))-julianday(signal_date) BETWEEN 0 AND 90 THEN 5 ELSE 0 END))"""


def lead_dict(row):
    item = dict(row)
    payload = json.loads(item.pop("payload"))
    result = {**payload, **item}
    result["score"], result["score_breakdown"] = score(payload, payload["match"])
    return result


def find_leads(filters, limit=40, offset=0):
    clauses, args = ["active=1"], []
    if not filters.get("state") and filters.get("territory", "target") == "target":
        clauses.append("state IN ('CA','SC')")
    for field in ["trade", "state", "city", "stage", "status"]:
        if filters.get(field):
            clauses.append(f"{field}=?")
            args.append(filters[field])
    if not filters.get("stage") and not filters.get("include_closed"):
        clauses.append("stage NOT IN ('Completed','Cancelled','Expired')")
    if filters.get("saved"):
        clauses.append("saved=1")
    if filters.get("q"):
        clauses.append(
            "(json_extract(payload,'$.address') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.description') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.contractor') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.permit_number') LIKE ? ESCAPE '\\')"
        )
        q = filters["q"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        args.extend([f"%{q}%"] * 4)
    for name, expression in [
        ("zip", "json_extract(payload,'$.zip')=?"),
        ("since", "signal_date>=?"),
        ("min_value", "json_extract(payload,'$.value')>=?"),
        ("min_score", f"({SCORE_SQL})>=?"),
    ]:
        if filters.get(name) is not None and filters.get(name) != "":
            clauses.append(expression)
            args.append(filters[name])
    if filters.get("kind"):
        clauses.append("json_extract(payload,'$.match.kind')=?")
        args.append(filters["kind"])
    where = " AND ".join(clauses)
    order = {
        "score": "computed_score DESC,signal_date DESC,id DESC",
        "newest": "signal_date DESC,id DESC",
        "value": "json_extract(payload,'$.value') DESC,id DESC",
    }[filters.get("sort", "score")]
    with connect() as db:
        total = db.execute(
            f"SELECT count(*) FROM leads WHERE {where}", args
        ).fetchone()[0]
        rows = db.execute(
            f"SELECT *, {SCORE_SQL} AS computed_score FROM leads WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            [*args, limit, offset],
        ).fetchall()
    return {
        "items": [lead_dict(row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def queue_source(source_id):
    with connect() as db:
        row = db.execute(
            "SELECT id FROM runs WHERE source_id=? AND status IN ('queued','running')",
            (source_id,),
        ).fetchone()
        if row:
            return row["id"]
        try:
            return db.execute(
                "INSERT INTO runs(source_id,queued_at) VALUES(?,?)", (source_id, now())
            ).lastrowid
        except sqlite3.IntegrityError:
            return db.execute(
                "SELECT id FROM runs WHERE source_id=? AND status IN ('queued','running')",
                (source_id,),
            ).fetchone()[0]

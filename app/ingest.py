"""One persistent local worker, with a durable queue and replay after restart."""

import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from .db import connect, ingest_batch, now, queue_source
from .sources import SOURCES, batches, client

log = logging.getLogger(__name__)


def run_source(run_id, stop=None):
    with connect() as db:
        run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        source_id = run["source_id"]
        state = dict(
            db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
        )
        db.execute(
            "UPDATE runs SET status='running',started_at=? WHERE id=?", (now(), run_id)
        )
        db.execute(
            "UPDATE sources SET last_started=?,error=NULL WHERE id=?",
            (now(), source_id),
        )
    started = now()
    today = datetime.now(timezone.utc).date().isoformat()
    newest = (
        (state["newest_record"] or "")
        if (state["newest_record"] or "") <= today
        else ""
    )
    try:
        with client() as http:
            if SOURCES[source_id]["kind"] == "socrata" and os.getenv(
                "SOCRATA_APP_TOKEN"
            ):
                http.headers["X-App-Token"] = os.environ["SOCRATA_APP_TOKEN"]
            for rows in batches(source_id, state, http):
                if stop and stop.is_set():
                    raise InterruptedError(
                        "Worker stopping; next run will safely replay"
                    )
                counts, batch_newest = ingest_batch(source_id, rows)
                newest = max(newest, batch_newest)
                with connect() as db:
                    db.execute(
                        "UPDATE runs SET fetched=fetched+?,new_permits=new_permits+?,changed=changed+?,duplicates=duplicates+?,leads_created=leads_created+? WHERE id=?",
                        (*counts.values(), run_id),
                    )
        next_run = (
            datetime.now(timezone.utc)
            + timedelta(seconds=SOURCES[source_id]["interval"])
        ).isoformat(timespec="seconds")
        with connect() as db:
            db.execute(
                "UPDATE sources SET last_success=?,newest_record=?,error=NULL,next_run=? WHERE id=?",
                (started, newest, next_run, source_id),
            )
            db.execute(
                "UPDATE runs SET status='success',finished_at=? WHERE id=?",
                (now(), run_id),
            )
    except Exception as exc:
        log.exception("Ingestion failed for %s", source_id)
        error = f"{type(exc).__name__}: {exc}"[:700]
        retry = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(
            timespec="seconds"
        )
        with connect() as db:
            db.execute(
                "UPDATE sources SET error=?,next_run=? WHERE id=?",
                (error, retry, source_id),
            )
            db.execute(
                "UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=?",
                (error, now(), run_id),
            )


def worker(stop: threading.Event, wake: threading.Event):
    # ponytail: one local ingestion worker; move this durable queue to a
    # distributed worker and PostgreSQL when multiple hosts are required.
    with connect() as db:
        interrupted = db.execute(
            "SELECT DISTINCT source_id FROM runs WHERE status='running'"
        ).fetchall()
        db.execute(
            "UPDATE runs SET status='failed',finished_at=?,error='Interrupted by restart; safe replay queued' WHERE status='running'",
            (now(),),
        )
    for row in interrupted:
        queue_source(row[0])
    while not stop.is_set():
        try:
            if os.getenv("AUTO_SYNC", "1") == "1":
                with connect() as db:
                    due = db.execute(
                        "SELECT id FROM sources WHERE enabled=1 AND (next_run IS NULL OR next_run<=?)",
                        (now(),),
                    ).fetchall()
                for source in due:
                    queue_source(source[0])
            with connect() as db:
                pending = db.execute(
                    "SELECT id FROM runs WHERE status='queued' ORDER BY id LIMIT 1"
                ).fetchone()
            if pending:
                run_source(pending[0], stop)
                continue
        except Exception:
            log.exception("Worker iteration failed; retrying")
        wake.wait(10)
        wake.clear()

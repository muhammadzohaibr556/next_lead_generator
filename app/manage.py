"""Maintenance commands. Stop the web app before reclassifying."""

import argparse
import fcntl

import json
from .db import connect, database_path, init, refresh_project
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["reclassify"])
    parser.parse_args()
    init()
    with open(str(database_path()) + ".worker.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Stop the application before reclassifying")
        with connect() as db:
            # Recompute derived date flags as part of a rules refresh, without
            # changing the municipal dates retained in the canonical payload.
            today = datetime.now(timezone.utc).date().isoformat()
            for row in db.execute("SELECT id,payload FROM permits").fetchall():
                payload = json.loads(row["payload"])
                payload["date_warning"] = payload["activity_date"] > today
                db.execute(
                    "UPDATE permits SET payload=? WHERE id=?",
                    (json.dumps(payload), row["id"]),
                )
            projects = [r[0] for r in db.execute("SELECT project_key FROM projects")]
        for start in range(0, len(projects), 500):
            with connect() as db:
                for project in projects[start : start + 500]:
                    refresh_project(db, project)
        print(
            f"Reclassified {len(projects):,} projects; saved status, assignments and notes retained."
        )


if __name__ == "__main__":
    main()

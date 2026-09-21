import base64
import csv
import fcntl
import io
import json
import os
import re
import secrets
import threading
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .db import (
    SCORE_SQL,
    connect,
    database_path,
    find_leads,
    init,
    lead_dict,
    now,
    queue_source,
)
from .engine import RULES, number
from .ingest import worker
from .sources import PARCEL, SOURCES, client, json_request

STATIC = Path(__file__).parent / "static"
wake = threading.Event()


@asynccontextmanager
async def lifespan(app):
    init()
    stop, thread, lock = threading.Event(), None, None
    if os.getenv("DISABLE_WORKER") != "1":
        lock = open(str(database_path()) + ".worker.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise RuntimeError("Use exactly one Uvicorn worker per database") from None
        thread = threading.Thread(
            target=worker, args=(stop, wake), daemon=True, name="permit-ingestion"
        )
        thread.start()
    try:
        yield
    finally:
        stop.set()
        wake.set()
        if thread:
            await run_in_threadpool(thread.join)
        if lock:
            lock.close()


app = FastAPI(title="Permit Atlas", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=os.getenv(
        "ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver"
    ).split(","),
)


@app.middleware("http")
async def security(request: Request, call_next):
    username, password = os.getenv("APP_USERNAME", ""), os.getenv("APP_PASSWORD", "")
    if bool(username) != bool(password):
        return JSONResponse(
            {"detail": "Configure both APP_USERNAME and APP_PASSWORD"}, 503
        )
    if password:
        try:
            scheme, encoded = request.headers.get("authorization", "").split(" ", 1)
            supplied = base64.b64decode(encoded, validate=True).decode()
            valid = scheme.lower() == "basic" and secrets.compare_digest(
                supplied.encode(), f"{username}:{password}".encode()
            )
        except (ValueError, UnicodeError):
            valid = False
        if not valid:
            return JSONResponse(
                {"detail": "Sign in required"},
                401,
                headers={"WWW-Authenticate": 'Basic realm="Permit Atlas"'},
            )
    elif not request.client or request.client.host not in {
        "127.0.0.1",
        "::1",
        "testclient",
    }:
        return JSONResponse(
            {"detail": "Remote access requires APP_USERNAME and APP_PASSWORD"}, 403
        )
    if request.method in {"POST", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin writes are not allowed"}, 403)
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"detail": "Use application/json"}, 415)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path == "/" or request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    if request.url.path == "/":
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        )
    return response


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    with connect() as db:
        db.execute("SELECT 1")
    return {"status": "ok", "automatic_sync": os.getenv("AUTO_SYNC", "1") == "1"}


class Filters(BaseModel):
    q: str = Field("", max_length=200)
    trade: str = Field("", max_length=40)
    state: Literal["", "CA", "SC", "TX"] = ""
    territory: Literal["target", "all"] = "target"
    city: str = Field("", max_length=80)
    zip: str = Field("", pattern=r"^(\d{5})?$")
    stage: Literal[
        "",
        "Application",
        "In review",
        "Issued",
        "In progress",
        "Active · stage unknown",
        "Completed",
        "Cancelled",
        "Expired",
    ] = ""
    status: Literal["", "New", "Qualified", "Contacted", "Sold", "Dismissed"] = ""
    kind: Literal["", "Direct", "Adjacent"] = ""
    saved: bool = False
    include_closed: bool = False
    since: date | None = None
    min_value: float | None = Field(None, ge=0, le=1e12)
    min_score: int = Field(0, ge=0, le=100)
    sort: Literal["score", "newest", "value"] = "score"
    limit: int = Field(40, ge=1, le=200)
    offset: int = Field(0, ge=0, le=1_000_000)


@app.get("/api/leads")
def leads(filters: Annotated[Filters, Query()]):
    return find_leads(filters.model_dump(mode="json"), filters.limit, filters.offset)


def csv_safe(value):
    value = "" if value is None else str(value)
    return (
        "'" + value
        if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r", "\n"))
        else value
    )


@app.get("/api/leads/export")
def export(filters: Annotated[Filters, Query()]):
    data = find_leads(filters.model_dump(mode="json"), limit=10001)
    if data["total"] > 10000:
        raise HTTPException(
            422, "Narrow your filters to 10,000 leads or fewer before exporting"
        )
    fields = [
        "id",
        "trade",
        "score",
        "address",
        "city",
        "state",
        "zip",
        "apn",
        "description",
        "stage",
        "signal_date",
        "value",
        "contractor",
        "contractor_phone",
        "permit_holder",
        "owner",
        "status",
        "assigned_to",
        "notes",
        "source_url",
    ]
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(fields)
    writer.writerows(
        [csv_safe(row.get(field)) for field in fields] for row in data["items"]
    )
    return Response(
        "\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="permit-atlas-leads.csv"'
        },
    )


@app.get("/api/leads/{lead_id}")
def lead_detail(lead_id: int):
    with connect() as db:
        row = db.execute("SELECT * FROM leads WHERE id=?", (lead_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Lead not found")
        item = lead_dict(row)
        permits = db.execute(
            "SELECT * FROM permits WHERE project_key=?", (row["project_key"],)
        ).fetchall()
        item["permits"] = []
        for permit in permits:
            events = db.execute(
                "SELECT e.id,e.source_id,e.fetched_at FROM raw_events e WHERE permit_id=? ORDER BY e.id DESC",
                (permit["id"],),
            ).fetchall()
            item["permits"].append(
                {
                    **json.loads(permit["payload"]),
                    "first_seen": permit["first_seen"],
                    "last_seen": permit["last_seen"],
                    "evidence": [dict(event) for event in events],
                }
            )
        enrich = (
            db.execute(
                "SELECT * FROM property_enrichment WHERE apn=?",
                (re.sub(r"\D", "", item["apn"]),),
            ).fetchone()
            if item["jurisdiction"] == "los-angeles"
            else None
        )
        item["property"] = (
            {"fetched_at": enrich["fetched_at"], **json.loads(enrich["payload"])}
            if enrich
            else None
        )
        item["related"] = [
            dict(r)
            for r in db.execute(
                "SELECT id,trade,stage FROM leads WHERE id<>? AND active=1 AND city=? AND json_extract(payload,'$.address_key')=? AND json_extract(payload,'$.address_key')<>'' LIMIT 12",
                (lead_id, item["city"], item["address_key"]),
            )
        ]
    return item


class LeadUpdate(BaseModel):
    status: Literal["New", "Qualified", "Contacted", "Sold", "Dismissed"] | None = None
    saved: bool | None = None
    notes: str | None = Field(None, max_length=10000)
    assigned_to: str | None = Field(None, max_length=120)


@app.patch("/api/leads/{lead_id}")
def update_lead(lead_id: int, update: LeadUpdate):
    changes = update.model_dump(exclude_none=True)
    with connect() as db:
        if not db.execute("SELECT 1 FROM leads WHERE id=?", (lead_id,)).fetchone():
            raise HTTPException(404, "Lead not found")
        if changes:
            db.execute(
                "UPDATE leads SET "
                + ",".join(f"{key}=?" for key in changes)
                + " WHERE id=?",
                [*changes.values(), lead_id],
            )
    return {"ok": True}


@app.get("/api/evidence/{event_id}")
def evidence(event_id: int):
    with connect() as db:
        row = db.execute("SELECT * FROM raw_events WHERE id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Evidence not found")
        return {**dict(row), "payload": json.loads(row["payload"])}


@app.post("/api/leads/{lead_id}/enrich")
def enrich(lead_id: int):
    lead = lead_detail(lead_id)
    apn = re.sub(r"\D", "", lead["apn"])
    if lead["jurisdiction"] != "los-angeles" or len(apn) != 10:
        raise HTTPException(
            422,
            "Exact parcel enrichment currently supports Los Angeles permits with a 10-digit APN",
        )
    if (
        lead["property"]
        and (
            datetime.now(timezone.utc)
            - datetime.fromisoformat(lead["property"]["fetched_at"])
        ).days
        < 30
    ):
        return lead["property"]
    try:
        with client() as http:
            data = json_request(
                http,
                PARCEL + "/query",
                {
                    "f": "json",
                    "where": f"AIN='{apn}'",
                    "outFields": "AIN,APN,SitusFullAddress,UseType,UseDescription,YearBuilt1,SQFTmain1,Units1,Bedrooms1,Bathrooms1,Roll_Year,Roll_LandValue,Roll_ImpValue",
                    "returnGeometry": "false",
                    "resultRecordCount": 2,
                },
            )
        features = data.get("features", [])
        if len(features) != 1:
            raise HTTPException(
                404, "No unique parcel match; property details were not guessed"
            )
        p = features[0]["attributes"]
        land, improvement = number(p.get("Roll_LandValue")), number(
            p.get("Roll_ImpValue")
        )
        result = {
            "apn": p.get("AIN"),
            "address": p.get("SitusFullAddress"),
            "use": p.get("UseDescription") or p.get("UseType"),
            "year_built": p.get("YearBuilt1"),
            "building_sqft": p.get("SQFTmain1"),
            "units": p.get("Units1"),
            "bedrooms": p.get("Bedrooms1"),
            "bathrooms": p.get("Bathrooms1"),
            "roll_year": p.get("Roll_Year"),
            "assessed_value": (
                land + improvement
                if land is not None and improvement is not None
                else None
            ),
            "source_url": PARCEL,
            "match_method": "Exact county AIN",
            "owner_contact": "Not provided by this parcel API",
        }
        with connect() as db:
            db.execute(
                "INSERT INTO property_enrichment VALUES(?,?,?) ON CONFLICT(apn) DO UPDATE SET fetched_at=excluded.fetched_at,payload=excluded.payload",
                (apn, now(), json.dumps(result)),
            )
        return {"fetched_at": now(), **result}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            502, f"County parcel service unavailable: {type(exc).__name__}"
        ) from exc


@app.get("/api/sources")
def sources():
    with connect() as db:
        states = {row["id"]: dict(row) for row in db.execute("SELECT * FROM sources")}
        runs = [
            dict(row)
            for row in db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 30")
        ]
    items = [{"id": key, **value, **states[key]} for key, value in SOURCES.items()]
    return {
        "items": items,
        "runs": runs,
        "automatic_sync": os.getenv("AUTO_SYNC", "1") == "1",
    }


@app.get("/api/coverage")
def coverage():
    """A connected city never implies coverage of its whole state or county."""
    with connect() as db:
        states = {r["id"]: dict(r) for r in db.execute("SELECT * FROM sources")}
        counts = {
            r[0]: r[1]
            for r in db.execute(
                "SELECT jurisdiction,count(*) FROM permits GROUP BY jurisdiction"
            )
        }
    result = []
    for code, name in [("CA", "California"), ("SC", "South Carolina")]:
        jurisdictions = {}
        for key, source in SOURCES.items():
            if source["state"] != code:
                continue
            item = jurisdictions.setdefault(
                source["jurisdiction"],
                {
                    "name": source["city"],
                    "permits": counts.get(source["jurisdiction"], 0),
                    "feeds": [],
                },
            )
            item["feeds"].append(
                {
                    "id": key,
                    "last_success": states[key]["last_success"],
                    "error": states[key]["error"],
                    "newest_record": states[key]["newest_record"],
                }
            )
        result.append(
            {
                "state": code,
                "name": name,
                "complete": False,
                "jurisdictions": list(jurisdictions.values()),
                "permits": sum(x["permits"] for x in jurisdictions.values()),
            }
        )
    return {
        "states": result,
        "message": "Partial jurisdiction coverage. All other cities and unincorporated county areas are unconnected. A statewide aggregate or provider state filter is not proof of complete permit coverage.",
    }


class SourceUpdate(BaseModel):
    enabled: bool


@app.patch("/api/sources/{source_id}")
def update_source(source_id: str, update: SourceUpdate):
    if source_id not in SOURCES:
        raise HTTPException(404, "Unknown source")
    with connect() as db:
        db.execute(
            "UPDATE sources SET enabled=? WHERE id=?", (update.enabled, source_id)
        )
    wake.set()
    return {"ok": True}


class SyncRequest(BaseModel):
    source_id: str | None = None


@app.post("/api/sync", status_code=202)
def sync(request: SyncRequest):
    if request.source_id and request.source_id not in SOURCES:
        raise HTTPException(404, "Unknown source")
    with connect() as db:
        ids = (
            [request.source_id]
            if request.source_id
            else [r[0] for r in db.execute("SELECT id FROM sources WHERE enabled=1")]
        )
    runs = [queue_source(key) for key in ids]
    wake.set()
    return {"run_ids": runs, "message": "Sync queued"}


@app.get("/api/stats")
def stats():
    with connect() as db:
        active = "active=1 AND state IN ('CA','SC') AND stage NOT IN ('Completed','Cancelled','Expired')"
        values = db.execute(
            f"SELECT count(*) total,sum(trade='Roofing') roofing,sum(trade='Tile') tile,sum(({SCORE_SQL})>=75) high_priority,sum(signal_date BETWEEN date('now','-7 days') AND date('now')) recent FROM leads WHERE {active}"
        ).fetchone()
        markets = [
            dict(row)
            for row in db.execute(
                f"SELECT city,state,count(*) total FROM leads WHERE {active} GROUP BY city,state ORDER BY total DESC"
            )
        ]
        trades = [
            dict(row)
            for row in db.execute(
                f"SELECT trade,count(*) total FROM leads WHERE {active} GROUP BY trade ORDER BY total DESC"
            )
        ]
        trend = [
            dict(row)
            for row in db.execute(
                f"SELECT signal_date day,count(*) total FROM leads WHERE {active} AND signal_date BETWEEN date('now','-13 days') AND date('now') GROUP BY signal_date ORDER BY signal_date"
            )
        ]
        permits = db.execute(
            "SELECT count(*) FROM permits WHERE json_extract(payload,'$.state') IN ('CA','SC')"
        ).fetchone()[0]
        saved = db.execute(
            "SELECT count(*) FROM leads WHERE active=1 AND saved=1 AND state IN ('CA','SC')"
        ).fetchone()[0]
        last_sync = db.execute("SELECT max(last_success) FROM sources").fetchone()[0]
    return {
        **{k: v or 0 for k, v in dict(values).items()},
        "permits": permits,
        "saved": saved,
        "markets": markets,
        "trades": trades,
        "trend": trend,
        "last_sync": last_sync,
        "categories": list(RULES),
    }


app.mount("/static", StaticFiles(directory=STATIC), name="static")

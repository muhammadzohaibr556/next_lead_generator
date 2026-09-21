"""Verified municipal endpoints; no paid data account required."""

import os
import tempfile
import time
from datetime import datetime, timedelta, timezone

import httpx
import pandas as pd

FW = "https://services5.arcgis.com/3ddLCBXe1bRt7mzj/arcgis/rest/services/CFW_Open_Data_Development_Permits_View/FeatureServer/0"
PARCEL = "https://cache.gis.lacounty.gov/cache/rest/services/LACounty_Cache/LACounty_Parcel/FeatureServer/0"
SD = "https://seshat.datasd.org/development_permits"
SOURCES = {
    "la-submitted": dict(
        name="Los Angeles · Submitted",
        city="Los Angeles",
        state="CA",
        jurisdiction="los-angeles",
        kind="socrata",
        url="https://data.lacity.org/resource/gwh9-jnip.json",
        page="https://data.lacity.org/d/gwh9-jnip",
        dates=["submitted_date", "issue_date", "status_date"],
        interval=21600,
        freshness="Publication cadence varies",
        default_stage="Application",
    ),
    "la-issued": dict(
        name="Los Angeles · Issued",
        city="Los Angeles",
        state="CA",
        jurisdiction="los-angeles",
        kind="socrata",
        url="https://data.lacity.org/resource/pi9x-tg5x.json",
        page="https://data.lacity.org/d/pi9x-tg5x",
        dates=["submitted_date", "issue_date", "status_date"],
        interval=21600,
        freshness="Publication cadence varies",
        default_stage="Issued",
    ),
    "austin": dict(
        name="Austin · Construction permits",
        city="Austin",
        state="TX",
        jurisdiction="austin",
        kind="socrata",
        url="https://data.austintexas.gov/resource/3syk-w9eu.json",
        page="https://data.austintexas.gov/d/3syk-w9eu",
        dates=["applieddate", "issue_date", "statusdate"],
        interval=14400,
        freshness="Daily publication",
        default_stage="Issued",
    ),
    "fort-worth": dict(
        name="Fort Worth · Development permits",
        city="Fort Worth",
        state="TX",
        jurisdiction="fort-worth",
        kind="arcgis",
        url=FW + "/query",
        page="https://www.arcgis.com/home/item.html?id=d2740f4d746b4bfaa03e25de0376238b",
        dates=["File_Date", "Status_Date"],
        interval=3600,
        freshness="Hourly during business hours",
        default_stage="Application",
    ),
    "sd-created": dict(
        name="San Diego · Created approvals",
        city="San Diego",
        state="CA",
        jurisdiction="san-diego",
        kind="csv",
        feed="created",
        url=SD,
        page="https://data.sandiego.gov/datasets/development-permits/",
        interval=21600,
        freshness="Daily publication",
        default_stage="Application",
    ),
    "sd-issued": dict(
        name="San Diego · Issued approvals",
        city="San Diego",
        state="CA",
        jurisdiction="san-diego",
        kind="csv",
        feed="issued",
        url=SD,
        page="https://data.sandiego.gov/datasets/development-permits/",
        interval=21600,
        freshness="Daily publication",
        default_stage="Issued",
    ),
}

# City limits, not statewide coverage. Keep the issuing jurisdiction in identity.
SOURCES["san-francisco"] = dict(
    name="San Francisco · Building permits",
    city="San Francisco",
    state="CA",
    jurisdiction="san-francisco",
    kind="socrata",
    url="https://data.sf.gov/resource/i98e-djp9.json",
    page="https://data.sf.gov/d/i98e-djp9",
    dates=["filed_date", "issued_date", "status_date", "last_permit_activity_date"],
    where="primary_address_flag = 'Y'",
    interval=86400,
    freshness="Daily publication",
    default_stage="Application",
    scope="City and County of San Francisco; primary permit address",
)

for key, city, state_code, url, dates, default_stage, scope in [
    (
        "charleston-active",
        "Charleston",
        "SC",
        "https://gis.charleston-sc.gov/arcgis2/rest/services/External/Applications/MapServer/20",
        ["APPLICATION_DATE", "ISSUE_DATE", "FINALED_DATE", "LAST_INSPECTION_DATE"],
        "Application",
        "City of Charleston active permits; excludes other county jurisdictions",
    ),
    (
        "charleston-issued",
        "Charleston",
        "SC",
        "https://gis.charleston-sc.gov/arcgis2/rest/services/External/Applications/MapServer/1134",
        ["APPLICATION_DATE", "ISSUE_DATE", "FINALED_DATE", "LAST_INSPECTION_DATE"],
        "Issued",
        "City of Charleston issued permits and subsequent status",
    ),
    (
        "sacramento",
        "Sacramento",
        "CA",
        "https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/BldgPermitIssued_CurrentYear/FeatureServer/0",
        [],
        "Issued",
        "City of Sacramento; current calendar year issued permits only; monthly publication",
    ),
    (
        "west-sacramento",
        "West Sacramento",
        "CA",
        "https://gis.cityofwestsacramento.org/server/rest/services/building_permits/FeatureServer/0",
        ["DateApplied", "StatusDate"],
        "Application",
        "City of West Sacramento; permit type/subtype available, detailed scope not published",
    ),
    (
        "pasadena",
        "Pasadena",
        "CA",
        "https://services2.arcgis.com/zNjnZafDYCAJAbN0/ArcGIS/rest/services/Permit_Activity/FeatureServer/0",
        ["LATEST_ACTIVITY"],
        "Active · stage unknown",
        "City of Pasadena active permits; activity date only, application/issue dates and status not published",
    ),
]:
    SOURCES[key] = dict(
        name=city
        + " · "
        + (
            "Active permits"
            if key.endswith("active") or key == "pasadena"
            else "Issued permits" if key.endswith("issued") else "Building permits"
        ),
        city=city,
        state=state_code,
        jurisdiction="charleston" if key.startswith("charleston-") else key,
        kind="arcgis",
        url=url + "/query",
        page=url,
        dates=dates,
        interval=86400,
        freshness=(
            "Monthly publication"
            if key == "sacramento"
            else "Publication cadence varies"
        ),
        default_stage=default_stage,
        scope=scope,
    )
SOURCES["pasadena"]["object_id"] = "ESRI_OID"
SOURCES["sacramento"]["client_dates"] = ["status_date"]

for key, resource, filename, default_stage in [
    (
        "recent",
        "2723cdec-a639-4b63-bded-175338c45473/resource/045b3678-e923-4002-b696-300955bc6d06",
        "buildingpermits30",
        "Issued",
    ),
    (
        "active",
        "fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f/resource/761b7ae8-3be1-4ad6-923d-c7af6404a904",
        "buildingpermitsactive",
        "Issued",
    ),
    (
        "expired",
        "3b40d486-bd19-44c5-b854-5f0638c2afc3/resource/df4b8461-0c7a-4d16-b85d-ff7f71c5fed5",
        "buildingpermitsexpired",
        "Expired",
    ),
]:
    SOURCES["sj-" + key] = dict(
        name="San José · " + key.title() + " permits",
        city="San José",
        state="CA",
        jurisdiction="san-jose",
        kind="csv",
        url=f"https://data.sanjoseca.gov/dataset/{resource}/download/{filename}.csv",
        page="https://data.sanjoseca.gov/dataset/" + resource.split("/")[0],
        dates=["issuedate", "finaldate"],
        required=["foldernumber", "issuedate", "finaldate"],
        interval=86400,
        freshness="Daily publication",
        default_stage=default_stage,
        scope="City of San José; published issued/final dates, no application date",
    )


def filter_dates(rows, columns, coverage):
    """Parse non-ISO municipal date columns in pandas, never compare MM/DD text."""
    if not rows:
        return []
    frame = pd.DataFrame(rows)
    frame.columns = frame.columns.str.lower().str.strip()
    if not set(columns).issubset(frame.columns):
        raise ValueError("Date columns missing; inspect source schema")
    mask = pd.Series(False, index=frame.index)
    for col in columns:
        mask |= pd.to_datetime(
            frame[col], format="mixed", errors="coerce", utc=True
        ) >= pd.Timestamp(coverage, tz="UTC")
    return [row for row, keep in zip(rows, mask) if keep]


def request(client, url, params=None):
    """Retry transient public-service failures, never silently accept error JSON."""
    for attempt in range(3):
        try:
            response = client.get(url, params=params)
            if response.status_code == 429 or response.status_code >= 500:
                if attempt < 2:
                    delay = response.headers.get("Retry-After", "")
                    time.sleep(min(int(delay), 30) if delay.isdigit() else 2**attempt)
                    continue
            response.raise_for_status()
            return response
        except httpx.TransportError:
            if attempt == 2:
                raise
            time.sleep(2**attempt)


def json_request(client, url, params):
    data = request(client, url, params).json()
    if isinstance(data, dict) and (data.get("error") or data.get("errorCode")):
        raise ValueError("Upstream API error: " + str(data)[:400])
    return data


def batches(source_id, state, client):
    source = SOURCES[source_id]
    coverage = state["coverage_since"][:10]
    if source["kind"] == "socrata":
        where = (
            "("
            + " OR ".join(f"{col} >= '{coverage}T00:00:00'" for col in source["dates"])
            + ")"
        )
        if source.get("where"):
            where += " AND (" + source["where"] + ")"
        if state["last_success"]:
            overlap = datetime.fromisoformat(state["last_success"]) - timedelta(
                hours=72
            )
            where += f" AND :updated_at >= '{overlap.strftime('%Y-%m-%dT%H:%M:%SZ')}'"
        # A provider may replace its whole snapshot; the fixed coverage boundary
        # keeps those refreshes bounded without forgetting the monitored cohort.
        offset = 0
        while True:
            data = json_request(
                client,
                source["url"],
                {
                    "$select": "*, :id, :updated_at",
                    "$where": where,
                    "$order": ":id",
                    "$limit": 1000,
                    "$offset": offset,
                },
            )
            if not isinstance(data, list):
                raise ValueError("Expected a Socrata list")
            if not data:
                break
            yield data
            offset += len(data)
            if len(data) < 1000:
                break
    elif source["kind"] == "arcgis":
        # This snapshot has no row modified timestamp. Reconcile the monitored
        # cohort each poll so corrections to previously seen permits are retained.
        where = (
            " OR ".join(
                f"{col} >= TIMESTAMP '{coverage} 00:00:00'" for col in source["dates"]
            )
            or "1=1"
        )
        offset = 0
        while True:
            data = json_request(
                client,
                source["url"],
                dict(
                    f="json",
                    where=where,
                    outFields="*",
                    returnGeometry="false",
                    orderByFields=source.get("object_id", "OBJECTID") + " ASC",
                    resultOffset=offset,
                    resultRecordCount=1000,
                ),
            )
            if "features" not in data:
                raise ValueError("ArcGIS response has no features")
            rows = [f["attributes"] for f in data["features"]]
            fetched_count = len(rows)
            if not rows and data.get("exceededTransferLimit"):
                raise ValueError("ArcGIS pagination made no progress")
            if rows and source.get("client_dates"):
                rows = filter_dates(rows, source["client_dates"], coverage)
            if rows:
                yield rows
            offset += fetched_count
            if not data.get("exceededTransferLimit"):
                break
    else:
        # Keep all annual files in the monitored cohort, including across Jan 1.
        urls = (
            [
                f"{SD}/approvals_{source['feed']}_{year}_datasd.csv"
                for year in range(
                    int(coverage[:4]), datetime.now(timezone.utc).year + 1
                )
            ]
            if source.get("feed")
            else [source["url"]]
        )
        for url in urls:
            # Disk spool + pandas chunks avoid holding a year's CSV in memory.
            with tempfile.TemporaryFile() as spool:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    size = 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 200_000_000:
                            raise ValueError(
                                "Annual CSV exceeded 200 MB; inspect source"
                            )
                        spool.write(chunk)
                spool.seek(0)
                for frame in pd.read_csv(
                    spool,
                    dtype=str,
                    keep_default_na=False,
                    chunksize=2000,
                    encoding="utf-8-sig",
                ):
                    frame.columns = frame.columns.str.lower().str.strip()
                    required = set(
                        source.get(
                            "required",
                            [
                                "approval_id",
                                "approval_create_date",
                                "approval_issue_date",
                            ],
                        )
                    )
                    if not required.issubset(frame.columns):
                        raise ValueError(f"{source_id} CSV schema changed")
                    if source.get("feed"):
                        mask = (frame["approval_create_date"] >= coverage) | (
                            frame["approval_issue_date"] >= coverage
                        )
                        rows = frame.loc[mask].to_dict("records")
                    else:
                        rows = filter_dates(
                            frame.to_dict("records"), source["dates"], coverage
                        )
                    if rows:
                        yield rows


def client():
    headers = {"User-Agent": "PermitAtlas/1.0 (municipal public-data research)"}
    # Token is only sent to Socrata, via the per-source client in ingest.py.
    return httpx.Client(
        timeout=httpx.Timeout(60, connect=15), headers=headers, follow_redirects=True
    )

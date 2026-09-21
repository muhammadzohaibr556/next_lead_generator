"""Runnable regression check: .venv/bin/python check.py (no network calls)."""

import csv
import io
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.db import connect, ingest_batch, now, queue_source
from app.engine import address_key, classify, normalize, score
from app.ingest import run_source
from app.main import app, csv_safe
from app.sources import batches, json_request


def check():
    today = datetime.now(timezone.utc).date().isoformat()
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    la = dict(
        permit_nbr="TEST-ROOF-1",
        primary_address="123 North Test Street",
        zip_code="90001",
        apn="1234567890",
        work_desc="Replace roof with clay tile",
        permit_type="Bldg-Alter/Repair",
        submitted_date=yesterday,
        status_date=yesterday,
        status_desc="Application Submitted",
        valuation="18,000",
    )
    assert address_key("123 N. Test Street") == address_key("123 North Test St")
    assert address_key("123 Test St Unit 1") != address_key("123 Test St Unit 2")
    assert "Tile" not in classify("Reroof with concrete roof tiles")
    assert "Roofing" not in classify("Install roof-mounted solar panels")
    assert "Roofing" not in classify("Install solar panels on existing roof")
    assert "Roofing" not in classify("Floor labels revised to P1, P2, Roof")
    assert "Roofing" not in classify("Mechanical unit replacement on the roof")
    assert "Roofing" not in classify("Install building maintenance equipment at roof")
    assert "Roofing" not in classify("Build new roof deck with stairs and railings")
    assert "Roofing" in classify("Replace roofing and build new roof deck")
    assert classify("New 2-story SFD with roof deck")["Roofing"]["kind"] == "Adjacent"
    assert (
        classify("Kitchen remodel and replace roof tiles")["Tile"]["kind"] == "Adjacent"
    )
    assert "Roofing" not in classify("No roofing work; install tile backsplash")
    assert classify("Bathroom remodel")["Tile"]["kind"] == "Adjacent"
    assert classify("Install porcelain tile flooring")["Tile"]["kind"] == "Direct"
    assert classify("New construction of a dwelling")["Roofing"]["kind"] == "Adjacent"
    fw = normalize(
        {
            "Permit_No": "FW-1",
            "Addr_No": 12,
            "Direction": "N",
            "Street_Name": "TEST",
            "Street_Suffix": "ST",
            "File_Date": 0,
            "Current_Status": "Issued",
        },
        "fort-worth",
    )
    assert fw["address"] == "12 N TEST ST" and fw["applied_date"] == "1970-01-01"
    fw_scope = normalize(
        {
            "Permit_No": "FW-2",
            "B1_WORK_DESC": "B1_WORK_DESC",
            "B1_SPECIAL_TEXT": "Reroof existing home",
        },
        "fort-worth",
    )
    assert fw_scope["description"] == "Reroof existing home"
    future = normalize({**la, "status_date": "2099-01-01"}, "la-submitted")
    assert (
        future["date_warning"]
        and score(future, classify(future["description"])["Roofing"])[0] <= 25
    )
    sf = normalize(
        {
            "permit_number": "SF-1",
            "street_number": "10",
            "street_name": "Test",
            "street_suffix": "St",
            "unit": "2",
            "unit_suffix": "C",
            "filed_date": today,
            "location": {"coordinates": [-122.4, 37.7]},
        },
        "san-francisco",
    )
    assert sf["address"] == "10 Test St Unit 2C" and sf["longitude"] == -122.4
    charleston = {
        "PERMIT_NUMBER": "SC-1",
        "PERMIT_ADDRESS_LINE1": "10 Test St",
        "PERMIT_ADDRESS_LINE2": "Charleston, SC 29401",
        "DESCRIPTION": "Reroof house",
        "APPLICATION_DATE": int(datetime.now(timezone.utc).timestamp() * 1000),
        "PERMIT_STATUS": "Applied Online",
        "PROJECT": "Generic project name",
    }
    sc = normalize(charleston, "charleston-active")
    assert (
        sc["zip"] == "29401" and sc["applied_date"] == today and not sc["project_ref"]
    )
    sj = normalize(
        {
            "FOLDERNUMBER": "SJ-1",
            "gx_location": "10 Test St, SAN JOSE CA 95112",
            "ISSUEDATE": "9/1/2026 12:00:00 AM",
            "PERMITAPPROVALS": "B-4. Complete",
            "FOLDERNAME": "ReRoof",
        },
        "sj-recent",
    )
    assert sj["stage"] == "Issued" and sj["issue_date"] == "2026-09-01"
    assert (
        normalize({"FOLDERNUMBER": "SJ-1", "ISSUEDATE": "9/1/2026"}, "sj-expired")[
            "stage"
        ]
        == "Expired"
    )
    pasadena = normalize(
        {"CASE_NUMBER": "P-1", "LATEST_ACTIVITY": 1789772898000}, "pasadena"
    )
    assert (
        pasadena["stage"] == "Active · stage unknown"
        and not pasadena["issue_date"]
        and pasadena["signal_date_kind"] == "Last activity"
    )
    assert "Roofing" in classify(
        "E-Permit: Tear Off - Yes, Resheet - No, 2 layer(s), 23 squares of Composite Class A."
    )

    with tempfile.TemporaryDirectory() as temp, patch.dict(
        os.environ,
        {
            "DATABASE_PATH": temp + "/test.db",
            "DISABLE_WORKER": "1",
            "AUTO_SYNC": "0",
            "APP_USERNAME": "",
            "APP_PASSWORD": "",
        },
    ):
        with TestClient(app) as api:
            counts, _ = ingest_batch("la-submitted", [la, la])
            assert counts["new_permits"] == counts["leads_created"] == 1
            assert counts["duplicates"] == 1
            listing = api.get("/api/leads?trade=Roofing").json()
            assert listing["total"] == 1 and listing["items"][0]["score"] >= 75
            lead_id = listing["items"][0]["id"]
            assert (
                api.patch(
                    f"/api/leads/{lead_id}",
                    json={
                        "saved": True,
                        "status": "Qualified",
                        "notes": "=SUM(1,2)",
                        "assigned_to": "Alex",
                    },
                ).status_code
                == 200
            )
            issued = {
                **la,
                "issue_date": today,
                "status_date": today,
                "status_desc": "Issued",
            }
            ingest_batch("la-issued", [issued])
            ingest_batch("la-submitted", [la])
            lead = api.get(f"/api/leads/{lead_id}").json()
            assert (
                lead["stage"] == "Issued"
                and lead["status"] == "Qualified"
                and lead["saved"] == 1
            )
            assert (
                len(lead["permits"]) == 1 and len(lead["permits"][0]["evidence"]) == 2
            )
            assert (
                api.get(
                    "/api/leads?saved=true&state=CA&zip=90001&min_value=17000"
                ).json()["total"]
                == 1
            )
            assert api.get("/api/leads?state=TX").json()["total"] == 0
            assert api.get("/api/leads?sort=invalid").status_code == 422
            assert api.get("/api/leads?min_score=101").status_code == 422
            assert (
                api.get("/api/leads?q=%25").json()["total"] == 0
            )  # literal %, not wildcard
            assert api.get("/api/leads?q=%27%20OR%201=1--").json()["total"] == 0
            exported = api.get("/api/leads/export?saved=true").text.lstrip("\ufeff")
            csv_row = next(csv.DictReader(io.StringIO(exported)))
            assert csv_row["notes"] == "'=SUM(1,2)"
            assert (
                api.patch(f"/api/leads/{lead_id}", json={"notes": ""}).status_code
                == 200
            )
            assert api.get(f"/api/leads/{lead_id}").json()["notes"] == ""
            assert csv_safe("  =BAD()") == "'  =BAD()"
            assert (
                api.post(
                    "/api/sync",
                    json={},
                    headers={"Origin": "https://untrusted.example"},
                ).status_code
                == 403
            )
            assert api.post("/api/sync", data={}).status_code == 415
            assert (
                api.patch(
                    f"/api/leads/{lead_id}", json={"status": "Invented"}
                ).status_code
                == 422
            )
            assert (
                api.post("/api/sync", json={"source_id": "unknown"}).status_code == 404
            )
            with patch.dict(
                os.environ, {"APP_USERNAME": "test", "APP_PASSWORD": "secret"}
            ):
                assert api.get("/api/stats").status_code == 401
                assert api.get("/api/stats", auth=("test", "secret")).status_code == 200
            with patch(
                "app.main.json_request",
                return_value={
                    "features": [
                        {
                            "attributes": {
                                "AIN": "1234567890",
                                "YearBuilt1": "1980",
                                "SQFTmain1": 1400,
                                "Roll_Year": "2025",
                                "Roll_LandValue": 100000,
                                "Roll_ImpValue": 200000,
                            }
                        }
                    ]
                },
            ):
                property_data = api.post(f"/api/leads/{lead_id}/enrich", json={}).json()
                assert (
                    property_data["assessed_value"] == 300000
                    and property_data["match_method"] == "Exact county AIN"
                )
            # Unrelated jobs at the same property must remain independently reviewable.
            ingest_batch("la-submitted", [{**la, "permit_nbr": "TEST-ROOF-2"}])
            assert api.get("/api/leads?trade=Roofing").json()["total"] == 2
            assert api.get(f"/api/leads/{lead_id}").json()["related"]
            closed = {**issued, "status_desc": "Permit Finaled"}
            ingest_batch("la-issued", [closed])
            ingest_batch(
                "la-submitted", [issued]
            )  # equal-date issued snapshot cannot undo a final
            assert api.get(f"/api/leads/{lead_id}").json()["stage"] == "Completed"
            assert api.get(f"/api/leads/{lead_id}").json()["score"] <= 10
            assert api.get("/api/leads?trade=Roofing").json()["total"] == 1
            assert (
                api.get("/api/leads?trade=Roofing&include_closed=true").json()["total"]
                == 2
            )
            sd = dict(
                APPROVAL_ID="SD-1",
                PROJECT_ID="PRJ-TEST",
                GIS_ADDRESS="10 Test Ave, San Diego, CA 92101",
                APPROVAL_SCOPE="Install ceramic floor tile",
                APPROVAL_STATUS="Created",
                APPROVAL_CREATE_DATE=today,
                APPROVAL_ISSUE_DATE="",
                APPROVAL_PERMIT_HOLDER="Example Permit Holder",
            )
            ingest_batch("sd-created", [sd, {**sd, "APPROVAL_ID": "SD-2"}])
            tiles = api.get("/api/leads?trade=Tile&city=San%20Diego").json()
            assert tiles["total"] == 1 and tiles["items"][0]["permit_count"] == 2
            assert not tiles["items"][0][
                "contractor"
            ]  # holder is not silently relabeled
            ingest_batch(
                "sd-created",
                [
                    {**sd, "APPROVAL_SCOPE": "Grading only"},
                    {**sd, "APPROVAL_ID": "SD-2", "APPROVAL_SCOPE": "Grading only"},
                ],
            )
            assert (
                api.get("/api/leads?trade=Tile&city=San%20Diego").json()["total"] == 0
            )
            ingest_batch("charleston-active", [charleston])
            sc_leads = api.get("/api/leads?state=SC&trade=Roofing").json()
            assert (
                sc_leads["total"] == 1 and sc_leads["items"][0]["city"] == "Charleston"
            )
            ingest_batch(
                "charleston-issued",
                [
                    {
                        **charleston,
                        "ISSUE_DATE": charleston["APPLICATION_DATE"],
                        "PERMIT_STATUS": "Issued",
                    }
                ],
            )
            assert api.get("/api/leads?state=SC").json()["total"] == 1
            assert "Charleston" in api.get("/api/leads/export?state=SC").text
            coverage = api.get("/api/coverage").json()
            assert {s["state"] for s in coverage["states"]} == {"CA", "SC"} and all(
                not s["complete"] for s in coverage["states"]
            )
            assert (
                next(s for s in coverage["states"] if s["state"] == "SC")["permits"]
                == 1
            )

            # A partial run commits completed batches but does not advance the cursor.
            def fail_after_batch(*args):
                yield [{**la, "permit_nbr": "PARTIAL-1"}]
                raise ValueError("Simulated second-page failure")

            run_id = queue_source("la-submitted")
            assert queue_source("la-submitted") == run_id
            with patch("app.ingest.batches", fail_after_batch):
                run_source(run_id)
            with connect() as db:
                assert (
                    db.execute(
                        "SELECT last_success FROM sources WHERE id='la-submitted'"
                    ).fetchone()[0]
                    is None
                )
                assert (
                    db.execute(
                        "SELECT status FROM runs WHERE id=?", (run_id,)
                    ).fetchone()[0]
                    == "failed"
                )
            next_run = queue_source("la-submitted")
            with patch(
                "app.ingest.batches",
                return_value=iter([[{**la, "permit_nbr": "PARTIAL-1"}]]),
            ):
                run_source(next_run)
            with connect() as db:
                r = db.execute("SELECT * FROM runs WHERE id=?", (next_run,)).fetchone()
                assert r["status"] == "success" and r["new_permits"] == 0
                assert db.execute(
                    "SELECT last_success FROM sources WHERE id='la-submitted'"
                ).fetchone()[0]
            # Bad records fail the whole batch rather than silently losing records.
            try:
                ingest_batch("la-submitted", [{**la, "permit_nbr": "ROLLBACK"}, {}])
                raise AssertionError("Missing identity accepted")
            except ValueError:
                pass
            with connect() as db:
                assert not db.execute(
                    "SELECT 1 FROM permits WHERE permit_number='ROLLBACK'"
                ).fetchone()

    requests = []

    def socrata(request):
        requests.append(request)
        n = 1000 if request.url.params["$offset"] == "0" else 1
        return httpx.Response(200, json=[la] * n)

    state = {"coverage_since": yesterday, "last_success": now()}
    with httpx.Client(transport=httpx.MockTransport(socrata)) as http:
        result = list(batches("la-issued", state, http))
        assert [len(page) for page in result] == [1000, 1]
        assert requests[1].url.params["$offset"] == "1000"
        assert ":updated_at" in requests[0].url.params["$where"]
        assert requests[0].url.params["$order"] == ":id"
    requests.clear()

    def arcgis(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "features": [{"attributes": {"Permit_No": "FW"}}],
                "exceededTransferLimit": len(requests) == 1,
            },
        )

    with httpx.Client(transport=httpx.MockTransport(arcgis)) as http:
        assert len(list(batches("fort-worth", state, http))) == 2
        assert requests[1].url.params["resultOffset"] == "1"
    requests.clear()

    def sacramento_pages(request):
        requests.append(request)
        first = len(requests) == 1
        return httpx.Response(
            200,
            json={
                "features": [
                    {
                        "attributes": {
                            "Application": "S-1",
                            "Status_Date": "01/01/2026" if first else "09/01/2026",
                        }
                    }
                ],
                "exceededTransferLimit": first,
            },
        )

    with httpx.Client(transport=httpx.MockTransport(sacramento_pages)) as http:
        result = list(
            batches(
                "sacramento",
                {"coverage_since": "2026-08-20", "last_success": None},
                http,
            )
        )
        assert len(result) == 1 and result[0][0]["Status_Date"] == "09/01/2026"
        assert (
            requests[1].url.params["resultOffset"] == "1"
        )  # advance even when all rows filtered
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                text="FOLDERNUMBER,ISSUEDATE,FINALDATE\nSJ-1,9/1/2026,\nSJ-2,1/1/2026,\n",
            )
        )
    ) as http:
        result = list(
            batches(
                "sj-recent",
                {"coverage_since": "2026-08-20", "last_success": None},
                http,
            )
        )
        assert len(result[0]) == 1 and result[0][0]["foldernumber"] == "SJ-1"
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, text="FOLDERNUMBER,ISSUEDATE,FINALDATE\n")
        )
    ) as http:
        assert (
            list(
                batches(
                    "sj-recent",
                    {"coverage_since": "2026-08-20", "last_success": None},
                    http,
                )
            )
            == []
        )
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"error": {"message": "Bad query"}})
        )
    ) as http:
        try:
            json_request(http, "https://example.com", {})
            raise AssertionError("Upstream error accepted")
        except ValueError:
            pass
    # Real CSV column names, quoted commas, chunk normalization, annual rollover.
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(sd))
    writer.writeheader()
    writer.writerow(sd)
    requests.clear()

    def annual_csv(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=output.getvalue().encode())

    start_year = datetime.now(timezone.utc).year - 1
    with httpx.Client(transport=httpx.MockTransport(annual_csv)) as http:
        result = list(
            batches(
                "sd-created",
                {"coverage_since": f"{start_year}-12-01", "last_success": None},
                http,
            )
        )
        assert len(requests) == 2 and result[0][0]["approval_id"] == "SD-1"
    print(
        "PASS: classification, normalization, canonical dedupe, project grouping, status precedence, filters, CSV safety, auth, evidence, enrichment, partial-run recovery, pagination, annual CSV rollover."
    )


if __name__ == "__main__":
    check()

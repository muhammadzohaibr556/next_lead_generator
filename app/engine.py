"""Normalization and explainable trade rules. No remote model calls."""

import hashlib
import json
import math
import re
from datetime import date, datetime, timezone

import pandas as pd

from .sources import SOURCES

RULES = {
    "Roofing": r"\b(?:re[- ]?roof(?:ing)?|roofing|shingles?|roof\s+(?:replacement|repair|covering|tiles?|tear[- ]?off)|(?:repair(?:ing)?|replac(?:e|ing|ement of)|install(?:ing|ation of)?|new)\s+(?:(?:the|an?|existing|new|fire|damaged|flat|sloped|metal|tile|clay|concrete|composition)\s+){0,4}roofs?)\b",
    "Tile": r"\b(?:tiling|tile[sd]?|backsplash|terrazzo|(?:porcelain|ceramic)\s+(?:floor|wall))\b",
    "HVAC": r"\b(?:hvac|furnace|air condition(?:ing|er)|heat pump|condenser|ductwork|a/?c (?:unit|system)|mechanical (?:permit|unit|system))\b",
    "Electrical": r"\b(?:electrical|rewir(?:e|ing)|panel upgrade|\d+\s*amp|evse|ev charger)\b",
    "Plumbing": r"\b(?:plumbing|re[- ]?pipe|sewer|water heater|drain line)\b",
    "Solar": r"\b(?:solar|photovoltaic|pv system)\b",
    "Remodeling": r"\b(?:remodel(?:ing)?|renovat(?:ion|e)|kitchen|bathroom|adu|accessory dwelling)\b",
    "New construction": r"\b(?:new construction|bldg[- ]new|new (?:single|two|multi)[- ]family|new\s+(?:\d+[- ]stor(?:y|ies)\s+)?(?:sfd|sfr|dwelling|residence|building|home))\b",
    "Windows & doors": r"\b(?:window replacement|replace windows|door replacement)\b",
}
PATTERNS = {name: re.compile(pattern, re.I) for name, pattern in RULES.items()}
TERMINAL = {"Completed", "Cancelled", "Expired"}


def text(value):
    if value is None or isinstance(value, (dict, list)):
        return ""
    value = str(value).strip()
    return (
        ""
        if value.lower() in {"nan", "none", "null", "n/a", "na", "not available"}
        else value
    )


def number(value):
    try:
        n = float(re.sub(r"[$,\s]", "", text(value)))
        return n if math.isfinite(n) and n >= 0 else None
    except ValueError:
        return None


def day(value):
    if not text(value):
        return ""
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return (
                (parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed)
                .date()
                .isoformat()
            )
        except ValueError:
            return pd.to_datetime(value, utc=True, errors="raise").date().isoformat()
    except (ValueError, TypeError, OverflowError):
        return ""


def address_key(value):
    value = re.sub(r"[^A-Z0-9# /-]", " ", value.upper())
    substitutions = {
        "NORTH": "N",
        "SOUTH": "S",
        "EAST": "E",
        "WEST": "W",
        "STREET": "ST",
        "AVENUE": "AVE",
        "ROAD": "RD",
        "DRIVE": "DR",
        "BOULEVARD": "BLVD",
        "LANE": "LN",
        "COURT": "CT",
        "APARTMENT": "UNIT",
        "APT": "UNIT",
        "SUITE": "UNIT",
    }
    return " ".join(substitutions.get(word, word) for word in value.split())


def stage(status, issued, closed, default):
    s = status.lower()
    if re.search(r"cancel|withdraw|void|denied", s):
        return "Cancelled"
    if re.search(r"expir", s):
        return "Expired"
    if closed or re.search(r"\b(?:final(?:ed)?|closed|complete[d]?)\b", s):
        return "Completed"
    if re.search(r"inspect|work started|in progress", s):
        return "In progress"
    if issued or re.search(r"issued|permit ready", s):
        return "Issued"
    if re.search(r"review|plan\s*check|pending|approved", s):
        return "In review"
    return default


def normalize(raw, source_id):
    s = SOURCES[source_id]
    r = {k.lower().strip(): v for k, v in raw.items()}

    def get(*names):
        return next(
            (
                text(r.get(n))
                for n in names
                if text(r.get(n)) and text(r.get(n)).lower() != n
            ),
            "",
        )

    base = dict.fromkeys(
        [
            "permit_number",
            "project_ref",
            "address",
            "zip",
            "apn",
            "description",
            "permit_type",
            "property_type",
            "applied_date",
            "issue_date",
            "completed_date",
            "activity_date",
            "raw_status",
            "contractor",
            "contractor_phone",
            "permit_holder",
            "owner",
            "latitude",
            "longitude",
        ],
        "",
    )
    base.update(
        source_id=source_id,
        jurisdiction=s["jurisdiction"],
        city=s["city"],
        state=s["state"],
        source_url=s["page"],
        value=None,
        sqft=None,
    )
    if s["jurisdiction"] == "los-angeles":
        base.update(
            permit_number=get("permit_nbr"),
            project_ref="",
            address=get("primary_address"),
            zip=get("zip_code")[:5],
            apn=get("apn"),
            description=get("work_desc"),
            permit_type=" · ".join(
                filter(None, [get("permit_type"), get("permit_sub_type")])
            ),
            property_type=get("use_desc"),
            applied_date=day(get("submitted_date")),
            issue_date=day(get("issue_date")),
            completed_date=day(get("cofo_date")),
            activity_date=day(get("status_date")),
            raw_status=get("status_desc"),
            value=number(get("valuation")),
            sqft=number(get("square_footage")),
            contractor="",
            contractor_phone="",
            permit_holder="",
            owner="",
            latitude=get("lat"),
            longitude=get("lon"),
        )
    elif s["jurisdiction"] == "austin":
        base.update(
            permit_number=get("permit_number"),
            project_ref=get("masterpermitnum") or get("project_id"),
            address=get("original_address1", "permit_location"),
            zip=get("original_zip")[:5],
            apn=get("tcad_id"),
            description=get("description"),
            permit_type=" · ".join(
                filter(None, [get("permit_type_desc"), get("work_class")])
            ),
            property_type=get("permit_class_mapped", "permit_class"),
            applied_date=day(get("applieddate")),
            issue_date=day(get("issue_date")),
            completed_date=day(get("completed_date")),
            activity_date=day(get("statusdate")),
            raw_status=get("status_current"),
            value=number(get("total_job_valuation")),
            sqft=number(get("total_existing_bldg_sqft")),
            contractor=get("contractor_company_name", "contractor_full_name"),
            contractor_phone=get("contractor_phone"),
            permit_holder="",
            owner="",
            latitude=get("latitude"),
            longitude=get("longitude"),
        )
    elif s["jurisdiction"] == "fort-worth":
        street = get("full_street_address") or " ".join(
            filter(
                None,
                [
                    get("addr_no"),
                    get("direction"),
                    get("street_name"),
                    get("street_suffix"),
                    get("street_suffix_dir"),
                ],
            )
        )
        base.update(
            permit_number=get("permit_no"),
            project_ref="",
            address=street,
            zip=get("zip_code")[:5],
            apn="",
            description=get("b1_work_desc", "b1_special_text"),
            permit_type=" · ".join(
                filter(None, [get("permit_type"), get("permit_subtype")])
            ),
            property_type=get("use_type", "permit_category"),
            applied_date=day(r.get("file_date")),
            issue_date="",
            completed_date="",
            activity_date=day(r.get("status_date")),
            raw_status=get("current_status"),
            value=number(get("jobvalue")),
            sqft=number(get("sqft")),
            contractor="",
            contractor_phone="",
            permit_holder="",
            owner=get("owner_full_name"),
            latitude="",
            longitude="",
        )
        if "issued" in base["raw_status"].lower():
            base["issue_date"] = base["activity_date"]
    elif s["jurisdiction"] == "san-diego":
        full_address = get("gis_address")
        zip_match = re.search(r"\bCA\s+(\d{5})", full_address)
        base.update(
            permit_number=get("approval_id"),
            project_ref=get("project_id"),
            address=full_address.split(",")[0],
            zip=zip_match.group(1) if zip_match else "",
            apn=get("gis_apn"),
            description=get("approval_scope", "project_scope"),
            permit_type=get("approval_type"),
            property_type=get("job_bc_code_description"),
            applied_date=day(get("approval_create_date")),
            issue_date=day(get("approval_issue_date")),
            completed_date=day(get("approval_close_date")),
            activity_date=max(
                day(get("approval_create_date")),
                day(get("approval_issue_date")),
                day(get("approval_close_date")),
            ),
            raw_status=get("approval_status"),
            value=number(get("approval_valuation")),
            sqft=number(get("approval_floor_area")),
            contractor="",
            contractor_phone="",
            permit_holder=get("approval_permit_holder"),
            owner="",
            latitude=get("gis_latitude"),
            longitude=get("gis_longitude"),
        )
    elif s["jurisdiction"] == "san-francisco":
        street = " ".join(
            filter(
                None,
                [
                    get("street_number"),
                    get("street_number_suffix"),
                    get("street_name"),
                    get("street_suffix"),
                ],
            )
        )
        unit = (get("unit") if get("unit") != "0" else "") + get("unit_suffix")
        if unit:
            street += " Unit " + unit
        point = r.get("location") or {}
        coordinates = point.get("coordinates", []) if isinstance(point, dict) else []
        base.update(
            permit_number=get("permit_number"),
            address=street,
            zip=get("zipcode")[:5],
            apn="-".join(filter(None, [get("block"), get("lot")])),
            description=get("description"),
            permit_type=get("permit_type_definition"),
            property_type=get("proposed_use", "existing_use"),
            applied_date=day(get("filed_date", "permit_creation_date")),
            issue_date=day(get("issued_date")),
            completed_date=day(get("completed_date")),
            activity_date=max(
                day(get("status_date")), day(get("last_permit_activity_date"))
            ),
            raw_status=get("status"),
            value=number(get("revised_cost", "estimated_cost")),
            latitude=coordinates[1] if len(coordinates) == 2 else "",
            longitude=coordinates[0] if len(coordinates) == 2 else "",
        )
    elif s["jurisdiction"] == "charleston":
        zip_match = re.search(
            r"\bSC\s+(\d{5})", get("permit_address_line2", "parceladdr_line2")
        )
        base.update(
            permit_number=get("permit_number"),
            address=get("permit_address_line1", "parceladdr_line1"),
            zip=get("zipcode")[:5] or (zip_match.group(1) if zip_match else ""),
            apn=get("main_parcel_number"),
            description=get("description"),
            permit_type=" · ".join(
                filter(None, [get("permit_type"), get("work_class")])
            ),
            applied_date=day(r.get("application_date")),
            issue_date=day(r.get("issue_date")),
            completed_date=day(r.get("finaled_date")),
            activity_date=day(r.get("last_inspection_date")),
            raw_status=get("permit_status"),
            value=number(get("valuation")),
            sqft=number(get("square_feet")),
        )
        # PROJECT is a free-text name, not a reliable grouping identifier.
    elif s["jurisdiction"] == "sacramento":
        base.update(
            permit_number=get("application"),
            address=get("address"),
            zip=get("zip")[:5],
            apn=get("parcel_no"),
            description=get("work_desc"),
            permit_type=" · ".join(filter(None, [get("type"), get("sub_type")])),
            property_type=get("category"),
            issue_date=day(get("status_date")),
            raw_status=get("current_status"),
            value=number(get("valuation")),
            sqft=number(get("project_sq_ft")),
            contractor=get("contractor"),
        )
    elif s["jurisdiction"] == "west-sacramento":
        full_address = get("address")
        zip_match = re.search(r"\bCA\s+(\d{5})", full_address)
        base.update(
            permit_number=get("permit"),
            address=re.split(r"\s+WEST SACRAMENTO\s+", full_address, flags=re.I)[0],
            zip=zip_match.group(1) if zip_match else "",
            apn=get("parcel"),
            permit_type=" · ".join(filter(None, [get("type"), get("subtype")])),
            applied_date=day(r.get("dateapplied")),
            activity_date=day(r.get("statusdate")),
            raw_status=get("status"),
            value=number(get("jobvalue")),
        )
        if "issued" in base["raw_status"].lower():
            base["issue_date"] = base["activity_date"]
    elif s["jurisdiction"] == "pasadena":
        base.update(
            permit_number=get("case_number"),
            address=get("address"),
            apn=get("parcel_no", "land_parcel_no"),
            description=get("description"),
            activity_date=day(r.get("latest_activity")),
            sqft=number(get("total_sqft")),
            raw_status="Active (source layer)",
        )
    elif s["jurisdiction"] == "san-jose":
        full_address = get("gx_location")
        zip_match = re.search(r"\bCA\s+(\d{5})", full_address)
        base.update(
            permit_number=get("foldernumber"),
            address=full_address.split(",")[0].strip(),
            zip=zip_match.group(1) if zip_match else "",
            apn=get("assessors_parcel_number"),
            description=get("foldername"),
            permit_type=" · ".join(
                filter(None, [get("folderdesc"), get("workdescription")])
            ),
            property_type=get("subtypedescription"),
            issue_date=day(get("issuedate")),
            completed_date=day(get("finaldate")),
            raw_status="Expired" if source_id == "sj-expired" else get("status"),
            value=number(get("permitvaluation")),
            sqft=number(get("squarefootage")),
            contractor=get("contractor"),
            owner=get("ownername"),
        )
    else:
        raise ValueError(f"No normalizer for {source_id}")
    if not base["permit_number"]:
        raise ValueError(
            f"Missing permit identifier in {source_id}; inspect source schema"
        )
    if base["project_ref"] in {"0", "0.0"}:
        base["project_ref"] = ""
    base["stage"] = stage(
        base["raw_status"],
        base["issue_date"],
        base["completed_date"],
        s["default_stage"],
    )
    base["activity_date"] = max(
        base["activity_date"],
        base["issue_date"],
        base["applied_date"],
        base["completed_date"],
    )
    base["signal_date"] = base["issue_date"] or base["applied_date"]
    base["signal_date_kind"] = (
        "Issued"
        if base["issue_date"]
        else "Applied" if base["applied_date"] else "Last activity"
    )
    if not base["signal_date"]:
        base["signal_date"] = base["activity_date"]
    base["date_warning"] = (
        base["activity_date"] > datetime.now(timezone.utc).date().isoformat()
    )
    base["address_key"] = address_key(base["address"])
    # Official project IDs only. Similar addresses may contain unrelated jobs.
    base["project_key"] = (
        f"{s['jurisdiction']}:{'project:' + base['project_ref'] if base['project_ref'] else 'permit:' + base['permit_number']}"
    )
    for key, limit in [("latitude", 90), ("longitude", 180)]:
        try:
            n = float(base[key])
            base[key] = n if math.isfinite(n) and abs(n) <= limit else None
        except (ValueError, TypeError):
            base[key] = None
    return base


def classify(description, permit_type=""):
    content = f"{description} {permit_type}".lower()
    # Ignore explicit negation and solar mounting language, which is not reroofing.
    content = re.sub(
        r"\b(?:no|not|without)\s+(?:new\s+)?(?:roof(?:ing)?|tile|plumbing|electrical)(?:\s+work)?",
        "",
        content,
    )
    content = re.sub(
        r"\b(?:roof[- ]?top|roof[- ]mounted|roof mount(?:ed)?)\b", "", content
    )
    content = re.sub(r"\broof\s+(?:deck|railing|hatch|access)\b", "deck", content)
    matches = {}
    for name, pattern in PATTERNS.items():
        trade_content = (
            re.sub(r"\broof tiles?\b|\btile roofs?\b", "", content)
            if name == "Tile"
            else content
        )
        match = pattern.search(trade_content)
        if match:
            matches[name] = {
                "kind": "Direct",
                "evidence": match.group(0),
                "confidence": 90,
            }
    if "Roofing" not in matches and re.search(
        r"tear off\s*[-:]\s*yes.{0,100}\bsquares of (?:composite|shingle)",
        content,
        re.S,
    ):
        matches["Roofing"] = {
            "kind": "Direct",
            "evidence": "Tear off with roofing squares of composite/shingle",
            "confidence": 90,
        }
    if (
        "Solar" in matches
        and "Roofing" in matches
        and not re.search(
            r"re[- ]?roof|shingle|roof(?:ing)?\s+(?:repair|replac)|(?:repair|replace)\s+(?:the\s+)?roof",
            content,
        )
    ):
        del matches["Roofing"]
    if (
        "Roofing" in matches
        and "Tile" in matches
        and not re.search(r"bath|kitchen|floor|backsplash|shower", content)
    ):
        del matches["Tile"]  # Roof tiles belong to roofing, not interior tile.
    if "Tile" not in matches and re.search(
        r"(?:kitchen|bathroom|shower).{0,30}(?:remodel|renovat)|(?:remodel|renovat).{0,30}(?:kitchen|bathroom|shower)",
        content,
    ):
        matches["Tile"] = {
            "kind": "Adjacent",
            "evidence": "Kitchen / bath remodel; tile scope unconfirmed",
            "confidence": 55,
        }
    if "New construction" in matches:
        for trade in ["Roofing", "Tile"]:
            matches.setdefault(
                trade,
                {
                    "kind": "Adjacent",
                    "evidence": "New construction; trade package unconfirmed",
                    "confidence": 50,
                },
            )
    return matches


def score(permit, match, today=None):
    today = today or datetime.now(timezone.utc).date()
    try:
        age = (today - date.fromisoformat(permit["signal_date"])).days
    except ValueError:
        age = 9999
    freshness = (
        30
        if 0 <= age <= 3
        else (
            22
            if 0 <= age <= 7
            else 14 if 0 <= age <= 30 else 5 if 0 <= age <= 90 else 0
        )
    )
    components = {
        "Recency": freshness,
        "Stage": {
            "Application": 25,
            "In review": 22,
            "Issued": 12,
            "In progress": 5,
        }.get(permit["stage"], 0),
        "Trade evidence": 25 if match["kind"] == "Direct" else 10,
        "Address": 10 if permit["address"] else 0,
        "Valuation": (
            10
            if (permit["value"] or 0) >= 10000
            else 5 if (permit["value"] or 0) > 0 else 0
        ),
    }
    if permit["contractor"]:
        components["Contractor already listed"] = -20
    if permit["permit_holder"]:
        components["Permit holder listed"] = -10
    total = max(0, min(100, sum(components.values())))
    if permit["stage"] in TERMINAL:
        total = min(10, total)
    if permit.get("date_warning") or age < 0:
        total = min(25, total)
    return total, components


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=True).encode()
    ).hexdigest()

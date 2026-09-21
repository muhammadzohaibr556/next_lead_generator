# California and South Carolina coverage

Verified and imported September 19, 2026. **Statewide completeness is not established.** This is the actual public-data coverage, not a statewide marketing claim.

## Imported records

The database currently contains **28,021 CA permits and 2,179 SC permits**, with raw source evidence. This expansion added **9,202 unique permits**. Counts are permit identities, not homeowners or available jobs. The monitored date boundary is **2026-08-20**: a qualifying application, issue or activity date can bring in an older permit. Invalid future dates are retained with a warning and reduced score.

| State | Issuing jurisdiction | Unique permits | Latest valid activity imported | Source scope |
|---|---|---:|---|---|
| CA | Los Angeles | 13,794 | 2026-09-14 | City submitted and issued feeds |
| CA | San Diego | 7,204 | 2026-09-18 | City created and issued approvals |
| CA | San Francisco | 3,759 | 2026-09-18 | City/county building permits, primary addresses |
| CA | San José | 2,310 | 2026-09-18 | City recent, active and expired CSVs |
| CA | West Sacramento | 413 | 2026-09-18 | City permits; type/subtype rather than full work description |
| CA | Pasadena | 323 | 2026-09-18 | City active layer; latest activity only |
| CA | Sacramento | 218 | 2026-08-22 | City current-year issued snapshot; monthly publication |
| SC | Charleston | 2,179 | 2026-09-18 | **City of Charleston**, active + issued layers |

There are **3,326 active roofing signals** (1,631 direct scope matches) and **2,765 active tile signals** (92 direct scope matches) across these two states. The remainder are explicitly labeled adjacent new-construction/remodel opportunities. One permit can produce multiple trade signals. These numbers change after imports and classification updates; `/api/coverage`, `/api/stats` and the dashboard are the live source of truth.

All nine new feeds completed a live import. San José expired returned zero records inside the selected date window; that is a successful empty result, not evidence of a complete permit history. Source URLs are in [README.md](README.md) and the app's Data sources page.

## What is not covered

Every issuing jurisdiction outside the list above remains unconnected. A city feed does **not** cover an entire surrounding county. All trade types are imported where the connected source publishes them, but classification cannot recover missing descriptions, missing contractor fields or permits absent from the source.

Property enrichment is still limited to the existing LA County exact-AIN connector. Other permits retain only property facts published with the permit. There is no statewide assessor, owner-contact or contractor-license matching service configured.

| Candidate checked | Outcome on this host | Why it is not shown as imported coverage |
|---|---|---|
| [Greenville City permit API](https://citygis.greenvillesc.gov/arcgis/rest/services/InfoHUB/BuildingPermits_PriorTwoYears/MapServer/0) | Connection refused over HTTPS and HTTP | Official metadata describes weekday updates, but no live records could be downloaded. Greenville County is a separate jurisdiction. |
| [Greenville County permitting](https://www.greenvillecounty.org/BuildingSafety/Permits.aspx) | Public website points to eTRAKiT | No working bulk permit feed verified in this implementation. |
| [Hilton Head GIS](https://maps.hiltonheadislandsc.gov/server/rest/services/Energov/EnergovLayers/MapServer) | Catalog reachable; public EPL point layer returned zero features; separate EPL service returned a server error | Base parcels/zoning layers are not permit records. |
| [Beaufort County GIS](https://gis.beaufortcountysc.gov/server/rest/services/EnerGov/MapServer) | Accessible layers contain addresses, parcels, roads and land-use code | No usable permit-record layer in this published service. |
| [Berkeley County builder portal](https://build.berkeleycountysc.gov/) | Account-oriented case lookup | No anonymous bulk API verified. |
| [Elk Grove permit service](https://webmaps.elkgrove.gov/arcgis/rest/services/AGOL/TRAKiT_Building_Permits/FeatureServer) | Did not return usable JSON during verification | Not registered as a successful connector. |

These are findings from the endpoints checked, not a claim that these jurisdictions have no other export or public-record access route. No forms or records requests were sent.

## Statewide datasets and the remaining requirement

[California HCD APR Table A2](https://catalog.data.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year) provides broad annual housing development reporting. It is useful for historical new-housing research, but it is not a current feed of all reroofing, tile and other repair permits. It was deliberately not mixed into fresh trade leads.

The [Census Building Permits Survey](https://bhs.econ.census.gov/bhs/bps/about.html) provides state, county and local new-residential-construction statistics. Those aggregates are useful for market sizing; they do not supply individual project addresses and contractors for lead generation.

For broader lead-level coverage, **Shovels is a suitable provider to evaluate**, because its [documented permit API](https://docs.shovels.ai/api-reference/permits/search-permits) supports geographic search, dates, tags, source jurisdiction and property facts. Its [state-filter example](https://www.shovels.ai/blog/how-to-use-the-shovels-v2-api/) and [coverage dashboard](https://www.shovels.ai/coverage) are public. API requests require an account key. No account/key was supplied, and no paid-provider records have been fetched or represented as present.

Before calling coverage complete, obtain the provider's CA/SC issuing-jurisdiction list, roofing/repair permit scope and latest successful collection dates; reconcile missing city and unincorporated-county authorities with official exports or additional feeds. A state filter by itself cannot establish completeness. Even [PermitIntel's SC coverage page](https://permitintel.ai/permit-data/south-carolina) explicitly says its ingested records are not a complete record of all SC permits.

For broader parcel enrichment, [Regrid's Parcel API](https://regrid.com/parcel-api) is a separate commercial option to evaluate after checking county coverage and required fields. Do not assume a parcel API includes fresh permits or contact permission.

**Next dependency for complete coverage:** provider access with a verified jurisdiction coverage list, and official exports/feeds for the remaining gaps. Store any future API credential locally as an environment variable; never commit it or paste it into the public source registry.

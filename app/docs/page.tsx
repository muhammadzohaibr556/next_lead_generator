const endpoints = [
  ["GET", "/api/health", "Database connectivity and sync configuration"],
  ["GET", "/api/leads", "Filtered, paginated opportunities"],
  ["GET", "/api/leads/map", "Filtered points and location counts"],
  ["GET", "/api/leads/export", "CSV export (maximum 10,000 leads)"],
  [
    "GET",
    "/api/leads/{id}",
    "Lead, permits, evidence, property and enrichment",
  ],
  ["PATCH", "/api/leads/{id}", "Update status, saved, notes or assigned_to"],
  [
    "POST",
    "/api/leads/{id}/enrich?kind=property",
    "Exact LA County parcel lookup",
  ],
  [
    "POST",
    "/api/leads/{id}/enrich?kind=owner",
    "Queue configured owner lookup",
  ],
  [
    "POST",
    "/api/leads/{id}/enrich?kind=contacts",
    "Search configured address contacts independently of owner enrichment",
  ],
  [
    "PATCH",
    "/api/leads/{id}/enrichment-review",
    "Update owner_type, reviewed, contacts_verified or suppressed",
  ],
  ["GET", "/api/evidence/{id}", "Original source evidence"],
  ["GET", "/api/stats", "Statistics using the same lead filters"],
  ["GET", "/api/sources", "Source status and recent runs"],
  [
    "PATCH",
    "/api/sources/{id}",
    'Enable or pause a source using {"enabled": true}',
  ],
  ["GET", "/api/coverage", "Connected jurisdictions and partial coverage"],
  [
    "POST",
    "/api/sync",
    'Queue enabled sources, or one using {"source_id": "la-submitted"}',
  ],
];
export default function Docs() {
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 32 }}>
      <a href="/">← Dashboard</a>
      <h1>Permit Atlas API</h1>
      <p>
        Same-origin JSON API. Requests use the workspace’s HTTP Basic
        credentials when configured. Mutations require Content-Type:
        application/json. Responses are not cached.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map(([method, path, description]) => (
            <tr key={method + path}>
              <td>{method}</td>
              <td>
                <code>{path}</code>
              </td>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Lead filters</h2>
      <p>
        scope (prospecting or history), q, trade, state (CA, SC, TX), territory
        (all or target), city, zip, stage, status, kind (Direct or Adjacent),
        saved, include_closed, since (YYYY-MM-DD), min_value, min_score, sort
        (score, newest, value), limit (1–200) and offset.
      </p>
      <p>
        Radius queries require center_lat, center_lon and radius_miles together.
        Supported radii: 5, 10, 25, 50, 100 miles. Unlocated records cannot
        match a radius.
      </p>
      <pre>{`GET /api/leads?trade=Roofing&state=CA&min_score=60\nGET /api/leads?scope=history&saved=true\nPATCH /api/leads/1\n{"status":"Qualified","saved":true,"notes":"Follow up next week"}`}</pre>
      <p>
        Validation errors return 422; missing records return 404;
        review/configuration conflicts return 409. Background lookups and syncs
        return 202 when queued. Scores are heuristics and coverage remains
        partial.
      </p>
    </main>
  );
}

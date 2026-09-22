"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import dynamic from "next/dynamic";
import type { Lead } from "../lib/types";
import type { EnrichmentDetails } from "../lib/enrichment";
import type { Point, Center } from "./map";
import type { leadDetail, stats, sourceStatus, coverage } from "../lib/api";
const PermitMap = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <p role="status">Loading map…</p>,
});
type Detail = Awaited<ReturnType<typeof leadDetail>>;
type Stats = Awaited<ReturnType<typeof stats>>;
type Sources = Awaited<ReturnType<typeof sourceStatus>>;
type Coverage = Awaited<ReturnType<typeof coverage>>;
const statuses = ["New", "Qualified", "Contacted", "Sold", "Dismissed"];
const stages = [
  "Application",
  "In review",
  "Issued",
  "In progress",
  "Active · stage unknown",
  "Completed",
  "Cancelled",
  "Expired",
];
const names: Record<string, string> = {
  feed: "Opportunity feed",
  saved: "Saved leads",
  pipeline: "My pipeline",
  sources: "Data sources",
};
const stateNames: Record<string, string> = {
  CA: "California",
  SC: "South Carolina",
  TX: "Texas",
};
const fmt = (v: unknown) => Number(v || 0).toLocaleString();
const money = (v: number | null) =>
  v == null
    ? "Not reported"
    : v.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
const date = (v: unknown) =>
  v
    ? new Date(
        String(v).length === 10 ? String(v) + "T12:00:00Z" : String(v),
      ).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Not published";
const stageDate = (lead: Lead) =>
  date(
    lead.stage === "Completed"
      ? lead.completed_date
      : lead.stage === "Issued" || lead.stage === "In progress"
        ? lead.issue_date
        : lead.stage === "Application" || lead.stage === "In review"
          ? lead.applied_date
          : lead.activity_date || lead.signal_date,
  );
const time = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString() : "Not yet";
const safeLink = (v: unknown) =>
  typeof v === "string" && /^https:\/\//i.test(v) ? v : "#";
const tradeClass = (v: string) =>
  v === "Roofing" ? "roofing" : v === "Tile" ? "tile" : "other";
export function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" aria-hidden="true">
      <use href={"/static/vendor/tabler-icons.svg#" + name} />
    </svg>
  );
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.detail || "Request failed");
  return data as T;
}
function useJson<T>(path: string | null, version = 0) {
  const previousPath = useRef<string | null>(null);
  const [state, setState] = useState<{
    data: T | null;
    error: string;
    loading: boolean;
  }>({ data: null, error: "", loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: "", loading: false });
      return;
    }
    const controller = new AbortController();
    let busy = false;
    const changed = previousPath.current !== path;
    previousPath.current = path;
    setState((s) => ({
      data: changed ? null : s.data,
      error: "",
      loading: changed || !s.data,
    }));
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const data = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted)
          setState({ data, error: "", loading: false });
      } catch (e) {
        if (!controller.signal.aborted)
          setState((s) => ({
            ...s,
            error: e instanceof Error ? e.message : "Request failed",
            loading: false,
          }));
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, version]);
  return state;
}
function Action({
  onClick,
  children,
  className = "btn btn-outline-secondary",
  disabled = false,
  title,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false),
    locked = useRef(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy || disabled}
      aria-busy={busy}
      title={title}
      onClick={async () => {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        try {
          await onClick();
        } finally {
          locked.current = false;
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
export default function Dashboard() {
  const [view, setView] = useState("feed"),
    [filters, setFilters] = useState<Record<string, string>>({}),
    [debounced, setDebounced] = useState(filters),
    [offset, setOffset] = useState(0),
    [display, setDisplay] = useState("list"),
    [center, setCenter] = useState<Center | null>(null),
    [radius, setRadius] = useState(10),
    [choosing, setChoosing] = useState(false),
    [activeId, setActiveId] = useState<number | null>(null),
    [version, setVersion] = useState(0),
    [toast, setToast] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filters), 250);
    return () => clearTimeout(timer);
  }, [filters]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const query = new URLSearchParams(
    Object.entries(debounced).filter(([, v]) => v !== ""),
  );
  query.set("scope", view === "feed" ? "prospecting" : "history");
  if (view === "saved") query.set("saved", "true");
  if (view === "feed") {
    query.delete("kind");
    query.delete("include_closed");
    if (center) {
      query.set("center_lat", String(center.lat));
      query.set("center_lon", String(center.lng));
      query.set("radius_miles", String(radius));
    }
  }
  const base = query.toString();
  query.set("offset", String(offset));
  const leads = useJson<{
    items: Lead[];
    total: number;
    limit: number;
    offset: number;
  }>(view === "sources" ? null : "/api/leads?" + query, version);
  const summary = useJson<Stats>("/api/stats?" + base, version),
    sources = useJson<Sources>("/api/sources", version),
    coverageData = useJson<Coverage>(
      view === "sources" ? "/api/coverage" : null,
      version,
    );
  const map = useJson<{
    points: Point[];
    total: number;
    mapped: number;
    pending: number;
    unmapped: number;
    excluded_unlocated: number;
    truncated: boolean;
  }>(
    view === "feed" && display === "map" ? "/api/leads/map?" + base : null,
    version,
  );
  const [detailVersion, setDetailVersion] = useState(0);
  const detail = useJson<Detail>(
    activeId ? "/api/leads/" + activeId : null,
    detailVersion,
  );
  const shownDetail = detail.data;
  const stats = summary.data,
    items = leads.data?.items || [],
    total = leads.data?.total || 0,
    connected = sources.data?.items || [];
  const busySync =
    sources.data?.runs.some((r) => ["queued", "running"].includes(r.status)) ||
    false;
  function change(name: string, value: string) {
    setFilters((f) => ({
      ...f,
      [name]: value,
      ...(name === "state" ? { city: "" } : {}),
    }));
    setOffset(0);
  }
  function switchView(next: string) {
    setView(next);
    setOffset(0);
    setDisplay("list");
    setChoosing(false);
    setFilters((f) => ({ ...f, status: "", stage: "" }));
  }
  function reset() {
    setFilters({});
    setCenter(null);
    setChoosing(false);
    setOffset(0);
  }
  function open(id: number) {
    setActiveId(id);
    setDetailVersion(0);
  }
  async function act(work: () => Promise<unknown>, message?: string) {
    try {
      await work();
      if (message) setToast(message);
      setVersion((v) => v + 1);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Request failed");
    }
  }
  const sync = (source?: string) =>
    act(
      () =>
        api("/api/sync", {
          method: "POST",
          body: JSON.stringify(source ? { source_id: source } : {}),
        }),
      "Sync queued. Records appear as each source finishes.",
    );
  const save = (lead: Lead) =>
    act(
      () =>
        api("/api/leads/" + lead.id, {
          method: "PATCH",
          body: JSON.stringify({ saved: !lead.saved }),
        }),
      lead.saved ? "Removed from shortlist" : "Saved to shortlist",
    );
  const select = (
    name: string,
    label: string,
    options: string[] | [string, string][],
  ) => (
    <select
      className="form-select"
      name={name}
      aria-label={label}
      value={filters[name] || ""}
      onChange={(e) => change(name, e.target.value)}
    >
      <option value="">{label}</option>
      {options.map((o) =>
        Array.isArray(o) ? (
          <option key={o[0]} value={o[0]}>
            {o[1]}
          </option>
        ) : (
          <option key={o}>{o}</option>
        ),
      )}
    </select>
  );
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Permit Atlas home">
          <span className="brand-mark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M4 25V13L16 4l12 9v12M10 25V15l6-5 6 5v10" />
            </svg>
          </span>
          <span>
            permit<span className="brand-light">atlas</span>
            <small>OPPORTUNITY INTELLIGENCE</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">PA</span>
          <div>
            My workspace<small>All states</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {Object.entries(names).map(([key, label], i) => (
            <button
              key={key}
              className={"nav-item " + (view === key ? "active" : "")}
              aria-current={view === key ? "page" : undefined}
              onClick={() => switchView(key)}
            >
              <Icon
                name={
                  ["layout-dashboard", "bookmark", "layout-kanban", "database"][
                    i
                  ]
                }
              />
              {label}
              {key === "feed" || key === "saved" ? (
                <span className="nav-count">
                  {fmt(key === "feed" ? stats?.total : stats?.saved)}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="mini-label">BUILT ON PUBLIC RECORDS</span>
          <p>
            A clearer view of
            <br />
            what’s being built.
          </p>
          <span>
            California, South Carolina & Texas.
            <br />
            Jurisdiction coverage tracked.
          </span>
          <div className="line-art" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">M</span>
          <div>
            My workspace<small>Private to this application</small>
          </div>
          <a href="/docs" aria-label="API documentation">
            ↗
          </a>
        </div>
      </aside>
      <div className="app-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="slash">/</span>
            {names[view]}
          </div>
          <div className="topbar-right">
            <span className="live-dot" />
            <span>
              {sources.error
                ? "Source status unavailable"
                : busySync
                  ? "Import in progress"
                  : sources.data
                    ? "Sources connected"
                    : "Connecting to sources"}
            </span>
            <span className="avatar small">M</span>
          </div>
        </header>
        <main id="main">
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                CONSTRUCTION SIGNALS. LOCAL OPPORTUNITIES.
              </div>
              <h1>
                {names[view]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {view === "feed"
                  ? "Turn local construction activity into your next conversation."
                  : view === "saved"
                    ? "A shortlist of the opportunities you want to follow."
                    : view === "pipeline"
                      ? "Qualify, track, and assign your construction opportunities."
                      : "See where signals come from and when they were checked."}
              </p>
            </div>
            <div className="heading-actions">
              {view !== "sources" && (
                <Action
                  onClick={() =>
                    act(async () => {
                      const response = await fetch("/api/leads/export?" + base);
                      if (!response.ok)
                        throw Error((await response.json()).detail);
                      const url = URL.createObjectURL(await response.blob()),
                        a = document.createElement("a");
                      a.href = url;
                      a.download = "permit-atlas-leads.csv";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  <Icon name="download" /> Export CSV
                </Action>
              )}
              <Action
                className="btn btn-primary"
                disabled={busySync}
                onClick={() => sync()}
              >
                <Icon name="refresh" />
                {busySync ? "Sync in progress" : "Sync sources"}
              </Action>
            </div>
          </section>
          <div className="overview-label">
            <span className="eyebrow">YOUR MARKET AT A GLANCE</span>
            <span>
              <Icon name="map-pin" />{" "}
              {stateNames[filters.state] || "All states"}
            </span>
          </div>
          <section aria-label="Filtered overview" className="metrics">
            {[
              [
                view === "feed"
                  ? "Recent opportunities"
                  : "Matching opportunities",
                stats?.total,
                "with a signal in the last 7 days",
              ],
              [
                "Roofing signals",
                stats?.roofing,
                "Roofing matches in current filters",
              ],
              [
                "Tile opportunities",
                stats?.tile,
                "Interior tile matches in current filters",
              ],
              [
                "High priority",
                stats?.high_priority,
                "Lead score of 75 or above",
              ],
            ].map(([label, value, hint], i) => (
              <div
                key={String(label)}
                className={"card metric " + (i === 3 ? "accent" : "")}
              >
                <span>
                  {label}
                  <span className="metric-icon">
                    <Icon
                      name={
                        ["building-community", "home", "layout-grid", "bolt"][i]
                      }
                    />
                  </span>
                </span>
                <strong>{value == null ? "—" : fmt(value)}</strong>
                <small>
                  {i === 0 ? fmt(stats?.recent) + " " : ""}
                  {hint}
                </small>
              </div>
            ))}
          </section>
          {summary.error && (
            <p role="alert" className="detail-warning">
              {summary.error}
            </p>
          )}
          <div className="data-notice">
            <Icon name="shield-check" />
            <p>
              <strong>Know the signal behind the lead.</strong> Permit activity
              indicates a project, not confirmed buying intent. Contractor and
              permit-holder details are shown when published.
            </p>
            <button
              className="btn btn-ghost-secondary"
              onClick={() => switchView("sources")}
            >
              View source health ↗
            </button>
          </div>
          {view === "sources" ? (
            <>
              <div className="section-heading">
                <div>
                  <h2>Connected public sources</h2>
                  <p>
                    Polling frequency and publication freshness are different.
                  </p>
                </div>
                <span className="badge pill">{connected.length} feeds</span>
              </div>
              {(sources.error || coverageData.error) && (
                <p role="alert">{sources.error || coverageData.error}</p>
              )}
              <div className="source-cards">
                {coverageData.data?.states.map((state) => (
                  <section className="card source-card" key={state.state}>
                    <h3>{state.name}</h3>
                    <p>{fmt(state.permits)} permits · partial coverage</p>
                    <p>{state.jurisdictions.map((j) => j.name).join(", ")}</p>
                  </section>
                ))}
              </div>
              <p className="coverage-notice">{coverageData.data?.message}</p>
              <div className="source-cards">
                {connected.map((source) => (
                  <section className="card source-card" key={source.id}>
                    <div className="source-card-top">
                      <span className="badge pill">
                        {source.enabled ? "Enabled" : "Paused"}
                      </span>
                      <span>{source.state}</span>
                    </div>
                    <h3>{source.name}</h3>
                    <p>{source.scope || source.city + " jurisdiction"}</p>
                    <p>
                      {source.freshness} · Poll every {source.interval / 3600}{" "}
                      hours
                    </p>
                    <dl>
                      <dt>Last successful check</dt>
                      <dd>{time(source.last_success)}</dd>
                      <dt>Newest permit activity</dt>
                      <dd>{date(source.newest_record)}</dd>
                    </dl>
                    {source.error && (
                      <p className="source-error" role="status">
                        {source.error}
                      </p>
                    )}
                    <div className="source-actions">
                      <a
                        href={safeLink(source.page)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Official source ↗
                      </a>
                      <Action
                        onClick={() =>
                          act(() =>
                            api("/api/sources/" + source.id, {
                              method: "PATCH",
                              body: JSON.stringify({
                                enabled: !source.enabled,
                              }),
                            }),
                          )
                        }
                      >
                        {source.enabled ? "Pause" : "Enable"}
                      </Action>
                      <Action
                        disabled={sources.data?.runs.some(
                          (r) =>
                            r.source_id === source.id &&
                            ["queued", "running"].includes(r.status),
                        )}
                        onClick={() => sync(source.id)}
                      >
                        Sync now
                      </Action>
                    </div>
                  </section>
                ))}
              </div>
              <section className="card run-panel">
                <h2>Ingestion history</h2>
                <div className="table-scroll">
                  <table className="table table-vcenter">
                    <thead>
                      <tr>
                        {[
                          "SOURCE",
                          "STARTED",
                          "STATUS",
                          "FETCHED",
                          "NEW PERMITS",
                          "NEW LEADS",
                        ].map((x) => (
                          <th key={x}>{x}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sources.data?.runs.map((run) => (
                        <tr key={run.id}>
                          <td>
                            {connected.find((s) => s.id === run.source_id)
                              ?.name || run.source_id}
                          </td>
                          <td>{time(run.started_at || run.queued_at)}</td>
                          <td>
                            {run.status}
                            {run.error && (
                              <small className="source-error">
                                {run.error}
                              </small>
                            )}
                          </td>
                          <td>{fmt(run.fetched)}</td>
                          <td>{fmt(run.new_permits)}</td>
                          <td>{fmt(run.leads_created)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!sources.data?.runs.length && (
                    <p className="empty-state">
                      No imports yet. Sync a source to start.
                    </p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="content-grid">
              <section className="card feed-panel" aria-busy={leads.loading}>
                <div className="feed-panel-heading">
                  <div
                    className="trade-tabs"
                    role="group"
                    aria-label="Quick trade filters"
                  >
                    {["", "Roofing", "Tile"].map((trade) => (
                      <button
                        key={trade}
                        className={
                          (filters.trade || "") === trade ? "selected" : ""
                        }
                        aria-pressed={(filters.trade || "") === trade}
                        onClick={() => change("trade", trade)}
                      >
                        <Icon
                          name={
                            trade === "Roofing"
                              ? "home"
                              : trade === "Tile"
                                ? "layout-grid"
                                : "layout-dashboard"
                          }
                        />
                        {trade || "All opportunities"}
                      </button>
                    ))}
                  </div>
                  <span className="record-label">
                    <span className="live-dot" /> PUBLIC RECORDS
                  </span>
                </div>
                {view === "feed" && (
                  <div className="focus-banner">
                    <strong>Potentially available · verification needed</strong>
                    <span>
                      Last 7 days · application / in review · direct trade
                      matches · no listed contractor or permit holder
                    </span>
                  </div>
                )}
                <form
                  className="filters"
                  autoComplete="off"
                  onSubmit={(e) => e.preventDefault()}
                >
                  <div className="search-row">
                    <div className="search-wrap">
                      <Icon name="search" />
                      <input
                        className="form-control"
                        aria-label="Search leads"
                        placeholder="Search address, contractor, or project…"
                        maxLength={200}
                        value={filters.q || ""}
                        onChange={(e) => change("q", e.target.value)}
                      />
                    </div>
                    <div className="filter-actions">
                      <details className="more-filters">
                        <summary className="btn btn-outline-secondary">
                          <Icon name="adjustments-horizontal" />
                          More filters
                        </summary>
                        <div className="filter-popover">
                          <label>
                            ZIP code
                            <input
                              className="form-control"
                              inputMode="numeric"
                              pattern="\d{5}"
                              maxLength={5}
                              value={filters.zip || ""}
                              onChange={(e) => change("zip", e.target.value)}
                            />
                          </label>
                          <label>
                            Signal on or after
                            <input
                              className="form-control"
                              type="date"
                              value={filters.since || ""}
                              onChange={(e) => change("since", e.target.value)}
                            />
                          </label>
                          <label>
                            Minimum score
                            <input
                              className="form-control"
                              type="number"
                              min={0}
                              max={100}
                              value={filters.min_score || ""}
                              onChange={(e) =>
                                change("min_score", e.target.value)
                              }
                            />
                          </label>
                          <label>
                            Minimum permit value
                            <input
                              className="form-control"
                              type="number"
                              min={0}
                              value={filters.min_value || ""}
                              onChange={(e) =>
                                change("min_value", e.target.value)
                              }
                            />
                          </label>
                          {view !== "feed" && (
                            <label>
                              Opportunity type
                              {select("kind", "All evidence", [
                                "Direct",
                                "Adjacent",
                              ])}
                            </label>
                          )}
                          <label>
                            Sales status
                            {select("status", "All statuses", statuses)}
                          </label>
                          {view !== "feed" && (
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={filters.include_closed === "true"}
                                onChange={(e) =>
                                  change(
                                    "include_closed",
                                    e.target.checked ? "true" : "",
                                  )
                                }
                              />{" "}
                              Include closed permits
                            </label>
                          )}
                        </div>
                      </details>
                      <button
                        type="button"
                        className="btn btn-ghost-secondary text-button"
                        onClick={reset}
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                  <div className="filter-row">
                    {select("state", "All states", Object.entries(stateNames))}
                    {select(
                      "city",
                      "All connected markets",
                      [
                        ...new Set(
                          connected
                            .filter(
                              (s) =>
                                !filters.state || s.state === filters.state,
                            )
                            .map((s) => s.city as string),
                        ),
                      ].sort(),
                    )}
                    {select("trade", "All trades", stats?.categories || [])}
                    {select(
                      "stage",
                      view === "feed"
                        ? "Application + in review"
                        : "Active stages",
                      view === "feed" ? ["Application", "In review"] : stages,
                    )}
                  </div>
                </form>
                {view === "pipeline" && (
                  <div className="pipeline-filters">
                    {["", ...statuses].map((status) => (
                      <button
                        key={status}
                        className={filters.status === status ? "selected" : ""}
                        onClick={() => change("status", status)}
                      >
                        {status || "All"}
                      </button>
                    ))}
                  </div>
                )}
                {view === "feed" && (
                  <div className="map-controls">
                    <div
                      className="view-toggle"
                      role="group"
                      aria-label="Opportunity display"
                    >
                      {["list", "map"].map((value) => (
                        <button
                          key={value}
                          className={
                            "btn btn-outline-secondary " +
                            (display === value ? "selected" : "")
                          }
                          aria-pressed={display === value}
                          onClick={() => {
                            setDisplay(value);
                            setChoosing(false);
                          }}
                        >
                          {value === "list" ? "List" : "Map"}
                        </button>
                      ))}
                    </div>
                    <label>
                      Radius{" "}
                      <select
                        className="form-select"
                        value={radius}
                        onChange={(e) => {
                          setRadius(Number(e.target.value));
                          setOffset(0);
                        }}
                      >
                        {[5, 10, 25, 50, 100].map((n) => (
                          <option key={n} value={n}>
                            {n} miles
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-outline-secondary"
                      aria-pressed={choosing}
                      onClick={() => {
                        setDisplay("map");
                        setChoosing(true);
                      }}
                    >
                      Choose on map
                    </button>
                    <Action
                      onClick={() =>
                        act(async () => {
                          if (!navigator.geolocation)
                            throw Error("Location unavailable. Choose on map.");
                          const position =
                            await new Promise<GeolocationPosition>(
                              (resolve, reject) =>
                                navigator.geolocation.getCurrentPosition(
                                  resolve,
                                  () =>
                                    reject(
                                      Error(
                                        "Location access failed. Choose on map.",
                                      ),
                                    ),
                                  { timeout: 10000, maximumAge: 60000 },
                                ),
                            );
                          setCenter({
                            lat: position.coords.latitude,
                            lng: position.coords.longitude,
                          });
                          setOffset(0);
                          setDisplay("map");
                        })
                      }
                    >
                      Use my location
                    </Action>
                    {(center || choosing) && (
                      <button
                        className="btn btn-ghost-secondary"
                        onClick={() => {
                          setCenter(null);
                          setChoosing(false);
                          setOffset(0);
                        }}
                      >
                        Clear radius
                      </button>
                    )}
                    <span role="status">
                      {choosing
                        ? "Click a point, or pan with arrow keys and press Enter."
                        : center
                          ? `${radius} miles from ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`
                          : "No radius applied"}
                    </span>
                  </div>
                )}
                <div className="results-meta">
                  <span role="status">
                    {leads.loading
                      ? "Loading opportunities…"
                      : leads.error
                        ? "Could not load opportunities"
                        : fmt(total) + " opportunities"}
                  </span>
                  <label>
                    Sort by{" "}
                    <select
                      className="form-select"
                      aria-label="Sort leads"
                      value={filters.sort || "score"}
                      onChange={(e) => change("sort", e.target.value)}
                    >
                      <option value="score">Highest score</option>
                      <option value="newest">Latest signal</option>
                      <option value="value">Project value</option>
                    </select>
                  </label>
                </div>
                {leads.error && (
                  <p className="detail-warning" role="alert">
                    {leads.error}
                  </p>
                )}
                {view === "feed" && display === "map" ? (
                  <section className="map-panel" aria-label="Opportunity map">
                    <p className="map-meta" role="status">
                      {map.error ||
                        (!map.data
                          ? "Loading locations…"
                          : `${fmt(map.data.mapped)} mapped · ${fmt(map.data.pending)} pending · ${fmt(map.data.unmapped)} unlocated${map.data.excluded_unlocated ? " · " + fmt(map.data.excluded_unlocated) + " excluded by radius" : ""}${map.data.truncated ? " · Showing 5,000 markers; narrow your filters" : ""}`)}
                    </p>
                    <PermitMap
                      points={map.data?.points || []}
                      center={center}
                      radius={radius}
                      choosing={choosing}
                      onChoose={(c) => {
                        setCenter(c);
                        setChoosing(false);
                        setOffset(0);
                      }}
                      onOpen={open}
                    />
                  </section>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table className="table table-vcenter lead-table">
                        <thead>
                          <tr>
                            <th aria-label="Saved" />
                            <th>PROJECT & LOCATION</th>
                            <th>TRADE</th>
                            <th>STAGE</th>
                            <th>VALUE</th>
                            <th>SCORE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((lead) => (
                            <tr key={lead.id}>
                              <td>
                                <Action
                                  className={
                                    "save-button " + (lead.saved ? "saved" : "")
                                  }
                                  title={
                                    lead.saved
                                      ? "Remove from shortlist"
                                      : "Save lead"
                                  }
                                  onClick={() => save(lead)}
                                >
                                  <Icon
                                    name={
                                      lead.saved
                                        ? "bookmark-filled"
                                        : "bookmark"
                                    }
                                  />
                                </Action>
                              </td>
                              <td>
                                <button
                                  className="address-button"
                                  onClick={() => open(lead.id)}
                                >
                                  {lead.address || "Address not published"}
                                </button>
                                <div className="location-text">
                                  {lead.city}, {lead.state} {lead.zip} ·{" "}
                                  {date(lead.signal_date)}
                                </div>
                                <p className="scope-preview">
                                  {lead.description || lead.permit_type}
                                </p>
                                {view === "pipeline" && (
                                  <span className="badge pill">
                                    {lead.status}
                                    {lead.assigned_to
                                      ? " · " + lead.assigned_to
                                      : ""}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span
                                  className={
                                    "badge pill " + tradeClass(lead.trade)
                                  }
                                >
                                  {lead.trade}
                                </span>
                                <small className="evidence-kind">
                                  {lead.match.kind}
                                </small>
                              </td>
                              <td>
                                <span className="badge pill stage">
                                  {lead.stage}
                                </span>
                                <small className="lead-date">
                                  Stage date: {stageDate(lead)}
                                </small>
                              </td>
                              <td className="value">{money(lead.value)}</td>
                              <td>
                                <span
                                  className={
                                    "score " + (lead.score >= 75 ? "high" : "")
                                  }
                                >
                                  {lead.score}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!leads.loading && !leads.error && !items.length && (
                      <div className="empty-state">
                        <Icon name="search" />
                        <h2>No opportunities here yet</h2>
                        <p>
                          Sync public sources or adjust your filters.
                          <br />
                          New records appear as imports complete.
                        </p>
                        <button
                          className="btn btn-outline-secondary"
                          onClick={reset}
                        >
                          Clear filters
                        </button>
                      </div>
                    )}
                    <footer className="table-footer">
                      <span>
                        {total
                          ? `${offset + 1}–${Math.min(offset + 40, total)} of ${fmt(total)}`
                          : "0 results"}
                      </span>
                      <div>
                        <button
                          className="btn btn-icon btn-outline-secondary page-button"
                          disabled={offset === 0 || leads.loading}
                          aria-label="Previous page"
                          onClick={() => setOffset(Math.max(0, offset - 40))}
                        >
                          <Icon name="arrow-left" />
                        </button>
                        <button
                          className="btn btn-icon btn-outline-secondary page-button"
                          disabled={offset + 40 >= total || leads.loading}
                          aria-label="Next page"
                          onClick={() => setOffset(offset + 40)}
                        >
                          <Icon name="arrow-right" />
                        </button>
                      </div>
                    </footer>
                  </>
                )}
              </section>
              <aside className="insights">
                <section className="card insight-card territory-card">
                  <div className="card-kicker">
                    YOUR TERRITORY <Icon name="compass" />
                  </div>
                  <h2>
                    Local signals.
                    <br />
                    Real possibilities.
                  </h2>
                  <div className="territory-art" aria-hidden="true">
                    <svg viewBox="0 0 260 130">
                      <path
                        className="map-grid"
                        d="M0 30h260M0 65h260M0 100h260M40 0v130M90 0v130M140 0v130M190 0v130M240 0v130"
                      />
                      <path
                        className="map-path"
                        d="M20 14l38 6 17 37 14 8 16 40-21 5-26-39-20-6-13-19zM142 51l64 2 21 18-28 39-14-11-14-21-29-15z"
                      />
                      <circle cx="63" cy="73" r="5" />
                      <circle cx="80" cy="93" r="5" />
                      <circle cx="188" cy="84" r="5" />
                    </svg>
                  </div>
                  <p>{stateNames[filters.state] || "All states"}</p>
                  <small>
                    Partial coverage ·{" "}
                    {
                      [
                        ...new Set(
                          connected
                            .filter(
                              (s) =>
                                !filters.state || s.state === filters.state,
                            )
                            .map((s) => s.jurisdiction),
                        ),
                      ].length
                    }{" "}
                    connected jurisdictions
                  </small>
                </section>
                <section className="card insight-card">
                  <div className="card-kicker">
                    MARKET ACTIVITY <span className="muted">ACTIVE</span>
                  </div>
                  <div className="market-bars">
                    {stats?.markets.length ? (
                      stats.markets.slice(0, 6).map((m) => (
                        <div className="market-line" key={m.city + m.state}>
                          <div>
                            <span>{m.city}</span>
                            <strong>{fmt(m.total)}</strong>
                          </div>
                          <div className="bar-track">
                            <i
                              className="bar-fill"
                              style={{
                                width: `${Math.max(4, (m.total / Math.max(...stats.markets.map((x) => x.total))) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted">Waiting for the first import.</p>
                    )}
                  </div>
                  <div className="insight-footer">
                    {fmt(stats?.permits)} unique permits in the selected
                    territory
                  </div>
                </section>
                <section className="card insight-card guide-card">
                  <span className="guide-icon">
                    <Icon name="bolt" />
                  </span>
                  <h3>A better first conversation</h3>
                  <p>
                    Start with early applications. Check scope, timing, and
                    contractor before qualifying an opportunity.
                  </p>
                  <button
                    className="btn btn-ghost-secondary text-button"
                    onClick={() => {
                      switchView("feed");
                      change("stage", "Application");
                    }}
                  >
                    Explore early signals ↗
                  </button>
                </section>
                <div className="last-sync">
                  Last successful check
                  <br />
                  <strong>{time(stats?.last_sync)}</strong>
                </div>
              </aside>
            </div>
          )}
          <footer className="page-footer">
            <span>PERMIT ATLAS</span>
            <span>Source-backed signals. Human decisions.</span>
            <a href="/docs">API documentation ↗</a>
          </footer>
        </main>
      </div>
      {activeId !== null && (
        <LeadDialog
          key={activeId}
          lead={shownDetail?.id === activeId ? shownDetail : null}
          error={detail.error}
          onClose={() => setActiveId(null)}
          onOpen={open}
          onAction={async (work, message) => {
            await act(work, message);
            setDetailVersion((v) => v + 1);
          }}
        />
      )}
      {toast && (
        <div id="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
function LeadDialog({
  lead,
  error,
  onClose,
  onOpen,
  onAction,
}: {
  lead: Detail | null;
  error: string;
  onClose: () => void;
  onOpen: (id: number) => void;
  onAction: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    locked = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lead || locked.current) return;
    const form = new FormData(event.currentTarget);
    locked.current = true;
    setBusy(true);
    try {
      await onAction(
        () =>
          api("/api/leads/" + lead.id, {
            method: "PATCH",
            body: JSON.stringify(Object.fromEntries(form)),
          }),
        "Pipeline changes saved",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      id="lead-dialog"
      ref={dialog}
      aria-labelledby="detail-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="detail-header">
        <div className="detail-top">
          <span className={"badge pill " + tradeClass(lead?.trade || "")}>
            {lead
              ? `${lead.trade} · ${lead.match.kind} signal`
              : "Lead details"}
          </span>
          <button
            className="btn btn-icon btn-ghost-secondary close-button"
            aria-label="Close lead details"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <h2 id="detail-title">{lead?.address || "Lead details"}</h2>
        {lead && (
          <p>
            {lead.city}, {lead.state} {lead.zip} · Lead #{lead.id}
          </p>
        )}
      </div>
      {error && (
        <p className="detail-warning" role="alert">
          {error}
        </p>
      )}
      {!lead ? (
        <p className="detail-body" role="status">
          {error ? "Unable to load lead." : "Loading lead…"}
        </p>
      ) : (
        <div className="detail-body">
          <div className="detail-signal">
            <strong>Opportunity score: {lead.score}/100</strong>
            <p>
              {lead.match.evidence} · {lead.match.confidence}% rule confidence
            </p>
          </div>
          <h3>Project scope</h3>
          <p className="detail-description">
            {lead.description || "Scope not published."}
          </p>
          {lead.date_warning && (
            <div className="detail-warning">
              The source contains a future activity date. Score capped at 25
              pending verification.
            </div>
          )}
          <dl className="detail-grid">
            {[
              ["Permit stage", lead.stage + " · " + lead.raw_status],
              ["Reported project value", money(lead.value)],
              ["Property type", lead.property_type],
              ["Parcel / assessor ID", lead.apn],
              ["Contractor of record", lead.contractor],
              ["Contractor phone", lead.contractor_phone],
              ["Permit holder (role unverified)", lead.permit_holder],
              ["Owner from permit record", lead.owner],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || "Not published"}</dd>
              </div>
            ))}
          </dl>
          <div className="detail-warning">
            {lead.contractor
              ? "A contractor is already listed. Verify whether the primary work is awarded."
              : lead.permit_holder
                ? "A permit holder is listed; their role is not inferred."
                : "A missing contractor field does not mean the work is available."}{" "}
            Public records do not establish permission to contact someone.
          </div>
          <p className="focus-detail">
            <strong>{lead.availability}</strong>
            <br />
            {lead.focus_reasons.join(" · ")}
          </p>
          <h3>Why this score</h3>
          <div className="score-parts">
            {Object.entries(lead.score_breakdown).map(([k, v]) => (
              <span key={k}>
                {k} {v >= 0 ? "+" : ""}
                {v}
              </span>
            ))}
          </div>
          <p className="muted">
            Heuristic score, not a conversion prediction. Closed records are
            capped at 10.
          </p>
          <h3>Property enrichment</h3>
          {lead.property ? (
            <>
              <dl className="detail-grid">
                {[
                  ["Year built", lead.property.year_built],
                  [
                    "Building area",
                    lead.property.building_sqft == null
                      ? "Not published"
                      : fmt(lead.property.building_sqft) + " sq ft",
                  ],
                  [
                    "Assessed value (not market value)",
                    money(lead.property.assessed_value),
                  ],
                  ["Assessment roll", lead.property.roll_year],
                  ["Property use", lead.property.use],
                  ["Match", lead.property.match_method],
                ].map(([k, v]) => (
                  <div key={String(k)}>
                    <dt>{String(k)}</dt>
                    <dd>{String(v ?? "Not published")}</dd>
                  </div>
                ))}
              </dl>
              <a
                href={safeLink(lead.property.source_url)}
                target="_blank"
                rel="noreferrer"
              >
                LA County parcel source ↗
              </a>
              <p className="muted">
                Retrieved {time(lead.property.fetched_at)}.{" "}
                {lead.property.owner_contact}
              </p>
            </>
          ) : lead.jurisdiction === "los-angeles" &&
            lead.apn.replace(/\D/g, "").length === 10 ? (
            <Action
              onClick={() =>
                onAction(
                  () =>
                    api("/api/leads/" + lead.id + "/enrich", {
                      method: "POST",
                      body: "{}",
                    }),
                  "Property details retrieved",
                )
              }
            >
              Fetch county property details ↗
            </Action>
          ) : (
            <p className="muted">
              A county assessor connector is not configured for this market.
            </p>
          )}
          <Enrichment
            key={lead.id}
            data={lead.enrichment}
            id={lead.id}
            onAction={onAction}
          />
          <h3>Evidence & timing · {lead.permit_count} permits</h3>
          <p className="muted">{lead.grouping}</p>
          {lead.permits.map((p: Detail["permits"][number]) => (
            <details className="permit-evidence" key={p.permit_number}>
              <summary>
                {p.permit_number} · {p.stage}
              </summary>
              <p>{p.description}</p>
              <div className="timeline">
                {[
                  ["Applied", p.applied_date],
                  ["Issued", p.issue_date],
                  ["Completed", p.completed_date],
                  ["Last activity", p.activity_date],
                  ["First detected", p.first_seen],
                ].map(([label, v]) => (
                  <div key={label}>
                    {label}
                    <strong>{date(v)}</strong>
                  </div>
                ))}
              </div>
              <a href={safeLink(p.source_url)} target="_blank" rel="noreferrer">
                Official dataset ↗
              </a>
              {p.evidence
                .slice(0, 5)
                .map(
                  (e: {
                    id: number;
                    source_id: string;
                    fetched_at: string;
                  }) => (
                    <p key={e.id}>
                      <a
                        href={"/api/evidence/" + e.id}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Raw evidence · {e.source_id} · {time(e.fetched_at)} ↗
                      </a>
                    </p>
                  ),
                )}
            </details>
          ))}
          {!!lead.related.length && (
            <>
              <h3>Other signals at this address</h3>
              <p className="muted">
                Review before treating related opportunities as separate jobs.
              </p>
              {lead.related.map((r) => (
                <button
                  className="btn btn-outline-secondary"
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                >
                  {r.trade} · #{r.id} ↗
                </button>
              ))}
            </>
          )}
          <h3>Your pipeline</h3>
          <form className="detail-form" onSubmit={submit}>
            <div className="detail-grid">
              <label>
                Sales status
                <select
                  className="form-select"
                  name="status"
                  defaultValue={lead.status}
                >
                  {statuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Assigned to
                <input
                  className="form-control"
                  name="assigned_to"
                  maxLength={120}
                  defaultValue={lead.assigned_to}
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                className="form-control"
                name="notes"
                maxLength={10000}
                defaultValue={lead.notes}
                placeholder="Qualification notes and next steps…"
              />
            </label>
            <div className="detail-actions">
              <Action
                onClick={() =>
                  onAction(() =>
                    api("/api/leads/" + lead.id, {
                      method: "PATCH",
                      body: JSON.stringify({ saved: !lead.saved }),
                    }),
                  )
                }
              >
                <Icon name="bookmark" />
                {lead.saved ? "Saved to shortlist" : "Save to shortlist"}
              </Action>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </dialog>
  );
}
function Enrichment({
  data,
  id,
  onAction,
}: {
  data: EnrichmentDetails;
  id: number;
  onAction: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const { owner, contacts, review, providers, jobs } = data,
    [busy, setBusy] = useState(false),
    locked = useRef(false);
  const pending = (kind: string) =>
    jobs.some(
      (j) => j.kind === kind && ["queued", "running"].includes(j.status),
    );
  const contactAllowed =
    !!owner &&
    review.reviewed &&
    ["Person", "Company"].includes(review.owner_type) &&
    !review.suppressed &&
    providers.melissa.available &&
    (review.owner_type !== "Person" || data.consumer_append_enabled);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current) return;
    const form = new FormData(e.currentTarget);
    locked.current = true;
    setBusy(true);
    try {
      await onAction(
        () =>
          api("/api/leads/" + id + "/enrichment-review", {
            method: "PATCH",
            body: JSON.stringify({
              owner_type: form.get("owner_type"),
              reviewed: form.has("reviewed"),
              suppressed: form.has("suppressed"),
              contacts_verified: form.has("contacts_verified"),
            }),
          }),
        "Identity review saved",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const enrich = (kind: string) =>
    onAction(
      () =>
        api("/api/leads/" + id + "/enrich?kind=" + kind, {
          method: "POST",
          body: "{}",
        }),
      "Lookup queued",
    );
  return (
    <>
      <h3>Owner & contact research</h3>
      <p className="muted">
        Lookups run only when requested. Ownership and contact matches do not
        confirm job availability or permission to contact.
      </p>
      {owner ? (
        <>
          <dl className="detail-grid">
            <div>
              <dt>Recorded owner</dt>
              <dd>
                {owner.name}
                {owner.second_owner && (
                  <>
                    <br />
                    {owner.second_owner}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Owner mailing address</dt>
              <dd>
                {owner.mailing_address || "Not published"}
                <br />
                {[owner.mailing_city, owner.mailing_state, owner.mailing_zip]
                  .filter(Boolean)
                  .join(" ")}
              </dd>
            </div>
            <div>
              <dt>Property match</dt>
              <dd>{owner.match_method}</dd>
            </div>
            <div>
              <dt>Property characteristics</dt>
              <dd>
                {String(owner.year_built || "Year not published")} ·{" "}
                {owner.building_sqft
                  ? fmt(owner.building_sqft) + " sq ft"
                  : "Area not published"}
              </dd>
            </div>
          </dl>
          <p className="muted">
            Realie · retrieved {time(owner.fetched_at)} · expires{" "}
            {time(owner.expires_at)}.{" "}
            {owner.record_date
              ? "Source date: " + owner.record_date
              : "Source record date not provided."}
          </p>
          <form
            className="detail-form"
            onSubmit={submit}
            key={owner.identity_hash + String(review.suppressed)}
          >
            <label>
              Owner type
              <select
                className="form-select"
                name="owner_type"
                defaultValue={review.owner_type}
              >
                {["Unknown", "Person", "Company", "Trust/Other"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="review-check">
              <input
                type="checkbox"
                name="reviewed"
                defaultChecked={review.reviewed}
              />{" "}
              I reviewed the property match and owner identity
            </label>
            <label className="review-check">
              <input
                type="checkbox"
                name="suppressed"
                defaultChecked={review.suppressed}
              />{" "}
              Suppress contact lookup for this owner
            </label>
            {!!contacts?.candidates.length && (
              <label className="review-check">
                <input
                  type="checkbox"
                  name="contacts_verified"
                  defaultChecked={review.contacts_verified}
                />{" "}
                I verified the contacts belong to this owner/business
              </label>
            )}
            <button
              className="btn btn-outline-secondary"
              disabled={busy}
              aria-busy={busy}
            >
              Save identity review
            </button>
          </form>
          <div className="contact-actions">
            <Action
              disabled={!contactAllowed || pending("contacts")}
              onClick={() => enrich("contacts")}
            >
              {pending("contacts") ? "Finding contacts…" : "Find contact"}
            </Action>
            <small>
              {review.suppressed
                ? "Contact lookup is suppressed."
                : !review.reviewed
                  ? "Review and save the owner identity first."
                  : review.owner_type === "Person" &&
                      !data.consumer_append_enabled
                    ? "Consumer contact lookup needs a confirmed Append trial."
                    : providers.melissa.message}
            </small>
          </div>
        </>
      ) : (
        <>
          <Action
            disabled={!providers.realie.available || pending("owner")}
            onClick={() => enrich("owner")}
          >
            {pending("owner") ? "Finding owner…" : "Find owner"}
          </Action>
          <p className="muted">Realie: {providers.realie.message}</p>
        </>
      )}
      {contacts && (
        <div className="contact-results">
          <strong>
            {review.contacts_verified
              ? "Identity verified by workspace user"
              : contacts.match_status}
          </strong>
          {contacts.candidates.length ? (
            contacts.candidates.map((c, i) => (
              <p key={i}>
                {c.name} · {c.role}
                <br />
                {c.phone || "Phone not returned"}
                <br />
                {c.email || "Email not returned"}
              </p>
            ))
          ) : (
            <p>No phone or email returned.</p>
          )}
          <small>
            Melissa · {time(contacts.fetched_at)} ·{" "}
            {contacts.result_codes.join(", ")}
          </small>
        </div>
      )}
      {!!jobs.length && (
        <p className="enrichment-job" role="status">
          Latest {jobs[0].kind} lookup: {jobs[0].status} · {jobs[0].message}
        </p>
      )}
    </>
  );
}

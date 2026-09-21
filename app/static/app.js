const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/static/vendor/tabler-icons.svg#${name}"></use></svg>`;
const fmt = (value) => Number(value || 0).toLocaleString();
const money = (value) => value == null ? 'Not reported' : Number(value).toLocaleString('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0});
const shortDate = (value) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Not published';
const timestamp = (value) => value ? new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Not yet';
const safeLink = (value) => /^https:\/\//i.test(value || '') ? escapeHTML(value) : '#';
let view = 'feed', offset = 0, total = 0, activeLead = null, requestController, toastTimer, searchTimer, syncBusy = false;
let connectedSources = [];

function updateMarkets() {
  const form = $('#filters').elements, previous = form.city.value;
  const markets = [...new Set(connectedSources.filter(s => form.state.value ? s.state === form.state.value : ['CA','SC'].includes(s.state)).map(s => s.city))].sort();
  form.city.replaceChildren(new Option('All connected markets', ''), ...markets.map(city => new Option(city, city)));
  if (markets.includes(previous)) form.city.value = previous;
}

async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers: {'Content-Type':'application/json', ...options.headers}});
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === 'string' ? error.detail : `Request failed (${response.status}). Check your filters.`);
  }
  return response.json();
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

function filters() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData($('#filters'))) if (value) params.set(key, value === 'on' ? 'true' : value);
  if (view === 'saved') params.set('saved', 'true');
  params.set('sort', $('#sort').value);
  return params;
}

function tradeClass(trade) { return trade === 'Roofing' ? '' : trade === 'Tile' ? 'tile' : 'other'; }
function scoreClass(score) { return score >= 75 ? 'high' : score < 40 ? 'low' : ''; }

async function loadLeads() {
  requestController?.abort(); requestController = new AbortController();
  const params = filters(); params.set('offset', offset); params.set('limit', 20);
  $('#results-count').textContent = 'Loading opportunities…';
  try {
    const data = await api(`/api/leads?${params}`, {signal:requestController.signal});
    total = data.total;
    if (offset > 0 && !data.items.length) { offset = 0; return loadLeads(); }
    $('#results-count').textContent = `${fmt(total)} ${view === 'saved' ? 'saved ' : ''}opportunities`;
    $('#lead-rows').innerHTML = data.items.map(lead => `<tr>
      <td><button class="btn btn-icon btn-ghost-secondary save-button ${lead.saved ? 'saved' : ''}" data-save="${lead.id}" data-saved="${lead.saved ? 1 : 0}" aria-label="${lead.saved ? 'Unsave' : 'Save'} ${escapeHTML(lead.address)}" aria-pressed="${!!lead.saved}">${icon('bookmark')}</button></td>
      <td><button class="address-button" data-lead="${lead.id}">${escapeHTML(lead.address || 'Address not published')} ${icon('arrow-up-right')}</button><div class="location-text">${escapeHTML(lead.city)}, ${escapeHTML(lead.state)} ${escapeHTML(lead.zip)}</div><div class="scope-preview" title="${escapeHTML(lead.description)}">${escapeHTML(lead.description || lead.permit_type)}</div></td>
      <td><span class="badge pill ${tradeClass(lead.trade)}">${icon(lead.trade === 'Roofing' ? 'home' : lead.trade === 'Tile' ? 'layout-grid' : 'building-community')}${escapeHTML(lead.trade)}</span><span class="evidence-kind">${escapeHTML(lead.match.kind)} signal</span></td>
      <td><span class="badge pill stage ${['Application','In review'].includes(lead.stage) ? 'early' : ''}">${escapeHTML(lead.stage)}</span><span class="lead-date" title="${escapeHTML(lead.signal_date_kind || 'Issued / applied')}">${shortDate(lead.signal_date)}</span></td>
      <td><span class="value">${lead.value == null ? '—' : money(lead.value)}</span><span class="lead-date">${lead.contractor ? 'Contractor listed' : lead.permit_holder ? 'Holder listed' : 'Contact unverified'}</span></td>
      <td><span class="score ${scoreClass(lead.score)}" title="Heuristic opportunity score: ${lead.score}/100">${lead.score}</span></td>
    </tr>`).join('');
    $('#empty-state').hidden = data.items.length > 0;
    $('#page-range').textContent = total ? `Showing ${fmt(offset + 1)}–${fmt(Math.min(offset + 20, total))} of ${fmt(total)}` : 'No results';
    $('#prev-page').disabled = offset === 0; $('#next-page').disabled = offset + 20 >= total;
    $$('.trade-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.trade === $('#filters').elements.trade.value));
    $$('#pipeline-filters button').forEach(button => button.classList.toggle('selected', button.dataset.status === $('#filters').elements.status.value));
  } catch (error) {
    if (error.name !== 'AbortError') { $('#results-count').textContent = 'Could not load opportunities'; toast(error.message, true); }
  }
}

async function loadStats() {
  const stats = await api('/api/stats');
  for (const [id, value] of Object.entries({'metric-total':stats.total,'metric-roofing':stats.roofing,'metric-tile':stats.tile,'metric-priority':stats.high_priority,'metric-recent':stats.recent,'nav-total':stats.total,'nav-saved':stats.saved,'tab-roofing':stats.roofing,'tab-tile':stats.tile,'permit-count':stats.permits})) $(`#${id}`).textContent = fmt(value);
  $('#last-sync').textContent = timestamp(stats.last_sync);
  const maximum = Math.max(1, ...stats.markets.map(market => market.total));
  $('#market-bars').innerHTML = stats.markets.length ? stats.markets.map(market => `<div class="market-line"><div><span>${escapeHTML(market.city)} <small>${escapeHTML(market.state)}</small></span><span>${fmt(market.total)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round(market.total / maximum * 100)}%"></div></div></div>`).join('') : '<p class="muted">Market activity appears after the first successful import.</p>';
  if ($('#filters').elements.trade.options.length === 1) {
    stats.categories.forEach(trade => $('#filters').elements.trade.add(new Option(trade, trade)));
  }
}

async function loadSources() {
  const data = await api('/api/sources');
  connectedSources = data.items;
  updateMarkets();
  const target = data.items.filter(s => ['CA','SC'].includes(s.state));
  $('#source-count').textContent = `${target.length} target feeds · ${new Set(target.map(s => s.jurisdiction)).size} jurisdictions`;
  $('#territory-coverage').textContent = `${new Set(target.filter(s => s.state === 'CA').map(s => s.jurisdiction)).size} CA + ${new Set(target.filter(s => s.state === 'SC').map(s => s.jurisdiction)).size} SC jurisdictions connected · statewide coverage incomplete`;
  const coverage = await api('/api/coverage');
  $('#coverage-cards').innerHTML = coverage.states.map(state => `<article class="card source-card"><div class="source-type">${escapeHTML(state.state)} · COVERAGE</div><h3>${escapeHTML(state.name)}</h3><span class="badge pill">Partial · ${state.jurisdictions.length} jurisdiction${state.jurisdictions.length === 1 ? '' : 's'}</span><p>${fmt(state.permits)} permits imported</p><p class="muted">${state.jurisdictions.map(j => `${escapeHTML(j.name)} (${fmt(j.permits)})`).join(' · ')}</p><small>All other jurisdictions remain unconnected.</small></article>`).join('');
  syncBusy = data.runs.some(run => ['running','queued'].includes(run.status));
  const failures = data.items.filter(source => source.error).length;
  $('#system-status').textContent = syncBusy ? 'Import in progress' : failures ? `${failures} source${failures > 1 ? 's' : ''} need attention` : data.automatic_sync ? 'Automatic sync enabled' : 'Manual sync mode';
  $('#sync-button').innerHTML = `${icon('refresh')} ${syncBusy ? 'Syncing sources' : 'Sync sources'}`;
  $('#sync-button').disabled = syncBusy;
  $('#source-cards').innerHTML = data.items.map(source => {
    const pending = data.runs.find(run => run.source_id === source.id && ['running','queued'].includes(run.status));
    const lag = source.newest_record ? Math.floor((Date.now() - new Date(source.newest_record + 'T00:00:00Z')) / 86400000) : null;
    const state = pending ? pending.status : !source.enabled ? 'Paused' : source.error ? 'Needs attention' : !source.last_success ? 'Not synced' : lag > 3 ? 'Older source activity' : 'Synced';
    return `<article class="card source-card"><div class="source-type">${escapeHTML(source.kind)} · ${escapeHTML(source.state)}</div><h3>${escapeHTML(source.name)}</h3><span class="badge pill ${source.error ? 'failed' : 'success'}">${escapeHTML(state)}</span><p class="muted">${escapeHTML(source.scope || 'Connected city only; excludes surrounding county jurisdictions.')}</p><dl><div><dt>Publication</dt><dd>${escapeHTML(source.freshness)}</dd></div><div><dt>Polling interval</dt><dd>Every ${source.interval / 3600} hours</dd></div><div><dt>Last successful check</dt><dd>${timestamp(source.last_success)}</dd></div><div><dt>Newest activity in import</dt><dd>${shortDate(source.newest_record)}</dd></div><div><dt>Coverage starts</dt><dd>${shortDate(source.coverage_since)}</dd></div></dl>${source.error ? `<p class="source-error">${escapeHTML(source.error)}</p>` : ''}<div class="source-actions"><button class="btn btn-outline-secondary" data-sync="${escapeHTML(source.id)}" ${pending ? 'disabled' : ''}>${pending ? 'Queued / running' : 'Sync now'}</button><button class="btn btn-ghost-secondary text-button" data-toggle="${escapeHTML(source.id)}" data-enabled="${source.enabled}">${source.enabled ? 'Pause schedule' : 'Resume schedule'}</button></div><a class="source-link" href="${safeLink(source.page)}" target="_blank" rel="noopener">Official data source ↗</a></article>`;
  }).join('');
  $('#run-rows').innerHTML = data.runs.map(run => `<tr><td>${escapeHTML(data.items.find(source => source.id === run.source_id)?.name || run.source_id)}</td><td>${timestamp(run.started_at || run.queued_at)}</td><td><span class="badge pill ${run.status === 'failed' ? 'failed' : 'success'}" title="${escapeHTML(run.error || '')}">${escapeHTML(run.status)}</span></td><td>${fmt(run.fetched)}</td><td>${fmt(run.new_permits)}</td><td>${fmt(run.leads_created)}</td></tr>`).join('') || '<tr><td colspan="6">No ingestion runs yet. Start a sync to import public records.</td></tr>';
}

function setView(next) {
  view = next; offset = 0;
  const titles = {feed:'Opportunity feed',saved:'Saved leads',pipeline:'My pipeline',sources:'Data sources'};
  $('#page-title').innerHTML = `${titles[next]}<span class="heading-dot">.</span>`;
  $('#breadcrumb-current').textContent = titles[next];
  $('#page-subtitle').textContent = {feed:'Turn local construction activity into your next conversation.',saved:'A shortlist of the opportunities you want to follow.',pipeline:'Qualify, track, and assign your construction opportunities.',sources:'See where the signals come from and how recently they were checked.'}[next];
  $$('.nav-item').forEach(button => { button.classList.toggle('active', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
  $('#feed-view').hidden = next === 'sources'; $('#sources-view').hidden = next !== 'sources';
  $('#pipeline-filters').hidden = next !== 'pipeline'; $('#export-button').hidden = next === 'sources';
  if (next === 'sources') loadSources().catch(error => toast(error.message, true)); else loadLeads();
}

async function sync(sourceId) {
  try {
    await api('/api/sync', {method:'POST',body:JSON.stringify(sourceId ? {source_id:sourceId} : {})});
    toast('Sync queued. New opportunities will appear as each source finishes.'); await loadSources();
  } catch (error) { toast(error.message, true); }
}

function propertyHTML(property) {
  if (!property) return '';
  return `<dl class="detail-grid"><div><dt>Year built</dt><dd>${escapeHTML(property.year_built || 'Not published')}</dd></div><div><dt>Building area</dt><dd>${property.building_sqft == null ? 'Not published' : fmt(property.building_sqft) + ' sq ft'}</dd></div><div><dt>Assessed value (not market value)</dt><dd>${money(property.assessed_value)}</dd></div><div><dt>Assessment roll</dt><dd>${escapeHTML(property.roll_year || 'Not published')}</dd></div><div><dt>Property use</dt><dd>${escapeHTML(property.use || 'Not published')}</dd></div><div><dt>Match</dt><dd>${escapeHTML(property.match_method)}</dd></div></dl><a class="detail-link" href="${safeLink(property.source_url)}" target="_blank" rel="noopener">LA County parcel source ↗</a><p class="muted">Retrieved ${timestamp(property.fetched_at)}. ${escapeHTML(property.owner_contact)}</p>`;
}

async function openLead(id) {
  try {
    const lead = await api(`/api/leads/${id}`); activeLead = lead;
    $('#detail-content').innerHTML = `<div class="detail-header"><div class="detail-top"><span class="badge pill ${tradeClass(lead.trade)}">${escapeHTML(lead.trade)} · ${escapeHTML(lead.match.kind)} signal</span><button class="btn btn-icon btn-ghost-secondary close-button" id="close-detail" aria-label="Close lead details">${icon('x')}</button></div><h2 id="detail-title">${escapeHTML(lead.address || 'Address not published')}</h2><p>${escapeHTML(lead.city)}, ${escapeHTML(lead.state)} ${escapeHTML(lead.zip)} &nbsp;·&nbsp; Lead #${lead.id}</p></div><div class="detail-body">
      <div class="detail-signal"><strong>Opportunity score: ${lead.score}/100</strong><p>${escapeHTML(lead.match.evidence)} · ${lead.match.confidence}% rule confidence</p></div>
      <h3>Project scope</h3><p class="detail-description">${escapeHTML(lead.description || 'Scope not published.')}</p>
      ${lead.date_warning ? '<div class="detail-warning">The source contains a future activity date. Dates are preserved as published; this score is capped at 25 pending verification.</div>' : ''}
      <dl class="detail-grid"><div><dt>Permit stage</dt><dd>${escapeHTML(lead.stage)} · ${escapeHTML(lead.raw_status)}</dd></div><div><dt>Reported project value</dt><dd>${money(lead.value)}</dd></div><div><dt>Property type</dt><dd>${escapeHTML(lead.property_type || 'Not published')}</dd></div><div><dt>Parcel / assessor ID</dt><dd>${escapeHTML(lead.apn || 'Not published')}</dd></div><div><dt>Contractor of record</dt><dd>${escapeHTML(lead.contractor || 'Not published')}</dd></div><div><dt>Contractor phone</dt><dd>${escapeHTML(lead.contractor_phone || 'Not published')}</dd></div><div><dt>Permit holder (role unverified)</dt><dd>${escapeHTML(lead.permit_holder || 'Not published')}</dd></div><div><dt>Owner from permit record</dt><dd>${escapeHTML(lead.owner || 'Not published')}</dd></div></dl>
      <div class="detail-warning">${lead.contractor ? 'A contractor is already listed. Check whether the primary work is awarded before treating this as a homeowner prospect.' : lead.permit_holder ? 'A permit holder is listed. This may be an owner, agent, or contractor; the role is not inferred.' : 'A missing contractor field does not mean the work is available.'} Homeowner phone and email are not supplied or inferred.</div>
      <h3>Why this score</h3><div class="score-parts">${Object.entries(lead.score_breakdown).map(([key,value]) => `<span>${escapeHTML(key)} ${value >= 0 ? '+' : ''}${value}</span>`).join('')}</div><p class="muted">Heuristic score, not a conversion prediction. Completed, expired, and cancelled records are capped at 10.</p>
      <h3>Property enrichment</h3><div id="property-content">${propertyHTML(lead.property) || (lead.jurisdiction === 'los-angeles' && lead.apn.replace(/\D/g,'').length === 10 ? '<p class="muted">Match the official LA County parcel using its exact assessor ID.</p><button id="enrich-button" class="btn btn-outline-secondary">Fetch county property details ↗</button>' : '<p class="muted">Permit property fields are shown above. A county assessor connector is not configured for this market.</p>')}</div>
      <h3>Evidence & timing · ${lead.permit_count} permit${lead.permit_count > 1 ? 's' : ''}</h3><p class="muted">${escapeHTML(lead.grouping)}</p>
      ${lead.permits.map(permit => `<details class="permit-evidence"><summary>${escapeHTML(permit.permit_number)} · ${escapeHTML(permit.stage)}</summary><p>${escapeHTML(permit.description)}</p><div class="timeline"><div>Applied<strong>${shortDate(permit.applied_date)}</strong></div><div>Issued<strong>${shortDate(permit.issue_date)}</strong></div><div>Completed<strong>${shortDate(permit.completed_date)}</strong></div><div>Last activity<strong>${shortDate(permit.activity_date)}</strong></div><div>First detected<strong>${timestamp(permit.first_seen)}</strong></div></div><a href="${safeLink(permit.source_url)}" target="_blank" rel="noopener">Official dataset ↗</a>${permit.evidence.slice(0,5).map(event => `<p><a href="/api/evidence/${event.id}" target="_blank" rel="noopener">Raw evidence · ${escapeHTML(event.source_id)} · ${timestamp(event.fetched_at)} ↗</a></p>`).join('')}</details>`).join('')}
      ${lead.related.length ? `<h3>Other signals at this address</h3><p class="muted">Review these before selling related opportunities as separate leads.</p>${lead.related.map(related => `<button class="btn btn-outline-secondary" data-related="${related.id}">${escapeHTML(related.trade)} · #${related.id} ↗</button>`).join(' ')}` : ''}
      <h3>Your pipeline</h3><form id="detail-form" class="detail-form"><div class="detail-grid"><label>Sales status<select class="form-select" name="status">${['New','Qualified','Contacted','Sold','Dismissed'].map(status => `<option ${lead.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><label>Assigned to<input class="form-control" name="assigned_to" maxlength="120" value="${escapeHTML(lead.assigned_to)}" placeholder="Team member or contractor"></label></div><label>Notes<textarea class="form-control" name="notes" maxlength="10000" placeholder="Qualification notes and next steps…">${escapeHTML(lead.notes)}</textarea></label><div class="detail-actions"><button type="button" id="detail-save" class="btn btn-outline-secondary">${icon('bookmark')} ${lead.saved ? 'Saved to shortlist' : 'Save to shortlist'}</button><button type="submit" class="btn btn-primary">Save changes</button></div></form>
    </div>`;
    if (!$('#lead-dialog').open) $('#lead-dialog').showModal();
    $('#lead-dialog').scrollTop = 0;
  } catch (error) { toast(error.message, true); }
}

document.addEventListener('click', async event => {
  if (!event.target.closest('.more-filters')) $('.more-filters').open = false;
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) setView(button.dataset.view);
  if ('trade' in button.dataset) { $('#filters').elements.trade.value = button.dataset.trade; offset = 0; loadLeads(); }
  if ('status' in button.dataset) { $('#filters').elements.status.value = button.dataset.status; offset = 0; loadLeads(); }
  if (button.dataset.lead || button.dataset.related) openLead(button.dataset.lead || button.dataset.related);
  if (button.dataset.sync) sync(button.dataset.sync);
  if (button.dataset.save) {
    button.disabled = true;
    try { await api(`/api/leads/${button.dataset.save}`, {method:'PATCH',body:JSON.stringify({saved:button.dataset.saved !== '1'})}); await Promise.all([loadLeads(),loadStats()]); } catch (error) { toast(error.message,true); button.disabled=false; }
  }
  if (button.dataset.toggle) {
    try { await api(`/api/sources/${button.dataset.toggle}`, {method:'PATCH',body:JSON.stringify({enabled:button.dataset.enabled !== '1'})}); await loadSources(); } catch (error) { toast(error.message,true); }
  }
  if (button.id === 'close-detail') $('#lead-dialog').close();
  if (button.id === 'detail-save') {
    try { await api(`/api/leads/${activeLead.id}`, {method:'PATCH',body:JSON.stringify({saved:!activeLead.saved})}); activeLead.saved = !activeLead.saved; button.textContent = activeLead.saved ? '★ Saved to shortlist' : '☆ Save to shortlist'; await Promise.all([loadLeads(),loadStats()]); } catch (error) { toast(error.message,true); }
  }
  if (button.id === 'enrich-button') {
    button.disabled = true; button.textContent = 'Checking county parcel…';
    try { const property = await api(`/api/leads/${activeLead.id}/enrich`,{method:'POST',body:'{}'}); $('#property-content').innerHTML = propertyHTML(property); } catch (error) { toast(error.message,true); button.disabled=false; button.textContent='Retry property lookup'; }
  }
});

document.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'detail-form') {
    const button = event.target.querySelector('[type=submit]'); button.disabled = true;
    try { await api(`/api/leads/${activeLead.id}`,{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); toast('Pipeline changes saved.'); loadLeads(); } catch (error) { toast(error.message,true); } finally { button.disabled = false; }
  }
});
$('#filters').addEventListener('input', event => { if (event.target.name === 'q') { clearTimeout(searchTimer); searchTimer = setTimeout(() => {offset=0;loadLeads();},300); } });
$('#filters').addEventListener('change', event => { if (event.target.name !== 'q') { if (!$('#filters').reportValidity()) return; if (event.target.name === 'state') { $('#filters').elements.city.value = ''; updateMarkets(); } offset=0;loadLeads(); } });
$('#sort').addEventListener('change', () => {offset=0;loadLeads();});
function resetFilters() { $('#filters').reset(); updateMarkets(); offset=0; loadLeads(); }
$('#reset-filters').addEventListener('click', resetFilters); $('#empty-reset').addEventListener('click', resetFilters);
$('#sync-button').addEventListener('click', () => sync());
$('#prev-page').addEventListener('click', () => {offset=Math.max(0,offset-20);loadLeads();});
$('#next-page').addEventListener('click', () => {offset+=20;loadLeads();});
$('#early-filter').addEventListener('click', () => {$('#filters').elements.stage.value='Application';offset=0;loadLeads();});
$('#source-notice-link').addEventListener('click', event => {event.preventDefault();setView('sources');});
$('#export-button').addEventListener('click', async () => {
  try { const response = await fetch(`/api/leads/export?${filters()}`); if (!response.ok) throw new Error((await response.json()).detail); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href=url; link.download='permit-atlas-leads.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); toast('Filtered leads exported.'); } catch (error) { toast(error.message,true); }
});
$('#lead-dialog').addEventListener('click', event => { if(event.target === $('#lead-dialog')) {const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();} });

async function boot() {
  try { await loadStats(); await Promise.all([loadLeads(),loadSources()]); } catch (error) { toast(error.message,true); $('#system-status').textContent='Connection unavailable'; }
}
boot();
setInterval(async () => {
  if (document.hidden) return;
  try { const wasBusy=syncBusy; await Promise.all([loadStats(),loadSources()]); if ((syncBusy || wasBusy) && view !== 'sources') await loadLeads(); } catch (_) { $('#system-status').textContent='Connection unavailable'; }
}, 12000);

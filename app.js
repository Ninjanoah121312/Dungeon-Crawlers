// ============================================================
// Dungeon Crawlers — frontend app logic
// Static site (GitHub Pages) talking to:
//   1) Discord's OAuth + REST API directly (PKCE, no secret needed here)
//   2) Your locally hosted bot (bot/bot.js) over http://localhost:3001
// Includes a tiny client-side router so URLs reflect the current
// screen (/, /dashboard, /servers/:id/:panel).
// ============================================================

const CFG = window.TICKET_KEEPER_CONFIG;
const LS = {
  verifier: "tk_pkce_verifier",
  token: "tk_access_token",
  tokenExpiry: "tk_token_expiry",
  user: "tk_user",
  theme: "tk_theme",
};
const ADMINISTRATOR = 0x8;

// ============================================================
// Router
// ============================================================
const routes = {
  parse() {
    const path = window.location.pathname.replace(CFG.BASE_PATH, "").replace(/^\/|\/$/g, "");
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "dashboard") return { screen: "picker" };
    if (parts[0] === "servers" && parts[1]) return { screen: "dashboard", guildId: parts[1], panel: parts[2] || "overview" };
    return { screen: "landing" };
  },
  go(url, replace = false) {
    const full = CFG.BASE_PATH.replace(/\/$/, "") + url;
    if (replace) window.history.replaceState({}, "", full);
    else window.history.pushState({}, "", full);
  },
};

window.addEventListener("popstate", () => renderFromRoute());

// ============================================================
// PKCE helpers
// ============================================================
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeVerifierAndChallenge() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}
async function beginLogin() {
  const { verifier, challenge } = await makeVerifierAndChallenge();
  sessionStorage.setItem(LS.verifier, verifier);
  sessionStorage.setItem("tk_post_login_redirect", "/dashboard");
  const params = new URLSearchParams({
    client_id: CFG.DISCORD_CLIENT_ID,
    redirect_uri: CFG.REDIRECT_URI,
    response_type: "code",
    scope: CFG.OAUTH_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.href = `https://discord.com/oauth2/authorize?${params.toString()}`;
}
async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem(LS.verifier);
  const body = new URLSearchParams({
    client_id: CFG.DISCORD_CLIENT_ID, grant_type: "authorization_code",
    code, redirect_uri: CFG.REDIRECT_URI, code_verifier: verifier,
  });
  try {
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!res.ok) throw new Error("direct exchange failed");
    return await res.json();
  } catch {
    const res2 = await fetch(`${CFG.LOCAL_BOT_URL}/oauth/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier, redirect_uri: CFG.REDIRECT_URI }),
    });
    if (!res2.ok) throw new Error("Could not complete login. Is your local bot running?");
    return await res2.json();
  }
}

function saveSession(tokenData, user) {
  localStorage.setItem(LS.token, tokenData.access_token);
  localStorage.setItem(LS.tokenExpiry, String(Date.now() + tokenData.expires_in * 1000));
  localStorage.setItem(LS.user, JSON.stringify(user));
}
function getSession() {
  const token = localStorage.getItem(LS.token);
  const expiry = Number(localStorage.getItem(LS.tokenExpiry) || 0);
  if (!token || Date.now() > expiry) return null;
  return { token, user: JSON.parse(localStorage.getItem(LS.user) || "null") };
}
function clearSession() { [LS.token, LS.tokenExpiry, LS.user].forEach(k => localStorage.removeItem(k)); }

// ============================================================
// Discord API (direct, via the user's own access token)
// ============================================================
async function fetchMe(token) {
  const res = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Failed to load Discord profile");
  return res.json();
}
async function fetchMyGuilds(token) {
  const res = await fetch("https://discord.com/api/users/@me/guilds", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Failed to load your servers");
  return res.json();
}
function isAdmin(guild) {
  return guild.owner || (BigInt(guild.permissions) & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
}

// ============================================================
// Local bot bridge
// ============================================================
async function pingLocalBot() {
  try {
    const res = await fetch(`${CFG.LOCAL_BOT_URL}/status`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error();
    return await res.json();
  } catch { return null; }
}
async function api(path, options = {}) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

// ============================================================
// Theme
// ============================================================
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem(LS.theme, theme);
  document.querySelectorAll("[id^=btn-theme]").forEach(btn => {
    btn.innerHTML = theme === "dark" ? `<i class="ti ti-moon"></i>` : `<i class="ti ti-sun"></i>`;
  });
}
function toggleTheme() { applyTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark"); }
applyTheme(localStorage.getItem(LS.theme) || "dark");

// ============================================================
// Small render helpers
// ============================================================
function showScreen(id) { document.querySelectorAll(".screen").forEach(s => s.classList.remove("active")); document.getElementById(id).classList.add("active"); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function initials(name) { return (name || "?").slice(0, 2).toUpperCase(); }
function avatarUrl(user) {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
}
function inviteUrl(guildId) {
  const p = { client_id: CFG.DISCORD_CLIENT_ID, permissions: CFG.BOT_PERMISSIONS, scope: "bot applications.commands" };
  if (guildId) p.guild_id = guildId;
  return `https://discord.com/oauth2/authorize?${new URLSearchParams(p)}`;
}
function formatUptime(sec) {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
function loadingBlock(msg) { return `<div class="loading-wrap"><div class="spinner"></div><div>${msg || "Loading…"}</div></div>`; }
function renderStatusPip(el, botInfo) {
  el.classList.remove("online", "offline", "checking");
  if (botInfo && botInfo.online) { el.classList.add("online"); el.innerHTML = `<span class="status-dot"></span>Bot online`; }
  else { el.classList.add("offline"); el.innerHTML = `<span class="status-dot"></span>Bot offline`; }
}
function renderLocalBanner(slotId, botInfo) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  slot.innerHTML = botInfo
    ? `<div class="local-banner ok"><i class="ti ti-check"></i> Connected to your local bot at ${CFG.LOCAL_BOT_URL}</div>`
    : `<div class="local-banner"><i class="ti ti-alert-triangle"></i> Can't reach your local bot at ${CFG.LOCAL_BOT_URL}. Start bot.js to load tickets, subjects, and config.</div>`;
}

// ============================================================
// Global state
// ============================================================
let botInfoCache = null;
let currentGuild = null;   // { id, name, icon }
let ticketsCache = [];
let subjectsCache = [];
let metaCache = null;      // channels/categories/roles for currentGuild

// ============================================================
// Boot + top-level routing
// ============================================================
async function boot() {
  // If 404.html bounced a deep link here, restore the real path first
  const redirectPath = sessionStorage.getItem("tk_redirect_path");
  if (redirectPath) {
    sessionStorage.removeItem("tk_redirect_path");
    window.history.replaceState({}, "", redirectPath);
  }

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  refreshHeroStatus();

  if (code) {
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.pathname + url.search);
    try {
      const tokenData = await exchangeCodeForToken(code);
      const user = await fetchMe(tokenData.access_token);
      saveSession(tokenData, user);
      routes.go(sessionStorage.getItem("tk_post_login_redirect") || "/dashboard", true);
      renderFromRoute();
    } catch (e) {
      alert(e.message || "Login failed");
      routes.go("/", true);
      showScreen("screen-landing");
    }
    return;
  }
  renderFromRoute();
}

async function renderFromRoute() {
  const route = routes.parse();
  const session = getSession();

  if (route.screen !== "landing" && !session) { routes.go("/", true); showScreen("screen-landing"); return; }

  if (route.screen === "landing") { showScreen("screen-landing"); return; }
  if (route.screen === "picker") { await enterPicker(); return; }
  if (route.screen === "dashboard") {
    if (!currentGuild || currentGuild.id !== route.guildId) {
      currentGuild = { id: route.guildId, name: null, icon: null };
    }
    await enterDashboard(route.panel || "overview");
  }
}

async function refreshHeroStatus() {
  const info = await pingLocalBot();
  botInfoCache = info;
  const heroPip = document.getElementById("hero-status-pip");
  if (heroPip) renderStatusPip(heroPip, info);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("hero-guild-count", info?.guildCount ?? "—");
  set("hero-uptime", info ? formatUptime(info.uptimeSeconds) : "—");
  set("hero-bot-tag", info?.botTag ?? "—");
  ["picker-status-pip", "dash-status-pip"].forEach(id => { const el = document.getElementById(id); if (el) renderStatusPip(el, info); });
}

// ============================================================
// Picker screen
// ============================================================
async function enterPicker() {
  showScreen("screen-picker");
  const session = getSession();
  document.getElementById("picker-user-chip").innerHTML = `<img src="${avatarUrl(session.user)}" alt=""> ${escapeHtml(session.user.username)}`;

  const grid = document.getElementById("server-grid");
  grid.innerHTML = loadingBlock("Loading your servers…");

  await refreshHeroStatus();
  renderLocalBanner("local-banner-slot", botInfoCache);

  try {
    const guilds = await fetchMyGuilds(session.token);
    const admin = guilds.filter(isAdmin);
    if (admin.length === 0) {
      grid.innerHTML = `<div class="empty-state"><i class="ti ti-folder-off glyph"></i>No servers found where you have Administrator permission.</div>`;
      return;
    }
    const botGuildIds = new Set((botInfoCache?.guilds || []).map(g => g.id));
    grid.innerHTML = admin.map(g => {
      const hasBot = botGuildIds.has(g.id);
      const iconHtml = g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">` : initials(g.name);
      return `
        <div class="server-card ${hasBot ? "" : "bot-absent"}">
          <div class="server-icon">${iconHtml}</div>
          <div class="server-name">${escapeHtml(g.name)}</div>
          <div class="server-meta">${hasBot ? "Bot is in this server" : "Bot not added yet"}</div>
          <div class="server-card-actions">
            ${hasBot
              ? `<button class="btn btn-primary btn-small" data-open-dash="${g.id}" data-name="${escapeHtml(g.name)}" data-icon="${g.icon || ""}">Dashboard</button>`
              : `<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${inviteUrl(g.id)}"><i class="ti ti-plus"></i> Invite</a>`}
          </div>
        </div>`;
    }).join("");
    grid.querySelectorAll("[data-open-dash]").forEach(btn => {
      btn.addEventListener("click", () => {
        currentGuild = { id: btn.dataset.openDash, name: btn.dataset.name, icon: btn.dataset.icon };
        routes.go(`/servers/${currentGuild.id}/overview`);
        enterDashboard("overview");
      });
    });
  } catch {
    grid.innerHTML = `<div class="empty-state">Couldn't load your servers. Try logging in again.</div>`;
  }
}

// ============================================================
// Dashboard shell
// ============================================================
async function enterDashboard(panel) {
  showScreen("screen-dashboard");
  const session = getSession();
  document.getElementById("dash-user-chip").innerHTML = `<img src="${avatarUrl(session.user)}" alt=""> ${escapeHtml(session.user.username)}`;

  await refreshHeroStatus();
  renderLocalBanner("local-banner-slot-dash", botInfoCache);

  // resolve guild display info from bot status if we don't have it (e.g. deep link)
  if (!currentGuild.name && botInfoCache) {
    const found = (botInfoCache.guilds || []).find(g => g.id === currentGuild.id);
    if (found) currentGuild = { id: found.id, name: found.name, icon: found.icon };
  }
  document.getElementById("dash-server-name").textContent = currentGuild.name || "Server";
  document.getElementById("dash-server-sub").textContent = botInfoCache ? "Connected" : "Bot offline";
  document.getElementById("dash-server-icon").innerHTML = currentGuild.icon
    ? `<img src="https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png" alt="">`
    : initials(currentGuild.name || "S");
  document.getElementById("dash-crumb").innerHTML = `Servers <i class="ti ti-chevron-right" style="font-size:12px"></i> <b>${escapeHtml(currentGuild.name || "…")}</b>`;

  switchPanel(panel, false);
}

function switchPanel(name, updateUrl = true) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === name));
  if (updateUrl) routes.go(`/servers/${currentGuild.id}/${name}`);
  const root = document.getElementById("module-root");
  root.innerHTML = loadingBlock();
  const renderers = {
    overview: renderOverview, tickets: renderTickets, insights: renderInsights,
    subjects: renderSubjects, panels: renderPanels, settings: renderSettings, status: renderStatusModule,
  };
  (renderers[name] || renderOverview)(root);
}

// ============================================================
// Overview module
// ============================================================
async function renderOverview(root) {
  root.innerHTML = `
    <div class="dash-header"><div><h1>Overview</h1><p>Live status from your locally hosted bot.</p></div></div>
    <div class="overview-grid">
      <div class="overview-card"><div class="num" id="ov-open">—</div><div class="lbl">Open tickets</div></div>
      <div class="overview-card"><div class="num" id="ov-pending">—</div><div class="lbl">Pending reply</div></div>
      <div class="overview-card"><div class="num" id="ov-closed">—</div><div class="lbl">Closed (all time)</div></div>
      <div class="overview-card"><div class="num" id="ov-members">—</div><div class="lbl">Server members</div></div>
    </div>
    <div class="config-section">
      <h3>Bot connection</h3>
      <div class="hint">Straight from your local bot.js instance.</div>
      <div class="config-row"><span class="config-row-label">Status</span><span class="status-pip checking" id="ov-bot-pip"><span class="status-dot"></span>Checking…</span></div>
      <div class="config-row"><span class="config-row-label">Bot tag</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${escapeHtml(botInfoCache?.botTag || "—")}</span></div>
      <div class="config-row"><span class="config-row-label">Uptime</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${formatUptime(botInfoCache?.uptimeSeconds)}</span></div>
      <div class="config-row"><span class="config-row-label">Data source</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">GitHub: ticket_tool_data.json</span></div>
    </div>`;
  const ovPip = document.getElementById("ov-bot-pip");
  if (ovPip) renderStatusPip(ovPip, botInfoCache);
  if (!botInfoCache) return;
  try {
    const data = await api(`/guilds/${currentGuild.id}/tickets`);
    ticketsCache = data.tickets || [];
    document.getElementById("ov-open").textContent = ticketsCache.filter(t => t.status === "open").length;
    document.getElementById("ov-pending").textContent = ticketsCache.filter(t => t.status === "pending").length;
    document.getElementById("ov-closed").textContent = ticketsCache.filter(t => t.status === "closed").length;
    document.getElementById("ov-members").textContent = data.memberCount ?? "—";
  } catch { /* banner already covers this */ }
}

// ============================================================
// Tickets module
// ============================================================
async function renderTickets(root) {
  root.innerHTML = `
    <div class="dash-header"><div><h1>Tickets</h1><p>All tickets synced from ticket_tool_data.json.</p></div></div>
    <div class="ticket-toolbar">
      <div class="ticket-filters">
        <span class="filter-chip active" data-filter="all">All</span>
        <span class="filter-chip" data-filter="open">Open</span>
        <span class="filter-chip" data-filter="pending">Pending</span>
        <span class="filter-chip" data-filter="closed">Closed</span>
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" class="search-input" id="ticket-search" placeholder="Search tickets…">
        <button class="btn btn-ghost btn-small" id="btn-refresh-tickets"><i class="ti ti-refresh"></i></button>
      </div>
    </div>
    <div class="ticket-table" id="ticket-table">${headRow()}${loadingBlock("Loading tickets…")}</div>`;

  document.querySelectorAll(".filter-chip").forEach(c => c.addEventListener("click", () => {
    document.querySelectorAll(".filter-chip").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    paintTickets(c.dataset.filter, document.getElementById("ticket-search").value);
  }));
  document.getElementById("ticket-search").addEventListener("input", (e) => {
    const active = document.querySelector(".filter-chip.active")?.dataset.filter || "all";
    paintTickets(active, e.target.value);
  });
  document.getElementById("btn-refresh-tickets").addEventListener("click", async () => {
    ticketsCache = [];
    await loadTicketsIfNeeded();
    paintTickets("all", "");
  });

  if (!botInfoCache) { document.getElementById("ticket-table").innerHTML = headRow() + `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Local bot is offline — start bot.js to load tickets.</div>`; return; }
  await loadTicketsIfNeeded();
  paintTickets("all", "");
}
async function loadTicketsIfNeeded() {
  if (ticketsCache.length) return;
  try {
    const data = await api(`/guilds/${currentGuild.id}/tickets`);
    ticketsCache = data.tickets || [];
  } catch { ticketsCache = []; }
}
function headRow() {
  return `<div class="ticket-row head"><span>ID</span><span>Subject</span><span>Opened by</span><span class="col-created">Created</span><span>Status</span></div>`;
}
function paintTickets(filter, query) {
  const table = document.getElementById("ticket-table");
  if (!table) return;
  let rows = filter === "all" ? ticketsCache : ticketsCache.filter(t => t.status === filter);
  if (query) {
    const q = query.toLowerCase();
    rows = rows.filter(t => (t.subject || "").toLowerCase().includes(q) || (t.openedBy || "").toLowerCase().includes(q) || String(t.id).includes(q));
  }
  if (rows.length === 0) { table.innerHTML = headRow() + `<div class="empty-state"><i class="ti ti-ticket-off glyph"></i>No tickets match.</div>`; return; }
  table.innerHTML = headRow() + rows.map(t => `
    <div class="ticket-row">
      <span>#${t.id}</span>
      <span>${escapeHtml(t.subject || "No subject")}</span>
      <span>${escapeHtml(t.openedBy || "Unknown")}</span>
      <span class="col-created">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</span>
      <span class="badge badge-${t.status}">${t.status}</span>
    </div>`).join("");
}

// ============================================================
// Insights module
// ============================================================
async function renderInsights(root) {
  root.innerHTML = `<div class="dash-header"><div><h1>Insights</h1><p>Ticket activity for this server.</p></div></div><div id="insights-body">${loadingBlock()}</div>`;
  const body = document.getElementById("insights-body");
  if (!botInfoCache) { body.innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Local bot is offline.</div>`; return; }
  await loadTicketsIfNeeded();
  const total = ticketsCache.length;
  const open = ticketsCache.filter(t => t.status === "open").length;
  const closed = ticketsCache.filter(t => t.status === "closed").length;
  const bySubject = {};
  ticketsCache.forEach(t => { const k = t.subject || "General"; bySubject[k] = (bySubject[k] || 0) + 1; });
  const subjectRows = Object.entries(bySubject).sort((a, b) => b[1] - a[1]);

  body.innerHTML = `
    <div class="overview-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="overview-card"><div class="num">${total}</div><div class="lbl">Total tickets</div></div>
      <div class="overview-card"><div class="num">${open}</div><div class="lbl">Currently open</div></div>
      <div class="overview-card"><div class="num">${closed}</div><div class="lbl">Closed</div></div>
    </div>
    <div class="config-section">
      <h3>Tickets by subject</h3>
      <div class="hint">Counts pulled from all tickets currently in the data file.</div>
      ${subjectRows.length === 0 ? `<div class="empty-state">No ticket data yet.</div>` :
        subjectRows.map(([name, count]) => `<div class="config-row"><span class="config-row-label">${escapeHtml(name)}</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${count}</span></div>`).join("")}
    </div>`;
}

// ============================================================
// Subjects module
// ============================================================
async function loadMetaIfNeeded() {
  if (metaCache) return;
  try { metaCache = await api(`/guilds/${currentGuild.id}/meta`); } catch { metaCache = null; }
}
async function renderSubjects(root) {
  root.innerHTML = `
    <div class="dash-header">
      <div><h1>Ticket subjects</h1><p>What a user picks when opening a ticket — determines the category and welcome text.</p></div>
      <div class="dash-header-actions"><button class="btn btn-primary btn-small" id="btn-new-subject"><i class="ti ti-plus"></i> New subject</button></div>
    </div>
    <div id="subjects-list">${loadingBlock()}</div>
    <div id="subject-editor-slot"></div>`;

  document.getElementById("btn-new-subject").addEventListener("click", () => openSubjectEditor(null));

  if (!botInfoCache) { document.getElementById("subjects-list").innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Local bot is offline.</div>`; return; }
  await loadMetaIfNeeded();
  await refreshSubjects();
}
async function refreshSubjects() {
  const list = document.getElementById("subjects-list");
  if (!list) return;
  try {
    const data = await api(`/guilds/${currentGuild.id}/subjects`);
    subjectsCache = data.subjects || [];
  } catch { list.innerHTML = `<div class="empty-state">Couldn't load subjects.</div>`; return; }

  if (subjectsCache.length === 0) { list.innerHTML = `<div class="empty-state"><i class="ti ti-tag-off glyph"></i>No subjects yet — create one to let members open tickets.</div>`; return; }

  list.innerHTML = subjectsCache.map(s => `
    <div class="subject-card">
      <div class="subject-card-main">
        <div class="subject-card-name">${escapeHtml(s.name)}</div>
        <div class="subject-card-desc">${escapeHtml(s.description || "No description")}</div>
      </div>
      <div class="subject-card-actions">
        <button class="toggle ${s.active ? "on" : ""}" data-toggle-subject="${s.id}" aria-label="Toggle active"></button>
        <button class="btn btn-ghost btn-small" data-edit-subject="${s.id}"><i class="ti ti-edit"></i></button>
        <button class="btn btn-ghost btn-small" data-delete-subject="${s.id}"><i class="ti ti-trash"></i></button>
      </div>
    </div>`).join("");

  list.querySelectorAll("[data-toggle-subject]").forEach(btn => btn.addEventListener("click", async () => {
    const s = subjectsCache.find(x => x.id === btn.dataset.toggleSubject);
    if (!s) return;
    btn.classList.toggle("on");
    try { await api(`/guilds/${currentGuild.id}/subjects/${s.id}`, { method: "PUT", body: JSON.stringify({ active: !s.active }) }); s.active = !s.active; }
    catch { btn.classList.toggle("on"); }
  }));
  list.querySelectorAll("[data-edit-subject]").forEach(btn => btn.addEventListener("click", () => openSubjectEditor(subjectsCache.find(x => x.id === btn.dataset.editSubject))));
  list.querySelectorAll("[data-delete-subject]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("Delete this subject?")) return;
    try { await api(`/guilds/${currentGuild.id}/subjects/${btn.dataset.deleteSubject}`, { method: "DELETE" }); await refreshSubjects(); } catch {}
  }));
}
function openSubjectEditor(subject) {
  const slot = document.getElementById("subject-editor-slot");
  const categoryOptions = (metaCache?.categories || []).map(c => `<option value="${c.id}" ${subject?.category === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  slot.innerHTML = `
    <div class="editor-panel">
      <h3 style="font-size:14px;font-weight:700;margin-bottom:14px">${subject ? "Edit subject" : "New subject"}</h3>
      <div class="field"><label>Name</label><input type="text" id="ed-name" value="${escapeHtml(subject?.name || "")}" placeholder="e.g. General Support"></div>
      <div class="field"><label>Description</label><textarea id="ed-desc" placeholder="Shown to users when picking this subject">${escapeHtml(subject?.description || "")}</textarea></div>
      <div class="field"><label>Ticket category</label><select id="ed-category"><option value="">No category</option>${categoryOptions}</select></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-small" id="ed-save">${subject ? "Save changes" : "Create subject"}</button>
        <button class="btn btn-ghost btn-small" id="ed-cancel">Cancel</button>
      </div>
    </div>`;
  document.getElementById("ed-cancel").addEventListener("click", () => { slot.innerHTML = ""; });
  document.getElementById("ed-save").addEventListener("click", async () => {
    const payload = {
      name: document.getElementById("ed-name").value.trim() || "Untitled subject",
      description: document.getElementById("ed-desc").value.trim(),
      category: document.getElementById("ed-category").value || null,
      active: subject ? subject.active : true,
    };
    try {
      if (subject) await api(`/guilds/${currentGuild.id}/subjects/${subject.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api(`/guilds/${currentGuild.id}/subjects`, { method: "POST", body: JSON.stringify(payload) });
      slot.innerHTML = "";
      await refreshSubjects();
    } catch { alert("Couldn't save — is bot.js running?"); }
  });
}

// ============================================================
// Panels module
// ============================================================
async function renderPanels(root) {
  root.innerHTML = `
    <div class="dash-header"><div><h1>Panels</h1><p>The message members click to open a ticket. Preview reflects your active subjects.</p></div></div>
    <div id="panels-body">${loadingBlock()}</div>`;
  const body = document.getElementById("panels-body");
  if (!botInfoCache) { body.innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Local bot is offline.</div>`; return; }

  await loadMetaIfNeeded();
  try {
    const data = await api(`/guilds/${currentGuild.id}/subjects`);
    subjectsCache = data.subjects || [];
  } catch { subjectsCache = []; }

  const active = subjectsCache.filter(s => s.active);
  const channelOptions = (metaCache?.channels || []).map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join("");

  body.innerHTML = `
    <div class="panel-preview">
      <div class="panel-preview-embed">
        <div class="panel-preview-title">Need help?</div>
        <div class="panel-preview-desc">Pick a subject below to open a private support ticket.</div>
      </div>
      <div class="panel-preview-select" style="margin-top:10px">
        ${active.length ? `Select an option… (${active.length} subject${active.length === 1 ? "" : "s"}: ${active.map(s => escapeHtml(s.name)).join(", ")})` : "No active subjects — add one first"}
      </div>
    </div>
    <div class="config-section" style="max-width:520px">
      <h3>Post this panel</h3>
      <div class="hint">Sends the panel above to a channel right now.</div>
      <div class="field"><label>Channel</label><select id="panel-channel">${channelOptions}</select></div>
      <button class="btn btn-primary btn-small" id="btn-post-panel" ${active.length ? "" : "disabled"}><i class="ti ti-send"></i> Post panel</button>
    </div>`;

  document.getElementById("btn-post-panel")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-post-panel");
    const channelId = document.getElementById("panel-channel").value;
    btn.textContent = "Posting…";
    try {
      await api(`/guilds/${currentGuild.id}/panel/post`, { method: "POST", body: JSON.stringify({ channelId }) });
      btn.innerHTML = `<i class="ti ti-check"></i> Posted`;
    } catch { btn.textContent = "Failed — check bot.js"; }
    setTimeout(() => { btn.innerHTML = `<i class="ti ti-send"></i> Post panel`; }, 2200);
  });
}

// ============================================================
// Settings module (ticket channel, category, support role, log channel)
// ============================================================
async function renderSettings(root) {
  root.innerHTML = `<div class="dash-header"><div><h1>Server settings</h1><p>Where tickets get created and who can see them.</p></div></div><div id="settings-body">${loadingBlock()}</div>`;
  const body = document.getElementById("settings-body");
  if (!botInfoCache) { body.innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Local bot is offline.</div>`; return; }

  await loadMetaIfNeeded();
  let cfg = {};
  try { cfg = await api(`/guilds/${currentGuild.id}/config`); } catch {}

  const channelOpts = (metaCache?.channels || []).map(c => `<option value="${c.id}" ${cfg.ticketChannel === c.id ? "selected" : ""}>#${escapeHtml(c.name)}</option>`).join("");
  const categoryOpts = (metaCache?.categories || []).map(c => `<option value="${c.id}" ${cfg.ticketCategory === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  const roleOpts = (metaCache?.roles || []).map(r => `<option value="${r.id}" ${cfg.supportRole === r.id ? "selected" : ""}>@${escapeHtml(r.name)}</option>`).join("");
  const logOpts = (metaCache?.channels || []).map(c => `<option value="${c.id}" ${cfg.logChannel === c.id ? "selected" : ""}>#${escapeHtml(c.name)}</option>`).join("");

  body.innerHTML = `
    <div class="config-section">
      <h3>Ticket category</h3><div class="hint">New ticket channels are created under this category.</div>
      <div class="config-row"><span class="config-row-label">Category</span><select id="cfg-category"><option value="">None</option>${categoryOpts}</select></div>
    </div>
    <div class="config-section">
      <h3>Support role</h3><div class="hint">This role can view and respond to tickets.</div>
      <div class="config-row"><span class="config-row-label">Role</span><select id="cfg-role"><option value="">None</option>${roleOpts}</select></div>
    </div>
    <div class="config-section">
      <h3>Log channel</h3><div class="hint">When a ticket closes, a summary is posted here.</div>
      <div class="config-row"><span class="config-row-label">Channel</span><select id="cfg-log"><option value="">Disabled</option>${logOpts}</select></div>
    </div>
    <div class="config-section">
      <h3>Fallback ticket channel</h3><div class="hint">Legacy single-channel mode, unused if you're using Panels.</div>
      <div class="config-row"><span class="config-row-label">Channel</span><select id="cfg-channel"><option value="">None</option>${channelOpts}</select></div>
    </div>
    <button class="btn btn-primary btn-small" id="btn-save-settings">Save changes</button>`;

  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-settings");
    btn.textContent = "Saving…";
    try {
      await api(`/guilds/${currentGuild.id}/config`, {
        method: "POST",
        body: JSON.stringify({
          ticketChannel: document.getElementById("cfg-channel").value || null,
          ticketCategory: document.getElementById("cfg-category").value || null,
          supportRole: document.getElementById("cfg-role").value || null,
          logChannel: document.getElementById("cfg-log").value || null,
        }),
      });
      btn.innerHTML = `<i class="ti ti-check"></i> Saved`;
    } catch { btn.textContent = "Failed — is bot.js running?"; }
    setTimeout(() => { btn.textContent = "Save changes"; }, 2200);
  });
}

// ============================================================
// Status module
// ============================================================
async function renderStatusModule(root) {
  await refreshHeroStatus();
  root.innerHTML = `
    <div class="dash-header"><div><h1>Status</h1><p>Live connection to your locally hosted bot.</p></div></div>
    <div class="config-section">
      <div class="config-row"><span class="config-row-label">Bot process</span><span class="status-pip ${botInfoCache?.online ? "online" : "offline"}"><span class="status-dot"></span>${botInfoCache?.online ? "Online" : "Offline"}</span></div>
      <div class="config-row"><span class="config-row-label">Bot tag</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${escapeHtml(botInfoCache?.botTag || "—")}</span></div>
      <div class="config-row"><span class="config-row-label">Uptime</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${formatUptime(botInfoCache?.uptimeSeconds)}</span></div>
      <div class="config-row"><span class="config-row-label">Guilds connected</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${botInfoCache?.guildCount ?? "—"}</span></div>
      <div class="config-row"><span class="config-row-label">Bridge URL</span><span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${CFG.LOCAL_BOT_URL}</span></div>
    </div>`;
}

// ============================================================
// Wiring
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-login").addEventListener("click", (e) => { e.preventDefault(); beginLogin(); });
  document.getElementById("btn-invite").addEventListener("click", (e) => { e.preventDefault(); window.open(inviteUrl(), "_blank"); });
  document.getElementById("btn-logout").addEventListener("click", () => { clearSession(); routes.go("/", true); showScreen("screen-landing"); });
  document.getElementById("btn-logout2").addEventListener("click", () => { clearSession(); routes.go("/", true); showScreen("screen-landing"); });
  document.getElementById("btn-back").addEventListener("click", () => {
    if (window.location.pathname.includes("/servers/")) { routes.go("/dashboard"); enterPicker(); }
    else window.history.back();
  });
  document.getElementById("btn-theme-picker").addEventListener("click", toggleTheme);
  document.getElementById("btn-theme-dash").addEventListener("click", toggleTheme);

  document.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", () => switchPanel(n.dataset.panel)));

  boot();
  setInterval(refreshHeroStatus, 15000);
});

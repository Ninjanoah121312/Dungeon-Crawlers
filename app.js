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
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch { /* body wasn't JSON */ }
    throw new Error(detail || `Request failed: ${res.status}`);
  }
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
  else { el.classList.add("offline"); el.innerHTML = `<span class="status-dot"></span>Bot Servers down`; }
}
function renderLocalBanner(slotId, botInfo) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  slot.innerHTML = botInfo
    ? `<div class="local-banner ok"><i class="ti ti-check"></i> Bot Servers online</div>`
    : `<div class="local-banner"><i class="ti ti-alert-triangle"></i> Bot Servers down — tickets, subjects, and config can't load right now.</div>`;
}

// ============================================================
// Global state
// ============================================================
let botInfoCache = null;
let currentGuild = null;   // { id, name, icon }
let ticketsCache = [];

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
  set("hero-bot-url", info?.online ? "Online" : "Down");
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
    // bot-joined servers first, alphabetical within each group
    const sorted = [...admin].sort((a, b) => {
      const aHas = botGuildIds.has(a.id), bHas = botGuildIds.has(b.id);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    grid.innerHTML = sorted.map(g => {
      const hasBot = botGuildIds.has(g.id);
      const iconHtml = g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">` : initials(g.name);
      const roleBadge = g.owner ? `<span class="role-badge owner"><i class="ti ti-crown"></i> Owner</span>` : `<span class="role-badge admin"><i class="ti ti-shield"></i> Admin</span>`;
      return `
        <div class="server-card ${hasBot ? "" : "bot-absent"}">
          <div class="server-icon">${iconHtml}</div>
          <div class="server-name">${escapeHtml(g.name)}</div>
          <div class="server-meta">${roleBadge} ${hasBot ? "" : "· Bot not added"}</div>
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
const CORE_PANELS = [
  { id: "overview", label: "Overview", icon: "ti-home" },
  { id: "insights", label: "Insights", icon: "ti-chart-bar" },
  { id: "status", label: "Status", icon: "ti-activity" },
];

let modulesLoaded = false;
let modulesLoadFailed = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(s);
  });
}

// Module code lives entirely on your local bot (bot/Modules/), not in
// this repo — the site fetches the manifest, then each file, at
// runtime. If the bot isn't running, modules simply won't appear;
// the dashboard still works for Overview/Insights/Status.
async function ensureModulesLoaded() {
  if (modulesLoaded || modulesLoadFailed) return;
  try {
    const manifest = await api("/modules");
    for (const file of manifest.shared || []) await loadScript(`${CFG.LOCAL_BOT_URL}/modules-static/${file}`);
    for (const file of manifest.modules || []) await loadScript(`${CFG.LOCAL_BOT_URL}/modules-static/${file}`);
    modulesLoaded = true;
  } catch {
    modulesLoadFailed = true; // Bot Servers down, or Modules/ is empty — dashboard still works without extra modules
  }
}

function buildContext() {
  const session = getSession();
  return {
    guildId: currentGuild.id,
    userId: session?.user?.id,
    api: (path, options) => api(path, options),
  };
}

function navItemHtml(id, icon, label) {
  return `<div class="nav-item" data-panel="${id}"><i class="ti ${icon}" aria-hidden="true"></i>${label}</div>`;
}

function buildSidebar() {
  const wrap = document.getElementById("dash-nav-items");
  const modules = window.DC?.modules || [];

  const modulesHtml = modules.length
    ? `<div class="nav-section-label">Modules</div>${modules.map(m => navItemHtml(m.id, m.icon, m.label)).join("")}`
    : "";
  const generalHtml = `<div class="nav-section-label">General</div>${CORE_PANELS.map(p => navItemHtml(p.id, p.icon, p.label)).join("")}`;

  wrap.innerHTML = modulesHtml + generalHtml;
  wrap.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", () => switchPanel(n.dataset.panel)));
}

async function enterDashboard(panel) {
  showScreen("screen-dashboard");
  const session = getSession();
  document.getElementById("dash-user-chip").innerHTML = `<img src="${avatarUrl(session.user)}" alt=""> ${escapeHtml(session.user.username)}`;

  await refreshHeroStatus();
  renderLocalBanner("local-banner-slot-dash", botInfoCache);
  if (botInfoCache) await ensureModulesLoaded();
  buildSidebar();

  if (!currentGuild.name && botInfoCache) {
    const found = (botInfoCache.guilds || []).find(g => g.id === currentGuild.id);
    if (found) currentGuild = { id: found.id, name: found.name, icon: found.icon };
  }
  document.getElementById("dash-server-name").textContent = currentGuild.name || "Server";
  document.getElementById("dash-server-icon").innerHTML = currentGuild.icon
    ? `<img src="https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png" alt="">`
    : initials(currentGuild.name || "S");
  document.getElementById("dash-crumb").innerHTML = `Servers <i class="ti ti-chevron-right" style="font-size:12px"></i> <b>${escapeHtml(currentGuild.name || "…")}</b>`;

  // resolve viewer's role (owner/admin) via bot meta, once we know the guild
  const sub = document.getElementById("dash-server-sub");
  if (botInfoCache) {
    const meta = await api(`/guilds/${currentGuild.id}/meta?userId=${session.user.id}`).catch(() => null);
    if (meta?.viewerRole) {
      sub.innerHTML = meta.viewerRole === "owner" ? `<span class="role-badge owner"><i class="ti ti-crown"></i> Owner</span>` : `<span class="role-badge admin"><i class="ti ti-shield"></i> Admin</span>`;
    } else {
      sub.textContent = "Connected";
    }
  } else {
    sub.textContent = "Bot Servers down";
  }

  switchPanel(panel, false);
}

function switchPanel(name, updateUrl = true) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === name));
  if (updateUrl) routes.go(`/servers/${currentGuild.id}/${name}`);
  const root = document.getElementById("module-root");
  root.innerHTML = loadingBlock();

  const mod = window.DC?.getModule(name);
  if (mod) { mod.render(root, buildContext()); return; }

  const renderers = { overview: renderOverview, insights: renderInsights, status: renderStatusModule };
  (renderers[name] || renderOverview)(root);
}

// ============================================================
// Overview module
// ============================================================
async function renderOverview(root) {
  root.innerHTML = `
    <div class="dash-header"><div><h1>Overview</h1><p>Live status from your locally hosted bot.</p></div></div>
    <div class="overview-grid">      <div class="overview-card"><div class="num" id="ov-open">—</div><div class="lbl">Open tickets</div></div>
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
// Insights module
// ============================================================
async function renderInsights(root) {
  root.innerHTML = `<div class="dash-header"><div><h1>Insights</h1><p>Ticket activity for this server.</p></div></div><div id="insights-body">${loadingBlock()}</div>`;
  const body = document.getElementById("insights-body");
  if (!botInfoCache) { body.innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Bot Servers down.</div>`; return; }
  let tickets = [];
  try { const d = await api(`/guilds/${currentGuild.id}/tickets`); tickets = d.tickets || []; } catch { tickets = []; }
  const total = tickets.length;
  const open = tickets.filter(t => t.status === "open").length;
  const closed = tickets.filter(t => t.status === "closed").length;
  const bySubject = {};
  tickets.forEach(t => { const k = t.subject || "General"; bySubject[k] = (bySubject[k] || 0) + 1; });
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

  boot();
  setInterval(async () => {
    const wasOnline = botInfoCache?.online;
    await refreshHeroStatus();
    // if the bot just came back up while a dashboard is open, load
    // modules and rebuild the sidebar so newly-available modules appear
    if (!wasOnline && botInfoCache?.online && document.getElementById("screen-dashboard").classList.contains("active")) {
      await ensureModulesLoaded();
      buildSidebar();
    }
  }, 15000);
});

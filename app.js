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
    if (parts[0] === "dashboard") return { screen: "picker", panel: "dashboard" };
    if (parts[0] === "my-tickets") return { screen: "picker", panel: "my-tickets" };
    if (parts[0] === "premium") return { screen: "picker", panel: "premium" };
    if (parts[0] === "admin") return { screen: "picker", panel: "admin" };
    if (parts[0] === "status") return { screen: "status" };
    if (parts[0] === "servers" && parts[1]) return { screen: "dashboard", guildId: parts[1], panel: parts[2] || "ticket-tool" };
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
  // Quick tunnels (trycloudflare.com) add real latency, especially right
  // after they spin up — 2.5s was too tight and made a perfectly-online
  // bot look down. Try /status first (this is the real check — it's the
  // endpoint that returns bot info); if that fails, fall back to a bare
  // root request purely to tell "bot unreachable" apart from "bot is up
  // but /status itself errored", which is a more useful failure signal.
  try {
    const res = await fetch(`${CFG.LOCAL_BOT_URL}/status`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch { /* fall through to root check below */ }

  try {
    await fetch(`${CFG.LOCAL_BOT_URL}/`, { signal: AbortSignal.timeout(8000) });
    // Root responds (even a 404 means the server answered) but /status
    // didn't — the tunnel/bot process is reachable, just not healthy.
    return null;
  } catch {
    return null; // truly unreachable: tunnel down, bot down, or DNS/CORS issue
  }
}
async function api(path, options = {}) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const text = await res.text();
      try { detail = JSON.parse(text).error || text; } catch { detail = text; }
    } catch { /* couldn't even read the body */ }
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

// Shared bottom-of-sidebar block used by both the picker screen and the
// per-server dashboard: a Status link, a light/dark switch, and the
// logged-in user's profile chip which opens a small Profile/Log out menu
// on click (matches the reference screenshot's popup).
function renderSidebarBottom(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  const session = getSession();
  const isDark = document.body.getAttribute("data-theme") !== "light";
  slot.innerHTML = `
    <div class="sidebar-bottom">
      <a href="#" class="nav-item sb-status-link"><i class="ti ti-activity"></i> Status</a>
      <div class="sidebar-theme-row">
        <span><i class="ti ${isDark ? "ti-moon" : "ti-sun"}"></i> ${isDark ? "Dark" : "Light"} mode</span>
        <button class="toggle sb-theme-toggle ${isDark ? "on" : ""}" aria-label="Toggle theme"></button>
      </div>
      <div class="sidebar-profile sb-profile-trigger">
        <img class="sidebar-profile-avatar" src="${avatarUrl(session.user)}" alt="">
        <div class="sidebar-profile-name">${escapeHtml(session.user.username)}</div>
        <i class="ti ti-chevron-up" style="margin-left:auto;color:var(--text-dim);font-size:14px"></i>
      </div>
      <div class="sidebar-profile-menu sb-profile-menu" style="display:none">
        <div class="sidebar-profile-menu-header">
          <img class="sidebar-profile-avatar" src="${avatarUrl(session.user)}" alt="">
          <div><div class="sidebar-profile-name">${escapeHtml(session.user.username)}</div><div class="field-hint" style="margin-top:1px">@${escapeHtml(session.user.username)}</div></div>
        </div>
        <button class="kebab-menu-item sb-profile-btn"><i class="ti ti-user-circle"></i> Profile</button>
        <button class="kebab-menu-item sb-admin-panel-btn" style="display:none"><i class="ti ti-shield-lock"></i> Admin Panel</button>
        <button class="kebab-menu-item danger sb-logout-btn"><i class="ti ti-logout"></i> Log out</button>
      </div>
    </div>`;

  // Admin Panel entry only shows for the bot owner or someone already
  // granted admin access — checked against the server, never guessed
  // client-side, so a random Discord account never even sees the option.
  maybeShowAdminPanelButton(slot);

  // Every query below is scoped to `slot`, not the whole document — three
  // screens (picker/dashboard/status) each have their own sidebar-bottom
  // container present in the DOM at the same time (only one is ever
  // visible via the .active class), so a global getElementById/querySelector
  // here would always resolve to whichever screen's copy rendered first
  // and silently wire up listeners on the wrong, invisible one. That was
  // the actual cause of "the Status link / theme toggle / profile menu
  // don't react" — the visible screen's buttons had no listeners at all.
  const statusLink = slot.querySelector(".sb-status-link");
  const themeToggle = slot.querySelector(".sb-theme-toggle");
  const menu = slot.querySelector(".sb-profile-menu");
  const trigger = slot.querySelector(".sb-profile-trigger");
  const profileBtn = slot.querySelector(".sb-profile-btn");
  const logoutBtn = slot.querySelector(".sb-logout-btn");
  const adminPanelBtn = slot.querySelector(".sb-admin-panel-btn");

  statusLink.addEventListener("click", (e) => { e.preventDefault(); enterStatusPage(); });
  themeToggle.addEventListener("click", (e) => {
    toggleTheme();
    e.currentTarget.classList.toggle("on");
    const isDarkNow = document.body.getAttribute("data-theme") !== "light";
    slot.querySelector(".sidebar-theme-row span").innerHTML = `<i class="ti ${isDarkNow ? "ti-moon" : "ti-sun"}"></i> ${isDarkNow ? "Dark" : "Light"} mode`;
  });
  function closeMenuOnOutsideClick(e) {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) {
      menu.style.display = "none";
      document.removeEventListener("click", closeMenuOnOutsideClick, true);
    }
  }
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display !== "none";
    if (isOpen) {
      menu.style.display = "none";
      document.removeEventListener("click", closeMenuOnOutsideClick, true);
    } else {
      menu.style.display = "block";
      // Attached only now, and only for this open menu instance — never
      // fires on a click that happened before the menu was actually open,
      // which was previously eating the first click on anything else in
      // the sidebar (theme toggle, Status link) instead of the menu.
      document.addEventListener("click", closeMenuOnOutsideClick, true);
    }
  });
  logoutBtn.addEventListener("click", () => { clearSession(); routes.go("/", true); showScreen("screen-landing"); });
  profileBtn.addEventListener("click", () => { menu.style.display = "none"; /* no dedicated profile page yet */ });
  adminPanelBtn.addEventListener("click", () => {
    menu.style.display = "none";
    pickerActivePanel = "admin";
    routes.go("/admin");
    enterPicker("admin");
  });
}

// Whether the currently logged-in Discord account is allowed into the
// Admin Panel at all (bot owner, or already granted access). This is a
// UI convenience only — every actual admin route still re-checks server-
// side, so hiding/showing this button is never itself a security boundary.
let adminEligibilityCache = null;
async function maybeShowAdminPanelButton(slot) {
  const btn = slot.querySelector(".sb-admin-panel-btn");
  if (!btn) return;
  const session = getSession();
  if (!session?.user?.id) return;
  if (adminEligibilityCache === null) {
    try {
      const result = await api(`/admin/eligibility?discordUserId=${session.user.id}`);
      adminEligibilityCache = Boolean(result.eligible);
    } catch { adminEligibilityCache = false; }
  }
  if (adminEligibilityCache) btn.style.display = "flex";
}

async function enterStatusPage() {
  showScreen("screen-status");
  renderSidebarBottom("status-sidebar-bottom");
  const root = document.getElementById("status-root");
  root.innerHTML = loadingBlock("Loading status…");
  await renderStatusModule(root);
}
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

// ============================================================
// Global state
// ============================================================
let botInfoCache = null;
let currentGuild = null;   // { id, name, icon }
let currentGuildDisabledModules = [];

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
  if (route.screen === "picker") { await enterPicker(route.panel); return; }
  if (route.screen === "status") { await enterStatusPage(); return; }
  if (route.screen === "dashboard") {
    if (!currentGuild || currentGuild.id !== route.guildId) {
      currentGuild = { id: route.guildId, name: null, icon: null };
    }
    await enterDashboard(route.panel || "ticket-tool");
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
let pickerActivePanel = "dashboard";

async function enterPicker(panel) {
  showScreen("screen-picker");
  pickerActivePanel = panel || pickerActivePanel || "dashboard";
  renderSidebarBottom("picker-sidebar-bottom");
  await refreshHeroStatus();
  paintPickerNav();
  await renderPickerPanel(pickerActivePanel);

  document.querySelectorAll("#picker-sidebar [data-picker-panel]").forEach(el => {
    el.addEventListener("click", () => {
      pickerActivePanel = el.dataset.pickerPanel;
      routes.go(pickerActivePanel === "dashboard" ? "/" : `/${pickerActivePanel}`);
      paintPickerNav();
      renderPickerPanel(pickerActivePanel);
    });
  });
}

function paintPickerNav() {
  document.querySelectorAll("#picker-sidebar [data-picker-panel]").forEach(el => {
    el.classList.toggle("active", el.dataset.pickerPanel === pickerActivePanel);
  });
}

async function renderPickerPanel(panel) {
  const root = document.getElementById("picker-panel-root");
  if (panel === "my-tickets") return renderMyTicketsPanel(root);
  if (panel === "premium") return renderPremiumPanel(root);
  if (panel === "admin") return renderAdminPanel(root);
  return renderDashboardPanel(root);
}

async function renderDashboardPanel(root) {
  root.innerHTML = `
    <h1 class="picker-heading">Your servers</h1>
    <p class="picker-sub">Servers where you have Administrator permissions.</p>
    <div class="server-grid" id="server-grid">${loadingBlock("Loading your servers…")}</div>`;
  const grid = document.getElementById("server-grid");
  const session = getSession();

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
        routes.go(`/servers/${currentGuild.id}/ticket-tool`);
        enterDashboard("ticket-tool");
      });
    });
  } catch {
    grid.innerHTML = `<div class="empty-state">Couldn't load your servers. Try logging in again.</div>`;
  }
}

function renderPremiumPanel(root) {
  root.innerHTML = `
    <h1 class="picker-heading">Premium</h1>
    <p class="picker-sub">Unlock higher limits and advanced features across every server.</p>
    <div class="empty-state"><i class="ti ti-crown glyph"></i>Premium plans aren't set up yet — check back soon.</div>`;
}

// ============================================================
// Admin panel — separate auth layer (username/password against .env,
// gated further by Discord user id) for controlling which guilds are
// allowed to use the tool and who else can manage that.
// ============================================================
const ADMIN_TOKEN_KEY = "tk_admin_token";
function getAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY); }
function setAdminToken(t) { t ? localStorage.setItem(ADMIN_TOKEN_KEY, t) : localStorage.removeItem(ADMIN_TOKEN_KEY); }
async function adminApi(path, options = {}) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Admin-Token": getAdminToken() || "", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) { setAdminToken(null); throw new Error("Session expired — please log in again"); }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error; } catch {}
    throw new Error(detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function renderAdminPanel(root) {
  root.innerHTML = `<h1 class="picker-heading">Admin Panel</h1><p class="picker-sub">Loading…</p>`;
  if (!botInfoCache) {
    root.innerHTML = `<h1 class="picker-heading">Admin Panel</h1><div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Bot Servers down — the admin panel needs a live connection.</div>`;
    return;
  }
  const token = getAdminToken();
  if (!token) { paintAdminLogin(root); return; }
  try {
    const session = await adminApi("/admin/session");
    paintAdminDashboard(root, session);
  } catch {
    paintAdminLogin(root);
  }
}

function paintAdminLogin(root) {
  root.innerHTML = `
    <h1 class="picker-heading">Admin Panel</h1>
    <p class="picker-sub">Sign in with the shared admin credentials. Your Discord account also needs to be granted access.</p>
    <div class="config-section" style="max-width:380px">
      <div class="field"><label>Username</label><input type="text" id="admin-username" autocomplete="username" placeholder="Username"></div>
      <div class="field"><label>Password</label><input type="text" id="admin-password" autocomplete="username" placeholder="Password" class="admin-password-as-username"></div>
      <div class="field-hint" id="admin-login-error" style="color:var(--red);display:none"></div>
      <button class="btn btn-primary btn-small" id="admin-login-btn" style="margin-top:6px">Log in</button>
    </div>`;
  document.getElementById("admin-login-btn").addEventListener("click", async () => {
    const username = document.getElementById("admin-username").value.trim();
    const password = document.getElementById("admin-password").value;
    const errEl = document.getElementById("admin-login-error");
    errEl.style.display = "none";
    try {
      const session = getSession();
      const loginResult = await adminApi("/admin/login", { method: "POST", body: JSON.stringify({ username, password, discordUserId: session.user.id }) });
      setAdminToken(loginResult.token);
      renderAdminPanel(document.getElementById("picker-panel-root"));
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = "block";
    }
  });
}

async function paintAdminDashboard(root, session) {
  root.innerHTML = `
    <div class="dash-header">
      <div><h1 class="picker-heading">Admin Panel</h1><p class="picker-sub">${session.isOwner ? "Signed in as the bot owner." : "Signed in with granted admin access."}</p></div>
      <button class="btn btn-ghost btn-small" id="admin-logout-btn"><i class="ti ti-logout"></i> Log out</button>
    </div>
    <div class="config-section">
      <h3>Allowed servers</h3>
      <div class="hint">Only servers in this list can use the ticket tool. Leave empty to allow every server the bot is in (default, until you add the first one).</div>
      <div id="admin-guilds-list">${loadingBlock()}</div>
    </div>
    ${session.isOwner ? `
    <div class="config-section" style="margin-top:18px">
      <h3>Granted admins</h3>
      <div class="hint">Discord user ids that can log into this panel, in addition to you as the owner.</div>
      <div class="field-row-inline" style="margin-bottom:10px">
        <input type="text" id="admin-add-userid" placeholder="Discord user id" style="flex:1">
        <button class="btn btn-primary btn-small" id="admin-add-btn">Grant access</button>
      </div>
      <div id="admin-admins-list">${loadingBlock()}</div>
    </div>` : ""}`;

  document.getElementById("admin-logout-btn").addEventListener("click", async () => {
    try { await adminApi("/admin/logout", { method: "POST" }); } catch {}
    setAdminToken(null);
    renderAdminPanel(root);
  });

  await paintAdminGuildsList();
  if (session.isOwner) await paintAdminAdminsList();
}

async function paintAdminGuildsList() {
  const slot = document.getElementById("admin-guilds-list");
  try {
    const guildsResult = await adminApi("/admin/guilds");
    const allowedGuildIds = guildsResult.allowedGuildIds;
    const knownGuilds = guildsResult.knownGuilds;
    // Empty allow-list means "every server is allowed" (fail-open default),
    // not "every server is individually toggled on" — those are different
    // states. Toggling a switch off in that mode should add every OTHER
    // known server to the list (so the one just switched off is excluded
    // while everything else keeps working), rather than adding just the
    // one clicked, which would silently flip into allow-list mode and lock
    // out every other server nobody touched.
    const noRestriction = allowedGuildIds.length === 0;
    if (knownGuilds.length === 0) { slot.innerHTML = `<div class="empty-state">The bot isn't in any servers yet.</div>`; return; }
    slot.innerHTML = `
      ${noRestriction ? `<div class="field-hint" style="margin-bottom:10px"><i class="ti ti-info-circle"></i> No restriction is active — every server below is currently allowed. Turning one off will switch to an explicit allow-list.</div>` : ""}
      ${knownGuilds.map(g => `
      <div class="config-row">
        <span class="config-row-label" style="display:flex;align-items:center;gap:8px">
          ${g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" style="width:22px;height:22px;border-radius:6px" alt="">` : `<span class="server-icon" style="width:22px;height:22px;font-size:9px;margin:0">${initials(g.name)}</span>`}
          ${escapeHtml(g.name)}
        </span>
        <button class="toggle ${noRestriction || allowedGuildIds.includes(g.id) ? "on" : ""}" data-guild-toggle="${g.id}" aria-label="Toggle ${g.name}"></button>
      </div>`).join("")}`;
    slot.querySelectorAll("[data-guild-toggle]").forEach(btn => btn.addEventListener("click", async () => {
      const guildId = btn.dataset.guildToggle;
      const isAllowing = !btn.classList.contains("on");
      try {
        if (noRestriction && !isAllowing) {
          // Switching one off while nothing was restricted yet: build the
          // explicit allow-list as "every known server except this one".
          const others = knownGuilds.map(g => g.id).filter(id => id !== guildId);
          for (const id of others) await adminApi("/admin/guilds", { method: "POST", body: JSON.stringify({ guildId: id }) });
        } else if (isAllowing) {
          await adminApi("/admin/guilds", { method: "POST", body: JSON.stringify({ guildId }) });
        } else {
          await adminApi(`/admin/guilds/${guildId}`, { method: "DELETE" });
        }
        await paintAdminGuildsList();
      } catch (e) { alert(`Couldn't update: ${e.message}`); }
    }));
  } catch (e) {
    slot.innerHTML = `<div class="empty-state">Couldn't load servers: ${escapeHtml(e.message)}</div>`;
  }
}

async function paintAdminAdminsList() {
  const slot = document.getElementById("admin-admins-list");
  const addBtn = document.getElementById("admin-add-btn");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const input = document.getElementById("admin-add-userid");
    const userId = input.value.trim();
    if (!userId) return;
    try { await adminApi("/admin/admins", { method: "POST", body: JSON.stringify({ userId }) }); input.value = ""; await paintAdminAdminsList(); }
    catch (e) { alert(`Couldn't grant access: ${e.message}`); }
  });
  try {
    const adminsResult = await adminApi("/admin/admins");
    const ownerUserId = adminsResult.ownerUserId;
    const grantedUserIds = adminsResult.grantedUserIds;
    const profiles = adminsResult.profiles || {};
    const rowHtml = (id, isOwner) => {
      const p = profiles[id] || { displayName: id, avatarUrl: null };
      return `
        <div class="config-row">
          <span class="config-row-label" style="display:flex;align-items:center;gap:8px">
            <img src="${p.avatarUrl || `https://cdn.discordapp.com/embed/avatars/0.png`}" alt="" style="width:26px;height:26px;border-radius:50%;border:1px solid var(--panel-border)">
            <span>${escapeHtml(p.displayName)}<div class="field-hint" style="margin-top:1px">${escapeHtml(id)}</div></span>
          </span>
          ${isOwner ? `<span class="badge badge-open">Owner</span>` : `<button class="btn btn-ghost btn-small" data-revoke-admin="${id}"><i class="ti ti-x"></i> Revoke</button>`}
        </div>`;
    };
    slot.innerHTML = rowHtml(ownerUserId, true) + grantedUserIds.map(id => rowHtml(id, false)).join("");
    slot.querySelectorAll("[data-revoke-admin]").forEach(btn => btn.addEventListener("click", async () => {
      try { await adminApi(`/admin/admins/${btn.dataset.revokeAdmin}`, { method: "DELETE" }); await paintAdminAdminsList(); }
      catch (e) { alert(`Couldn't revoke: ${e.message}`); }
    }));
  } catch (e) {
    slot.innerHTML = `<div class="empty-state">Couldn't load admins: ${escapeHtml(e.message)}</div>`;
  }
}


// ============================================================
// My Tickets — every ticket the logged-in user has personally
// opened, across every server the bot is in (not just servers
// they administer).
// ============================================================
async function renderMyTicketsPanel(root) {
  root.innerHTML = `
    <h1 class="picker-heading">My Tickets</h1>
    <p class="picker-sub" id="my-tickets-count">Loading…</p>
    <div class="ticket-toolbar">
      <input type="text" class="search-input" id="mt-search" placeholder="Search tickets…">
    </div>
    <div id="my-tickets-list">${loadingBlock()}</div>`;

  const session = getSession();
  let tickets = [];
  try {
    const d = await api(`/tickets?userId=${session.user.id}`);
    tickets = d.tickets || [];
  } catch {
    document.getElementById("my-tickets-list").innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Couldn't load your tickets — Bot Servers down.</div>`;
    document.getElementById("my-tickets-count").textContent = "";
    return;
  }
  document.getElementById("my-tickets-count").textContent = `~${tickets.length} ticket${tickets.length === 1 ? "" : "s"} found`;
  paintMyTicketsList(tickets, "");
  document.getElementById("mt-search").addEventListener("input", (e) => paintMyTicketsList(tickets, e.target.value));
}

function paintMyTicketsList(tickets, query) {
  const list = document.getElementById("my-tickets-list");
  let rows = tickets;
  if (query) {
    const q = query.toLowerCase();
    rows = rows.filter(t => (t.subject || "").toLowerCase().includes(q) || (t.guildName || "").toLowerCase().includes(q));
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-ticket-off glyph"></i>${tickets.length === 0 ? "You haven't opened any tickets yet." : "No tickets match."}</div>`;
    return;
  }
  list.innerHTML = `
    <div class="ticket-table">
      <div class="ticket-row head"><span>Server</span><span>Subject</span><span class="col-created">Created</span><span>Status</span></div>
      ${rows.map(t => `
        <div class="ticket-row ticket-row-clickable" data-my-ticket="${t.guildId}:${t.id}">
          <span style="display:flex;align-items:center;gap:8px">${t.guildIcon ? `<img src="https://cdn.discordapp.com/icons/${t.guildId}/${t.guildIcon}.png" style="width:20px;height:20px;border-radius:6px" alt="">` : `<span class="server-icon" style="width:20px;height:20px;font-size:9px;margin:0">${initials(t.guildName || "?")}</span>`} ${escapeHtml(t.guildName || "Unknown server")}</span>
          <span>${escapeHtml(t.subject || "No subject")}</span>
          <span class="col-created">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</span>
          <span class="badge badge-${t.status}">${t.status}</span>
        </div>`).join("")}
    </div>
    <div id="my-ticket-detail-slot"></div>`;
  list.querySelectorAll("[data-my-ticket]").forEach(row => row.addEventListener("click", () => {
    const [guildId, ticketId] = row.dataset.myTicket.split(":");
    openMyTicketDetail(guildId, ticketId, tickets);
  }));
}

async function openMyTicketDetail(guildId, ticketId, tickets) {
  const root = document.getElementById("picker-panel-root");
  root.innerHTML = `
    <button class="btn btn-ghost btn-small" id="mt-back"><i class="ti ti-arrow-left"></i> Back to Tickets</button>
    <div id="mt-detail-body" style="margin-top:16px">${loadingBlock("Loading ticket…")}</div>`;
  document.getElementById("mt-back").addEventListener("click", () => renderMyTicketsPanel(root));

  let data;
  try { data = await api(`/guilds/${guildId}/tickets/${ticketId}/transcript`); }
  catch (e) {
    document.getElementById("mt-detail-body").innerHTML = `<div class="empty-state"><i class="ti ti-alert-triangle glyph"></i>Couldn't load this ticket: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const { ticket, messages, hasLog } = data;
  const body = document.getElementById("mt-detail-body");
  body.innerHTML = `
    <div class="modal-panel" style="max-width:900px;max-height:none">
      <div class="transcript-header">
        <div>
          <h3 style="font-size:16px;font-weight:700">${escapeHtml(ticket.subject || "No subject")}</h3>
          <div class="field-hint" style="margin-top:2px">
            <span class="badge badge-${ticket.status}">${ticket.status}</span>
            · ${escapeHtml(ticket.subject || "General")} · Created ${timeAgoGlobal(ticket.createdAt)}
            ${ticket.closedBy ? ` · Closed by ${escapeHtml(ticket.closedBy)}` : ""}
          </div>
        </div>
      </div>
      <div class="transcript-body" style="max-height:60vh">
        ${!hasLog
          ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No message log available for this ticket.</div>`
          : messages.length === 0
            ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No messages were sent in this ticket.</div>`
            : messages.map(m => `
              <div class="transcript-msg ${m.deleted ? "deleted" : ""}">
                <img class="transcript-msg-avatar" src="${m.authorAvatar ? escapeHtml(m.authorAvatar) : "https://cdn.discordapp.com/embed/avatars/0.png"}" alt="">
                <div class="transcript-msg-body">
                  <div class="transcript-msg-meta">
                    <span class="transcript-msg-author">${escapeHtml(m.authorName)}</span>
                    ${m.authorIsStaff ? `<span class="staff-tag">STAFF</span>` : ""}
                    <span class="transcript-msg-time">${new Date(m.createdAt).toLocaleString()}</span>
                    ${m.deleted ? `<span class="transcript-msg-deleted-tag"><i class="ti ti-trash"></i> deleted</span>` : ""}
                  </div>
                  <div class="transcript-msg-content">${escapeHtml(m.content) || `<span class="field-hint">(no text content)</span>`}</div>
                </div>
              </div>`).join("")}
      </div>
    </div>`;
}
function timeAgoGlobal(iso) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

// ============================================================
// Dashboard shell
// ============================================================
const CORE_PANELS = [];

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
function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return; // already injected
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

// Module code lives entirely on your local bot (bot/Modules/<id>/), not
// in this repo — the site fetches the manifest, then each module's JS
// (and CSS, if it has one) at runtime. If the bot isn't running, modules
// simply won't appear; the dashboard still works for Status.
async function ensureModulesLoaded() {
  if (modulesLoaded || modulesLoadFailed) return;
  try {
    const manifest = await api("/modules");
    for (const file of manifest.shared || []) await loadScript(`${CFG.LOCAL_BOT_URL}/modules-static/${file}`);
    for (const mod of manifest.modules || []) {
      if (mod.css) loadStyle(`${CFG.LOCAL_BOT_URL}/modules-static/${mod.css}`);
      if (mod.js) await loadScript(`${CFG.LOCAL_BOT_URL}/modules-static/${mod.js}`);
    }
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

function navItemHtml(id, icon, label, toggleable, isEnabled) {
  const disabledClass = toggleable && !isEnabled ? "module-disabled" : "";
  return `<div class="nav-item ${disabledClass}" data-panel="${id}">
    <i class="ti ${icon}" aria-hidden="true"></i><span class="nav-item-label">${label}</span>
    ${toggleable ? `<button class="toggle nav-item-toggle ${isEnabled ? "on" : ""}" data-module-toggle="${id}" aria-label="Toggle ${label}"></button>` : ""}
  </div>`;
}

function buildSidebar(disabledModules) {
  disabledModules = disabledModules || [];
  const wrap = document.getElementById("dash-nav-items");
  const modules = window.DC?.modules || [];

  // Toggling a module off is purely cosmetic — it never disappears from
  // this list or stops working. The switch just visually greys the label
  // out as a personal "I've turned this off" marker; the module panel
  // stays fully clickable either way.
  const modulesHtml = modules.length
    ? `<div class="nav-section-label">Modules</div>${modules.map(m => navItemHtml(m.id, m.icon, m.label, true, !disabledModules.includes(m.id))).join("")}`
    : "";
  const generalHtml = CORE_PANELS.length ? `<div class="nav-section-label">General</div>${CORE_PANELS.map(p => navItemHtml(p.id, p.icon, p.label, false)).join("")}` : "";

  wrap.innerHTML = modulesHtml + generalHtml;
  wrap.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", (e) => {
    if (e.target.closest("[data-module-toggle]")) return; // the toggle button handles its own click
    switchPanel(n.dataset.panel);
  }));
  wrap.querySelectorAll("[data-module-toggle]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const moduleId = btn.dataset.moduleToggle;
    const turningOn = !btn.classList.contains("on");
    openModuleToggleConfirm(moduleId, turningOn, btn, disabledModules);
  }));
}

function openModuleToggleConfirm(moduleId, turningOn, btn, disabledModules) {
  const label = (window.DC?.modules || []).find(m => m.id === moduleId)?.label || moduleId;
  let overlay = document.getElementById("module-toggle-overlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.id = "module-toggle-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:380px;max-height:none;padding:20px">
      <h3 style="font-size:14.5px;font-weight:700;margin-bottom:8px">${turningOn ? "Turn on" : "Turn off"} ${escapeHtml(label)}?</h3>
      <p class="field-hint" style="margin-bottom:16px">This is just a personal marker — ${escapeHtml(label)} keeps working normally either way, this only changes how it looks in your sidebar.</p>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost btn-small" id="mtc-cancel">Cancel</button>
        <button class="btn btn-primary btn-small" id="mtc-confirm">${turningOn ? "Turn on" : "Turn off"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("mtc-cancel").addEventListener("click", () => overlay.remove());
  document.getElementById("mtc-confirm").addEventListener("click", async () => {
    overlay.remove();
    try {
      await api(`/guilds/${currentGuild.id}/modules/${moduleId}`, { method: "PUT", body: JSON.stringify({ enabled: turningOn }) });
      currentGuildDisabledModules = turningOn ? disabledModules.filter(id => id !== moduleId) : [...disabledModules, moduleId];
      buildSidebar(currentGuildDisabledModules);
    } catch (e2) { alert(`Couldn't update module: ${e2.message}`); }
  });
}

async function enterDashboard(panel) {
  showScreen("screen-dashboard");
  renderSidebarBottom("dash-sidebar-bottom");
  const session = getSession();

  await refreshHeroStatus();
  if (botInfoCache) await ensureModulesLoaded();

  if (!currentGuild.name && botInfoCache) {
    const found = (botInfoCache.guilds || []).find(g => g.id === currentGuild.id);
    if (found) currentGuild = { id: found.id, name: found.name, icon: found.icon };
  }
  document.getElementById("dash-server-name").textContent = currentGuild.name || "Server";
  document.getElementById("dash-server-icon").innerHTML = currentGuild.icon
    ? `<img src="https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png" alt="">`
    : initials(currentGuild.name || "S");
  document.getElementById("dash-crumb").innerHTML = `Servers <i class="ti ti-chevron-right" style="font-size:12px"></i> <b>${escapeHtml(currentGuild.name || "…")}</b>`;

  // resolve viewer's role (owner/admin) and which modules this server has
  // disabled via one shared meta call, once we know the guild
  const sub = document.getElementById("dash-server-sub");
  let guildDisabledModules = [];
  if (botInfoCache) {
    const meta = await api(`/guilds/${currentGuild.id}/meta?userId=${session.user.id}`).catch(() => null);
    guildDisabledModules = meta?.disabledModules || [];
    currentGuildDisabledModules = guildDisabledModules;
    if (meta?.viewerRole) {
      sub.innerHTML = meta.viewerRole === "owner" ? `<span class="role-badge owner"><i class="ti ti-crown"></i> Owner</span>` : `<span class="role-badge admin"><i class="ti ti-shield"></i> Admin</span>`;
    } else {
      sub.textContent = "Connected";
    }
    if (meta && meta.allowed === false) {
      buildSidebar(guildDisabledModules);
      document.getElementById("module-root").innerHTML = `
        <div class="empty-state" style="max-width:520px;margin:40px auto"><i class="ti ti-lock-off glyph"></i>${escapeHtml(meta.notAllowedMessage || "This server isn't authorized to use this tool.")}</div>`;
      return;
    }
  } else {
    sub.textContent = "Bot Servers down";
  }
  buildSidebar(guildDisabledModules);

  switchPanel(panel, false);
}

function switchPanel(name, updateUrl = true) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === name));
  if (updateUrl) routes.go(`/servers/${currentGuild.id}/${name}`);
  const root = document.getElementById("module-root");
  root.innerHTML = loadingBlock();

  const mod = window.DC?.getModule(name);
  if (mod) { mod.render(root, buildContext()); return; }

  const renderers = { status: renderStatusModule };
  (renderers[name] || renderStatusModule)(root);
}

// ============================================================
// Status module
// ============================================================
async function renderStatusModule(root) {
  await refreshHeroStatus();
  root.innerHTML = `<div class="dash-header"><div><h1>Status</h1><p>Uptime history for your locally hosted bot.</p></div></div><div id="status-body">${loadingBlock()}</div>`;
  const body = document.getElementById("status-body");
  if (!botInfoCache) {
    body.innerHTML = `
      <div class="status-banner down"><i class="ti ti-alert-triangle"></i> Bot is currently offline</div>
      <div class="empty-state"><i class="ti ti-plug-connected-x glyph"></i>Can't reach the bot right now — history will still be here once it's back online.</div>`;
    return;
  }
  let history;
  try { history = await api("/status-history"); } catch { history = null; }
  if (!history) {
    body.innerHTML = `<div class="empty-state"><i class="ti ti-alert-triangle glyph"></i>Bot is online, but its history couldn't be loaded.</div>`;
    return;
  }

  const days = buildDayBuckets(history.incidents, 90);
  body.innerHTML = `
    <div class="status-banner ${history.online ? "up" : "down"}"><i class="ti ${history.online ? "ti-circle-check" : "ti-alert-triangle"}"></i> ${history.online ? "All Systems Operational" : "Bot Offline"}</div>
    <div class="status-uptime-card">
      <div class="status-uptime-header">
        <span>Bot process</span>
        <span class="status-pip ${history.online ? "online" : "offline"}"><span class="status-dot"></span>${history.online ? "Operational" : "Down"}</span>
      </div>
      <div class="status-daybar" id="status-daybar">
        ${days.map((d, i) => `<div class="status-day status-day-${d.level}" data-day-idx="${i}"></div>`).join("")}
      </div>
      <div class="status-daybar-footer">
        <span>90 days ago</span>
        <span>${history.uptimePercent}% uptime over 90 days</span>
        <span>Today</span>
      </div>
      <div class="status-day-tooltip" id="status-day-tooltip" style="display:none"></div>
    </div>
    <div class="overview-grid" style="grid-template-columns:repeat(3,1fr);margin-top:18px">
      <div class="overview-card"><div class="num">${formatUptime(history.currentUptimeSeconds)}</div><div class="lbl">Current uptime</div></div>
      <div class="overview-card"><div class="num">${history.uptimePercent}%</div><div class="lbl">Uptime (90 days)</div></div>
      <div class="overview-card"><div class="num">${history.incidents.length}</div><div class="lbl">Recorded incidents</div></div>
    </div>
    <div class="config-section" style="margin-top:18px">
      <h3>Installed modules</h3>
      <div class="hint">Turn modules on or off for this server. Disabling a module hides it from the sidebar without deleting its data.</div>
      <div id="status-modules-list">${loadingBlock()}</div>
    </div>
    <div class="config-section" style="margin-top:18px">
      <h3>Incident history</h3>
      <div class="hint">Unplanned downtime the bot detected on its own restart — a clean shutdown (Ctrl+C) is never logged as an incident.</div>
      ${history.incidents.length === 0
        ? `<div class="empty-state">No downtime recorded.</div>`
        : history.incidents.slice(0, 25).map(i => `
          <div class="config-row" style="align-items:flex-start">
            <span class="config-row-label">${new Date(i.startedAt).toLocaleString()}${i.note ? `<div class="field-hint" style="margin-top:2px;font-weight:400">${escapeHtml(i.note)}</div>` : ""}</span>
            <span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${formatDuration(i.durationSeconds)} downtime</span>
          </div>`).join("")}
    </div>`;

  wireStatusDayTooltips(days);
  if (currentGuild?.id) paintStatusModulesList();
  else document.getElementById("status-modules-list").innerHTML = `<div class="empty-state">Open a server's dashboard first to manage its modules.</div>`;
}

async function paintStatusModulesList() {
  const slot = document.getElementById("status-modules-list");
  if (!slot) return;
  try {
    const meta = await api(`/guilds/${currentGuild.id}/meta?userId=${getSession().user.id}`);
    const disabled = meta.disabledModules || [];
    const modules = window.DC?.modules || [];
    if (modules.length === 0) { slot.innerHTML = `<div class="empty-state">No modules loaded.</div>`; return; }
    slot.innerHTML = modules.map(m => `
      <div class="config-row">
        <span class="config-row-label"><i class="ti ${m.icon}" style="margin-right:8px;color:var(--text-dim)"></i>${escapeHtml(m.label)}</span>
        <span class="badge badge-${disabled.includes(m.id) ? "closed" : "open"}">${disabled.includes(m.id) ? "Off" : "On"}</span>
      </div>`).join("");
  } catch {
    slot.innerHTML = `<div class="empty-state">Couldn't load module list.</div>`;
  }
}

function wireStatusDayTooltips(days) {
  const bar = document.getElementById("status-daybar");
  const tooltip = document.getElementById("status-day-tooltip");
  if (!bar || !tooltip) return;
  bar.querySelectorAll("[data-day-idx]").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const d = days[+el.dataset.dayIdx];
      tooltip.innerHTML = `
        <div class="status-day-tooltip-date">${d.dateLabel}</div>
        ${d.downtimeSeconds > 0 ? `
          <div class="status-day-tooltip-row"><i class="ti ti-alert-triangle" style="color:var(--amber)"></i> ${formatDuration(d.downtimeSeconds)} downtime</div>
          <div class="status-day-tooltip-pct">${d.pctOfDay}% of the day</div>
          ${d.notes.length ? d.notes.map(n => `<div class="status-day-tooltip-note">${escapeHtml(n)}</div>`).join("") : ""}
        ` : `<div class="status-day-tooltip-row ok"><i class="ti ti-check"></i> No downtime recorded</div>`}`;
      const rect = el.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const tooltipWidth = 220; // matches min-width + padding below
      const idealLeft = rect.left - barRect.left + rect.width / 2;
      const clampedLeft = Math.max(tooltipWidth / 2, Math.min(barRect.width - tooltipWidth / 2, idealLeft));
      tooltip.style.left = `${clampedLeft}px`;
      tooltip.style.display = "block";
    });
    el.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
  });
}

function buildDayBuckets(incidents, numDays) {
  const now = new Date();
  const days = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const dayIncidents = incidents.filter(inc => {
      const s = new Date(inc.startedAt), e = new Date(inc.endedAt);
      return s < dayEnd && e > dayStart;
    });
    const downtimeMs = dayIncidents.reduce((sum, inc) => {
      const s = Math.max(new Date(inc.startedAt).getTime(), dayStart.getTime());
      const e = Math.min(new Date(inc.endedAt).getTime(), dayEnd.getTime());
      return sum + Math.max(0, e - s);
    }, 0);
    const pctDown = downtimeMs / 86400000;
    let level = "ok";
    if (dayStart > now) level = "future";
    else if (pctDown > 0.1) level = "major";
    else if (pctDown > 0) level = "minor";
    days.push({
      level,
      dateLabel: dayStart.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
      downtimeSeconds: Math.round(downtimeMs / 1000),
      pctOfDay: Math.round(pctDown * 1000) / 10,
      notes: dayIncidents.filter(inc => inc.note).map(inc => inc.note),
    });
  }
  return days;
}
function formatDuration(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ============================================================
// Wiring
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // Defensive: a mismatch between index.html and app.js (stale deploy of
  // one but not the other, a renamed id, etc.) should never crash the
  // whole boot sequence again — one missing element used to throw here
  // and silently kill every listener after it, including boot() itself,
  // which is exactly why the status pip could get stuck on "Checking..."
  // forever with no visible error on the page.
  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    else console.warn(`Wiring: #${id} not found in the page — skipping its listener. If this persists, index.html and app.js are probably out of sync (redeploy both together).`);
  }

  on("btn-login", "click", (e) => { e.preventDefault(); beginLogin(); });
  on("btn-invite", "click", (e) => { e.preventDefault(); window.open(inviteUrl(), "_blank"); });
  on("btn-logout", "click", () => { clearSession(); routes.go("/", true); showScreen("screen-landing"); });
  on("btn-back", "click", () => {
    if (window.location.pathname.includes("/servers/")) { routes.go("/dashboard"); enterPicker(); }
    else window.history.back();
  });
  on("status-back-btn", "click", () => { window.history.back(); });

  boot();
  setInterval(async () => {
    const wasOnline = botInfoCache?.online;
    await refreshHeroStatus();
    // if the bot just came back up while a dashboard is open, load
    // modules and rebuild the sidebar so newly-available modules appear
    if (!wasOnline && botInfoCache?.online && document.getElementById("screen-dashboard").classList.contains("active")) {
      await ensureModulesLoaded();
      buildSidebar(currentGuildDisabledModules);
    }
  }, 15000);
});

// ============================================================
// NEXORA — frontend app logic
// Static site (GitHub Pages) talking to:
//   1) Discord's OAuth + REST API directly (PKCE, no secret needed here)
//   2) Your own hosted bot (bot/bot.js) over CFG.LOCAL_BOT_URL
//
// URL shape (extended router):
//   /                                        landing
//   /dashboard | /my-tickets | /my-servers | /premium   picker screens
//   /status                                  status page
//   /servers/:guildId/:moduleId              a module's default tab
//   /servers/:guildId/:moduleId/:tab         a module's named sub-tab
//   /servers/:guildId/:moduleId/ticket/:id   a ticket detail page
//   /share/:shareId                          public read-only ticket view
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
    if (parts[0] === "my-tickets") {
      // /my-tickets/ticket/:guildId/:ticketId — a specific ticket opened
      // from the personal My Tickets list, distinct from the module's
      // own /servers/:id/:module/ticket/:id (different entry point,
      // same underlying detail page).
      if (parts[1] === "ticket" && parts[2] && parts[3]) return { screen: "picker", panel: "my-tickets", myTicketGuildId: parts[2], myTicketId: parts[3] };
      return { screen: "picker", panel: "my-tickets" };
    }
    if (parts[0] === "my-servers") return { screen: "picker", panel: "my-servers" };
    if (parts[0] === "premium") return { screen: "picker", panel: "premium" };
    if (parts[0] === "admin") return { screen: "picker", panel: "admin" };
    if (parts[0] === "share" && parts[1]) return { screen: "share", shareId: parts[1] };
    if (parts[0] === "servers" && parts[1]) {
      const guildId = parts[1];
      const moduleId = parts[2] || "ticket-tool";
      if (parts[3] === "ticket" && parts[4]) return { screen: "dashboard", guildId, panel: moduleId, ticketId: parts[4] };
      const tab = parts[3] || null;
      return { screen: "dashboard", guildId, panel: moduleId, tab };
    }
    return { screen: "landing" };
  },
  go(url, replace = false) {
    const full = CFG.BASE_PATH.replace(/\/$/, "") + url;
    if (replace) window.history.replaceState({}, "", full);
    else window.history.pushState({}, "", full);
  },
  moduleUrl(guildId, moduleId, tab) {
    return `/servers/${guildId}/${moduleId}${tab ? `/${tab}` : ""}`;
  },
  ticketUrl(guildId, moduleId, ticketId) {
    return `/servers/${guildId}/${moduleId}/ticket/${ticketId}`;
  },
  myTicketUrl(guildId, ticketId) {
    return `/my-tickets/ticket/${guildId}/${ticketId}`;
  },
};

window.addEventListener("popstate", () => renderFromRoute());

// ============================================================
// Shared modal system — every dialog in the app (confirm, alert, or a
// fully custom body) renders through this, so nothing anywhere uses the
// browser's native confirm()/alert() or a one-off overlay div.
// ============================================================
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

const DCModal = (() => {
  const root = () => document.getElementById("dc-modal-root");

  function close() {
    const r = root();
    r.innerHTML = "";
    r.classList.remove("dc-modal-open");
    document.removeEventListener("keydown", onEscape);
  }
  function onEscape(e) { if (e.key === "Escape") close(); }

  function open(bodyHtml, { maxWidth = "440px", onMount } = {}) {
    const r = root();
    r.classList.add("dc-modal-open");
    r.innerHTML = `
      <div class="dc-modal-overlay">
        <div class="dc-modal-panel" style="max-width:${maxWidth}">${bodyHtml}</div>
      </div>`;
    r.querySelector(".dc-modal-overlay").addEventListener("click", (e) => { if (e.target.classList.contains("dc-modal-overlay")) close(); });
    document.addEventListener("keydown", onEscape);
    if (onMount) onMount(r);
    return r;
  }

  function confirm(message, opts = {}) {
    return new Promise((resolve) => {
      const { title = "Are you sure?", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = opts;
      open(`
        <div class="dc-modal-header"><h3>${escapeHtml(title)}</h3></div>
        <div class="dc-modal-body"><p>${escapeHtml(message)}</p></div>
        <div class="dc-modal-footer">
          <button class="btn btn-ghost btn-small" id="dc-modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"} btn-small" id="dc-modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>`, {
        onMount: (r) => {
          r.querySelector("#dc-modal-cancel").addEventListener("click", () => { close(); resolve(false); });
          r.querySelector("#dc-modal-confirm").addEventListener("click", () => { close(); resolve(true); });
        },
      });
    });
  }

  function alertModal(message, opts = {}) {
    return new Promise((resolve) => {
      const { title = "Notice", okLabel = "OK" } = opts;
      open(`
        <div class="dc-modal-header"><h3>${escapeHtml(title)}</h3></div>
        <div class="dc-modal-body"><p>${escapeHtml(message)}</p></div>
        <div class="dc-modal-footer">
          <button class="btn btn-primary btn-small" id="dc-modal-ok">${escapeHtml(okLabel)}</button>
        </div>`, {
        onMount: (r) => r.querySelector("#dc-modal-ok").addEventListener("click", () => { close(); resolve(); }),
      });
    });
  }

  function promptModal(message, opts = {}) {
    return new Promise((resolve) => {
      const { title = "Enter a value", placeholder = "", defaultValue = "", confirmLabel = "Save" } = opts;
      open(`
        <div class="dc-modal-header"><h3>${escapeHtml(title)}</h3></div>
        <div class="dc-modal-body">
          <p style="margin-bottom:10px">${escapeHtml(message)}</p>
          <input type="text" class="dc-modal-input" id="dc-modal-prompt-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
        </div>
        <div class="dc-modal-footer">
          <button class="btn btn-ghost btn-small" id="dc-modal-cancel">Cancel</button>
          <button class="btn btn-primary btn-small" id="dc-modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>`, {
        onMount: (r) => {
          const input = r.querySelector("#dc-modal-prompt-input");
          input.focus();
          input.select();
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { close(); resolve(input.value); } });
          r.querySelector("#dc-modal-cancel").addEventListener("click", () => { close(); resolve(null); });
          r.querySelector("#dc-modal-confirm").addEventListener("click", () => { close(); resolve(input.value); });
        },
      });
    });
  }

  function custom(bodyHtml, opts = {}) {
    return open(bodyHtml, opts);
  }

  return { confirm, alert: alertModal, prompt: promptModal, custom, close };
})();

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
    if (!res2.ok) throw new Error("Could not complete login. Is your bot running?");
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
// Bot bridge
// ============================================================
async function pingLocalBot() {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${CFG.LOCAL_BOT_URL}/status`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      // Round-trip time for this exact request — the only place we can
      // measure latency from, since the bot itself doesn't report one.
      data.latencyMs = Math.round(performance.now() - startedAt);
      return data;
    }
  } catch { /* fall through to root check below */ }
  try {
    await fetch(`${CFG.LOCAL_BOT_URL}/`, { signal: AbortSignal.timeout(8000) });
    return null;
  } catch {
    return null;
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
      try {
        detail = JSON.parse(text).error || "";
      } catch {
        // The bot didn't return JSON (an unexpected HTML error page from
        // Express itself, a proxy, etc). Rather than dumping raw HTML
        // markup into the UI (unreadable, and looks broken), fall back
        // to a short, honest message that still names the HTTP status.
        detail = "";
      }
    } catch { /* couldn't even read the body */ }
    throw new Error(detail || `Request failed (HTTP ${res.status}). The bot may need to be restarted — check its console output.`);
  }
  return res.json();
}

// ============================================================
// Theme — #18: three-way Light / Dark / System selector, replacing the
// old two-way on/off toggle. "system" tracks prefers-color-scheme live
// (via a media query listener) rather than being resolved once at
// apply-time, so the page follows the OS if the person leaves it set
// to System and changes their OS theme later.
// ============================================================
const systemThemeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
function resolveSystemTheme() { return systemThemeQuery && systemThemeQuery.matches ? "light" : "dark"; }
function applyTheme(theme) {
  // theme is the person's PREFERENCE: "light" | "dark" | "system".
  // The actual attribute painted on <body> is always a concrete
  // "light"/"dark" — "system" resolves to whichever the OS reports.
  const resolved = theme === "system" ? resolveSystemTheme() : theme;
  document.body.setAttribute("data-theme", resolved);
  localStorage.setItem(LS.theme, theme);
  document.querySelectorAll("[id^=btn-theme]").forEach(btn => {
    btn.innerHTML = resolved === "dark" ? `<i class="ti ti-moon"></i>` : `<i class="ti ti-sun"></i>`;
  });
}
function getThemePreference() { return localStorage.getItem(LS.theme) || "system"; }
if (systemThemeQuery) {
  systemThemeQuery.addEventListener("change", () => { if (getThemePreference() === "system") applyTheme("system"); });
}

// Shared bottom-of-sidebar block: the theme picker sits above
// Status, then the logged-in user's profile chip with its
// Profile/Admin Panel/Log out menu.
function renderSidebarBottom(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  const session = getSession();
  const currentPref = getThemePreference();
  const THEME_OPTIONS = [
    { id: "light", label: "Light", icon: "ti-sun" },
    { id: "dark", label: "Dark", icon: "ti-moon" },
    { id: "system", label: "System", icon: "ti-device-desktop" },
  ];
  const currentOpt = THEME_OPTIONS.find(o => o.id === currentPref) || THEME_OPTIONS[1];
  slot.innerHTML = `
    <div class="sidebar-bottom">
      <div class="theme-picker-anchor">
        <div class="nav-item sidebar-theme-row theme-picker-trigger">
          <i class="ti ${currentOpt.icon}"></i> <span class="sidebar-theme-label">${currentOpt.label}</span>
          <i class="ti ti-chevron-up" style="margin-left:auto;color:var(--text-dim);font-size:14px"></i>
        </div>
        <div class="theme-picker-menu" style="display:none">
          ${THEME_OPTIONS.map(o => `<button class="theme-picker-item ${o.id === currentPref ? "active" : ""}" data-theme-opt="${o.id}"><i class="ti ${o.icon}"></i> ${o.label}</button>`).join("")}
        </div>
      </div>
      <a href="#" class="nav-item sb-status-link"><i class="ti ti-activity"></i> Status</a>
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

  maybeShowAdminPanelButton(slot);

  const statusLink = slot.querySelector(".sb-status-link");
  const themeTrigger = slot.querySelector(".theme-picker-trigger");
  const themeMenu = slot.querySelector(".theme-picker-menu");
  const menu = slot.querySelector(".sb-profile-menu");
  const trigger = slot.querySelector(".sb-profile-trigger");
  const profileBtn = slot.querySelector(".sb-profile-btn");
  const logoutBtn = slot.querySelector(".sb-logout-btn");
  const adminPanelBtn = slot.querySelector(".sb-admin-panel-btn");

  statusLink.addEventListener("click", async (e) => {
    e.preventDefault();
    // Status is a dashboard panel like any module (server context,
    // full module list in the sidebar) rather than its own separate
    // screen — if no server is currently open (e.g. clicked from the
    // picker), fall back to the last server that was open, or the
    // first server the bot is in, so there's always something to show.
    if (!currentGuild?.id) {
      await refreshHeroStatus();
      const fallback = (botInfoCache?.guilds || [])[0];
      if (!fallback) { await DCModal.alert("No servers to show status for yet — open a server's dashboard first.", { title: "No server selected" }); return; }
      currentGuild = { id: fallback.id, name: fallback.name, icon: fallback.icon };
    }
    routes.go(routes.moduleUrl(currentGuild.id, "status"));
    enterDashboard("status");
  });

  function closeThemeMenuOnOutsideClick(e) {
    if (!themeMenu.contains(e.target) && !themeTrigger.contains(e.target)) {
      themeMenu.style.display = "none";
      document.removeEventListener("click", closeThemeMenuOnOutsideClick, true);
    }
  }
  themeTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = themeMenu.style.display !== "none";
    if (isOpen) { themeMenu.style.display = "none"; document.removeEventListener("click", closeThemeMenuOnOutsideClick, true); }
    else { themeMenu.style.display = "block"; document.addEventListener("click", closeThemeMenuOnOutsideClick, true); }
  });
  themeMenu.querySelectorAll("[data-theme-opt]").forEach(btn => btn.addEventListener("click", () => {
    applyTheme(btn.dataset.themeOpt);
    themeMenu.style.display = "none";
    document.removeEventListener("click", closeThemeMenuOnOutsideClick, true);
    // Repaint every sidebar-bottom slot currently in the DOM so the
    // trigger's own label/icon and the menu's "active" state update
    // immediately, without needing a full screen re-render.
    ["picker-sidebar-bottom", "dash-sidebar-bottom"].forEach(id => { if (document.getElementById(id)) renderSidebarBottom(id); });
  }));

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

applyTheme(getThemePreference());

// ============================================================
// Small render helpers
// ============================================================
function showScreen(id) { document.querySelectorAll(".screen").forEach(s => s.classList.remove("active")); document.getElementById(id).classList.add("active"); }
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
  if (botInfo && botInfo.online) {
    el.classList.add("online");
    const latency = botInfo.latencyMs != null ? `${botInfo.latencyMs}ms` : "—";
    const uptime = formatUptime(botInfo.uptimeSeconds);
    el.innerHTML = `<span class="status-dot"></span>Bot online <span class="status-pip-sep">·</span> ${latency} <span class="status-pip-sep">·</span> up ${uptime}`;
  } else {
    el.classList.add("offline");
    el.innerHTML = `<span class="status-dot"></span>Bot Servers down`;
  }
}
function timeAgoGlobal(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
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
  const redirectPath = sessionStorage.getItem("tk_redirect_path");
  if (redirectPath) {
    sessionStorage.removeItem("tk_redirect_path");
    window.history.replaceState({}, "", redirectPath);
  }

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");

  const route = routes.parse();
  if (route.screen === "share") { await enterSharePage(route.shareId); return; }

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
      await DCModal.alert(e.message || "Login failed", { title: "Login failed" });
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

  if (route.screen === "share") { await enterSharePage(route.shareId); return; }
  if (route.screen !== "landing" && !session) { routes.go("/", true); showScreen("screen-landing"); return; }

  if (route.screen === "landing") { showScreen("screen-landing"); return; }
  if (route.screen === "picker") { await enterPicker(route.panel, { myTicketGuildId: route.myTicketGuildId, myTicketId: route.myTicketId }); return; }
  if (route.screen === "dashboard") {
    if (!currentGuild || currentGuild.id !== route.guildId) {
      currentGuild = { id: route.guildId, name: null, icon: null };
    }
    await enterDashboard(route.panel || "ticket-tool", { tab: route.tab, ticketId: route.ticketId });
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

async function enterPicker(panel, deepLink = {}) {
  showScreen("screen-picker");
  pickerActivePanel = panel || pickerActivePanel || "dashboard";
  renderSidebarBottom("picker-sidebar-bottom");
  await refreshHeroStatus();
  paintPickerNav();

  if (pickerActivePanel === "my-tickets" && deepLink.myTicketGuildId && deepLink.myTicketId) {
    await openMyTicketDetail(deepLink.myTicketGuildId, deepLink.myTicketId, false);
  } else {
    await renderPickerPanel(pickerActivePanel);
  }

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
  if (panel === "my-servers") return renderMyServersPanel(root);
  if (panel === "premium") return renderPremiumPanel(root);
  if (panel === "admin") return renderAdminPanel(root);
  return renderDashboardPanel(root);
}

async function renderDashboardPanel(root) {
  root.innerHTML = `
    <div class="dash-header">
      <div><h1 class="picker-heading">Your Servers</h1><p class="picker-sub">Manage tickets and settings for your Discord servers</p></div>
      <div class="dash-header-actions">
        <button class="btn btn-ghost btn-small" id="ds-refresh-btn"><i class="ti ti-refresh"></i> Refresh Servers</button>
        <a class="btn btn-primary btn-small" href="${inviteUrl()}" target="_blank" rel="noopener"><i class="ti ti-plus"></i> Add Bot</a>
      </div>
    </div>
    <div class="servers-search-row">
      <input type="text" class="search-input" id="ds-search" placeholder="Search servers…">
    </div>
    <p class="field-hint" id="ds-count" style="margin-bottom:14px">Loading…</p>
    <div class="server-grid" id="server-grid">${loadingBlock("Loading your servers…")}</div>`;

  const grid = document.getElementById("server-grid");
  const countEl = document.getElementById("ds-count");
  const session = getSession();
  let sorted = [];

  function cardHtml(g, hasBot) {
    const iconHtml = g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">` : initials(g.name);
    const roleBadge = g.owner ? `<span class="role-badge owner"><i class="ti ti-crown"></i> Owner</span>` : `<span class="role-badge admin"><i class="ti ti-shield"></i> Admin</span>`;
    return `
      <div class="server-card ${hasBot ? "" : "bot-absent"}" data-server-name="${escapeHtml(g.name.toLowerCase())}">
        <div class="server-icon">${iconHtml}</div>
        <div class="server-name">${escapeHtml(g.name)}</div>
        <div class="server-meta">${roleBadge} ${hasBot ? "" : "· Bot not added"}</div>
        <div class="server-card-actions">
          ${hasBot
            ? `<button class="btn btn-primary btn-small" data-open-dash="${g.id}" data-name="${escapeHtml(g.name)}" data-icon="${g.icon || ""}">Manage Server</button>`
            : `<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${inviteUrl(g.id)}"><i class="ti ti-plus"></i> Begin setup</a>`}
        </div>
      </div>`;
  }

  function wireDashButtons() {
    grid.querySelectorAll("[data-open-dash]").forEach(btn => {
      btn.addEventListener("click", () => {
        currentGuild = { id: btn.dataset.openDash, name: btn.dataset.name, icon: btn.dataset.icon };
        routes.go(routes.moduleUrl(currentGuild.id, "ticket-tool"));
        enterDashboard("ticket-tool");
      });
    });
  }

  async function loadAndPaint() {
    const guilds = await fetchMyGuilds(session.token);
    const admin = guilds.filter(isAdmin);
    if (admin.length === 0) {
      grid.innerHTML = `<div class="empty-state"><i class="ti ti-folder-off glyph"></i>No servers found where you have Administrator permission.</div>`;
      countEl.textContent = "";
      return;
    }
    const botGuildIds = new Set((botInfoCache?.guilds || []).map(g => g.id));
    sorted = [...admin].sort((a, b) => {
      const aHas = botGuildIds.has(a.id), bHas = botGuildIds.has(b.id);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const activeCount = sorted.filter(g => botGuildIds.has(g.id)).length;
    countEl.textContent = `${activeCount} active · ${sorted.length} available`;
    grid.innerHTML = sorted.map(g => cardHtml(g, botGuildIds.has(g.id))).join("");
    wireDashButtons();
  }

  try {
    await loadAndPaint();
  } catch {
    grid.innerHTML = `<div class="empty-state">Couldn't load your servers. Try logging in again.</div>`;
    countEl.textContent = "";
    return;
  }

  document.getElementById("ds-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    grid.querySelectorAll(".server-card[data-server-name]").forEach(card => {
      card.style.display = card.dataset.serverName.includes(q) ? "" : "none";
    });
  });

  // #13: Refresh Servers — re-fetches guild membership and bot-presence
  // data and repaints the grid in place, without a full page reload.
  // The button shows a brief spinning-icon "working" state so it's
  // clear the click registered while the requests are in flight.
  const refreshBtn = document.getElementById("ds-refresh-btn");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("btn-refreshing");
    try {
      await refreshHeroStatus();
      await loadAndPaint();
    } catch (e) {
      await DCModal.alert(`Couldn't refresh servers: ${e.message}`);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("btn-refreshing");
    }
  });
}

function renderPremiumPanel(root) {
  root.innerHTML = `
    <h1 class="picker-heading">Premium</h1>
    <p class="picker-sub">Unlock higher limits and advanced features across every server.</p>
    <div class="empty-state"><i class="ti ti-crown glyph"></i>Premium plans aren't set up yet — check back soon.</div>`;
}

// ============================================================
// Admin panel
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
    try { detail = (await res.json()).error; } catch { /* not JSON — fall back below */ }
    throw new Error(detail || `Request failed (HTTP ${res.status}). The bot may need to be restarted — check its console output.`);
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
      <h3>Server access</h3>
      <div class="hint">Choose whether every server the bot is in may use it, or only servers you explicitly allow.</div>
      <div class="config-row" style="margin-bottom:4px">
        <span class="config-row-label">Restrict to an allow-list</span>
        <button class="toggle" id="admin-allowmode-toggle" aria-label="Toggle allow-list mode"></button>
      </div>
      <div id="admin-guilds-section"></div>
    </div>
    <div class="config-section" style="margin-top:18px">
      <div class="dash-header" style="margin-bottom:4px">
        <h3 style="margin:0">Ticket search</h3>
        <button class="btn btn-ghost btn-small" id="admin-ticket-refresh-btn"><i class="ti ti-refresh"></i> Refresh Tickets</button>
      </div>
      <div class="hint">Find any ticket across every server by its number, subject, or who opened/claimed/closed it.</div>
      <input type="text" class="search-input" id="admin-ticket-search" placeholder="Search by ticket number, subject, or user…" style="width:100%;margin-bottom:10px">
      <div id="admin-ticket-search-results"></div>
    </div>
    ${session.isOwner ? `
    <div class="config-section" style="margin-top:18px">
      <h3>Granted admins</h3>
      <div class="hint">Discord user ids that can log into this panel, in addition to you as the owner. Numbers only.</div>
      <div class="field-row-inline" style="margin-bottom:10px">
        <input type="text" id="admin-add-userid" placeholder="Discord user id (numbers only)" inputmode="numeric" style="flex:1">
        <button class="btn btn-primary btn-small" id="admin-add-btn">Grant access</button>
      </div>
      <div class="field-hint" id="admin-add-error" style="display:none;color:var(--red);margin-bottom:8px"></div>
      <div id="admin-admins-list">${loadingBlock()}</div>
    </div>` : ""}`;

  document.getElementById("admin-logout-btn").addEventListener("click", async () => {
    try { await adminApi("/admin/logout", { method: "POST" }); } catch {}
    setAdminToken(null);
    renderAdminPanel(root);
  });

  await paintAdminGuildsSection();
  wireAdminTicketSearch();
  if (session.isOwner) await paintAdminAdminsList();
}

async function paintAdminGuildsSection() {
  const section = document.getElementById("admin-guilds-section");
  const toggle = document.getElementById("admin-allowmode-toggle");
  try {
    const result = await adminApi("/admin/guilds");
    const isAllowlist = result.allowMode === "allowlist";
    toggle.classList.toggle("on", isAllowlist);

    if (!isAllowlist) {
      section.innerHTML = `<div class="field-hint" style="margin-top:10px"><i class="ti ti-info-circle"></i> Every server the bot is in may currently use it. Turn the toggle on to restrict access to specific servers.</div>`;
    } else {
      section.innerHTML = `
        <div style="margin-top:10px">
          <div class="field-row-inline" style="margin-bottom:10px">
            <input type="text" id="admin-add-guildid" placeholder="Server id (numbers only)" inputmode="numeric" style="flex:1">
            <button class="btn btn-primary btn-small" id="admin-add-guild-btn">Grant server</button>
          </div>
          <div class="field-hint" id="admin-add-guild-error" style="display:none;color:var(--red);margin-bottom:8px"></div>
          <div id="admin-guilds-list">${loadingBlock()}</div>
        </div>`;
      await paintAdminGuildsList(result);
      document.getElementById("admin-add-guild-btn").addEventListener("click", async () => {
        const input = document.getElementById("admin-add-guildid");
        const errEl = document.getElementById("admin-add-guild-error");
        errEl.style.display = "none";
        const guildId = input.value.trim();
        try {
          await adminApi("/admin/guilds", { method: "POST", body: JSON.stringify({ guildId }) });
          input.value = "";
          await paintAdminGuildsSection();
        } catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; }
      });
    }

    toggle.addEventListener("click", async () => {
      const newMode = isAllowlist ? "all" : "allowlist";
      try { await adminApi("/admin/guilds-mode", { method: "PUT", body: JSON.stringify({ allowMode: newMode }) }); await paintAdminGuildsSection(); }
      catch (e) { await DCModal.alert(`Couldn't update: ${e.message}`); }
    }, { once: true });
  } catch (e) {
    section.innerHTML = `<div class="empty-state">Couldn't load servers: ${escapeHtml(e.message)}</div>`;
  }
}

async function paintAdminGuildsList(guildsResult) {
  const slot = document.getElementById("admin-guilds-list");
  const allowedGuildIds = guildsResult.allowedGuildIds;
  const knownGuilds = guildsResult.knownGuilds;
  if (knownGuilds.length === 0) { slot.innerHTML = `<div class="empty-state">The bot isn't in any servers yet.</div>`; return; }
  const allowedKnown = knownGuilds.filter(g => allowedGuildIds.includes(g.id));
  const allowedUnknownIds = allowedGuildIds.filter(id => !knownGuilds.some(g => g.id === id));
  slot.innerHTML = `
    ${allowedKnown.map(g => `
    <div class="config-row">
      <span class="config-row-label" style="display:flex;align-items:center;gap:8px">
        ${g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" style="width:22px;height:22px;border-radius:6px" alt="">` : `<span class="server-icon" style="width:22px;height:22px;font-size:9px;margin:0">${initials(g.name)}</span>`}
        ${escapeHtml(g.name)}
      </span>
      <button class="btn btn-ghost btn-small" data-guild-revoke="${g.id}"><i class="ti ti-x"></i> Remove</button>
    </div>`).join("")}
    ${allowedUnknownIds.map(id => `
    <div class="config-row">
      <span class="config-row-label" style="display:flex;align-items:center;gap:8px"><span class="server-icon" style="width:22px;height:22px;font-size:9px;margin:0">?</span>${escapeHtml(id)} <span class="field-hint">(bot not in this server)</span></span>
      <button class="btn btn-ghost btn-small" data-guild-revoke="${id}"><i class="ti ti-x"></i> Remove</button>
    </div>`).join("")}
    ${allowedKnown.length === 0 && allowedUnknownIds.length === 0 ? `<div class="empty-state">No servers granted yet — every server is currently blocked until you add one.</div>` : ""}`;
  slot.querySelectorAll("[data-guild-revoke]").forEach(btn => btn.addEventListener("click", async () => {
    try { await adminApi(`/admin/guilds/${btn.dataset.guildRevoke}`, { method: "DELETE" }); await paintAdminGuildsSection(); }
    catch (e) { await DCModal.alert(`Couldn't update: ${e.message}`); }
  }));
}

async function paintAdminAdminsList() {
  const slot = document.getElementById("admin-admins-list");
  const addBtn = document.getElementById("admin-add-btn");
  const errEl = document.getElementById("admin-add-error");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const input = document.getElementById("admin-add-userid");
    const userId = input.value.trim();
    errEl.style.display = "none";
    if (!userId) return;
    try { await adminApi("/admin/admins", { method: "POST", body: JSON.stringify({ userId }) }); input.value = ""; await paintAdminAdminsList(); }
    catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; }
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
      const ok = await DCModal.confirm("Revoke this admin's access to the panel?", { title: "Revoke access", confirmLabel: "Revoke", danger: true });
      if (!ok) return;
      try { await adminApi(`/admin/admins/${btn.dataset.revokeAdmin}`, { method: "DELETE" }); await paintAdminAdminsList(); }
      catch (e) { await DCModal.alert(`Couldn't revoke: ${e.message}`); }
    }));
  } catch (e) {
    slot.innerHTML = `<div class="empty-state">Couldn't load admins: ${escapeHtml(e.message)}</div>`;
  }
}

// Renders the Admin Panel's inline ticket detail view (#6: opened
// directly inside the Admin Panel, never redirecting the admin out to
// My Tickets) including the viewers list (#7).
async function openAdminTicketDetail(guildId, ticketId) {
  const root = document.getElementById("picker-panel-root");
  root.innerHTML = `
    <button class="btn btn-ghost btn-small" id="admin-ticket-back"><i class="ti ti-arrow-left"></i> Back to Admin Panel</button>
    <div id="admin-ticket-detail-body" style="margin-top:16px">${loadingBlock("Loading ticket…")}</div>`;
  document.getElementById("admin-ticket-back").addEventListener("click", () => renderAdminPanel(root));
  const body = document.getElementById("admin-ticket-detail-body");
  try {
    const data = await adminApi(`/admin/guilds/${guildId}/tickets/${ticketId}`);
    paintAdminTicketDetail(body, guildId, ticketId, data);
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><i class="ti ti-alert-triangle glyph"></i>Couldn't load this ticket: ${escapeHtml(e.message)}</div>`;
  }
}

function userDisplayHtml(profile, fallbackId) {
  const name = profile?.displayName || profile?.username || fallbackId || "Unknown";
  const avatar = profile?.avatarUrl || "https://cdn.discordapp.com/embed/avatars/0.png";
  return `<span class="user-display"><img class="user-display-avatar" src="${escapeHtml(avatar)}" alt=""><span class="user-display-name">${escapeHtml(name)}</span></span>`;
}

function paintAdminTicketDetail(body, guildId, ticketId, data) {
  const { ticket, messages, viewers, opener } = data;
  body.innerHTML = `
    <div class="ticket-panel-card">
      <div class="ticket-panel-card-header">
        <span class="ticket-panel-card-title">${escapeHtml(ticket.subject || "No subject")} <span class="field-hint" style="font-weight:400">#${escapeHtml(String(ticket.number ?? ticket.id))}</span></span>
        <span class="badge badge-${ticket.status}">${ticket.status}</span>
      </div>
      <div class="ticket-panel-card-body">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="ticket-info-label" style="margin-bottom:0">Author</span> ${userDisplayHtml(opener, ticket.openedById)}</div>
        ${messages.length === 0
          ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No messages were sent in this ticket.</div>`
          : messages.map(m => `
            <div class="msg-container">
              <img class="msg-container-avatar" src="${m.authorAvatar ? escapeHtml(m.authorAvatar) : "https://cdn.discordapp.com/embed/avatars/0.png"}" alt="">
              <div class="msg-container-body">
                <div class="msg-container-meta">
                  <span class="msg-container-author">${escapeHtml(m.authorName)}</span>
                  ${m.authorIsStaff ? `<span class="staff-tag">STAFF</span>` : ""}
                  <span class="msg-container-time">${new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div class="msg-container-content">${escapeHtml(m.content) || `<span class="field-hint">(no text content)</span>`}</div>
              </div>
            </div>`).join("")}
      </div>
    </div>
    <div class="ticket-panel-card">
      <div class="ticket-panel-card-header"><span class="ticket-panel-card-title"><i class="ti ti-eye"></i> Viewers</span></div>
      <div class="ticket-panel-card-body">
        ${viewers.length === 0 ? `<div class="empty-state">No one has viewed this ticket yet.</div>` : `
          <div class="ticket-viewers-list">
            ${viewers.map(v => `
              <div class="ticket-viewer-row">
                ${userDisplayHtml(v, v.userId)}
                <span class="ticket-viewer-time">${new Date(v.viewedAt).toLocaleString()}</span>
              </div>`).join("")}
          </div>`}
      </div>
    </div>`;
}

function wireAdminTicketSearch() {
  const input = document.getElementById("admin-ticket-search");
  const resultsSlot = document.getElementById("admin-ticket-search-results");
  let debounceTimer = null;
  async function runSearch() {
    resultsSlot.innerHTML = loadingBlock("Searching…");
    try {
      const d = await api(`/admin/tickets/search?q=${encodeURIComponent(input.value.trim())}`);
      paintAdminTicketSearchResults(d.tickets || []);
    } catch (e) {
      resultsSlot.innerHTML = `<div class="empty-state">Couldn't search: ${escapeHtml(e.message)}</div>`;
    }
  }
  function paintAdminTicketSearchResults(tickets) {
    if (tickets.length === 0) { resultsSlot.innerHTML = `<div class="empty-state">No tickets found.</div>`; return; }
    resultsSlot.innerHTML = `
      <div class="ticket-table">
        <div class="ticket-row head" style="grid-template-columns:70px 1fr 1fr 100px 120px"><span>#</span><span>Server</span><span>Subject</span><span>Status</span><span>Created</span></div>
        ${tickets.slice(0, 50).map(t => `
          <div class="ticket-row ticket-row-clickable" style="grid-template-columns:70px 1fr 1fr 100px 120px" data-admin-ticket="${t.guildId}:${t.id}">
            <span>${escapeHtml(String(t.number ?? t.id))}</span>
            <span>${escapeHtml(t.guildName || "Unknown")}</span>
            <span>${escapeHtml(t.subject || "—")}</span>
            <span class="badge badge-${t.status}">${t.status}</span>
            <span>${timeAgoGlobal(t.createdAt)}</span>
          </div>`).join("")}
      </div>`;
    resultsSlot.querySelectorAll("[data-admin-ticket]").forEach(row => row.addEventListener("click", () => {
      const [guildId, ticketId] = row.dataset.adminTicket.split(":");
      openAdminTicketDetail(guildId, ticketId);
    }));
  }
  input.addEventListener("input", () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(runSearch, 300); });
  // #14: Refresh Tickets in the Admin Panel — re-runs the current
  // search (or the default unfiltered list) in place.
  const refreshBtn = document.getElementById("admin-ticket-refresh-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("btn-refreshing");
    try { await runSearch(); }
    finally { refreshBtn.disabled = false; refreshBtn.classList.remove("btn-refreshing"); }
  });
  runSearch();
}

// ============================================================
// My Tickets — filter chips (status/server/subject/date range), a
// columns toggle, and a detail page with an Author/Created/Subject/
// Closed-By info panel plus claim/share-link controls.
// ============================================================
// #9: "Opened By" removed from the My Tickets table — the whole list
// already belongs to the logged-in user, so it added no information.
// It's kept inside the ticket detail view itself (see the Author row in
// paintTicketDetailBody below). Column order/set now fixed to match the
// reference exactly: Server, Subject, Content, Status, Created.
const MY_TICKETS_COLUMNS = ["server", "subject", "content", "status", "created"];
const MY_TICKETS_COLUMN_LABELS = { server: "Server", subject: "Subject", content: "Content", status: "Status", created: "Created" };

async function renderMyTicketsPanel(root) {
  root.innerHTML = `
    <div class="dash-header">
      <div><h1 class="picker-heading">My Tickets</h1><p class="picker-sub" id="my-tickets-count">Loading…</p></div>
      <div class="dash-header-actions">
        <button class="btn btn-ghost btn-small" id="mt-refresh-btn"><i class="ti ti-refresh"></i> Refresh Tickets</button>
      </div>
    </div>
    <p class="field-hint" style="margin-bottom:10px">Use filters below to refine results</p>
    <div class="ticket-toolbar">
      <input type="text" class="search-input" id="mt-search" placeholder="Search tickets…">
      <div class="dropdown-anchor">
        <button class="btn btn-ghost btn-small" id="mt-status-btn">All Status <i class="ti ti-chevron-down"></i></button>
        <div class="dropdown-panel-floating" id="mt-status-panel" style="display:none">
          <div class="dropdown-panel-item" data-mt-status="">All Status</div>
          <div class="dropdown-panel-item" data-mt-status="open">Active</div>
          <div class="dropdown-panel-item" data-mt-status="closed">Closed</div>
        </div>
      </div>
      <div class="dropdown-anchor">
        <button class="btn btn-ghost btn-small" id="mt-server-btn">Server <i class="ti ti-chevron-down"></i></button>
        <div class="dropdown-panel-floating" id="mt-server-panel" style="display:none">
          <input type="text" class="dropdown-panel-search" id="mt-server-search" placeholder="Search tickets...">
          <div id="mt-server-options"></div>
        </div>
      </div>
      <div class="dropdown-anchor">
        <button class="btn btn-ghost btn-small" id="mt-subject-btn">Subject <i class="ti ti-chevron-down"></i></button>
        <div class="dropdown-panel-floating" id="mt-subject-panel" style="display:none">
          <input type="text" class="dropdown-panel-search" id="mt-subject-search" placeholder="Search subjects...">
          <div id="mt-subject-options"></div>
        </div>
      </div>
      <div class="dropdown-anchor">
        <button class="btn btn-ghost btn-small" id="mt-date-btn"><i class="ti ti-calendar"></i> Date range</button>
        <div class="dropdown-panel-floating" id="mt-date-panel" style="display:none"></div>
      </div>
    </div>
    <div id="my-tickets-list">${loadingBlock()}</div>`;

  const session = getSession();
  let tickets = [];
  async function loadTickets() {
    tickets = (await api(`/tickets?userId=${session.user.id}`)).tickets || [];
  }
  try {
    await loadTickets();
  } catch (e) {
    document.getElementById("my-tickets-list").innerHTML = `<div class="empty-state"><i class="ti ti-alert-triangle glyph"></i>Couldn't load your tickets: ${escapeHtml(e.message)}</div>`;
    document.getElementById("my-tickets-count").textContent = "";
    return;
  }
  document.getElementById("my-tickets-count").textContent = `~${tickets.length} ticket${tickets.length === 1 ? "" : "s"} found`;

  const filters = { query: "", status: "", server: "", subject: "", dateFrom: null, dateTo: null };
  function applyFiltersAndPaint() {
    let rows = tickets;
    if (filters.query) { const q = filters.query.toLowerCase(); rows = rows.filter(t => (t.subject || "").toLowerCase().includes(q) || (t.guildName || "").toLowerCase().includes(q)); }
    if (filters.status) rows = rows.filter(t => (filters.status === "open" ? t.status !== "closed" : t.status === "closed"));
    if (filters.server) rows = rows.filter(t => t.guildName === filters.server);
    if (filters.subject) rows = rows.filter(t => t.subject === filters.subject);
    if (filters.dateFrom) rows = rows.filter(t => new Date(t.createdAt) >= filters.dateFrom);
    if (filters.dateTo) rows = rows.filter(t => new Date(t.createdAt) <= filters.dateTo);
    paintMyTicketsList(rows, tickets);
  }

  document.getElementById("mt-search").addEventListener("input", (e) => { filters.query = e.target.value; applyFiltersAndPaint(); });

  wireFloatingDropdown("mt-status-btn", "mt-status-panel");
  document.querySelectorAll("[data-mt-status]").forEach(item => item.addEventListener("click", () => {
    filters.status = item.dataset.mtStatus;
    document.getElementById("mt-status-btn").innerHTML = `${item.textContent} <i class="ti ti-chevron-down"></i>`;
    closeAllFloatingDropdowns();
    applyFiltersAndPaint();
  }));

  wireFloatingDropdown("mt-server-btn", "mt-server-panel");
  function uniqueServersNow() { return [...new Set(tickets.map(t => t.guildName).filter(Boolean))]; }
  function paintServerOptions(query) {
    const q = (query || "").toLowerCase();
    const opts = uniqueServersNow().filter(s => s.toLowerCase().includes(q));
    document.getElementById("mt-server-options").innerHTML = opts.map(s => `<div class="dropdown-panel-item" data-mt-server-opt="${escapeHtml(s)}">${escapeHtml(s)}</div>`).join("") || `<div class="dropdown-panel-empty">No matches</div>`;
    document.querySelectorAll("[data-mt-server-opt]").forEach(item => item.addEventListener("click", () => {
      filters.server = item.dataset.mtServerOpt;
      document.getElementById("mt-server-btn").innerHTML = `${escapeHtml(filters.server)} <i class="ti ti-chevron-down"></i>`;
      closeAllFloatingDropdowns();
      applyFiltersAndPaint();
    }));
  }
  paintServerOptions("");
  document.getElementById("mt-server-search").addEventListener("input", (e) => paintServerOptions(e.target.value));

  wireFloatingDropdown("mt-subject-btn", "mt-subject-panel");
  function uniqueSubjectsNow() { return [...new Set(tickets.map(t => t.subject).filter(Boolean))]; }
  function paintSubjectOptions(query) {
    const q = (query || "").toLowerCase();
    const opts = uniqueSubjectsNow().filter(s => s.toLowerCase().includes(q));
    document.getElementById("mt-subject-options").innerHTML = opts.map(s => `<div class="dropdown-panel-item" data-mt-subject-opt="${escapeHtml(s)}">${escapeHtml(s)}</div>`).join("") || `<div class="dropdown-panel-empty">No matches</div>`;
    document.querySelectorAll("[data-mt-subject-opt]").forEach(item => item.addEventListener("click", () => {
      filters.subject = item.dataset.mtSubjectOpt;
      document.getElementById("mt-subject-btn").innerHTML = `${escapeHtml(filters.subject)} <i class="ti ti-chevron-down"></i>`;
      closeAllFloatingDropdowns();
      applyFiltersAndPaint();
    }));
  }
  paintSubjectOptions("");
  document.getElementById("mt-subject-search").addEventListener("input", (e) => paintSubjectOptions(e.target.value));

  wireFloatingDropdown("mt-date-btn", "mt-date-panel");
  paintDateRangePicker(document.getElementById("mt-date-panel"), (from, to) => {
    filters.dateFrom = from; filters.dateTo = to;
    closeAllFloatingDropdowns();
    applyFiltersAndPaint();
  });

  // #14: Refresh Tickets — reloads the ticket list in place (re-fetch +
  // repaint) without touching filters, scroll position, or the rest of
  // the dashboard/page around it.
  const refreshBtn = document.getElementById("mt-refresh-btn");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("btn-refreshing");
    try {
      await loadTickets();
      document.getElementById("my-tickets-count").textContent = `~${tickets.length} ticket${tickets.length === 1 ? "" : "s"} found`;
      applyFiltersAndPaint();
    } catch (e) {
      await DCModal.alert(`Couldn't refresh tickets: ${e.message}`);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("btn-refreshing");
    }
  });

  applyFiltersAndPaint();
}

function closeAllFloatingDropdowns() {
  document.querySelectorAll(".dropdown-panel-floating").forEach(p => { p.style.display = "none"; });
}
function wireFloatingDropdown(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!btn || !panel) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = panel.style.display !== "none";
    closeAllFloatingDropdowns();
    panel.style.display = isOpen ? "none" : "block";
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
}
document.addEventListener("click", () => closeAllFloatingDropdowns());

function paintDateRangePicker(panel, onPick) {
  const now = new Date();
  let viewMonth = now.getMonth();
  let viewYear = now.getFullYear();
  let rangeStart = null, rangeEnd = null;

  function render() {
    const first = new Date(viewYear, viewMonth, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let cells = "";
    for (let i = 0; i < startWeekday; i++) cells += `<span class="dc-cal-cell dc-cal-empty"></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const thisDate = new Date(viewYear, viewMonth, d);
      const isSelected = (rangeStart && thisDate.getTime() === rangeStart.getTime()) || (rangeEnd && thisDate.getTime() === rangeEnd.getTime());
      const inRange = rangeStart && rangeEnd && thisDate > rangeStart && thisDate < rangeEnd;
      cells += `<span class="dc-cal-cell ${isSelected ? "selected" : ""} ${inRange ? "in-range" : ""}" data-cal-day="${d}">${d}</span>`;
    }
    panel.innerHTML = `
      <div class="dc-cal-header">
        <button class="icon-btn" id="dc-cal-prev"><i class="ti ti-chevron-left"></i></button>
        <span>${monthNames[viewMonth]} ${viewYear}</span>
        <button class="icon-btn" id="dc-cal-next"><i class="ti ti-chevron-right"></i></button>
      </div>
      <div class="dc-cal-grid">${["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => `<span class="dc-cal-dow">${d}</span>`).join("")}${cells}</div>
      <div class="dc-cal-footer">
        <button class="btn btn-ghost btn-small" id="dc-cal-clear">Clear</button>
        <button class="btn btn-primary btn-small" id="dc-cal-apply">Apply</button>
      </div>`;
    panel.querySelector("#dc-cal-prev").addEventListener("click", () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render(); });
    panel.querySelector("#dc-cal-next").addEventListener("click", () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render(); });
    panel.querySelectorAll("[data-cal-day]").forEach(cell => cell.addEventListener("click", () => {
      const d = new Date(viewYear, viewMonth, Number(cell.dataset.calDay));
      if (!rangeStart || (rangeStart && rangeEnd)) { rangeStart = d; rangeEnd = null; }
      else if (d < rangeStart) { rangeEnd = rangeStart; rangeStart = d; }
      else { rangeEnd = d; }
      render();
    }));
    panel.querySelector("#dc-cal-clear").addEventListener("click", () => { rangeStart = null; rangeEnd = null; onPick(null, null); });
    panel.querySelector("#dc-cal-apply").addEventListener("click", () => onPick(rangeStart, rangeEnd || rangeStart));
  }
  render();
}

// Shared "opened by" preview cell — avatar, display name, and the raw
// Discord user id in small dim text underneath. Used inside a ticket's
// own detail view (#9 keeps this there) and the Ticket Tool module's
// own staff-facing ticket list, so both show who opened a ticket the
// same way.
function openerPreviewHtml(t) {
  const opener = t.opener;
  const displayName = opener?.displayName || t.openedBy || "Unknown";
  const userId = opener?.id || t.openedById || "";
  const avatar = opener?.avatarUrl || "https://cdn.discordapp.com/embed/avatars/0.png";
  return `
    <span class="opener-preview">
      <img class="opener-preview-avatar" src="${escapeHtml(avatar)}" alt="">
      <span class="opener-preview-text">
        <span class="opener-preview-name">${escapeHtml(displayName)}</span>
        ${userId ? `<span class="opener-preview-id">${escapeHtml(userId)}</span>` : ""}
      </span>
    </span>`;
}

function paintMyTicketsList(rows, allTickets) {
  const list = document.getElementById("my-tickets-list");
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-ticket-off glyph"></i>${allTickets.length === 0 ? "You haven't opened any tickets yet." : "No tickets match."}</div>`;
    return;
  }
  // #9: fixed column set/order — Server, Subject, Content, Status,
  // Created — no "Opened By" column and no per-user column toggle
  // (removed along with it, since it existed mainly to hide/show that
  // column).
  const cols = MY_TICKETS_COLUMNS;
  const colWidths = { server: "1fr", subject: "1fr", content: "1.6fr", status: "100px", created: "120px" };
  const gridTemplate = cols.map(c => colWidths[c]).join(" ");
  const colLabel = MY_TICKETS_COLUMN_LABELS;
  const cellHtml = {
    server: (t) => `<span style="display:flex;align-items:center;gap:8px">${t.guildIcon ? `<img src="https://cdn.discordapp.com/icons/${t.guildId}/${t.guildIcon}.png" style="width:20px;height:20px;border-radius:6px" alt="">` : `<span class="server-icon" style="width:20px;height:20px;font-size:9px;margin:0">${initials(t.guildName || "?")}</span>`} ${escapeHtml(t.guildName || "Unknown server")}</span>`,
    subject: (t) => `<span class="cc-trigger-chip" style="background:rgba(139,92,246,.14);color:var(--violet);border-color:rgba(139,92,246,.3)">${escapeHtml(t.subject || "No subject")}</span>`,
    content: (t) => escapeHtml((t.messages && t.messages[0]?.content) || "—").slice(0, 80),
    status: (t) => `<span class="badge badge-${t.status}">${t.status}</span>`,
    created: (t) => timeAgoGlobal(t.createdAt),
  };
  list.innerHTML = `
    <div class="ticket-table">
      <div class="ticket-row head" style="grid-template-columns:${gridTemplate}">${cols.map(c => `<span>${colLabel[c]}</span>`).join("")}</div>
      ${rows.map(t => `
        <div class="ticket-row ticket-row-clickable" style="grid-template-columns:${gridTemplate}" data-my-ticket="${t.guildId}:${t.id}">
          ${cols.map(c => `<span>${cellHtml[c](t)}</span>`).join("")}
        </div>`).join("")}
    </div>`;
  list.querySelectorAll("[data-my-ticket]").forEach(row => row.addEventListener("click", () => {
    const [guildId, ticketId] = row.dataset.myTicket.split(":");
    openMyTicketDetail(guildId, ticketId);
  }));
}

async function openMyTicketDetail(guildId, ticketId, updateUrl = true) {
  if (updateUrl) routes.go(routes.myTicketUrl(guildId, ticketId));
  const root = document.getElementById("picker-panel-root");
  root.innerHTML = `
    <button class="btn btn-ghost btn-small" id="mt-back"><i class="ti ti-arrow-left"></i> Back to Tickets</button>
    <div id="mt-detail-body" style="margin-top:16px">${loadingBlock("Loading ticket…")}</div>`;
  document.getElementById("mt-back").addEventListener("click", () => { routes.go("/my-tickets"); renderMyTicketsPanel(root); });
  await paintTicketDetailBody(document.getElementById("mt-detail-body"), guildId, ticketId);
}

// Shared ticket-detail renderer (used by both My Tickets and a module's
// own ticket view) — the info panel (Author/Created/Subject/Closed By),
// claimed/unclaimed state, share-link controls, and the transcript.
//
// #5: every call now identifies the requester (the logged-in user) so
// the backend's authorizeTicketAccess() can enforce "owner or staff
// only" server-side — a denial here renders the same empty-state UI a
// 404 would, rather than silently falling back to showing the ticket
// anyway.
async function paintTicketDetailBody(body, guildId, ticketId) {
  const session = getSession();
  let data;
  try { data = await api(`/guilds/${guildId}/tickets/${ticketId}/transcript?requesterId=${session?.user?.id || ""}`); }
  catch (e) {
    body.innerHTML = `<div class="empty-state"><i class="ti ti-lock-off glyph"></i>${escapeHtml(e.message || "Couldn't load this ticket.")}</div>`;
    return;
  }
  const { ticket, messages, hasLog, opener, claimer, closer } = data;
  body.innerHTML = `
    <div class="ticket-detail-layout">
      <div class="ticket-detail-main">
        <h3 style="font-size:16px;font-weight:700">${escapeHtml(ticket.subject || "No subject")} <span class="field-hint" style="font-weight:400">#${escapeHtml(String(ticket.number ?? ticket.id))}</span></h3>
        <div class="field-hint" style="margin:6px 0 14px"><span class="badge badge-${ticket.status}">${ticket.status}</span> · ${escapeHtml(ticket.subject || "General")} · Created ${timeAgoGlobal(ticket.createdAt)}</div>
        <div class="transcript-body" style="max-height:60vh">
          ${!hasLog
            ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No message log available for this ticket.</div>`
            : messages.length === 0
              ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No messages were sent in this ticket.</div>`
              : messages.map(m => `
                <div class="msg-container ${m.deleted ? "deleted" : ""}">
                  <img class="msg-container-avatar" src="${m.authorAvatar ? escapeHtml(m.authorAvatar) : "https://cdn.discordapp.com/embed/avatars/0.png"}" alt="">
                  <div class="msg-container-body">
                    <div class="msg-container-meta">
                      <span class="msg-container-author">${escapeHtml(m.authorName)}</span>
                      ${m.authorIsBot ? `<span class="staff-tag" style="background:rgba(125,211,252,.14);color:var(--sky, #7dd3fc)">APP</span>` : ""}
                      ${m.authorIsStaff ? `<span class="staff-tag">STAFF</span>` : ""}
                      <span class="msg-container-time">${new Date(m.createdAt).toLocaleString()}</span>
                      ${m.deleted ? `<span class="transcript-msg-deleted-tag"><i class="ti ti-trash"></i> deleted</span>` : ""}
                    </div>
                    <div class="msg-container-content">${escapeHtml(m.content) || `<span class="field-hint">(no text content)</span>`}</div>
                  </div>
                </div>`).join("")}
        </div>
      </div>
      <div class="ticket-detail-sidebar">
        <h4>Ticket Information</h4>
        <div class="ticket-info-row"><i class="ti ti-user"></i><div><div class="ticket-info-label">Author</div><div class="ticket-info-val">${userDisplayHtml(opener, ticket.openedById || ticket.openedBy)}</div></div></div>
        <div class="ticket-info-row"><i class="ti ti-calendar"></i><div><div class="ticket-info-label">Created</div><div class="ticket-info-val">${timeAgoGlobal(ticket.createdAt)}</div></div></div>
        <div class="ticket-info-row"><i class="ti ti-tag"></i><div><div class="ticket-info-label">Subject</div><div class="ticket-info-val"><span class="cc-trigger-chip" style="background:rgba(139,92,246,.14);color:var(--violet);border-color:rgba(139,92,246,.3)">${escapeHtml(ticket.subject || "—")}</span></div></div></div>
        <div class="ticket-info-row"><i class="ti ti-lock"></i><div><div class="ticket-info-label">Claimed By</div><div class="ticket-info-val">${ticket.claimedBy ? userDisplayHtml(claimer, ticket.claimedById || ticket.claimedBy) : `<span class="field-hint">Not claimed yet</span>`}</div></div></div>
        ${ticket.status === "closed" ? `
        <div class="ticket-info-row"><i class="ti ti-lock-check"></i><div><div class="ticket-info-label">Closed By</div><div class="ticket-info-val">${userDisplayHtml(closer, ticket.closedById || ticket.closedBy)}</div><div class="field-hint">${timeAgoGlobal(ticket.closedAt)}</div></div></div>`
          : `<div class="field-hint" style="margin-top:8px"><i class="ti ti-lock-open"></i> This ticket hasn't been closed yet.</div>`}
        <div class="ticket-share-block" id="ticket-share-block-wrap">
          <div id="ticket-share-controls">${loadingBlock("")}</div>
        </div>
      </div>
    </div>`;
  paintTicketShareControls(document.getElementById("ticket-share-controls"), guildId, ticketId, ticket);
}

// #4: share-link controls only render at all when sharing is enabled
// for this server — while it's off, no share-link UI is shown (not
// even a disabled state), per "Users should not see share-link
// functionality" when the setting is off.
async function paintTicketShareControls(slot, guildId, ticketId, ticket) {
  let sharingEnabled = false;
  try { sharingEnabled = (await api(`/guilds/${guildId}/sharing-settings`)).sharingEnabled; } catch { /* default false on failure */ }
  const wrap = document.getElementById("ticket-share-block-wrap");
  if (!sharingEnabled) { if (wrap) wrap.style.display = "none"; return; }
  if (wrap) wrap.style.display = "";

  const session = getSession();
  const shareUrl = ticket.currentShareId ? `${window.location.origin}${CFG.BASE_PATH.replace(/\/$/, "")}/share/${ticket.currentShareId}` : null;
  slot.innerHTML = `<div class="config-row-label" style="margin-bottom:8px">Share link</div>` + (shareUrl
    ? `<div class="dc-share-link"><input type="text" readonly value="${escapeHtml(shareUrl)}" id="ticket-share-url"></div>
       <div class="field-row-inline" style="margin-top:8px">
         <button class="btn btn-ghost btn-small" id="ticket-share-copy"><i class="ti ti-copy"></i> Copy</button>
         <button class="btn btn-ghost btn-small" id="ticket-share-regen"><i class="ti ti-refresh"></i> Regenerate</button>
       </div>`
    : `<button class="btn btn-primary btn-small" id="ticket-share-create"><i class="ti ti-link"></i> Create share link</button>`);

  const createBtn = document.getElementById("ticket-share-create");
  if (createBtn) createBtn.addEventListener("click", async () => {
    try { await api(`/guilds/${guildId}/tickets/${ticketId}/share`, { method: "POST", body: JSON.stringify({ requesterId: session?.user?.id }) }); await refreshShareControls(); }
    catch (e) { await DCModal.alert(`Couldn't create share link: ${e.message}`); }
  });
  const copyBtn = document.getElementById("ticket-share-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    document.getElementById("ticket-share-url").select();
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
  });
  const regenBtn = document.getElementById("ticket-share-regen");
  if (regenBtn) regenBtn.addEventListener("click", async () => {
    const ok = await DCModal.confirm("The old link will stop working immediately. Continue?", { title: "Regenerate share link", confirmLabel: "Regenerate" });
    if (!ok) return;
    try { await api(`/guilds/${guildId}/tickets/${ticketId}/share`, { method: "POST", body: JSON.stringify({ requesterId: session?.user?.id }) }); await refreshShareControls(); }
    catch (e) { await DCModal.alert(`Couldn't regenerate: ${e.message}`); }
  });

  async function refreshShareControls() {
    try {
      const fresh = await api(`/guilds/${guildId}/tickets/${ticketId}/transcript?requesterId=${session?.user?.id || ""}`);
      paintTicketShareControls(slot, guildId, ticketId, fresh.ticket);
    } catch { /* keep old controls visible on failure */ }
  }
}

// ============================================================
// Public share page — no auth, reachable at /share/:shareId
// ============================================================
async function enterSharePage(shareId) {
  showScreen("screen-share");
  const root = document.getElementById("share-root");
  root.innerHTML = loadingBlock("Loading ticket…");
  try {
    const data = await api(`/share/tickets/${shareId}`);
    const { ticket, guildName, messages } = data;
    root.innerHTML = `
      <div class="brand-row" style="margin-bottom:18px"><div class="brand-glyph">NX</div>NEXORA</div>
      <div class="modal-panel" style="max-width:800px;max-height:none;margin:0 auto">
        <div class="transcript-header">
          <div>
            <h3 style="font-size:16px;font-weight:700">${escapeHtml(ticket.subject || "No subject")} <span class="field-hint" style="font-weight:400">#${escapeHtml(String(ticket.number ?? ticket.id))}</span></h3>
            <div class="field-hint" style="margin-top:2px">${escapeHtml(guildName)} · <span class="badge badge-${ticket.status}">${ticket.status}</span> · Created ${timeAgoGlobal(ticket.createdAt)}</div>
          </div>
        </div>
        <div class="transcript-body" style="max-height:70vh">
          ${messages.length === 0
            ? `<div class="empty-state"><i class="ti ti-message-off glyph"></i>No messages were sent in this ticket.</div>`
            : messages.map(m => `
              <div class="transcript-msg ${m.deleted ? "deleted" : ""}">
                <img class="transcript-msg-avatar" src="${m.authorAvatar ? escapeHtml(m.authorAvatar) : "https://cdn.discordapp.com/embed/avatars/0.png"}" alt="">
                <div class="transcript-msg-body">
                  <div class="transcript-msg-meta">
                    <span class="transcript-msg-author">${escapeHtml(m.authorName)}</span>
                    ${m.authorIsStaff ? `<span class="staff-tag">STAFF</span>` : ""}
                    <span class="transcript-msg-time">${new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div class="transcript-msg-content">${escapeHtml(m.content) || `<span class="field-hint">(no text content)</span>`}</div>
                </div>
              </div>`).join("")}
        </div>
      </div>`;
  } catch (e) {
    root.innerHTML = `
      <div class="brand-row" style="margin-bottom:18px"><div class="brand-glyph">NX</div>NEXORA</div>
      <div class="empty-state"><i class="ti ti-link-off glyph"></i>${escapeHtml(e.message || "This share link is invalid.")}</div>`;
  }
}

// ============================================================
// My Servers (#16) — servers with NEXORA already installed (where the
// user has the required permissions) and servers where NEXORA can be
// added (where the user can manage the bot but it isn't installed
// yet). Servers the user can't manage at all are never shown in
// either section.
// ============================================================
async function renderMyServersPanel(root) {
  root.innerHTML = `
    <h1 class="picker-heading">My Servers</h1>
    <p class="picker-sub">Servers you can manage — with NEXORA installed, and where you can add it.</p>
    <div id="my-servers-body">${loadingBlock("Loading your servers…")}</div>`;
  const body = document.getElementById("my-servers-body");
  const session = getSession();
  try {
    const guilds = await fetchMyGuilds(session.token);
    const manageable = guilds.filter(isAdmin);
    await refreshHeroStatus();
    const botGuildIds = new Set((botInfoCache?.guilds || []).map(g => g.id));
    const withBot = manageable.filter(g => botGuildIds.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));
    const withoutBot = manageable.filter(g => !botGuildIds.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));

    function cardHtml(g, hasBot) {
      const iconHtml = g.icon ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">` : initials(g.name);
      const roleBadge = g.owner ? `<span class="role-badge owner"><i class="ti ti-crown"></i> Owner</span>` : `<span class="role-badge admin"><i class="ti ti-shield"></i> Admin</span>`;
      return `
        <div class="server-card ${hasBot ? "" : "bot-absent"}" data-server-name="${escapeHtml(g.name.toLowerCase())}">
          <div class="server-icon">${iconHtml}</div>
          <div class="server-name">${escapeHtml(g.name)}</div>
          <div class="server-meta">${roleBadge}</div>
          <div class="server-card-actions">
            ${hasBot
              ? `<button class="btn btn-primary btn-small" data-open-dash="${g.id}" data-name="${escapeHtml(g.name)}" data-icon="${g.icon || ""}">Dashboard</button>`
              : `<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${inviteUrl(g.id)}"><i class="ti ti-plus"></i> Add NEXORA</a>`}
          </div>
        </div>`;
    }

    body.innerHTML = `
      <div class="servers-search-row">
        <input type="text" class="search-input" id="my-servers-search" placeholder="Search your servers…">
      </div>
      <div class="my-servers-section">
        <div class="my-servers-section-title"><i class="ti ti-server-2"></i> Servers with NEXORA <span class="badge badge-open">${withBot.length}</span></div>
        <div class="server-grid" id="my-servers-with-bot">
          ${withBot.length ? withBot.map(g => cardHtml(g, true)).join("") : `<div class="empty-state" style="grid-column:1/-1">NEXORA isn't installed on any server you manage yet.</div>`}
        </div>
      </div>
      <div class="my-servers-section">
        <div class="my-servers-section-title"><i class="ti ti-plus"></i> Servers without NEXORA <span class="badge badge-pending">${withoutBot.length}</span></div>
        <div class="server-grid" id="my-servers-without-bot">
          ${withoutBot.length ? withoutBot.map(g => cardHtml(g, false)).join("") : `<div class="empty-state" style="grid-column:1/-1">NEXORA is already on every server you manage.</div>`}
        </div>
      </div>`;

    function wireDashButtons() {
      body.querySelectorAll("[data-open-dash]").forEach(btn => {
        btn.addEventListener("click", () => {
          currentGuild = { id: btn.dataset.openDash, name: btn.dataset.name, icon: btn.dataset.icon };
          routes.go(routes.moduleUrl(currentGuild.id, "ticket-tool"));
          enterDashboard("ticket-tool");
        });
      });
    }
    wireDashButtons();

    // #15-style search, scoped to this My Servers view: filters both
    // sections by server name as the user types, no page reload.
    document.getElementById("my-servers-search").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      body.querySelectorAll(".server-card[data-server-name]").forEach(card => {
        card.style.display = card.dataset.serverName.includes(q) ? "" : "none";
      });
    });
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Couldn't load your servers: ${escapeHtml(e.message)}</div>`;
  }
}

// ============================================================
// Dashboard shell
// ============================================================
// Status isn't a real module (it has no server-side .server.js, no
// toggle, no Module_Data file) — it's core dashboard functionality, so
// it lives in CORE_PANELS rather than window.DC.modules. It still
// renders through the exact same switchPanel/buildSidebar machinery as
// every module, which is what makes it show the same full sidebar
// (server context, module list, profile/theme footer) instead of a
// separate stripped-down screen.
const CORE_PANELS = [{ id: "status", label: "Status", icon: "ti-activity" }];

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
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

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
    modulesLoadFailed = true;
  }
}

function buildContext(extra = {}) {
  const session = getSession();
  return {
    guildId: currentGuild.id,
    userId: session?.user?.id,
    api: (path, options) => api(path, options),
    modal: DCModal,
    routes,
    // Exposed so a module (ticket-tool) can render the same ticket detail
    // page — info panel, transcript, share-link controls — that My
    // Tickets and the deep-linked /ticket/:id route use, instead of
    // reimplementing its own transcript viewer.
    renderTicketDetail: (container, guildId, ticketId) => paintTicketDetailBody(container, guildId, ticketId),
    openerPreviewHtml,
    userDisplayHtml,
    navigateToTab: (tab) => { routes.go(routes.moduleUrl(currentGuild.id, currentPanelId, tab)); switchTab(tab); },
    navigateToTicket: (ticketId) => { routes.go(routes.ticketUrl(currentGuild.id, currentPanelId, ticketId)); switchToTicketView(ticketId); },
    ...extra,
  };
}

// Used by navigateToTicket so a module can push a person straight into a
// ticket's detail view without a full page navigation — mirrors what
// enterDashboard does for a page-load-time deep link.
function switchToTicketView(ticketId) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === currentPanelId));
  const root = document.getElementById("module-root");
  root.innerHTML = `<button class="btn btn-ghost btn-small" id="dash-ticket-back"><i class="ti ti-arrow-left"></i> Back</button><div id="dash-ticket-body" style="margin-top:16px">${loadingBlock("Loading ticket…")}</div>`;
  document.getElementById("dash-ticket-back").addEventListener("click", () => { routes.go(routes.moduleUrl(currentGuild.id, currentPanelId)); switchPanel(currentPanelId, false); });
  paintTicketDetailBody(document.getElementById("dash-ticket-body"), currentGuild.id, ticketId);
}

function navItemHtml(id, icon, label, toggleable, isEnabled) {
  const disabledClass = toggleable && !isEnabled ? "module-disabled" : "";
  return `<div class="nav-item ${disabledClass}" data-panel="${id}" title="${escapeHtml(label)}">
    <i class="ti ${icon}" aria-hidden="true"></i><span class="nav-item-label">${escapeHtml(label)}</span>
    ${toggleable ? `<button class="toggle nav-item-toggle ${isEnabled ? "on" : ""}" data-module-toggle="${id}" aria-label="Toggle ${escapeHtml(label)}"></button>` : ""}
  </div>`;
}

function buildSidebar(disabledModules) {
  disabledModules = disabledModules || [];
  const wrap = document.getElementById("dash-nav-items");
  // The custom-commands module's built-in "Bot Status" slash command is
  // intentionally excluded here — it's a Discord slash command, not a
  // dashboard page, and only ever appears in that module's own command
  // list. This dashboard's own Status page is added via CORE_PANELS
  // below instead, since it's not a toggleable module.
  const modules = (window.DC?.modules || []).filter(m => m.id !== "status");
  // Preserve which panel is currently open across the rebuild below —
  // wrap.innerHTML replaces every .nav-item from scratch, which would
  // otherwise silently drop the .active class (and, since the module
  // toggle is only shown on the active item per its CSS, make the
  // toggle disappear) every time this runs, e.g. right after using
  // that very toggle.
  const activePanel = wrap.querySelector(".nav-item.active")?.dataset.panel || null;

  const modulesHtml = modules.length
    ? `<div class="nav-section-label">Modules</div>${modules.map(m => navItemHtml(m.id, m.icon, m.label, true, !disabledModules.includes(m.id))).join("")}`
    : "";
  const generalHtml = CORE_PANELS.length ? `<div class="nav-section-label">General</div>${CORE_PANELS.map(p => navItemHtml(p.id, p.icon, p.label, false)).join("")}` : "";

  wrap.innerHTML = modulesHtml + generalHtml;
  if (activePanel) wrap.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === activePanel));
  wrap.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", (e) => {
    if (e.target.closest("[data-module-toggle]")) return;
    routes.go(routes.moduleUrl(currentGuild.id, n.dataset.panel));
    switchPanel(n.dataset.panel, false);
  }));
  wrap.querySelectorAll("[data-module-toggle]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const moduleId = btn.dataset.moduleToggle;
    const turningOn = !btn.classList.contains("on");
    openModuleToggleConfirm(moduleId, turningOn, btn, disabledModules);
  }));
}

async function openModuleToggleConfirm(moduleId, turningOn, btn, disabledModules) {
  const label = (window.DC?.modules || []).find(m => m.id === moduleId)?.label || moduleId;
  const ok = await DCModal.confirm(
    `${label} keeps working normally either way — this only changes how it looks in your sidebar.`,
    { title: `${turningOn ? "Turn on" : "Turn off"} ${label}?`, confirmLabel: turningOn ? "Turn on" : "Turn off" }
  );
  if (!ok) return;
  try {
    await api(`/guilds/${currentGuild.id}/modules/${moduleId}`, { method: "PUT", body: JSON.stringify({ enabled: turningOn }) });
    currentGuildDisabledModules = turningOn ? disabledModules.filter(id => id !== moduleId) : [...disabledModules, moduleId];
    buildSidebar(currentGuildDisabledModules);
    // The toggle is only ever visible on the module you're currently
    // looking at (see navItemHtml/CSS), so flipping it always affects
    // the open module — update its overlay immediately rather than
    // requiring a navigate-away-and-back to see the change take effect.
    if (currentPanelId === moduleId) setModuleDisabledOverlay(!turningOn);
  } catch (e2) { await DCModal.alert(`Couldn't update module: ${e2.message}`); }
}

// Shows/hides the translucent "this module is off" overlay on top of
// module-root — the module underneath keeps rendering and working
// completely normally either way (toggling is purely cosmetic); this
// never replaces its content, only sits above it.
function setModuleDisabledOverlay(isDisabled) {
  const wrap = document.getElementById("module-root-wrap");
  const overlay = document.getElementById("module-disabled-overlay");
  if (!wrap || !overlay) return;
  wrap.classList.toggle("disabled-active", isDisabled);
  overlay.style.display = isDisabled ? "flex" : "none";
}

let currentPanelId = "ticket-tool";
let currentTab = null;

async function enterDashboard(panel, { tab, ticketId } = {}) {
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

  currentPanelId = panel;
  currentTab = tab || null;

  if (ticketId) {
    document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === panel));
    const root = document.getElementById("module-root");
    root.innerHTML = `<button class="btn btn-ghost btn-small" id="dash-ticket-back"><i class="ti ti-arrow-left"></i> Back</button><div id="dash-ticket-body" style="margin-top:16px">${loadingBlock("Loading ticket…")}</div>`;
    document.getElementById("dash-ticket-back").addEventListener("click", () => { routes.go(routes.moduleUrl(currentGuild.id, panel)); switchPanel(panel, false); });
    await paintTicketDetailBody(document.getElementById("dash-ticket-body"), currentGuild.id, ticketId);
    return;
  }

  switchPanel(panel, false, tab);
}

function switchPanel(name, updateUrl = true, tab = null) {
  currentPanelId = name;
  currentTab = tab;
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === name));
  if (updateUrl) routes.go(routes.moduleUrl(currentGuild.id, name, tab));

  // A disabled module still renders and works completely normally
  // underneath (toggling is purely cosmetic) — setModuleDisabledOverlay
  // only adds a translucent grey overlay with a centered "this module
  // is off" message on top of it, and never skips actually rendering
  // the module itself.
  setModuleDisabledOverlay(currentGuildDisabledModules.includes(name));

  const root = document.getElementById("module-root");
  root.innerHTML = loadingBlock();

  const mod = window.DC?.getModule(name);
  if (mod) { mod.render(root, buildContext(), tab); return; }

  const renderers = { status: renderStatusModule };
  (renderers[name] || renderStatusModule)(root);
}

function switchTab(tab) {
  currentTab = tab;
  routes.go(routes.moduleUrl(currentGuild.id, currentPanelId, tab));
}

// ============================================================
// Status module — colored uptime bar (green/yellow/orange/red by worst
// incident severity that day) with a HOVER tooltip (#17 — no click
// required) showing that day's detail.
// ============================================================
async function renderStatusModule(root) {
  await refreshHeroStatus();
  root.innerHTML = `<div class="dash-header"><div><h1>Status</h1><p>Uptime history for your bot.</p></div></div><div id="status-body">${loadingBlock()}</div>`;
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

  const days = history.days || [];
  body.innerHTML = `
    <div class="status-banner ${history.online ? "up" : "down"}"><i class="ti ${history.online ? "ti-circle-check" : "ti-alert-triangle"}"></i> ${history.online ? "All Systems Operational" : "Bot Offline"}</div>
    <div class="status-uptime-card">
      <div class="status-uptime-header">
        <span>Bot process</span>
        <span class="status-pip ${history.online ? "online" : "offline"}"><span class="status-dot"></span>${history.online ? "Operational" : "Down"}</span>
      </div>
      <div class="status-daybar" id="status-daybar">
        ${days.map((d, i) => `<div class="status-day status-day-${d.severity}" data-day-idx="${i}"></div>`).join("")}
      </div>
      <div class="status-daybar-footer">
        <span>90 days ago</span>
        <span>${history.uptimePercent}% uptime over 90 days</span>
        <span>Today</span>
      </div>
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
            <span class="config-row-label"><span class="severity-dot severity-${i.severity}"></span>${new Date(i.startedAt).toLocaleString()}${i.note ? `<div class="field-hint" style="margin-top:2px;font-weight:400">${escapeHtml(i.note)}</div>` : ""}</span>
            <span class="config-row-label" style="font-weight:400;color:var(--text-dim)">${formatDuration(i.durationSeconds)} downtime</span>
          </div>`).join("")}
    </div>`;

  wireStatusDayHoverTooltip(days, history.incidents);
  paintStatusModulesList();
}

async function paintStatusModulesList() {
  const slot = document.getElementById("status-modules-list");
  if (!slot) return;
  try {
    const meta = await api(`/guilds/${currentGuild.id}/meta?userId=${getSession().user.id}`);
    const disabled = meta.disabledModules || [];
    const modules = (window.DC?.modules || []).filter(m => m.id !== "status");
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

// #17: hover (not click) opens a small fixed-position tooltip that
// follows the mouse across the bar — "September 12 / Incident: Bot
// restarted unexpectedly." or "September 13 / No incidents." — and
// disappears immediately on mouseleave. One tooltip element is reused
// for the whole bar rather than one per day, repositioned/repainted on
// each mouseenter.
function wireStatusDayHoverTooltip(days, incidents) {
  const bar = document.getElementById("status-daybar");
  if (!bar) return;

  let tooltip = document.getElementById("status-day-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "status-day-tooltip";
    tooltip.className = "status-day-tooltip";
    document.body.appendChild(tooltip);
  }

  function positionTooltip(target) {
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${rect.top - tipRect.height - 10}px`;
  }

  bar.querySelectorAll("[data-day-idx]").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const d = days[+el.dataset.dayIdx];
      const dayIncidents = incidents.filter(i => new Date(i.startedAt).toISOString().slice(0, 10) === d.date);
      const dateLabel = new Date(d.date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
      tooltip.innerHTML = `
        <div class="status-day-tooltip-date">${dateLabel}</div>
        ${dayIncidents.length === 0
          ? `<div class="status-day-tooltip-none"><i class="ti ti-check"></i> No incidents.</div>`
          : dayIncidents.map(i => `
            <div class="status-day-tooltip-row">
              <span class="severity-dot severity-${i.severity}" style="margin-top:3px"></span>
              <span>Incident:<br>${escapeHtml(i.note || `${formatDuration(i.durationSeconds)} downtime`)}</span>
            </div>`).join("")}`;
      tooltip.classList.add("visible");
      positionTooltip(el);
    });
    el.addEventListener("mousemove", () => positionTooltip(el));
    el.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
  });
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
  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    else console.warn(`Wiring: #${id} not found in the page — skipping its listener.`);
  }

  on("btn-login", "click", (e) => { e.preventDefault(); beginLogin(); });
  on("btn-invite", "click", (e) => { e.preventDefault(); window.open(inviteUrl(), "_blank"); });
  on("btn-logout", "click", () => { clearSession(); routes.go("/", true); showScreen("screen-landing"); });
  on("btn-back", "click", () => {
    if (window.location.pathname.includes("/servers/")) { routes.go("/dashboard"); enterPicker(); }
    else window.history.back();
  });

  boot();
  setInterval(async () => {
    const wasOnline = botInfoCache?.online;
    await refreshHeroStatus();
    if (!wasOnline && botInfoCache?.online && document.getElementById("screen-dashboard").classList.contains("active")) {
      await ensureModulesLoaded();
      buildSidebar(currentGuildDisabledModules);
    }
  }, 15000);
});

// Expose the modal API for modules to use.
window.DC = window.DC || {};
window.DC.modal = DCModal;

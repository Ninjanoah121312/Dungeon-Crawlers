// ============================================================
// Ticket Keeper — frontend app logic
// Runs entirely client-side on GitHub Pages. Talks to:
//   1) Discord's public OAuth + API endpoints directly (PKCE flow,
//      no client secret needed here)
//   2) Your locally hosted bot (bot/bot.js) over http://localhost:3001
//      for anything that needs the bot token / GitHub token
// ============================================================

const CFG = window.TICKET_KEEPER_CONFIG;
const LS = {
  verifier: "tk_pkce_verifier",
  token: "tk_access_token",
  tokenExpiry: "tk_token_expiry",
  user: "tk_user",
};

// ---------- tiny router between the 3 screens ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ---------- PKCE helpers ----------
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeVerifierAndChallenge() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(digest);
  return { verifier, challenge };
}

async function beginLogin() {
  const { verifier, challenge } = await makeVerifierAndChallenge();
  sessionStorage.setItem(LS.verifier, verifier);
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
  // NOTE: Discord's token endpoint requires a client secret UNLESS your
  // app is registered as a "public client". If Discord rejects this
  // (invalid_client), you have two options:
  //   a) In the Developer Portal, check if your app can be flagged public
  //   b) Route this one exchange through your local bot instead:
  //      POST {LOCAL_BOT_URL}/oauth/exchange { code, verifier }
  // We try direct first, then fall back to the local bot automatically.
  const body = new URLSearchParams({
    client_id: CFG.DISCORD_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: CFG.REDIRECT_URI,
    code_verifier: verifier,
  });

  try {
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error("direct exchange failed");
    return await res.json();
  } catch (e) {
    // Fallback: ask the local bot to do the exchange (it holds the secret)
    const res2 = await fetch(`${CFG.LOCAL_BOT_URL}/oauth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
function clearSession() {
  [LS.token, LS.tokenExpiry, LS.user].forEach(k => localStorage.removeItem(k));
}

// ---------- Discord API (direct, using the user's own access token) ----------
async function fetchMe(token) {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load Discord profile");
  return res.json();
}
async function fetchMyGuilds(token) {
  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load your servers");
  return res.json();
}
const MANAGE_GUILD = 0x20;
function canManage(guild) {
  return (BigInt(guild.permissions) & BigInt(MANAGE_GUILD)) === BigInt(MANAGE_GUILD) || guild.owner;
}

// ---------- Local bot bridge ----------
async function pingLocalBot() {
  try {
    const res = await fetch(`${CFG.LOCAL_BOT_URL}/status`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error();
    return await res.json(); // { online, guildCount, uptimeSeconds, guilds: [...] }
  } catch {
    return null;
  }
}
async function fetchGuildTickets(guildId) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}/guilds/${guildId}/tickets`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error("Could not load tickets from local bot");
  return res.json();
}
async function fetchGuildConfig(guildId) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}/guilds/${guildId}/config`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error("Could not load config from local bot");
  return res.json();
}
async function saveGuildConfig(guildId, config) {
  const res = await fetch(`${CFG.LOCAL_BOT_URL}/guilds/${guildId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Could not save config");
  return res.json();
}

// ---------- status pip rendering ----------
function renderStatusPip(el, botInfo) {
  el.classList.remove("online", "offline", "checking");
  if (botInfo && botInfo.online) {
    el.classList.add("online");
    el.innerHTML = `<span class="status-dot"></span>Bot online`;
  } else {
    el.classList.add("offline");
    el.innerHTML = `<span class="status-dot"></span>Bot offline`;
  }
}

function renderLocalBanner(slotId, botInfo) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  if (botInfo) {
    slot.innerHTML = `<div class="local-banner ok">✓ Connected to your local bot at ${CFG.LOCAL_BOT_URL}</div>`;
  } else {
    slot.innerHTML = `<div class="local-banner">⚠ Can't reach your local bot at ${CFG.LOCAL_BOT_URL}. Ticket data, config, and status won't load until bot.js is running on your machine.</div>`;
  }
}

// ---------- boot ----------
let currentGuild = null;
let botInfoCache = null;
let ticketsCache = [];

async function boot() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");

  // fire status check immediately, independent of auth state
  refreshHeroStatus();

  if (code) {
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.toString());
    try {
      const tokenData = await exchangeCodeForToken(code);
      const user = await fetchMe(tokenData.access_token);
      saveSession(tokenData, user);
      await enterPicker();
    } catch (e) {
      alert(e.message || "Login failed");
      showScreen("screen-landing");
    }
    return;
  }

  const session = getSession();
  if (session) {
    await enterPicker();
  } else {
    showScreen("screen-landing");
  }
}

async function refreshHeroStatus() {
  const info = await pingLocalBot();
  botInfoCache = info;
  const heroPip = document.getElementById("hero-status-pip");
  if (heroPip) renderStatusPip(heroPip, info);
  const guildCountEl = document.getElementById("hero-guild-count");
  const uptimeEl = document.getElementById("hero-uptime");
  const statStatus = document.getElementById("stat-status");
  const statServers = document.getElementById("stat-servers");
  if (info) {
    if (guildCountEl) guildCountEl.textContent = info.guildCount ?? "—";
    if (uptimeEl) uptimeEl.textContent = formatUptime(info.uptimeSeconds);
    if (statStatus) statStatus.textContent = "Online";
    if (statServers) statServers.textContent = info.guildCount ?? "—";
  } else {
    if (statStatus) statStatus.textContent = "Offline";
  }
  ["picker-status-pip", "dash-status-pip", "ov-bot-pip"].forEach(id => {
    const el = document.getElementById(id);
    if (el) renderStatusPip(el, info);
  });
  const ovUptime = document.getElementById("ov-uptime");
  if (ovUptime) ovUptime.textContent = info ? formatUptime(info.uptimeSeconds) : "—";
}

function formatUptime(sec) {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------- picker screen ----------
async function enterPicker() {
  showScreen("screen-picker");
  const session = getSession();
  const chip = document.getElementById("picker-user-chip");
  chip.innerHTML = `<img src="${avatarUrl(session.user)}" alt=""> ${session.user.username}`;

  await refreshHeroStatus();
  renderLocalBanner("local-banner-slot", botInfoCache);

  const grid = document.getElementById("server-grid");
  grid.innerHTML = `<div class="loading-text">Loading your servers…</div>`;

  try {
    const guilds = await fetchMyGuilds(session.token);
    const manageable = guilds.filter(canManage);
    if (manageable.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="glyph">🗂️</div>No servers found where you can manage tickets.<br>You need "Manage Server" permission.</div>`;
      return;
    }
    const botGuildIds = new Set((botInfoCache?.guilds || []).map(g => g.id));
    grid.innerHTML = manageable.map(g => {
      const hasBot = botGuildIds.has(g.id);
      const iconHtml = g.icon
        ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">`
        : initials(g.name);
      return `
        <div class="server-card ${hasBot ? "" : "bot-absent"}">
          <div class="server-icon">${iconHtml}</div>
          <div class="server-name">${escapeHtml(g.name)}</div>
          <div class="server-meta">${hasBot ? "Bot is in this server" : "Bot not added yet"}</div>
          <div class="server-card-actions">
            ${hasBot
              ? `<button class="btn btn-primary btn-small" data-open-dash="${g.id}" data-name="${escapeHtml(g.name)}" data-icon="${g.icon || ""}">Dashboard</button>`
              : `<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${inviteUrl(g.id)}">＋ Invite</a>`
            }
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll("[data-open-dash]").forEach(btn => {
      btn.addEventListener("click", () => {
        currentGuild = { id: btn.dataset.openDash, name: btn.dataset.name, icon: btn.dataset.icon };
        enterDashboard();
      });
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Couldn't load your servers. Try logging in again.</div>`;
  }
}

function inviteUrl(guildId) {
  const params = new URLSearchParams({
    client_id: CFG.DISCORD_CLIENT_ID,
    permissions: CFG.BOT_PERMISSIONS,
    scope: "bot applications.commands",
    guild_id: guildId,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
function avatarUrl(user) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${(Number(user.discriminator || 0)) % 5}.png`;
}
function initials(name) { return (name || "?").slice(0, 2).toUpperCase(); }
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

// ---------- dashboard screen ----------
async function enterDashboard() {
  showScreen("screen-dashboard");
  const session = getSession();
  document.getElementById("dash-user-chip").innerHTML = `<img src="${avatarUrl(session.user)}" alt=""> ${session.user.username}`;
  document.getElementById("dash-server-name").textContent = currentGuild.name;
  document.getElementById("dash-server-icon").innerHTML = currentGuild.icon
    ? `<img src="https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png" alt="">`
    : initials(currentGuild.name);

  await refreshHeroStatus();
  renderLocalBanner("local-banner-slot-dash", botInfoCache);
  switchPanel("overview");
  loadOverview();
}

function switchPanel(name) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.panel === name));
  document.querySelectorAll(".dash-panel").forEach(p => p.style.display = p.dataset.panel === name ? "block" : "none");
  if (name === "tickets") loadTickets();
  if (name === "config") loadConfig();
}

async function loadOverview() {
  if (!botInfoCache) return;
  try {
    const data = await fetchGuildTickets(currentGuild.id);
    ticketsCache = data.tickets || [];
    const open = ticketsCache.filter(t => t.status === "open").length;
    const pending = ticketsCache.filter(t => t.status === "pending").length;
    const closed = ticketsCache.filter(t => t.status === "closed").length;
    document.getElementById("ov-open").textContent = open;
    document.getElementById("ov-pending").textContent = pending;
    document.getElementById("ov-closed").textContent = closed;
    document.getElementById("ov-members").textContent = data.memberCount ?? "—";
  } catch (e) {
    // banner already communicates the offline state
  }
}

async function loadTickets(filter = "all") {
  const table = document.getElementById("ticket-table");
  if (!botInfoCache) {
    table.innerHTML = headRow() + `<div class="loading-text">Local bot is offline — start bot.js to load tickets.</div>`;
    return;
  }
  table.innerHTML = headRow() + `<div class="loading-text">Loading tickets…</div>`;
  try {
    if (ticketsCache.length === 0) {
      const data = await fetchGuildTickets(currentGuild.id);
      ticketsCache = data.tickets || [];
    }
    const rows = filter === "all" ? ticketsCache : ticketsCache.filter(t => t.status === filter);
    if (rows.length === 0) {
      table.innerHTML = headRow() + `<div class="empty-state"><div class="glyph">🎫</div>No tickets here yet.</div>`;
      return;
    }
    table.innerHTML = headRow() + rows.map(t => `
      <div class="ticket-row">
        <span>#${t.id}</span>
        <span>${escapeHtml(t.subject || "No subject")}</span>
        <span>${escapeHtml(t.openedBy || "Unknown")}</span>
        <span class="col-created">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</span>
        <span class="badge badge-${t.status}">${t.status}</span>
      </div>`).join("");
  } catch (e) {
    table.innerHTML = headRow() + `<div class="empty-state">Couldn't load tickets right now.</div>`;
  }
}
function headRow() {
  return `<div class="ticket-row head"><span>ID</span><span>Subject</span><span>Opened by</span><span class="col-created">Created</span><span>Status</span></div>`;
}

async function loadConfig() {
  if (!botInfoCache) return;
  try {
    const cfg = await fetchGuildConfig(currentGuild.id);
    if (cfg.channels) {
      document.getElementById("cfg-channel").innerHTML = cfg.channels.map(c => `<option value="${c.id}" ${c.id===cfg.ticketChannel?"selected":""}>#${c.name}</option>`).join("");
    }
    if (cfg.categories) {
      document.getElementById("cfg-category").innerHTML = cfg.categories.map(c => `<option value="${c.id}" ${c.id===cfg.ticketCategory?"selected":""}>${c.name}</option>`).join("");
    }
    if (cfg.roles) {
      document.getElementById("cfg-role").innerHTML = cfg.roles.map(r => `<option value="${r.id}" ${r.id===cfg.supportRole?"selected":""}>@${r.name}</option>`).join("");
    }
  } catch (e) { /* banner covers it */ }
}

// ---------- wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-login").addEventListener("click", (e) => { e.preventDefault(); beginLogin(); });
  document.getElementById("btn-invite").addEventListener("click", (e) => {
    e.preventDefault();
    window.open(`https://discord.com/oauth2/authorize?${new URLSearchParams({
      client_id: CFG.DISCORD_CLIENT_ID, permissions: CFG.BOT_PERMISSIONS, scope: "bot applications.commands",
    })}`, "_blank");
  });
  document.getElementById("btn-logout").addEventListener("click", () => { clearSession(); showScreen("screen-landing"); });
  document.getElementById("btn-logout2").addEventListener("click", () => { clearSession(); showScreen("screen-landing"); });
  document.getElementById("btn-back-picker").addEventListener("click", enterPicker);

  document.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", () => switchPanel(n.dataset.panel)));
  document.querySelectorAll(".filter-chip").forEach(c => c.addEventListener("click", () => {
    document.querySelectorAll(".filter-chip").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    loadTickets(c.dataset.filter);
  }));
  document.getElementById("btn-refresh-tickets").addEventListener("click", () => { ticketsCache = []; loadTickets(); });
  document.getElementById("btn-save-config").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-config");
    btn.textContent = "Saving…";
    try {
      await saveGuildConfig(currentGuild.id, {
        ticketChannel: document.getElementById("cfg-channel").value,
        ticketCategory: document.getElementById("cfg-category").value,
        supportRole: document.getElementById("cfg-role").value,
      });
      btn.textContent = "Saved ✓";
    } catch {
      btn.textContent = "Failed — is bot.js running?";
    }
    setTimeout(() => { btn.textContent = "Save changes"; }, 2200);
  });

  boot();
  setInterval(refreshHeroStatus, 15000);
});

// ============================================================
// PUBLIC CONFIG — safe to publish on GitHub Pages.
// Never put your bot token, client SECRET, or GitHub token here.
// Only the client ID (public by design) and public URLs belong here.
// ============================================================

window.TICKET_KEEPER_CONFIG = {
  // Your Discord application's Client ID (found on the Discord Developer
  // Portal -> your app -> OAuth2 -> General). This is PUBLIC, not secret.
  DISCORD_CLIENT_ID: "1545012669113827488",

  // Must exactly match a redirect URL you added in the Discord Developer
  // Portal -> OAuth2 -> Redirects. When hosted on GitHub Pages this will
  // look like: https://<your-username>.github.io/<repo-name>/
  REDIRECT_URI: "https://ninjanoah121312.github.io/Dungeon-Crawlers/",

  // Scopes requested during login.
  OAUTH_SCOPES: ["identify", "guilds"],

  // Where your locally hosted bot's bridge server is listening.
  // bot.js runs this — see bot/bot.js. Only reachable while your PC
  // and the bot are running; the site handles that being offline.
  LOCAL_BOT_URL: "http://localhost:3001",

  // Invite link scope/permissions used by the "Invite to server" button.
  // 268earth kept generic: adjust the `permissions` integer to match
  // exactly what your bot needs (Manage Channels, Manage Roles, etc).
  BOT_PERMISSIONS: "268435472"
};

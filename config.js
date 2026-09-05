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
  LOCAL_BOT_URL: "https://proposition-pittsburgh-bow-waiting.trycloudflare.com",

  // GitHub Pages project sites are served from a subpath, e.g.
  // /Dungeon-Crawlers/. The router needs this to build correct URLs
  // like /Dungeon-Crawlers/dashboard. Must match your repo name with
  // leading and trailing slash. Leave as "/" only if using a custom
  // domain or a user/organization root site (username.github.io).
  BASE_PATH: "/Dungeon-Crawlers/",

  // Invite link scope/permissions used by the "Invite to server" button.
  // Adjust the `permissions` integer to match exactly what your bot
  // needs (Manage Channels, Manage Roles, etc).
  BOT_PERMISSIONS: "268435472"
};

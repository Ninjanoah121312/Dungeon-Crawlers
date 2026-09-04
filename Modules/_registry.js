// ============================================================
// Module registry — each file in site/modules/ calls
// DC.registerModule({ id, label, icon, section, render, onEnter })
// to add itself here. The dashboard shell (app.js) reads this list
// to build the sidebar and to render whichever module is active.
// Kept as plain local files (not fetched from GitHub at runtime) —
// executing remote JS pulled live from a repo on every page load
// would let anyone with write access to that path run code inside
// your dashboard session. Same "one file per module" organization,
// without that exposure.
// ============================================================

window.DC = window.DC || {};
window.DC.modules = [];

window.DC.registerModule = function (mod) {
  if (!mod || !mod.id || typeof mod.render !== "function") {
    console.error("Invalid module registration", mod);
    return;
  }
  window.DC.modules.push(mod);
};

window.DC.getModule = function (id) {
  return window.DC.modules.find(m => m.id === id);
};

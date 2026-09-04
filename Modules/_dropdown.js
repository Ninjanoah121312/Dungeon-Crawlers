// ============================================================
// Custom dropdown component — replaces native <select> with a
// styled, searchable list matching the reference screenshots
// (dark panel, checkmark on selected item, channel/role icons).
// ============================================================

window.DC = window.DC || {};

/**
 * Renders a custom dropdown into `container`.
 * options: [{ value, label, icon (optional html), sub (optional muted text) }]
 * Returns { getValue(), setValue(val), onChange(fn) }
 */
window.DC.createDropdown = function (container, { options, value, placeholder, searchable = false, onChange }) {
  let current = value ?? null;
  let listeners = [];
  let open = false;

  container.innerHTML = "";
  container.classList.add("dc-dropdown");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dc-dropdown-trigger";
  container.appendChild(trigger);

  const panel = document.createElement("div");
  panel.className = "dc-dropdown-panel";
  panel.style.display = "none";
  container.appendChild(panel);

  let searchInput = null;
  if (searchable) {
    searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search…";
    searchInput.className = "dc-dropdown-search";
    panel.appendChild(searchInput);
  }

  const list = document.createElement("div");
  list.className = "dc-dropdown-list";
  panel.appendChild(list);

  function paintTrigger() {
    const opt = options.find(o => o.value === current);
    trigger.innerHTML = `
      <span class="dc-dropdown-trigger-content">${opt ? (opt.icon || "") + escapeLabel(opt.label) : `<span class="dc-dropdown-placeholder">${placeholder || "Select…"}</span>`}</span>
      <i class="ti ti-chevron-down"></i>`;
  }
  function escapeLabel(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function paintList(filter) {
    const q = (filter || "").toLowerCase();
    const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
    if (filtered.length === 0) { list.innerHTML = `<div class="dc-dropdown-empty">No matches</div>`; return; }
    list.innerHTML = filtered.map(o => `
      <div class="dc-dropdown-item ${o.value === current ? "selected" : ""}" data-val="${escapeLabel(String(o.value))}">
        <span class="dc-dropdown-item-main">${o.icon || ""}<span>${escapeLabel(o.label)}</span>${o.sub ? `<span class="dc-dropdown-item-sub">${escapeLabel(o.sub)}</span>` : ""}</span>
        ${o.value === current ? `<i class="ti ti-check"></i>` : ""}
      </div>`).join("");
    list.querySelectorAll("[data-val]").forEach(el => el.addEventListener("click", () => {
      const opt = options.find(o => String(o.value) === el.dataset.val);
      current = opt ? opt.value : el.dataset.val;
      paintTrigger();
      closePanel();
      listeners.forEach(fn => fn(current));
    }));
  }

  function openPanel() {
    open = true;
    panel.style.display = "block";
    paintList(searchInput ? searchInput.value : "");
    if (searchInput) { searchInput.value = ""; searchInput.focus(); }
    document.addEventListener("click", onDocClick, true);
  }
  function closePanel() {
    open = false;
    panel.style.display = "none";
    document.removeEventListener("click", onDocClick, true);
  }
  function onDocClick(e) { if (!container.contains(e.target)) closePanel(); }

  trigger.addEventListener("click", () => (open ? closePanel() : openPanel()));
  if (searchInput) searchInput.addEventListener("input", () => paintList(searchInput.value));

  paintTrigger();

  if (onChange) listeners.push(onChange);

  return {
    getValue: () => current,
    setValue: (val) => { current = val; paintTrigger(); },
    onChange: (fn) => listeners.push(fn),
  };
};

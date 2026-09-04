// ============================================================
// Ticket Tool module — everything ticket-related lives here.
// Registered into window.DC.modules; the dashboard shell mounts
// this only when the user opens the "Ticket Tool" sidebar entry.
// ============================================================

(function () {
  const state = {
    subjects: [],
    tickets: [],
    meta: null,
    panelCfg: null,
    wizard: null, // holds in-progress panel builder state
  };

  function esc(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  function loading(msg) { return `<div class="loading-wrap"><div class="spinner"></div><div>${msg || "Loading…"}</div></div>`; }

  async function ensureMeta(ctx) {
    if (state.meta) return state.meta;
    try { state.meta = await ctx.api(`/guilds/${ctx.guildId}/meta?userId=${ctx.userId}`); } catch { state.meta = null; }
    return state.meta;
  }
  async function loadSubjects(ctx) {
    try { const d = await ctx.api(`/guilds/${ctx.guildId}/subjects`); state.subjects = d.subjects || []; } catch { state.subjects = []; }
    return state.subjects;
  }
  async function loadTickets(ctx) {
    try { const d = await ctx.api(`/guilds/${ctx.guildId}/tickets`); state.tickets = d.tickets || []; return d; } catch { state.tickets = []; return { tickets: [] }; }
  }
  async function loadPanelCfg(ctx) {
    try { state.panelCfg = await ctx.api(`/guilds/${ctx.guildId}/panel`); } catch { state.panelCfg = { title: "Need help?", description: "Pick a subject below to open a private support ticket.", color: "#8b5cf6", style: "dropdown" }; }
    return state.panelCfg;
  }

  function renderShell(root, ctx, activeTab) {
    root.innerHTML = `
      <div class="dash-header">
        <div><h1>Ticket tool</h1><p>Everything ticket-related for this server lives here.</p></div>
      </div>
      <div class="ticket-filters" style="margin-bottom:18px">
        ${tab("tickets", "Tickets", activeTab)}
        ${tab("subjects", "Subjects", activeTab)}
        ${tab("panels", "Panels", activeTab)}
        ${tab("settings", "Settings", activeTab)}
      </div>
      <div id="tt-body">${loading()}</div>`;
    root.querySelectorAll("[data-tt-tab]").forEach(el => el.addEventListener("click", () => renderTab(root, ctx, el.dataset.ttTab)));
    return document.getElementById("tt-body");
  }
  function tab(id, label, active) {
    return `<span class="filter-chip ${active === id ? "active" : ""}" data-tt-tab="${id}">${label}</span>`;
  }
  function renderTab(root, ctx, tabId) {
    const body = renderShell(root, ctx, tabId);
    const renderers = { tickets: renderTickets, subjects: renderSubjects, panels: renderPanelsHome, settings: renderSettings };
    (renderers[tabId] || renderTickets)(body, ctx);
  }

  async function renderTickets(body, ctx) {
    body.innerHTML = loading("Loading tickets…");
    const data = await loadTickets(ctx);
    paintTicketList(body, data.tickets || [], "all", "");
  }
  function paintTicketList(body, tickets, filter, query) {
    let rows = filter === "all" ? tickets : tickets.filter(t => t.status === filter);
    if (query) { const q = query.toLowerCase(); rows = rows.filter(t => (t.subject || "").toLowerCase().includes(q) || (t.openedBy || "").toLowerCase().includes(q) || String(t.id).includes(q)); }

    body.innerHTML = `
      <div class="ticket-toolbar">
        <div class="ticket-filters">
          <span class="filter-chip ${filter === "all" ? "active" : ""}" data-f="all">All</span>
          <span class="filter-chip ${filter === "open" ? "active" : ""}" data-f="open">Open</span>
          <span class="filter-chip ${filter === "pending" ? "active" : ""}" data-f="pending">Pending</span>
          <span class="filter-chip ${filter === "closed" ? "active" : ""}" data-f="closed">Closed</span>
        </div>
        <input type="text" class="search-input" id="tt-search" placeholder="Search tickets…" value="${esc(query)}">
      </div>
      <div class="ticket-table">
        <div class="ticket-row head"><span>ID</span><span>Subject</span><span>Opened by</span><span class="col-created">Created</span><span>Status</span></div>
        ${rows.length === 0
          ? `<div class="empty-state"><i class="ti ti-ticket-off glyph"></i>No tickets match.</div>`
          : rows.map(t => `
            <div class="ticket-row">
              <span>#${t.id}</span><span>${esc(t.subject || "No subject")}</span><span>${esc(t.openedBy || "Unknown")}</span>
              <span class="col-created">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</span>
              <span class="badge badge-${t.status}">${t.status}</span>
            </div>`).join("")}
      </div>`;
    body.querySelectorAll("[data-f]").forEach(chip => chip.addEventListener("click", () => paintTicketList(body, tickets, chip.dataset.f, document.getElementById("tt-search").value)));
    document.getElementById("tt-search").addEventListener("input", (e) => paintTicketList(body, tickets, filter, e.target.value));
  }

  async function renderSubjects(body, ctx) {
    body.innerHTML = loading();
    await ensureMeta(ctx);
    await loadSubjects(ctx);
    paintSubjects(body, ctx);
  }
  function paintSubjects(body, ctx) {
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
        <button class="btn btn-primary btn-small" id="tt-new-subject"><i class="ti ti-plus"></i> New subject</button>
      </div>
      <div id="tt-subject-list"></div>
      <div id="tt-subject-editor"></div>`;
    document.getElementById("tt-new-subject").addEventListener("click", () => openSubjectEditor(ctx, null));
    paintSubjectList(ctx);
  }
  function paintSubjectList(ctx) {
    const list = document.getElementById("tt-subject-list");
    if (!list) return;
    if (state.subjects.length === 0) { list.innerHTML = `<div class="empty-state"><i class="ti ti-tag-off glyph"></i>No subjects yet.</div>`; return; }
    list.innerHTML = state.subjects.map(s => `
      <div class="subject-card">
        <div class="subject-card-main">
          <div class="subject-card-name">${esc(s.name)}</div>
          <div class="subject-card-desc">${esc(s.description || "No description")}</div>
        </div>
        <div class="subject-card-actions">
          <button class="toggle ${s.active ? "on" : ""}" data-toggle="${s.id}" aria-label="Toggle active"></button>
          <button class="btn btn-ghost btn-small" data-edit="${s.id}"><i class="ti ti-edit"></i></button>
          <button class="btn btn-ghost btn-small" data-del="${s.id}"><i class="ti ti-trash"></i></button>
        </div>
      </div>`).join("");
    list.querySelectorAll("[data-toggle]").forEach(btn => btn.addEventListener("click", async () => {
      const s = state.subjects.find(x => x.id === btn.dataset.toggle);
      btn.classList.toggle("on");
      try { await ctx.api(`/guilds/${ctx.guildId}/subjects/${s.id}`, { method: "PUT", body: JSON.stringify({ active: !s.active }) }); s.active = !s.active; }
      catch { btn.classList.toggle("on"); }
    }));
    list.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => openSubjectEditor(ctx, state.subjects.find(x => x.id === btn.dataset.edit))));
    list.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("Delete this subject?")) return;
      try { await ctx.api(`/guilds/${ctx.guildId}/subjects/${btn.dataset.del}`, { method: "DELETE" }); await loadSubjects(ctx); paintSubjectList(ctx); } catch {}
    }));
  }
  function openSubjectEditor(ctx, subject) {
    const slot = document.getElementById("tt-subject-editor");
    const roleChecks = (state.meta?.roles || []).map(r => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">
        <input type="checkbox" data-role-chk value="${r.id}" ${subject?.staffRoles?.includes(r.id) ? "checked" : ""} style="width:auto">
        @${esc(r.name)}
      </label>`).join("");

    slot.innerHTML = `
      <div class="editor-panel">
        <h3 style="font-size:14px;font-weight:700;margin-bottom:14px">${subject ? "Edit subject" : "New subject"}</h3>
        <div class="field"><label>Name</label><input type="text" id="ed-name" value="${esc(subject?.name || "")}" placeholder="e.g. General Support"></div>
        <div class="field"><label>Description</label><textarea id="ed-desc" placeholder="Shown to users when picking this subject" style="min-height:44px">${esc(subject?.description || "")}</textarea></div>
        <div class="field"><label>Ticket category</label><div id="ed-category"></div></div>
        <div class="field"><label>Staff roles (can view this subject's tickets)</label><div style="max-height:140px;overflow-y:auto;border:1px solid var(--panel-border);border-radius:7px;padding:4px 10px">${roleChecks || `<div class="field-hint">No roles found</div>`}</div></div>
        <div class="field"><label>Welcome message</label>
          <textarea id="ed-welcome" placeholder="{user.mention} welcome — describe your issue">${esc(subject?.welcomeMessage || "{user.mention} welcome — **{subject.name}**. Describe your issue and support will be with you shortly.")}</textarea>
          <div class="field-hint">Placeholders: {user.mention} {user.name} {subject.name} {ticket.id}</div>
        </div>
        <div class="field"><label>Close message</label>
          <textarea id="ed-close" placeholder="Thanks for reaching out!">${esc(subject?.closeMessage || "This ticket has been closed. Thanks for reaching out!")}</textarea>
          <div class="field-hint">DM'd to the user when their ticket closes. Placeholders: {user.name} {subject.name} {server.name}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-small" id="ed-save">${subject ? "Save changes" : "Create subject"}</button>
          <button class="btn btn-ghost btn-small" id="ed-cancel">Cancel</button>
        </div>
      </div>`;

    const catDrop = window.DC.createDropdown(document.getElementById("ed-category"), {
      options: [{ value: "", label: "No category" }, ...(state.meta?.categories || []).map(c => ({ value: c.id, label: c.name }))],
      value: subject?.category || "",
      placeholder: "No category",
    });

    document.getElementById("ed-cancel").addEventListener("click", () => { slot.innerHTML = ""; });
    document.getElementById("ed-save").addEventListener("click", async () => {
      const staffRoles = Array.from(document.querySelectorAll("[data-role-chk]:checked")).map(el => el.value);
      const payload = {
        name: document.getElementById("ed-name").value.trim() || "Untitled subject",
        description: document.getElementById("ed-desc").value.trim(),
        category: catDrop.getValue() || null,
        active: subject ? subject.active : true,
        welcomeMessage: document.getElementById("ed-welcome").value,
        closeMessage: document.getElementById("ed-close").value,
        staffRoles,
      };
      try {
        if (subject) await ctx.api(`/guilds/${ctx.guildId}/subjects/${subject.id}`, { method: "PUT", body: JSON.stringify(payload) });
        else await ctx.api(`/guilds/${ctx.guildId}/subjects`, { method: "POST", body: JSON.stringify(payload) });
        slot.innerHTML = "";
        await loadSubjects(ctx);
        paintSubjectList(ctx);
      } catch { alert("Couldn't save — is bot.js running?"); }
    });
  }

  async function renderPanelsHome(body, ctx) {
    body.innerHTML = loading();
    await ensureMeta(ctx);
    await loadSubjects(ctx);
    await loadPanelCfg(ctx);
    paintPanelsHome(body, ctx);
  }
  function paintPanelsHome(body, ctx) {
    const active = state.subjects.filter(s => s.active);
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
        <button class="btn btn-primary btn-small" id="tt-create-panel"><i class="ti ti-plus"></i> Create panel</button>
      </div>
      <div class="panel-preview">
        ${embedPreviewHtml(state.panelCfg, active)}
      </div>`;
    document.getElementById("tt-create-panel").addEventListener("click", () => startWizard(body, ctx));
  }
  function embedPreviewHtml(cfg, subjects) {
    const optionsHtml = subjects.length
      ? (cfg.style === "buttons"
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${subjects.slice(0, 5).map(s => `<span class="btn btn-primary btn-small" style="pointer-events:none">${esc(s.name)}</span>`).join("")}</div>`
          : `<div class="embed-options-preview">Select an option… (${subjects.length} subject${subjects.length === 1 ? "" : "s"})</div>`)
      : `<div class="embed-options-preview">No active subjects — add one first</div>`;
    return `
      <div class="embed-msg">
        <div class="embed-msg-header">
          <div class="embed-msg-avatar"></div>
          <div><span class="embed-msg-author">TicketBot<span class="embed-msg-tag">APP</span></span><span class="embed-msg-time">Today</span></div>
        </div>
        <div class="embed-card" style="--embed-color:${esc(cfg.color || "#8b5cf6")}">
          <div class="embed-card-title">${esc(cfg.title || "Need help?")}</div>
          <div class="embed-card-desc">${esc(cfg.description || "")}</div>
        </div>
        ${optionsHtml}
      </div>`;
  }

  function startWizard(root, ctx) {
    state.wizard = {
      step: 1,
      panel: { ...state.panelCfg },
      options: state.subjects.filter(s => s.active).map(s => ({ subjectId: s.id, label: s.name, description: s.description || "" })),
      channelId: null,
    };
    renderWizard(root, ctx);
  }
  function renderWizard(root, ctx) {
    const w = state.wizard;
    root.innerHTML = `
      <div class="wizard-steps">
        ${wizardStep(1, "Message", w.step)}<div class="wizard-sep"></div>
        ${wizardStep(2, "Buttons", w.step)}<div class="wizard-sep"></div>
        ${wizardStep(3, "Channel", w.step)}<div class="wizard-sep"></div>
        ${wizardStep(4, "Send", w.step)}
        <div style="margin-left:auto"><button class="btn btn-ghost btn-small" id="wiz-cancel"><i class="ti ti-x"></i> Cancel</button></div>
      </div>
      <div id="wiz-body"></div>
      <div class="wizard-footer">
        <button class="btn btn-ghost btn-small" id="wiz-back" ${w.step === 1 ? "disabled" : ""}><i class="ti ti-arrow-left"></i> Back</button>
        <button class="btn btn-primary btn-small" id="wiz-next">${w.step === 4 ? "Save changes" : "Continue"} <i class="ti ti-arrow-right"></i></button>
      </div>`;
    document.getElementById("wiz-cancel").addEventListener("click", () => renderPanelsHome(root, ctx));
    document.getElementById("wiz-back").addEventListener("click", () => { w.step = Math.max(1, w.step - 1); renderWizard(root, ctx); });
    document.getElementById("wiz-next").addEventListener("click", () => handleWizardNext(root, ctx));
    renderWizardStep(document.getElementById("wiz-body"), ctx);
  }
  function wizardStep(n, label, current) {
    const cls = current > n ? "done" : current === n ? "active" : "";
    return `<div class="wizard-step ${cls}"><span class="wizard-step-num">${current > n ? "" : n}</span>${label}</div>`;
  }

  function renderWizardStep(body, ctx) {
    const w = state.wizard;
    if (w.step === 1) return renderWizardMessage(body);
    if (w.step === 2) return renderWizardOptions(body, ctx);
    if (w.step === 3) return renderWizardChannel(body, ctx);
    if (w.step === 4) return renderWizardSend(body);
  }

  function renderWizardMessage(body) {
    const w = state.wizard;
    body.innerHTML = `
      <p style="text-align:center;color:var(--text-dim);font-size:13px;margin-bottom:18px">Create the message users will see.</p>
      <div class="wizard-body">
        <div class="editor-panel">
          <div class="field"><label>Title</label><input type="text" id="w-title" maxlength="256" value="${esc(w.panel.title)}"></div>
          <div class="field"><label>Description</label><textarea id="w-desc" maxlength="4000" style="min-height:100px">${esc(w.panel.description)}</textarea></div>
          <div class="field"><label>Accent color</label><input type="color" id="w-color" value="${esc(w.panel.color)}" style="height:38px;padding:3px;cursor:pointer"></div>
        </div>
        <div class="panel-preview" id="w-preview"></div>
      </div>`;
    const paint = () => {
      w.panel.title = document.getElementById("w-title").value;
      w.panel.description = document.getElementById("w-desc").value;
      w.panel.color = document.getElementById("w-color").value;
      document.getElementById("w-preview").innerHTML = embedPreviewHtml(w.panel, state.subjects.filter(s => s.active));
    };
    ["w-title", "w-desc", "w-color"].forEach(id => document.getElementById(id).addEventListener("input", paint));
    paint();
  }

  function renderWizardOptions(body, ctx) {
    const w = state.wizard;
    body.innerHTML = `
      <p style="text-align:center;color:var(--text-dim);font-size:13px;margin-bottom:14px">Add buttons or a dropdown that users click to open tickets.</p>
      <div class="ticket-filters" style="justify-content:center;margin-bottom:18px">
        <span class="filter-chip ${w.panel.style !== "buttons" ? "active" : ""}" data-style="dropdown"><i class="ti ti-list"></i> Dropdown</span>
        <span class="filter-chip ${w.panel.style === "buttons" ? "active" : ""}" data-style="buttons"><i class="ti ti-square"></i> Buttons</span>
      </div>
      <div class="wizard-body">
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">Options (${w.options.length}/25)</div>
          <div id="w-opts-list"></div>
          <button class="btn btn-ghost btn-small" id="w-add-opt"><i class="ti ti-plus"></i> Add from subjects</button>
        </div>
        <div class="panel-preview" id="w-preview"></div>
      </div>`;

    body.querySelectorAll("[data-style]").forEach(chip => chip.addEventListener("click", () => {
      w.panel.style = chip.dataset.style;
      renderWizardOptions(body, ctx);
    }));

    function paintOpts() {
      const list = document.getElementById("w-opts-list");
      list.innerHTML = w.options.map((o, i) => `
        <div class="opt-row">
          <div class="opt-row-top">
            <span class="opt-row-drag"><i class="ti ti-grip-vertical"></i></span>
            <div style="flex:1">
              <input type="text" data-opt-label="${i}" value="${esc(o.label)}" placeholder="Label" maxlength="100">
              <div class="char-count">${o.label.length}/100</div>
            </div>
            <button class="btn btn-ghost btn-small opt-row-remove" data-opt-remove="${i}"><i class="ti ti-trash"></i></button>
          </div>
          <textarea data-opt-desc="${i}" placeholder="Description (optional)" maxlength="100" style="min-height:38px">${esc(o.description)}</textarea>
        </div>`).join("") || `<div class="empty-state">No options yet — add a subject below.</div>`;

      list.querySelectorAll("[data-opt-label]").forEach(el => el.addEventListener("input", () => { w.options[el.dataset.optLabel].label = el.value; paintPreview(); paintOpts(); }));
      list.querySelectorAll("[data-opt-desc]").forEach(el => el.addEventListener("input", () => { w.options[el.dataset.optDesc].description = el.value; paintPreview(); }));
      list.querySelectorAll("[data-opt-remove]").forEach(el => el.addEventListener("click", () => { w.options.splice(el.dataset.optRemove, 1); paintOpts(); paintPreview(); }));
    }
    function paintPreview() {
      document.getElementById("w-preview").innerHTML = embedPreviewHtml(w.panel, w.options.map(o => ({ name: o.label })));
    }
    document.getElementById("w-add-opt").addEventListener("click", () => {
      const unused = state.subjects.filter(s => !w.options.some(o => o.subjectId === s.id));
      if (unused.length === 0) { alert("All active subjects are already added, or you have no more subjects — add one in the Subjects tab first."); return; }
      w.options.push({ subjectId: unused[0].id, label: unused[0].name, description: unused[0].description || "" });
      paintOpts(); paintPreview();
    });
    paintOpts(); paintPreview();
  }

  function renderWizardChannel(body, ctx) {
    const w = state.wizard;
    const channels = state.meta?.channels || [];
    body.innerHTML = `
      <p style="text-align:center;color:var(--text-dim);font-size:13px;margin-bottom:18px">Choose where to post your panel.</p>
      <div class="wizard-body">
        <div class="editor-panel">
          <div class="field"><label>Channel</label><div id="w-channel"></div></div>
        </div>
        <div class="panel-preview" id="w-preview"></div>
      </div>`;
    const drop = window.DC.createDropdown(document.getElementById("w-channel"), {
      options: channels.map(c => ({ value: c.id, label: c.name, icon: `<span style="color:var(--text-dim)">#</span> ` })),
      value: w.channelId,
      placeholder: "Select a channel…",
      searchable: true,
    });
    drop.onChange(val => { w.channelId = val; });
    document.getElementById("w-preview").innerHTML = embedPreviewHtml(w.panel, w.options.map(o => ({ name: o.label })));
  }

  function renderWizardSend(body) {
    const w = state.wizard;
    const channelName = (state.meta?.channels || []).find(c => c.id === w.channelId)?.name;
    body.innerHTML = `
      <p style="text-align:center;color:var(--text-dim);font-size:13px;margin-bottom:18px">Review your changes.</p>
      <div class="wizard-body">
        <div class="panel-preview">${embedPreviewHtml(w.panel, w.options.map(o => ({ name: o.label })))}</div>
        <div class="editor-panel">
          <div class="field"><label>Channel</label><div class="field-hint">${channelName ? "#" + esc(channelName) : "No channel selected"}</div></div>
          <div class="field"><label>Options</label><div class="field-hint">${w.options.length} option${w.options.length === 1 ? "" : "s"}: ${w.options.map(o => esc(o.label)).join(", ") || "none"}</div></div>
        </div>
      </div>`;
  }

  async function handleWizardNext(root, ctx) {
    const w = state.wizard;
    if (w.step === 3 && !w.channelId) { alert("Pick a channel first."); return; }
    if (w.step < 4) { w.step++; renderWizard(root, ctx); return; }

    const btn = document.getElementById("wiz-next");
    btn.textContent = "Saving…";
    try {
      await ctx.api(`/guilds/${ctx.guildId}/panel`, { method: "PUT", body: JSON.stringify(w.panel) });
      await ctx.api(`/guilds/${ctx.guildId}/panel/post`, { method: "POST", body: JSON.stringify({ channelId: w.channelId }) });
      state.panelCfg = w.panel;
      state.wizard = null;
      renderPanelsHome(root, ctx);
    } catch {
      alert("Couldn't post the panel — check that bot.js is running and has access to that channel.");
      btn.innerHTML = `Save changes <i class="ti ti-arrow-right"></i>`;
    }
  }

  async function renderSettings(body, ctx) {
    body.innerHTML = loading();
    await ensureMeta(ctx);
    let cfg = {};
    try { cfg = await ctx.api(`/guilds/${ctx.guildId}/config`); } catch {}

    body.innerHTML = `
      <div class="config-section">
        <h3>Fallback ticket category</h3><div class="hint">Used when a subject doesn't set its own category.</div>
        <div class="config-row"><span class="config-row-label">Category</span><div id="s-category" style="width:220px"></div></div>
      </div>
      <div class="config-section">
        <h3>Support role</h3><div class="hint">Can view and respond to every ticket, in addition to any per-subject staff roles.</div>
        <div class="config-row"><span class="config-row-label">Role</span><div id="s-role" style="width:220px"></div></div>
      </div>
      <div class="config-section">
        <h3>Log channel</h3><div class="hint">A summary is posted here whenever a ticket closes.</div>
        <div class="config-row"><span class="config-row-label">Channel</span><div id="s-log" style="width:220px"></div></div>
      </div>
      <button class="btn btn-primary btn-small" id="s-save">Save changes</button>`;

    const catDrop = window.DC.createDropdown(document.getElementById("s-category"), {
      options: [{ value: "", label: "None" }, ...(state.meta?.categories || []).map(c => ({ value: c.id, label: c.name }))],
      value: cfg.ticketCategory || "", placeholder: "None",
    });
    const roleDrop = window.DC.createDropdown(document.getElementById("s-role"), {
      options: [{ value: "", label: "None" }, ...(state.meta?.roles || []).map(r => ({ value: r.id, label: "@" + r.name }))],
      value: cfg.supportRole || "", placeholder: "None",
    });
    const logDrop = window.DC.createDropdown(document.getElementById("s-log"), {
      options: [{ value: "", label: "Disabled" }, ...(state.meta?.channels || []).map(c => ({ value: c.id, label: "#" + c.name }))],
      value: cfg.logChannel || "", placeholder: "Disabled",
    });

    document.getElementById("s-save").addEventListener("click", async () => {
      const btn = document.getElementById("s-save");
      btn.textContent = "Saving…";
      try {
        await ctx.api(`/guilds/${ctx.guildId}/config`, {
          method: "POST",
          body: JSON.stringify({
            ticketChannel: cfg.ticketChannel || null,
            ticketCategory: catDrop.getValue() || null,
            supportRole: roleDrop.getValue() || null,
            logChannel: logDrop.getValue() || null,
          }),
        });
        btn.innerHTML = `<i class="ti ti-check"></i> Saved`;
      } catch { btn.textContent = "Failed — is bot.js running?"; }
      setTimeout(() => { btn.textContent = "Save changes"; }, 2200);
    });
  }

  window.DC.registerModule({
    id: "ticket-tool",
    label: "Ticket tool",
    icon: "ti-ticket",
    section: "Modules",
    render(root, ctx) {
      state.subjects = []; state.tickets = []; state.meta = null; state.panelCfg = null; state.wizard = null;
      renderTab(root, ctx, "tickets");
    },
  });
})();

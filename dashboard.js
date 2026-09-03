(function () {
  const API = window.TICKET_DESK_CONFIG.API_BASE_URL;
  let currentGuildId = null;
  let currentGuildData = null; // last-loaded config response for the active guild

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = 'index.html';
      throw new Error('Not logged in');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  async function init() {
    let me;
    try {
      me = await api('/api/me');
    } catch {
      return; // already redirected to login
    }

    document.getElementById('logout-btn').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' });
      window.location.href = 'index.html';
    });

    const guilds = await api('/api/guilds');
    renderGuildRail(guilds);
  }

  function renderGuildRail(guilds) {
    const list = document.getElementById('guild-list');
    list.innerHTML = '';
    guilds.forEach((g) => {
      const el = document.createElement('div');
      el.className = 'guild-icon' + (g.botIsIn ? '' : ' no-bot');
      el.title = g.name + (g.botIsIn ? '' : ' (bot not added yet)');
      el.textContent = initials(g.name);
      if (g.icon) {
        const img = document.createElement('img');
        img.src = g.icon;
        img.alt = '';
        el.textContent = '';
        el.appendChild(img);
      }
      el.addEventListener('click', () => selectGuild(g, el));
      list.appendChild(el);
    });
  }

  function initials(name) {
    return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  }

  async function selectGuild(guild, el) {
    document.querySelectorAll('.guild-icon').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
    currentGuildId = guild.id;

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('guild-panel').classList.remove('hidden');
    document.getElementById('guild-name').textContent = guild.name;

    const pill = document.getElementById('bot-status-pill');
    const inviteBanner = document.getElementById('invite-banner');
    const configSections = document.getElementById('config-sections');

    if (!guild.botIsIn) {
      pill.textContent = 'Bot not added';
      pill.className = 'status-pill status-bad';
      inviteBanner.classList.remove('hidden');
      configSections.classList.add('hidden');
      document.getElementById('invite-link').href = guild.inviteUrl;
      return;
    }

    pill.textContent = 'Bot connected';
    pill.className = 'status-pill status-good';
    inviteBanner.classList.add('hidden');
    configSections.classList.remove('hidden');

    const data = await api(`/api/guilds/${guild.id}/config`);
    currentGuildData = data;
    renderConfig(data);
    renderTickets(guild.id);
  }

  function renderConfig(data) {
    const categorySelect = document.getElementById('category-select');
    categorySelect.innerHTML = '<option value="">No category (top level)</option>';
    data.guildCategories.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (data.config.ticket_category_id === c.id) opt.selected = true;
      categorySelect.appendChild(opt);
    });

    document.getElementById('welcome-message').value =
      data.config.welcome_message || 'Thanks for opening a ticket! Support will be with you shortly.';

    renderSupportRoles(data);
    renderTicketTypes(data.ticketTypes);
  }

  function renderSupportRoles(data) {
    const list = document.getElementById('support-roles-list');
    const select = document.getElementById('add-role-select');
    const selectedIds = new Set(data.supportRoles.map((r) => r.role_id));

    list.innerHTML = '';
    data.supportRoles.forEach((r) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.roleId = r.role_id;
      chip.innerHTML = `${escapeHtml(r.role_name || r.role_id)} <button type="button" aria-label="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        chip.remove();
        rebuildRoleSelect(data);
      });
      list.appendChild(chip);
    });

    select.innerHTML = '<option value="">+ Add a role…</option>';
    data.guildRoles
      .filter((r) => !selectedIds.has(r.id))
      .forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name;
        opt.dataset.roleName = r.name;
        select.appendChild(opt);
      });

    select.onchange = () => {
      if (!select.value) return;
      const roleName = select.options[select.selectedIndex].dataset.roleName;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.roleId = select.value;
      chip.innerHTML = `${escapeHtml(roleName)} <button type="button" aria-label="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        chip.remove();
        rebuildRoleSelect(data);
      });
      list.appendChild(chip);
      select.value = '';
      rebuildRoleSelect(data);
    };
  }

  function rebuildRoleSelect(data) {
    const currentIds = [...document.querySelectorAll('#support-roles-list .chip')].map((c) => c.dataset.roleId);
    const select = document.getElementById('add-role-select');
    select.innerHTML = '<option value="">+ Add a role…</option>';
    data.guildRoles
      .filter((r) => !currentIds.includes(r.id))
      .forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name;
        opt.dataset.roleName = r.name;
        select.appendChild(opt);
      });
  }

  function renderTicketTypes(types) {
    const list = document.getElementById('ticket-types-list');
    list.innerHTML = '';
    types.forEach((t) => addTicketTypeRow(t));

    document.getElementById('add-type-btn').onclick = () => {
      if (list.children.length >= 5) {
        alert('Discord only allows 5 buttons per panel — remove one first.');
        return;
      }
      addTicketTypeRow({});
    };
  }

  function addTicketTypeRow(t) {
    const template = document.getElementById('ticket-type-row-template');
    const node = template.content.cloneNode(true);
    node.querySelector('.tt-emoji').value = t.emoji || '';
    node.querySelector('.tt-label').value = t.label || '';
    node.querySelector('.tt-description').value = t.description || '';
    node.querySelector('.tt-remove').addEventListener('click', (e) => {
      e.target.closest('.ticket-type-row').remove();
    });
    document.getElementById('ticket-types-list').appendChild(node);
  }

  async function renderTickets(guildId) {
    const tickets = await api(`/api/guilds/${guildId}/tickets`);
    const tbody = document.getElementById('tickets-tbody');
    tbody.innerHTML = '';
    if (tickets.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color: var(--text-dim); font-family: var(--font-sans);">No tickets yet.</td></tr>';
      return;
    }
    tickets.slice(0, 25).forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(t.opener_username || t.opener_user_id)}</td>
        <td>${escapeHtml(t.ticket_type_label || '—')}</td>
        <td><span class="tix-status ${t.status}">${t.status}</span></td>
        <td>${new Date(t.created_at + 'Z').toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.getElementById('save-btn').addEventListener('click', async () => {
    if (!currentGuildId) return;
    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const supportRoles = [...document.querySelectorAll('#support-roles-list .chip')].map((chip) => ({
      roleId: chip.dataset.roleId,
      roleName: chip.textContent.replace('✕', '').trim(),
    }));

    const ticketTypes = [...document.querySelectorAll('.ticket-type-row')]
      .map((row) => ({
        label: row.querySelector('.tt-label').value.trim(),
        emoji: row.querySelector('.tt-emoji').value.trim(),
        description: row.querySelector('.tt-description').value.trim(),
      }))
      .filter((t) => t.label);

    try {
      await api(`/api/guilds/${currentGuildId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          ticketCategoryId: document.getElementById('category-select').value || null,
          welcomeMessage: document.getElementById('welcome-message').value,
          supportRoles,
          ticketTypes,
        }),
      });
      saveBtn.textContent = 'Saved ✓';
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
      saveBtn.textContent = 'Save changes';
    } finally {
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save changes';
      }, 1500);
    }
  });

  init();
})();

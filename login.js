(function () {
  const API = window.TICKET_DESK_CONFIG.API_BASE_URL;

  document.getElementById('login-btn').addEventListener('click', () => {
    window.location.href = `${API}/auth/login`;
  });

  // If we're already logged in (valid session cookie), skip straight to the dashboard.
  fetch(`${API}/api/me`, { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : null))
    .then((me) => {
      if (me) window.location.href = 'dashboard.html';
    })
    .catch(() => {
      /* not logged in, or API unreachable — stay on the login screen either way */
    });
})();

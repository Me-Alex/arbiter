// Runs before styles without depending on any window.arbiter* scripts.
(function () {
  const key = 'arbiter-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => ['light', 'dark', 'system'].includes(value);
  let preference = 'light';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch (_err) { /* Storage may be unavailable; the controls still work. */ }

  function apply() {
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.theme = preference === 'system'
      ? (system.matches ? 'dark' : 'light') : preference;
    document.querySelectorAll('[data-theme-choice]').forEach((select) => {
      select.value = preference;
    });
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('change', (event) => {
    if (!event.target.matches('[data-theme-choice]') || !valid(event.target.value)) return;
    preference = event.target.value;
    try { localStorage.setItem(key, preference); } catch (_err) { /* Session only. */ }
    apply();
  });
  system.addEventListener('change', () => {
    if (preference === 'system') apply();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'light';
    apply();
  });
})();

// login.js — language toggle for the standalone login card (i18n.apply() re-translates
// the data-i18n nodes in place, so no page reload is needed here).
(function () {
  function wire() {
    const btn = document.querySelector('[data-lang-toggle]');
    if (!btn) return;
    const update = () => { btn.textContent = window.arbiterI18n.t('language'); };
    btn.addEventListener('click', () => {
      const next = window.arbiterI18n.lang === 'ro' ? 'en' : 'ro';
      window.arbiterI18n.setLang(next);
      document.documentElement.lang = next;
      update();
    });
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

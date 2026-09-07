// Common UI helpers for Arbiter pages
// Expose createDropdown, createChip, applyDesignTokens on window
window.createDropdown = function(id, options, config = {}) {
  const sel = document.getElementById(id);
  if (!sel) return null;
  const escape = (s) => s && typeof s === 'string' ? s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) : '';
  sel.innerHTML = options.map(o => `<option value="${escape(o.value)}">${escape(o.text)}</option>`).join('');
  if (config.storageKey) {
    const saved = localStorage.getItem(config.storageKey) || '';
    if (saved) sel.value = saved;
    sel.addEventListener('change', () => {
      localStorage.setItem(config.storageKey, sel.value);
    });
  }
  return sel;
};

window.createChip = function(text, extraClass = '') {
  const span = document.createElement('span');
  span.className = 'chip ' + extraClass;
  span.textContent = text;
  return span;
};

window.applyDesignTokens = function(element) {
  // Placeholder: could add token classes or styles dynamically if needed.
  // Currently CSS uses var(--) tokens, so no action required.
  return element;
};

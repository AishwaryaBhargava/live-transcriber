// Lightweight modal opener/closer so main.js can keep its logic untouched.

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('aria-hidden', 'false');
  // close on Esc
  const onKey = (e) => {
    if (e.key === 'Escape') closeModal(id);
  };
  el._esc = onKey;
  window.addEventListener('keydown', onKey);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('aria-hidden', 'true');
  if (el._esc) {
    window.removeEventListener('keydown', el._esc);
    el._esc = null;
  }
}

// Buttons
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnOpenExport = document.getElementById('btn-open-export');

btnOpenSettings?.addEventListener('click', () => openModal('settings-modal'));
btnOpenExport?.addEventListener('click', () => openModal('export-modal'));

// Overlay and close buttons
document.addEventListener('click', (e) => {
  const closeTarget = e.target.closest('[data-close]');
  if (!closeTarget) return;
  const which = closeTarget.getAttribute('data-close');
  if (which === 'settings') closeModal('settings-modal');
  if (which === 'export') closeModal('export-modal');
});

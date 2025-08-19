const KEY = 'twinmind_theme_v1';

function apply(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

function load() {
  try {
    return localStorage.getItem(KEY) || 'light';
  } catch {
    return 'light';
  }
}
function save(t) {
  try {
    localStorage.setItem(KEY, t);
  } catch {}
}

function setIcon(btn, theme) {
  // Show the icon of the action you'll get
  btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  btn.title = theme === 'dark' ? 'Switch to Light' : 'Switch to Dark';
}

(function init() {
  const btn = document.getElementById('btn-theme');
  const current = load();
  apply(current);
  if (btn) {
    setIcon(btn, current);
    btn.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const next = isDark ? 'light' : 'dark';
      apply(next);
      save(next);
      setIcon(btn, next);
    });
  }
})();

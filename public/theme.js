// Applies this device's last theme before the page draws, so it never flashes.
// (The app then loads the logged-in person's theme from the server.)
// No saved theme (or "system") leaves it to the device's light or dark setting.
(function () {
  // A custom theme's colours as CSS. Light or dark controls follow how dark the background is.
  window.customThemeCss = function (vars) {
    var hex = (vars && vars.bg) || '#ffffff';
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    var dark = lum < 0.5;
    var css = ':root[data-theme="custom"]{color-scheme:' + (dark ? 'dark' : 'light') + ';' + (dark ? '--shadow:none;' : '');
    for (var k in vars) if (k !== 'account' && /^[a-z-]+$/.test(k) && /^#[0-9a-f]{6}$/i.test(vars[k])) css += '--' + k + ':' + vars[k] + ';';
    return css + '}';
  };
  window.applyCustomTheme = function (vars) {
    var el = document.getElementById('custom-theme');
    if (!el) { el = document.createElement('style'); el.id = 'custom-theme'; document.head.appendChild(el); }
    el.textContent = vars ? window.customThemeCss(vars) : '';
  };
  // Each login's own account icon colour, on top of whatever theme.
  window.applyAccountColour = function (c) {
    var root = document.documentElement.style;
    if (c && /^#[0-9a-f]{6}$/i.test(c)) root.setProperty('--account', c); else root.removeProperty('--account');
    try { localStorage.setItem('account-colour', c || ''); } catch (e) { /* not remembered here */ }
  };
  // The tab icon: the pie logo drawn in the current theme's accent colours.
  window.updateFavicon = function () {
    var link = document.getElementById('favicon');
    if (!link) return;
    var cs = getComputedStyle(document.documentElement);
    var bg = cs.getPropertyValue('--brand').trim();
    var fg = cs.getPropertyValue('--on-brand').trim();
    if (!bg || !fg) return;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="' + bg + '"/>' +
      '<circle cx="12" cy="12" r="6.5" fill="none" stroke="' + fg + '" stroke-width="3.6" pathLength="100" stroke-dasharray="44 6 25 6 13 6" transform="rotate(-90 12 12)"/></svg>';
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  };
  window.addEventListener('load', window.updateFavicon);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', window.updateFavicon);
  try {
    var ac = localStorage.getItem('account-colour');
    if (ac) document.documentElement.style.setProperty('--account', ac);
    var t = localStorage.getItem('theme');
    if (t === 'custom') window.applyCustomTheme(JSON.parse(localStorage.getItem('custom-theme') || 'null'));
    if (t && t !== 'system') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the device */ }
})();

  // Apply saved theme before first paint to avoid a flash of the wrong theme.
  (function() {
    try {
      if (localStorage.getItem('chalk_theme') === 'light') {
        document.documentElement.classList.add('light-theme');
      }
    } catch (_) { /* localStorage unavailable */ }
  })();

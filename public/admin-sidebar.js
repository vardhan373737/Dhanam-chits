(function () {
  function isSidebarVisible(sidebar) {
    if (!sidebar) return false;
    if (document.body.classList.contains('sidebar-open')) return true;
    if (sidebar.classList.contains('open')) return true;
    // fallback: check computed transform/visibility
    try {
      const comp = getComputedStyle(sidebar);
      if (comp.display === 'none' || comp.visibility === 'hidden' || parseFloat(comp.opacity || '1') === 0) return false;
    } catch (e) {
      // ignore
    }
    return false;
  }

  function closeSidebar(sidebar) {
    console.log('admin-sidebar: closing sidebar');
    if (document.body.classList.contains('sidebar-open')) document.body.classList.remove('sidebar-open');
    if (sidebar && sidebar.classList.contains('open')) sidebar.classList.remove('open');
    if (sidebar) {
      sidebar.style.transform = '';
      sidebar.style.left = '';
      sidebar.style.width = '';
      sidebar.removeAttribute('data-open');
    }
  }

  function openSidebar(sidebar) {
    console.log('admin-sidebar: opening sidebar');
    document.body.classList.add('sidebar-open');
    if (sidebar) sidebar.classList.add('open');
    if (sidebar) {
      // apply inline styles to ensure visibility across different page CSS
      sidebar.style.transform = 'translateX(0)';
      sidebar.style.left = '0';
      // if sidebar was collapsed to icon width, expand it
      sidebar.style.width = sidebar.style.width || '270px';
      sidebar.setAttribute('data-open', 'true');
    }
  }

  function toggleSidebarHandler(e) {
    const now = Date.now();
    const etype = e && e.type ? String(e.type) : 'programmatic';
    // ignore duplicate invocations from touch/pointer + click within 400ms
    if (toggleSidebarHandler._last && (now - toggleSidebarHandler._last.time) < 400) {
      if (toggleSidebarHandler._last.type !== etype) {
        console.log('admin-sidebar: ignoring duplicate toggle', etype);
        return;
      }
    }
    toggleSidebarHandler._last = { time: now, type: etype };
    console.log('admin-sidebar: toggle invoked', etype);
    const sidebar = document.querySelector('.sidebar');
    if (isSidebarVisible(sidebar)) {
      closeSidebar(sidebar);
    } else {
      // record last toggle time so outside-click handler can ignore the originating event
      window.__adminSidebarLastToggle = Date.now();
      openSidebar(sidebar);
    }
  }

  function init() {
    // expose a unified toggle function for inline onclicks
    window.toggleSidebar = toggleSidebarHandler;

    // attach to all .menu-toggle buttons (click + pointer/touch for mobile)
    const buttons = Array.from(document.querySelectorAll('.menu-toggle'));
    console.log('admin-sidebar: found', buttons.length, '.menu-toggle buttons');
    buttons.forEach(btn => {
      // avoid double-binding if script is included multiple times
      if (btn.__adminSidebarAttached) return;
      // use wrappers that stop propagation so the document 'click' handler doesn't close immediately
      const wrappedClick = function (ev) { ev.stopPropagation(); toggleSidebarHandler(ev); };
      btn.addEventListener('click', wrappedClick);
      // also assign to onclick as a fallback for inline handlers
      try { btn.onclick = function (ev) { ev.stopPropagation(); toggleSidebarHandler(ev); }; } catch (e) { /* ignore */ }
      // pointerdown covers touch and mouse reliably
      btn.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); toggleSidebarHandler(ev); });
      // fallback for older touch-only browsers
      try {
        btn.addEventListener('touchstart', (ev) => { ev.stopPropagation(); toggleSidebarHandler(ev); }, { passive: true });
      } catch (e) {
        // ignore if passive option unsupported
        btn.addEventListener('touchstart', (ev) => { ev.stopPropagation(); toggleSidebarHandler(ev); });
      }
      btn.__adminSidebarAttached = true;
    });

    // close when clicking outside — ignore events that happen immediately after a toggle
    document.addEventListener('click', (ev) => {
      const sidebar = document.querySelector('.sidebar');
      if (!isSidebarVisible(sidebar)) return;
      const toggle = ev.target.closest('.menu-toggle');
      if (toggle) return;
      if (!sidebar) return;
      const last = window.__adminSidebarLastToggle || 0;
      if (Date.now() - last < 500) {
        // likely the same interaction that opened the sidebar; ignore to avoid immediate close
        console.log('admin-sidebar: ignoring outside click immediately after toggle');
        return;
      }
      if (!ev.target.closest('.sidebar')) {
        closeSidebar(sidebar);
      }
    }, { capture: true });

    // close on Escape
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        const sidebar = document.querySelector('.sidebar');
        if (isSidebarVisible(sidebar)) closeSidebar(sidebar);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

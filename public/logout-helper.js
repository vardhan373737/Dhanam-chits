(function () {
  function hasExistingLogoutControl() {
    if (document.querySelector('[data-global-logout="true"]')) {
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('a, button'));
    return candidates.some((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      const onclick = (el.getAttribute('onclick') || '').toLowerCase();
      const href = (el.getAttribute('href') || '').toLowerCase();
      return text === 'logout' || onclick.includes('logout') || href.includes('logout');
    });
  }

  async function performLogout() {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (_err) {
      // Continue with client-side logout even if network call fails.
    }

    localStorage.removeItem('user');
    localStorage.removeItem('mobile');
    localStorage.removeItem('chitId');
    localStorage.removeItem('name');
    window.location.href = 'Login.html';
  }

  function addGlobalLogoutButton() {
    if (hasExistingLogoutControl()) {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Logout';
    button.setAttribute('data-global-logout', 'true');
    button.style.position = 'fixed';
    button.style.left = '16px';
    button.style.bottom = '16px';
    button.style.zIndex = '9999';
    button.style.padding = '10px 14px';
    button.style.border = 'none';
    button.style.borderRadius = '12px';
    button.style.background = 'linear-gradient(120deg, #0f766e, #0891b2)';
    button.style.color = '#ffffff';
    button.style.fontWeight = '700';
    button.style.cursor = 'pointer';
    button.style.boxShadow = '0 10px 24px rgba(8, 145, 178, 0.35)';

    button.addEventListener('click', performLogout);
    document.body.appendChild(button);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addGlobalLogoutButton);
  } else {
    addGlobalLogoutButton();
  }
})();

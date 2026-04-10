/**
 * DarkMatter Session Bridge — content script on darkmatterhub.ai
 * Injected by manifest into darkmatterhub.ai/* pages.
 *
 * The /ext/callback page fires window.dispatchEvent(new CustomEvent('dm_auth', { detail: auth }))
 * This script catches that event and forwards auth to the background service worker via
 * chrome.runtime.sendMessage({ type: 'SET_AUTH', auth }).
 *
 * This is the only reliable path in MV3: web page -> content script -> background.
 * Direct chrome.runtime.sendMessage from a web page requires externally_connectable,
 * which requires submitting to Web Store. This content script approach works immediately.
 */
'use strict';

window.addEventListener('dm_auth', async (e) => {
  const auth = e.detail;
  if (!auth?.agent_id || !auth?.api_key) return;

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'SET_AUTH', auth }, (r) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r);
      });
    });

    if (response?.ok) {
      console.log('[DarkMatter] Extension auth successful for', auth.email);
    }
  } catch(err) {
    console.warn('[DarkMatter] Bridge sendMessage failed:', err.message);
  }
});

// Also handle the case where /ext/callback already has a session in localStorage
// and this script loads after the CustomEvent was already fired.
// On /ext/callback pages, re-trigger auth by re-reading localStorage.
if (location.pathname === '/ext/callback') {
  const tryPickUpSession = async () => {
    const raw = localStorage.getItem('dm_session');
    if (!raw) return;
    // The /ext/callback page handles everything; just make sure we're listening.
    // The CustomEvent will be dispatched by the page script.
  };
  tryPickUpSession();
}

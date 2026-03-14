async function withActiveTab(fn) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return null;
  const tab = tabs[0];
  return fn(tab);
}

const DEFAULTS = {
  baseUrl: 'https://digital-store.top',
  token: '',
  scopeAdminId: ''
};

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

async function loadSettings() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById('baseUrl').value = cfg.baseUrl || DEFAULTS.baseUrl;
  document.getElementById('token').value = cfg.token || '';
  document.getElementById('scopeAdminId').value = cfg.scopeAdminId || '';
}

function normalizeBaseUrl(url) {
  const u = (url || '').trim();
  return u.replace(/\/+$/, '');
}

async function togglePanel(tab, refresh) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (doRefresh) => {
      const el = document.getElementById('ds-wa-panel');
      if (el) {
        if (doRefresh) {
          document.dispatchEvent(new CustomEvent('ds-wa-boot'));
        }
        el.classList.remove('ds-hidden');
      } else {
        document.dispatchEvent(new CustomEvent('ds-wa-boot'));
      }
    },
    args: [refresh]
  });
}

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = normalizeBaseUrl(document.getElementById('baseUrl').value) || DEFAULTS.baseUrl;
  const token = (document.getElementById('token').value || '').trim();
  const scopeAdminId = (document.getElementById('scopeAdminId').value || '').trim();
  await chrome.storage.sync.set({ baseUrl, token, scopeAdminId });
  setStatus('Saved');
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus('Testing...');
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const baseUrl = normalizeBaseUrl(cfg.baseUrl || DEFAULTS.baseUrl);
  const token = (cfg.token || '').trim();
  if (!token) {
    setStatus('Set token first');
    return;
  }
  const url = new URL(baseUrl + '/index.php');
  url.searchParams.set('page', 'ajax_customer_lookup');
  url.searchParams.set('name', 'test');
  if (cfg.scopeAdminId) url.searchParams.set('scope_admin_id', cfg.scopeAdminId);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json();
    setStatus(json && json.ok ? 'OK' : (json.error || 'Failed'));
  } catch (e) {
    setStatus('Network error');
  }
});

document.getElementById('openPanel').addEventListener('click', async () => {
  setStatus('Opening...');
  try {
    await withActiveTab(async (tab) => togglePanel(tab, true));
    setStatus('Panel opened');
  } catch (e) {
    setStatus('Open WhatsApp Web tab');
  }
});

document.getElementById('refreshPanel').addEventListener('click', async () => {
  setStatus('Refreshing...');
  try {
    await withActiveTab(async (tab) => togglePanel(tab, true));
    setStatus('Refreshed');
  } catch (e) {
    setStatus('Open WhatsApp Web tab');
  }
});

document.getElementById('openSite').addEventListener('click', async () => {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const baseUrl = normalizeBaseUrl(cfg.baseUrl || DEFAULTS.baseUrl) || DEFAULTS.baseUrl;
  await chrome.tabs.create({ url: baseUrl + '/index.php?page=settings' });
});

loadSettings();

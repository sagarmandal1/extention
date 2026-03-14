(() => {
  const DEFAULTS = {
    baseUrl: 'https://digital-store.top',
    token: '',
    scopeAdminId: ''
  };

  let booted = false;
  let observer = null;
  let pollTimer = null;
  let loadRunning = false;
  let loadQueued = null;

  function qs(sel, root = document) { return root.querySelector(sel); }

  function isContextInvalidatedError(e) {
    const msg = String(e && e.message ? e.message : e || '');
    return msg.toLowerCase().includes('extension context invalidated');
  }

  function isExtensionContextAlive() {
    try {
      return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function cleanupOnInvalidated() {
    try {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      booted = false;
    } catch { }
  }

  function normalizeBaseUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  async function getConfig() {
    if (!isExtensionContextAlive()) {
      cleanupOnInvalidated();
      return { ...DEFAULTS };
    }
    let cfg = null;
    try {
      cfg = await chrome.storage.sync.get(DEFAULTS);
    } catch (e) {
      if (isContextInvalidatedError(e)) cleanupOnInvalidated();
      return { ...DEFAULTS };
    }
    return {
      baseUrl: normalizeBaseUrl(cfg.baseUrl || DEFAULTS.baseUrl) || DEFAULTS.baseUrl,
      token: (cfg.token || '').trim(),
      scopeAdminId: (cfg.scopeAdminId || '').trim()
    };
  }

  async function getChatBindings() {
    if (!isExtensionContextAlive()) {
      cleanupOnInvalidated();
      return {};
    }
    try {
      const res = await chrome.storage.local.get({ chatBindings: {} });
      const map = res && res.chatBindings && typeof res.chatBindings === 'object' ? res.chatBindings : {};
      return map || {};
    } catch (e) {
      if (isContextInvalidatedError(e)) cleanupOnInvalidated();
      return {};
    }
  }

  function normalizeKey(key) {
    return String(key || '').trim().toLowerCase();
  }

  async function setChatBindings(keys, phoneDigits) {
    const p = (phoneDigits || '').trim();
    if (!p) return;
    const map = await getChatBindings();
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const key of arr) {
      const k = (key || '').trim();
      if (!k) continue;
      map[k] = p;
      map[normalizeKey(k)] = p;
    }
    if (!isExtensionContextAlive()) {
      cleanupOnInvalidated();
      return;
    }
    try {
      await chrome.storage.local.set({ chatBindings: map });
    } catch (e) {
      if (isContextInvalidatedError(e)) cleanupOnInvalidated();
    }
  }

  function extractDigits(str) {
    return (String(str || '').match(/\d+/g) || []).join('');
  }

  function normalizePhoneDigits(digits) {
    const d = String(digits || '');
    if (d.length < 10 || d.length > 15) return '';
    return d;
  }

  function getStableChatKey() {
    const root = document.querySelector('#app') || document.body;
    const pickKeyFromEl = (el) => {
      if (!el || !el.getAttribute) return '';
      const did = el.getAttribute('data-id') || '';
      if (did) return `data-id:${did}`;
      const jid = el.getAttribute('data-jid') || '';
      if (jid) return `data-jid:${jid}`;
      const dt = el.getAttribute('data-testid') || '';
      if (dt) return `data-testid:${dt}`;
      const id = el.id || '';
      if (id) return `id:${id}`;
      return '';
    };

    const selected = root.querySelector('[aria-selected="true"]') || document.querySelector('[aria-selected="true"]');
    const direct = pickKeyFromEl(selected) || pickKeyFromEl(selected && selected.closest('[data-id], [data-jid], [data-testid], [id]'));
    if (direct) return direct;

    const header = document.querySelector('header');
    const headerKey = pickKeyFromEl(header && header.closest('[data-id], [data-jid], [data-testid], [id]'));
    if (headerKey) return headerKey;

    const anyKey = pickKeyFromEl(root.querySelector('[data-id^="true_"], [data-jid]'));
    if (anyKey) return anyKey;

    return '';
  }

  function extractPhoneFromJidString(str) {
    const s = String(str || '');
    if (!s) return '';
    const m = s.match(/(\d{10,15})@(?:c\.us|s\.whatsapp\.net)/i);
    if (m && m[1]) return normalizePhoneDigits(m[1]);
    const m2 = s.match(/(?:c\.us|s\.whatsapp\.net).*?(\d{10,15})/i);
    if (m2 && m2[1]) return normalizePhoneDigits(m2[1]);
    return '';
  }

  function findPhoneCandidate(str) {
    const s = String(str || '');
    const m = s.match(/(\+?\d[\d\s\-()]{6,}\d)/);
    if (!m) return '';
    const digits = extractDigits(m[1]);
    return normalizePhoneDigits(digits);
  }

  function scorePhoneCandidate(digits, meta = {}) {
    const d = String(digits || '');
    if (!d) return -1;
    let score = 0;
    const len = d.length;
    if (d.startsWith('8801') && len === 13) score += 60;
    else if (d.startsWith('880') && len >= 12 && len <= 15) score += 25;
    else if (d.startsWith('01') && len === 11) score += 20;

    if (meta.hasPlus) score += 8;
    score += Math.max(0, 20 - Math.abs(len - 13)); // prefer typical BD length
    const idx = Number(meta.idx || 0);
    score += Math.max(0, 300 - idx) / 100; // earlier nodes slightly preferred
    return score;
  }

  function findRightPanelPhone() {
    const w = window.innerWidth || 1200;
    const maxTop = 420;
    const minLeft = w * 0.55;

    const nodes = document.querySelectorAll('span, div');
    let best = { digits: '', score: -1, rect: null };

    const limit = Math.min(nodes.length, 2500);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (!el) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 44) continue;
      const digits = findPhoneCandidate(txt);
      if (!digits) continue;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.left < minLeft) continue;
      if (r.bottom < 0 || r.top > maxTop) continue;
      const hasPlus = txt.includes('+');
      const posBonus = Math.max(0, maxTop - r.top) / 4;
      const sideBonus = Math.max(0, r.left - minLeft) / 40;
      const score = scorePhoneCandidate(digits, { hasPlus, idx: i }) + posBonus + sideBonus;
      if (score > best.score) {
        best = { digits, score, rect: r };
        if (score >= 95) break;
      }
    }

    return best.digits;
  }

  function findContactInfoRoot() {
    const rootNodes = Array.from(document.querySelectorAll('aside, section, div'));
    const must = ['Contact info'];
    const hints = [
      'Media, links and docs',
      'Starred messages',
      'Mute notifications',
      'Advanced chat privacy',
      'Encryption',
    ];

    const w = window.innerWidth || 1200;
    let best = null;
    let bestScore = -1;
    for (const el of rootNodes) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (!must.every(m => t.includes(m))) continue;
      const hintCount = hints.reduce((acc, h) => acc + (t.includes(h) ? 1 : 0), 0);
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.width < 240 || r.height < 260) continue;
      if (r.left < w * 0.35) continue;
      const score = hintCount * 10 + Math.max(0, 600 - r.top) / 50 + Math.max(0, r.left - w * 0.35) / 50;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function findPhoneInScope(rootEl) {
    if (!rootEl) return '';
    let bestDigits = '';
    let bestScore = -1;

    const consider = (txt, idx) => {
      if (!txt) return;
      const raw = String(txt);
      const hasPlus = raw.includes('+');
      const digits = findPhoneCandidate(raw);
      if (!digits) return;
      const score = scorePhoneCandidate(digits, { hasPlus, idx });
      if (score > bestScore) {
        bestScore = score;
        bestDigits = digits;
      }
    };

    const attrs = ['aria-label', 'title'];
    attrs.forEach((a, i) => consider(rootEl.getAttribute && rootEl.getAttribute(a), i));
    consider(rootEl.textContent, 10);

    const nodes = rootEl.querySelectorAll
      ? rootEl.querySelectorAll('span[title], span[dir="auto"], div[role="heading"], h1, h2, h3, [aria-label]')
      : [];
    let idx = 20;
    for (const n of nodes) {
      if (!n) continue;
      if (n.getAttribute) {
        consider(n.getAttribute('title'), idx++);
        consider(n.getAttribute('aria-label'), idx++);
      }
      consider(n.textContent, idx++);
      if (idx > 260) break;
    }

    return bestDigits;
  }

  function findPhoneFromJidInScope(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return '';
    let bestDigits = '';
    let bestScore = -1;

    const consider = (raw, idx) => {
      const digits = extractPhoneFromJidString(raw);
      if (!digits) return;
      const score = scorePhoneCandidate(digits, { hasPlus: false, idx });
      if (score > bestScore) {
        bestScore = score;
        bestDigits = digits;
      }
    };

    const attrs = ['data-jid', 'data-id', 'id', 'href'];
    let idx = 0;
    if (rootEl.getAttribute) {
      for (const a of attrs) {
        idx++;
        consider(rootEl.getAttribute(a), idx);
      }
    }
    const nodes = rootEl.querySelectorAll('[data-jid], [data-id], a[href]');
    for (const n of nodes) {
      idx++;
      if (n.getAttribute) {
        consider(n.getAttribute('data-jid'), idx);
        consider(n.getAttribute('data-id'), idx);
        consider(n.getAttribute('href'), idx);
      }
      if (idx > 200) break;
    }
    return bestDigits;
  }

  function findPhoneInContactInfoPanel() {
    const root = findContactInfoRoot();
    if (!root) return '';
    const w = window.innerWidth || 1200;
    let bestDigits = '';
    let bestScore = -1;

    const nodes = root.querySelectorAll('span, div, h1, h2, h3');
    let idx = 0;
    for (const n of nodes) {
      idx++;
      const txt = (n.textContent || '').trim();
      if (!txt) continue;
      const digits = findPhoneCandidate(txt);
      if (!digits) continue;
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.left < w * 0.35) continue;
      if (r.top > 260) continue;
      const hasPlus = txt.includes('+');
      const score = scorePhoneCandidate(digits, { hasPlus, idx }) + Math.max(0, 260 - r.top) / 5;
      if (score > bestScore) {
        bestScore = score;
        bestDigits = digits;
      }
      if (bestScore >= 90) break;
      if (idx > 400) break;
    }
    return bestDigits;
  }

  function findPhoneInHeader() {
    const header = document.querySelector('header');
    if (!header) return '';
    let bestDigits = '';
    let bestScore = -1;
    const nodes = header.querySelectorAll('span, div, h1, h2, h3');
    let idx = 0;
    for (const n of nodes) {
      idx++;
      const txt = (n.textContent || '').trim();
      if (!txt) continue;
      const digits = findPhoneCandidate(txt);
      if (!digits) continue;
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.top > 140) continue;
      const hasPlus = txt.includes('+');
      const score = scorePhoneCandidate(digits, { hasPlus, idx }) + Math.max(0, 140 - r.top) / 5;
      if (score > bestScore) {
        bestScore = score;
        bestDigits = digits;
      }
      if (bestScore >= 90) break;
      if (idx > 250) break;
    }
    return bestDigits;
  }

  function findPhoneInDom(scopes) {
    const els = [];
    for (const s of (Array.isArray(scopes) ? scopes : [])) {
      if (s) els.push(s);
    }
    const rightPhone = findRightPanelPhone();
    if (rightPhone) return rightPhone;
    const fromContact = findPhoneInContactInfoPanel();
    if (fromContact) return fromContact;
    for (const r of els) {
      const fromJid = findPhoneFromJidInScope(r);
      if (fromJid) return fromJid;
    }
    const fromHeader = findPhoneInHeader();
    if (fromHeader) return fromHeader;
    els.push(document.querySelector('#app [aria-selected="true"]') || document.querySelector('[aria-selected="true"]'));

    for (const root of els.filter(Boolean)) {
      const digits = findPhoneInScope(root);
      if (digits) return digits;
    }
    return '';
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function openModal(title, bodyHtml, onBind) {
    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay';
    overlay.innerHTML = `
      <div class="ds-modal">
        <div class="ds-modal-header">
          <div class="ds-modal-title">${escapeHtml(title)}</div>
          <button class="ds-modal-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="ds-modal-body">${bodyHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.ds-modal-close').addEventListener('click', close);
    if (typeof onBind === 'function') onBind(overlay, close);
    return { overlay, close };
  }

  function openToast(msg) {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.right = '16px';
    el.style.bottom = '92px';
    el.style.zIndex = '1000002';
    el.style.background = '#111';
    el.style.color = '#fff';
    el.style.padding = '10px 12px';
    el.style.borderRadius = '10px';
    el.style.boxShadow = '0 10px 24px rgba(0,0,0,.22)';
    el.style.fontSize = '13px';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function showApiError(title, res) {
    const err = escapeHtml((res && res.error) ? String(res.error) : 'error');
    const raw = escapeHtml((res && res.raw) ? String(res.raw) : '');
    openModal(title, `
      <div style="font-weight:800; margin-bottom:8px;">${err}</div>
      ${raw ? `<pre style="white-space:pre-wrap; word-break:break-word; font-size:12px; background:#f6f7f8; padding:10px; border-radius:10px; border:1px solid #eee; max-height:220px; overflow:auto;">${raw}</pre>` : ''}
      <div class="ds-modal-actions">
        <button class="ds-btn ds-btn-block" type="button" id="ds-err-ok">ঠিক আছে</button>
      </div>
    `, (overlay, close) => {
      overlay.querySelector('#ds-err-ok').onclick = close;
    });
  }

  async function loadSafe(panel, identity) {
    if (loadRunning) {
      loadQueued = identity;
      return;
    }
    loadRunning = true;
    try {
      await load(panel, identity);
    } finally {
      loadRunning = false;
      if (loadQueued) {
        const next = loadQueued;
        loadQueued = null;
        await loadSafe(panel, next);
      }
    }
  }

  function getChatIdentity() {
    const extractPhone = (str) => {
      if (!str) return '';
      const digits = (str.match(/\d+/g) || []).join('');
      return normalizePhoneDigits(digits);
    };

    const stableKey = getStableChatKey();
    const selected = document.querySelector('#app [aria-selected="true"]') || document.querySelector('[aria-selected="true"]');
    const rightPhone = findRightPanelPhone();
    const header = document.querySelector('header');

    if (rightPhone) {
      const keyBase = stableKey || rightPhone;
      return { key: keyBase, titleKey: '', name: '', phone: rightPhone };
    }

    if (header) {
      const spans = header.querySelectorAll('span[dir="auto"][title]');
      for (const span of spans) {
        const title = span.getAttribute('title').trim();
        const phone = extractPhone(title);
        if (phone) return { key: stableKey || title, titleKey: title, name: title, phone };
      }

      const titleEl = header.querySelector('[data-testid="conversation-info-header"] span') ||
        header.querySelector('div[role="heading"] span') ||
        header.querySelector('span.selectable-text');
      if (titleEl) {
        const title = titleEl.textContent.trim();
        const phoneFromTitle = extractPhone(title);
        const phone = phoneFromTitle || findPhoneInDom([selected, header]);
        return { key: stableKey || title, titleKey: title, name: title, phone };
      }
    }

    const sidebar = document.querySelector('[data-testid="contact-info-drawer"]') ||
      document.querySelector('[data-testid="drawer-right"]') ||
      document.querySelector('section'); // চ্যাট ডিটেইলস সেকশন
    if (sidebar) {
      const sidebarTitleEls = [
        sidebar.querySelector('[data-testid="contact-info-title"]'),
        sidebar.querySelector('span[data-testid="contact-info-header-title"]'),
        sidebar.querySelector('span[dir="auto"][title]'),
        sidebar.querySelector('.selectable-text.copyable-text')
      ];
      for (const el of sidebarTitleEls) {
        if (el) {
          const title = (el.getAttribute('title') || el.textContent || '').trim();
          if (title) {
            const phoneFromTitle = extractPhone(title);
            const phone = phoneFromTitle || findPhoneInDom([selected, sidebar]);
            return { key: stableKey || title, titleKey: title, name: title, phone };
          }
        }
      }
    }

    // ৪. যদি উপরে কোথাও না পাওয়া যায়, তবে পুরো পেজে dir="auto" সহ চ্যাট টাইটেল খোঁজা
    // এটি শেষ চেষ্টা হিসেবে করা হচ্ছে
    const activeChat = document.querySelector('div[aria-selected="true"]');
    if (activeChat) {
      const span = activeChat.querySelector('span[dir="auto"][title]');
      if (span) {
        const title = span.getAttribute('title').trim();
        const phone = extractPhone(title);
        return { key: stableKey || title, titleKey: title, name: title, phone };
      }
    }

    if (stableKey) {
      return { key: stableKey, titleKey: '', name: '', phone: findPhoneInDom([selected, header]) };
    }
    return null;
  }

  function ensurePanel() {
    let panel = document.getElementById('ds-wa-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ds-wa-panel';
      panel.innerHTML = `
        <div class="ds-header">
          <span class="ds-title">Digital Store</span>
          <div class="ds-header-actions">
            <button class="ds-refresh-btn" id="ds-refresh-now" title="রিফ্রেশ">↻</button>
            <button class="ds-close" title="হাইড">×</button>
          </div>
        </div>
        <div class="ds-body">
          <div class="ds-tabs">
            <button class="ds-tab-btn active" data-tab="customer">কাস্টমার</button>
            <button class="ds-tab-btn" data-tab="tools">অন্যান্য</button>
          </div>
          <div class="ds-tab-content" id="ds-tab-customer">
            <div class="ds-section" id="ds-customer">Loading...</div>
            <div class="ds-actions" id="ds-actions"></div>
            <div class="ds-section" id="ds-recent"></div>
          </div>
          <div class="ds-tab-content ds-hidden" id="ds-tab-tools">
            <div class="ds-section">
              <div class="ds-subtitle">ব্যবসায়িক টুলস</div>
              <div class="ds-actions">
                <button class="ds-btn" id="ds-expense-add">খরচ যোগ করুন</button>
                <button class="ds-btn" id="ds-price-check">প্রাইস লিস্ট</button>
                <button class="ds-btn ds-btn-secondary" id="ds-due-list">বাকি তালিকা</button>
                <button class="ds-btn ds-btn-secondary" id="ds-daily-stats">আজকের রিপোর্ট</button>
              </div>
            </div>
            <div class="ds-section">
              <div class="ds-subtitle">সাইট শর্টকাট</div>
              <div class="ds-actions">
                <a class="ds-link" id="ds-link-customers" target="_blank" rel="noopener noreferrer" href="#">Customers</a>
                <a class="ds-link" id="ds-link-products" target="_blank" rel="noopener noreferrer" href="#">Products</a>
                <a class="ds-link" id="ds-link-sales" target="_blank" rel="noopener noreferrer" href="#">Sales</a>
                <a class="ds-link" id="ds-link-dues" target="_blank" rel="noopener noreferrer" href="#">Due</a>
                <a class="ds-link" id="ds-link-expenses" target="_blank" rel="noopener noreferrer" href="#">Expenses</a>
                <a class="ds-link" id="ds-link-reports" target="_blank" rel="noopener noreferrer" href="#">Reports</a>
                <a class="ds-link" id="ds-link-settings" target="_blank" rel="noopener noreferrer" href="#">Settings</a>
              </div>
            </div>
            <div class="ds-section" id="ds-tools-output"></div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      // Tab switching logic
      panel.querySelectorAll('.ds-tab-btn').forEach(btn => {
        btn.onclick = () => {
          panel.querySelectorAll('.ds-tab-btn').forEach(b => b.classList.remove('active'));
          panel.querySelectorAll('.ds-tab-content').forEach(c => c.classList.add('ds-hidden'));
          btn.classList.add('active');
          document.getElementById('ds-tab-' + btn.dataset.tab).classList.remove('ds-hidden');
        };
      });

      panel.querySelector('.ds-close').addEventListener('click', () => panel.classList.toggle('ds-hidden'));
      panel.querySelector('#ds-refresh-now').addEventListener('click', () => boot(true));

      getConfig().then(cfg => {
        const base = cfg.baseUrl || DEFAULTS.baseUrl;
        const set = (id, page) => {
          const a = panel.querySelector(id);
          if (a) a.href = `${base}/index.php?page=${page}`;
        };
        set('#ds-link-customers', 'customers');
        set('#ds-link-products', 'products');
        set('#ds-link-sales', 'sales');
        set('#ds-link-dues', 'dues');
        set('#ds-link-expenses', 'expenses');
        set('#ds-link-reports', 'reports');
        set('#ds-link-settings', 'settings');
      }).catch(() => { });

      // Global tools events
      panel.querySelector('#ds-expense-add').onclick = async () => {
        openModal('খরচ যোগ করুন', `
          <div class="ds-field">
            <label class="ds-label">পরিমাণ</label>
            <input class="ds-input" id="ds-exp-amount" inputmode="decimal" placeholder="যেমন 500">
          </div>
          <div class="ds-field">
            <label class="ds-label">ক্যাটাগরি</label>
            <input class="ds-input" id="ds-exp-cat" placeholder="General">
          </div>
          <div class="ds-field">
            <label class="ds-label">নোট</label>
            <textarea class="ds-textarea" id="ds-exp-note" placeholder="ঐচ্ছিক"></textarea>
          </div>
          <div class="ds-modal-actions">
            <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-exp-cancel">বাতিল</button>
            <button class="ds-btn ds-btn-block" type="button" id="ds-exp-save">সেভ</button>
          </div>
        `, (overlay, close) => {
          overlay.querySelector('#ds-exp-cancel').onclick = close;
          overlay.querySelector('#ds-exp-save').onclick = async () => {
            const amount = Number(overlay.querySelector('#ds-exp-amount').value || 0);
            if (!(amount > 0)) {
              openToast('পরিমাণ দিন');
              return;
            }
            const category = (overlay.querySelector('#ds-exp-cat').value || 'General').trim() || 'General';
            const note = (overlay.querySelector('#ds-exp-note').value || '').trim();
            const res = await apiPost('ajax_expense_add', { amount, category, note });
            if (res.ok) {
              close();
              openToast('খরচ যোগ হয়েছে');
            } else {
              openToast(res.error || 'ব্যর্থ হয়েছে');
            }
          };
        });
      };

      panel.querySelector('#ds-price-check').onclick = async () => {
        const q = prompt('প্রোডাক্টের নাম বা SKU লিখুন:', '') || '';
        const res = await apiGet('ajax_products_lookup', { q });
        const out = document.getElementById('ds-tools-output');
        if (res.ok && res.products.length > 0) {
          out.innerHTML = `<div class="ds-subtitle">প্রোডাক্ট লিস্ট</div><div class="ds-list">${res.products.map(p => `<div><b>${p.name}</b><br><span class="ds-muted">SKU: ${p.sku} • মূল্য: ${fmtMoney(p.price)}</span></div>`).join('')}</div>`;
        } else {
          out.innerHTML = '<div class="ds-muted">কোনো প্রোডাক্ট পাওয়া যায়নি</div>';
        }
      };

      panel.querySelector('#ds-due-list').onclick = async () => {
        const res = await apiGet('ajax_dues_list');
        const out = document.getElementById('ds-tools-output');
        if (res.ok && res.dues.length > 0) {
          out.innerHTML = `<div class="ds-subtitle">বাকি তালিকা (Top 20)</div><div class="ds-list">${res.dues.map(d => `<div><b>${d.name}</b><br><span class="ds-muted">${d.phone}</span><br><b class="ds-red">বাকি: ${fmtMoney(d.due)}</b></div>`).join('')}</div>`;
        } else {
          out.innerHTML = '<div class="ds-muted">কোনো বাকি নেই</div>';
        }
      };

      panel.querySelector('#ds-daily-stats').onclick = async () => {
        const res = await apiGet('ajax_daily_stats');
        const out = document.getElementById('ds-tools-output');
        if (res.ok) {
          const s = res.stats;
          out.innerHTML = `
            <div class="ds-subtitle">আজকের রিপোর্ট (${res.date})</div>
            <div class="ds-kpis">
              <div><div class="ds-kpi-label">বিক্রয়</div><div class="ds-kpi">${fmtMoney(s.sales)}</div></div>
              <div><div class="ds-kpi-label">কালেকশন</div><div class="ds-kpi ds-green">${fmtMoney(s.payments)}</div></div>
              <div><div class="ds-kpi-label">খরচ</div><div class="ds-kpi ds-red">${fmtMoney(s.expenses)}</div></div>
            </div>
            <div style="margin-top:10px; font-weight:700; text-align:center;">ক্যাশ ইন হ্যান্ড: <span class="${s.net >= 0 ? 'ds-green' : 'ds-red'}">${fmtMoney(s.net)}</span></div>
          `;
        }
      };
    }
    if (panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
    return panel;
  }

  async function apiGet(page, params = {}) {
    const cfg = await getConfig();
    if (!cfg.token) return { ok: false, error: 'token_missing' };
    const url = new URL(cfg.baseUrl + '/index.php');
    url.searchParams.set('page', page);
    if (cfg.scopeAdminId) url.searchParams.set('scope_admin_id', cfg.scopeAdminId);
    Object.entries(params).forEach(([k, v]) => v != null && v !== '' && url.searchParams.set(k, v));
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${cfg.token}` }
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: `bad_response_${res.status}`, raw: text.slice(0, 2000) };
      }
    } catch (e) {
      if (isContextInvalidatedError(e)) cleanupOnInvalidated();
      return { ok: false, error: 'network' };
    }
  }

  async function apiPost(page, data) {
    const cfg = await getConfig();
    if (!cfg.token) return { ok: false, error: 'token_missing' };
    const url = new URL(cfg.baseUrl + '/index.php');
    url.searchParams.set('page', page);
    if (cfg.scopeAdminId) url.searchParams.set('scope_admin_id', cfg.scopeAdminId);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`
        },
        body: JSON.stringify(data || {})
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: `bad_response_${res.status}`, raw: text.slice(0, 2000) };
      }
    } catch (e) {
      if (isContextInvalidatedError(e)) cleanupOnInvalidated();
      return { ok: false, error: 'network' };
    }
  }

  function fmtMoney(n) {
    const v = Number(n || 0);
    return v.toFixed(2);
  }

  async function render(panel, identity, lookup, ledger) {
    const customerEl = panel.querySelector('#ds-customer');
    const actionsEl = panel.querySelector('#ds-actions');
    const recentEl = panel.querySelector('#ds-recent');

    if (!lookup.ok) {
      if (lookup.error === 'token_missing') {
        customerEl.innerHTML = `<div class="ds-muted">Set API token from extension popup</div>`;
      } else if (lookup.error === 'Unauthorized') {
        customerEl.innerHTML = `<div class="ds-muted">Token invalid. Generate token in Settings</div>`;
      } else {
        customerEl.innerHTML = `<div class="ds-muted">Failed (${lookup.error || 'error'})</div>`;
      }
      actionsEl.innerHTML = '';
      recentEl.innerHTML = '';
      return;
    }

    if (!lookup.found) {
      customerEl.innerHTML = `
        <div style="margin-bottom:10px;"><b>${identity.name || identity.phone || 'Unknown'}</b></div>
        <div class="ds-muted" style="margin-bottom:10px;">এই কাস্টমারটি ডাটাবেসে নেই।</div>
      `;
      actionsEl.innerHTML = `<button class="ds-btn ds-btn-block" id="ds-add">+ কাস্টমার যোগ করুন</button>`;
      recentEl.innerHTML = '';
      actionsEl.querySelector('#ds-add').onclick = async () => {
        const initPhone = (identity.phone || '').trim();
        openModal('নতুন কাস্টমার', `
          <div class="ds-field">
            <label class="ds-label">ফোন</label>
            <input class="ds-input" id="ds-new-phone" value="${escapeHtml(initPhone)}" placeholder="+880...">
          </div>
          <div class="ds-field">
            <label class="ds-label">নাম</label>
            <input class="ds-input" id="ds-new-name" value="${escapeHtml(identity.name || '')}" placeholder="কাস্টমারের নাম">
          </div>
          <div class="ds-field">
            <label class="ds-label">ইমেইল</label>
            <input class="ds-input" id="ds-new-email" placeholder="ঐচ্ছিক">
          </div>
          <div class="ds-field">
            <label class="ds-label">ঠিকানা</label>
            <textarea class="ds-textarea" id="ds-new-address" placeholder="ঐচ্ছিক"></textarea>
          </div>
          <div class="ds-field">
            <label class="ds-label">ক্যাটাগরি</label>
            <select class="ds-select" id="ds-new-cat">
              <option value="Regular">Regular</option>
              <option value="VIP">VIP</option>
            </select>
          </div>
          <div class="ds-modal-actions">
            <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-new-cancel">বাতিল</button>
            <button class="ds-btn ds-btn-block" type="button" id="ds-new-save">সেভ</button>
          </div>
        `, (overlay, close) => {
          overlay.querySelector('#ds-new-cancel').onclick = close;
          overlay.querySelector('#ds-new-save').onclick = async () => {
            const phone = (overlay.querySelector('#ds-new-phone').value || '').trim();
            const digits = extractDigits(phone);
            const name = (overlay.querySelector('#ds-new-name').value || '').trim();
            const email = (overlay.querySelector('#ds-new-email').value || '').trim();
            const address = (overlay.querySelector('#ds-new-address').value || '').trim();
            const category = (overlay.querySelector('#ds-new-cat').value || 'Regular').trim();
            if (digits.length < 7 && !name) {
              openToast('ফোন বা নাম দিন');
              return;
            }
            const res = await apiPost('ajax_customer_quick_add', { name, phone, email, address, category });
            if (res.ok) {
              close();
              await loadSafe(panel, { ...(identity || {}), phone: digits || phone, name: name || identity.name || '' });
            } else {
              openToast(res.error || 'যোগ করতে ব্যর্থ হয়েছে');
            }
          };
        });
      };
      return;
    }

    const c = lookup.customer;
    const s = lookup.summary;
    const notes = Array.isArray(lookup.notes) ? lookup.notes : [];
    const recentSales = Array.isArray(lookup.recent_sales) ? lookup.recent_sales : [];
    customerEl.innerHTML = `
      ${identity && identity.nameMatch ? `<div class="ds-muted" style="text-align:left; padding:0; margin-bottom:8px;">ফোন ডিটেক্ট হয়নি, নাম দিয়ে মিলেছে</div>` : ''}
      <div style="font-size:15px;"><b>${c.name}</b> <span class="ds-badge">${c.category || 'Regular'}</span></div>
      <div class="ds-muted" style="text-align:left; padding:2px 0;">📞 ${c.phone || '-'}</div>
      <div class="ds-muted" style="text-align:left; padding:2px 0;">📧 ${c.email || '-'}</div>
      ${c.address ? `<div class="ds-muted" style="text-align:left; padding:2px 0;">📍 ${c.address}</div>` : ''}
      <div class="ds-kpis">
        <div><div class="ds-kpi-label">মোট বিক্রয়</div><div class="ds-kpi">${fmtMoney(s.total_sell)}</div></div>
        <div><div class="ds-kpi-label">পরিশোধ</div><div class="ds-kpi ds-green">${fmtMoney(s.total_paid)}</div></div>
        <div><div class="ds-kpi-label">বাকি</div><div class="ds-kpi ${s.total_due > 0.01 ? 'ds-red' : 'ds-green'}">${fmtMoney(s.total_due)}</div></div>
      </div>
    `;

    const cfg = await getConfig();
    actionsEl.innerHTML = `
      <div class="ds-actionbar">
        <div class="ds-menu-wrap">
          <button class="ds-btn ds-btn-secondary ds-menu-btn" id="ds-action-menu-btn" type="button">
            অ্যাকশন <span>▾</span>
          </button>
          <div class="ds-menu ds-hidden" id="ds-action-menu">
            <button class="ds-menu-item" id="ds-sale" type="button">নতুন সেল</button>
            <button class="ds-menu-item" id="ds-pay" type="button">পেমেন্ট</button>
            <button class="ds-menu-item" id="ds-note" type="button">নোট যোগ</button>
            <button class="ds-menu-item" id="ds-update" type="button">কাস্টমার আপডেট</button>
            <button class="ds-menu-item" id="ds-send-summary" type="button">সামারি পাঠান</button>
            <button class="ds-menu-item" id="ds-send-due" type="button">বকেয়া রিমাইন্ডার</button>
            <button class="ds-menu-item" id="ds-send-invoice" type="button">ইনভয়েস পাঠান</button>
          </div>
        </div>
        <a class="ds-link" target="_blank" href="${cfg.baseUrl}/index.php?page=customer_ledger&id=${c.id}">লেজার</a>
      </div>
      ${identity && identity.nameMatch ? `<button class="ds-btn ds-btn-secondary ds-btn-block" id="ds-bind-detected" type="button">এই চ্যাটে ফোন লিংক করুন</button>` : ''}
    `;

    const menuBtn = actionsEl.querySelector('#ds-action-menu-btn');
    const menu = actionsEl.querySelector('#ds-action-menu');
    const closeMenu = () => menu.classList.add('ds-hidden');
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('ds-hidden');
    };
    document.addEventListener('click', closeMenu, { once: true });
    menu.addEventListener('click', (e) => e.stopPropagation());

    if (identity && identity.nameMatch) {
      const btn = actionsEl.querySelector('#ds-bind-detected');
      if (btn) {
        btn.onclick = async () => {
          const digits = normalizePhoneDigits(extractDigits(c.phone || ''));
          if (!digits) {
            openToast('ফোন পাওয়া যায়নি');
            return;
          }
          const keys = [];
          if (identity.key) keys.push(String(identity.key));
          if (identity.titleKey) keys.push(String(identity.titleKey));
          if (identity.name) keys.push(String(identity.name));
          if (!keys.length) {
            openToast('চ্যাট কী পাওয়া যায়নি');
            return;
          }
          await setChatBindings(keys, digits);
          openToast('লিংক হয়েছে');
          await loadSafe(panel, { ...(identity || {}), phone: digits, nameMatch: false });
        };
      }
    }

    const ledgerEvents = ledger && ledger.ok && Array.isArray(ledger.events) ? ledger.events : [];

    recentEl.innerHTML = `
      <div class="ds-subtitle">সাম্প্রতিক লেনদেন</div>
      <div class="ds-list">
        ${ledgerEvents.map(e => `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600;">${e.type === 'sale' ? 'বিক্রয়' : 'পেমেন্ট'} (${e.invoice_no})</div>
              <div class="ds-muted" style="text-align:left; padding:0;">${e.date}</div>
            </div>
            <div class="ds-kpi ${e.type === 'sale' ? 'ds-red' : 'ds-green'}">${e.type === 'sale' ? '-' : '+'}${fmtMoney(e.amount)}</div>
          </div>
        `).join('') || '<div class="ds-muted">কোনো লেনদেন পাওয়া যায়নি</div>'}
      </div>
      
      ${notes.length > 0 ? `
        <div class="ds-subtitle">নোটসমূহ</div>
        <div class="ds-list">
          ${notes.map(n => `<div><div class="ds-muted" style="text-align:left; padding:0;">${n.created_at}</div><div>${n.note}</div></div>`).join('')}
        </div>
      ` : ''}
    `;

    actionsEl.querySelector('#ds-sale').onclick = async () => {
      closeMenu();
      let selected = { id: null, name: 'WhatsApp Quick Sale', price: 0 };
      openModal('নতুন সেল', `
        <div class="ds-field">
          <label class="ds-label">প্রোডাক্ট (ঐচ্ছিক)</label>
          <input class="ds-input" id="ds-sale-q" placeholder="নাম বা SKU লিখুন">
          <div class="ds-suggest" id="ds-sale-suggest"></div>
        </div>
        <div class="ds-row">
          <div class="ds-field">
            <label class="ds-label">পরিমাণ (মোট)</label>
            <input class="ds-input" id="ds-sale-amount" inputmode="decimal" placeholder="যেমন 1000">
          </div>
          <div class="ds-field">
            <label class="ds-label">Quantity</label>
            <input class="ds-input" id="ds-sale-qty" inputmode="numeric" value="1">
          </div>
          <div class="ds-field">
            <label class="ds-label">তাত্ক্ষণিক পেমেন্ট</label>
            <input class="ds-input" id="ds-sale-pay" inputmode="decimal" value="0">
          </div>
        </div>
        <div class="ds-field">
          <label class="ds-label">নোট</label>
          <textarea class="ds-textarea" id="ds-sale-notes" placeholder="ঐচ্ছিক"></textarea>
        </div>
        <div class="ds-modal-actions">
          <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-sale-cancel">বাতিল</button>
          <button class="ds-btn ds-btn-block" type="button" id="ds-sale-save">সেভ</button>
        </div>
      `, (overlay, close) => {
        const qEl = overlay.querySelector('#ds-sale-q');
        const suggestEl = overlay.querySelector('#ds-sale-suggest');
        const amountEl = overlay.querySelector('#ds-sale-amount');
        const qtyEl = overlay.querySelector('#ds-sale-qty');
        let t = null;
        const doSearch = async () => {
          const q = (qEl.value || '').trim();
          if (!q) {
            suggestEl.innerHTML = '';
            return;
          }
          const res = await apiGet('ajax_products_lookup', { q, customer_id: c.id });
          if (!res.ok || !Array.isArray(res.products)) {
            suggestEl.innerHTML = '';
            return;
          }
          suggestEl.innerHTML = res.products.slice(0, 6).map(p => `
            <button type="button" class="ds-suggest-item" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}">
              <div style="font-weight:800;">${escapeHtml(p.name)}</div>
              <div class="ds-muted" style="text-align:left; padding:0;">SKU: ${escapeHtml(p.sku || '')} • মূল্য: ${fmtMoney(p.price)}${p.is_custom ? ' (Custom)' : ''}</div>
            </button>
          `).join('');
          suggestEl.querySelectorAll('.ds-suggest-item').forEach(item => {
            item.addEventListener('click', () => {
              selected = {
                id: Number(item.dataset.id || 0) || null,
                name: item.dataset.name || 'WhatsApp Quick Sale',
                price: Number(item.dataset.price || 0) || 0
              };
              const qty = Math.max(1, Math.min(999, Number(qtyEl.value || 1) || 1));
              qtyEl.value = String(qty);
              amountEl.value = String((selected.price || 0) * qty);
              suggestEl.innerHTML = '';
              qEl.value = selected.name;
            });
          });
        };
        qEl.addEventListener('input', () => {
          if (t) clearTimeout(t);
          t = setTimeout(doSearch, 250);
        });
        qtyEl.addEventListener('input', () => {
          const qty = Math.max(1, Math.min(999, Number(qtyEl.value || 1) || 1));
          qtyEl.value = String(qty);
          if (selected && selected.id) {
            amountEl.value = String((selected.price || 0) * qty);
          }
        });

        overlay.querySelector('#ds-sale-cancel').onclick = close;
        overlay.querySelector('#ds-sale-save').onclick = async () => {
          const amount = Number(amountEl.value || 0);
          if (!(amount > 0)) {
            openToast('পরিমাণ দিন');
            return;
          }
          const qty = Math.max(1, Math.min(999, Number(qtyEl.value || 1) || 1));
          const payment_amount = Number(overlay.querySelector('#ds-sale-pay').value || 0) || 0;
          const notes = (overlay.querySelector('#ds-sale-notes').value || '').trim();
          const res = await apiPost('ajax_quick_sale', {
            customer_id: c.id,
            amount,
            notes,
            payment_amount,
            product_id: selected.id,
            product_name: selected.name || 'WhatsApp Quick Sale',
            qty
          });
          if (res.ok) {
            close();
            await loadSafe(panel, identity);
            openToast('সেল যোগ হয়েছে');
          } else {
            openToast(res.error || 'ব্যর্থ হয়েছে');
          }
        };
      });
    };

    actionsEl.querySelector('#ds-pay').onclick = async () => {
      closeMenu();
      openModal('পেমেন্ট', `
        <div class="ds-row">
          <div class="ds-field">
            <label class="ds-label">পরিমাণ</label>
            <input class="ds-input" id="ds-pay-amount" inputmode="decimal" placeholder="যেমন 500">
          </div>
          <div class="ds-field">
            <label class="ds-label">পদ্ধতি</label>
            <select class="ds-select" id="ds-pay-method">
              <option value="Cash">Cash</option>
              <option value="bKash">bKash</option>
              <option value="Nagad">Nagad</option>
              <option value="Bank">Bank</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>
        <div class="ds-field">
          <label class="ds-label">নোট</label>
          <textarea class="ds-textarea" id="ds-pay-note" placeholder="ঐচ্ছিক"></textarea>
        </div>
        <div class="ds-modal-actions">
          <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-pay-cancel">বাতিল</button>
          <button class="ds-btn ds-btn-block" type="button" id="ds-pay-save">সেভ</button>
        </div>
      `, (overlay, close) => {
        overlay.querySelector('#ds-pay-cancel').onclick = close;
        overlay.querySelector('#ds-pay-save').onclick = async () => {
          const amount = Number(overlay.querySelector('#ds-pay-amount').value || 0);
          if (!(amount > 0)) {
            openToast('পরিমাণ দিন');
            return;
          }
          const method = (overlay.querySelector('#ds-pay-method').value || 'Cash').trim();
          const note = (overlay.querySelector('#ds-pay-note').value || '').trim();
          const res = await apiPost('ajax_quick_payment', { customer_id: c.id, amount, method, note });
          if (res.ok) {
            close();
            await loadSafe(panel, identity);
            openToast('পেমেন্ট যোগ হয়েছে');
          } else {
            openToast(res.error || 'ব্যর্থ হয়েছে');
          }
        };
      });
    };

    actionsEl.querySelector('#ds-update').onclick = async () => {
      closeMenu();
      openModal('কাস্টমার আপডেট', `
        <div class="ds-field">
          <label class="ds-label">নাম</label>
          <input class="ds-input" id="ds-up-name" value="${escapeHtml(c.name || '')}">
        </div>
        <div class="ds-field">
          <label class="ds-label">ফোন</label>
          <input class="ds-input" id="ds-up-phone" value="${escapeHtml(c.phone || '')}">
        </div>
        <div class="ds-field">
          <label class="ds-label">ইমেইল</label>
          <input class="ds-input" id="ds-up-email" value="${escapeHtml(c.email || '')}">
        </div>
        <div class="ds-field">
          <label class="ds-label">ঠিকানা</label>
          <textarea class="ds-textarea" id="ds-up-address">${escapeHtml(c.address || '')}</textarea>
        </div>
        <div class="ds-field">
          <label class="ds-label">ক্যাটাগরি</label>
          <select class="ds-select" id="ds-up-cat">
            <option value="Regular" ${c.category === 'VIP' ? '' : 'selected'}>Regular</option>
            <option value="VIP" ${c.category === 'VIP' ? 'selected' : ''}>VIP</option>
          </select>
        </div>
        <div class="ds-modal-actions">
          <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-up-cancel">বাতিল</button>
          <button class="ds-btn ds-btn-block" type="button" id="ds-up-save">সেভ</button>
        </div>
      `, (overlay, close) => {
        overlay.querySelector('#ds-up-cancel').onclick = close;
        overlay.querySelector('#ds-up-save').onclick = async () => {
          const name = (overlay.querySelector('#ds-up-name').value || '').trim();
          const phone = (overlay.querySelector('#ds-up-phone').value || '').trim();
          const email = (overlay.querySelector('#ds-up-email').value || '').trim();
          const address = (overlay.querySelector('#ds-up-address').value || '').trim();
          const category = (overlay.querySelector('#ds-up-cat').value || c.category || 'Regular').trim();
          const res = await apiPost('ajax_customer_update', { id: c.id, name, phone, email, address, category });
          if (res.ok) {
            close();
            await loadSafe(panel, identity);
            openToast('আপডেট হয়েছে');
          } else {
            openToast(res.error || 'ব্যর্থ হয়েছে');
          }
        };
      });
    };

    actionsEl.querySelector('#ds-note').onclick = async () => {
      closeMenu();
      openModal('নোট যোগ', `
        <div class="ds-field">
          <label class="ds-label">নোট</label>
          <textarea class="ds-textarea" id="ds-note-text" placeholder="নোট লিখুন"></textarea>
        </div>
        <div class="ds-modal-actions">
          <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-note-cancel">বাতিল</button>
          <button class="ds-btn ds-btn-block" type="button" id="ds-note-save">সেভ</button>
        </div>
      `, (overlay, close) => {
        overlay.querySelector('#ds-note-cancel').onclick = close;
        overlay.querySelector('#ds-note-save').onclick = async () => {
          const note = (overlay.querySelector('#ds-note-text').value || '').trim();
          if (!note) {
            openToast('নোট লিখুন');
            return;
          }
          const res = await apiPost('ajax_customer_note_add', { customer_id: c.id, note });
          if (res.ok) {
            close();
            await loadSafe(panel, identity);
            openToast('নোট যোগ হয়েছে');
          } else {
            openToast(res.error || 'ব্যর্থ হয়েছে');
          }
        };
      });
    };

    actionsEl.querySelector('#ds-send-summary').onclick = async () => {
      closeMenu();
      const res = await apiPost('ajax_send_notification', { customer_id: c.id, type: 'summary' });
      if (res.ok) openToast('সামারি পাঠানো হয়েছে');
      else showApiError('সামারি পাঠাতে ব্যর্থ', res);
    };

    actionsEl.querySelector('#ds-send-due').onclick = async () => {
      closeMenu();
      const res = await apiPost('ajax_send_notification', { customer_id: c.id, type: 'due_reminder' });
      if (res.ok) openToast('রিমাইন্ডার পাঠানো হয়েছে');
      else showApiError('রিমাইন্ডার পাঠাতে ব্যর্থ', res);
    };

    actionsEl.querySelector('#ds-send-invoice').onclick = async () => {
      closeMenu();
      if (!recentSales.length) {
        openToast('এই কাস্টমারের কোনো ইনভয়েস নেই');
        return;
      }

      const itemsHtml = recentSales.slice(0, 6).map(r => {
        const inv = escapeHtml(r.invoice_no || '');
        const dt = escapeHtml(r.sale_date || '');
        const tot = fmtMoney(Number(r.total_sell || 0));
        const paid = fmtMoney(Number(r.paid_amount || 0));
        const dueAmt = fmtMoney(Math.max(0, Number(r.total_sell || 0) - Number(r.paid_amount || 0)));
        return `
          <button type="button" class="ds-suggest-item" data-sale-id="${r.id}">
            <div style="font-weight:900;">${inv}</div>
            <div class="ds-muted" style="text-align:left; padding:0;">তারিখ: ${dt}</div>
            <div class="ds-muted" style="text-align:left; padding:0;">মোট: ${tot} • পরিশোধ: ${paid} • বাকি: ${dueAmt}</div>
          </button>
        `;
      }).join('');

      openModal('ইনভয়েস পাঠান', `
        <div class="ds-muted" style="text-align:left; padding:0; margin-bottom:10px;">যে ইনভয়েসটি পাঠাবেন সেটি সিলেক্ট করুন</div>
        <div class="ds-suggest">${itemsHtml}</div>
        <div class="ds-modal-actions">
          <button class="ds-btn ds-btn-secondary ds-btn-block" type="button" id="ds-inv-cancel">বাতিল</button>
        </div>
      `, (overlay, close) => {
        overlay.querySelector('#ds-inv-cancel').onclick = close;
        overlay.querySelectorAll('[data-sale-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const saleId = Number(btn.getAttribute('data-sale-id') || 0);
            if (!(saleId > 0)) return;
            const res = await apiPost('ajax_send_invoice', { sale_id: saleId });
            if (res.ok) {
              close();
              openToast('ইনভয়েস পাঠানো হয়েছে');
            } else {
              showApiError('ইনভয়েস পাঠাতে ব্যর্থ', res);
            }
          });
        });
      });
    };
  }

  async function load(panel, identity) {
    const customerEl = panel.querySelector('#ds-customer');
    const actionsEl = panel.querySelector('#ds-actions');
    const recentEl = panel.querySelector('#ds-recent');

    customerEl.textContent = 'Loading...';
    actionsEl.innerHTML = '';
    recentEl.innerHTML = '';

    let phoneDigits = (identity && identity.phone) ? extractDigits(identity.phone) : '';
    phoneDigits = normalizePhoneDigits(phoneDigits);
    if (!phoneDigits) {
      const keys = [];
      if (identity && identity.key) keys.push(String(identity.key));
      if (identity && identity.titleKey) keys.push(String(identity.titleKey));
      if (identity && identity.name) keys.push(String(identity.name));
      const bindings = await getChatBindings();
      for (const k of keys) {
        const v = bindings[k] || bindings[normalizeKey(k)];
        if (v) {
          phoneDigits = normalizePhoneDigits(extractDigits(v));
          if (phoneDigits) break;
        }
      }
    }

    if (!phoneDigits) {
      const nameCandidate = ((identity && (identity.titleKey || identity.name)) ? String(identity.titleKey || identity.name) : '').trim();
      if (nameCandidate && nameCandidate.length >= 3) {
        const byName = await apiGet('ajax_customer_lookup', { name: nameCandidate });
        if (byName && byName.ok && byName.found && byName.customer && byName.customer.id) {
          const cid = byName.customer.id;
          const derivedPhone = normalizePhoneDigits(extractDigits(byName.customer.phone || ''));
          const ledger = await apiGet('ajax_customer_ledger_events', { customer_id: cid });
          await render(panel, { ...(identity || {}), phone: derivedPhone, nameMatch: true }, byName, ledger);
          return;
        }
      }

      const display = (identity && (identity.titleKey || identity.name || identity.key)) ? (identity.titleKey || identity.name || identity.key) : 'Unknown';
      customerEl.innerHTML = `
        <div style="margin-bottom:10px;"><b>${escapeHtml(display)}</b></div>
        <div class="ds-muted" style="margin-bottom:10px;">এই চ্যাট থেকে ফোন নম্বর পাওয়া যায়নি। ফোন সেট করলে সবসময় ফোন দিয়ে মিলাবে।</div>
      `;
      actionsEl.innerHTML = `<button class="ds-btn" id="ds-bind-phone" style="width:100%">এই চ্যাটের ফোন সেট করুন</button>`;
      actionsEl.querySelector('#ds-bind-phone').onclick = async () => {
        const raw = prompt('ফোন নম্বর লিখুন (+880...):', '') || '';
        const digits = normalizePhoneDigits(extractDigits(raw));
        if (!digits) {
          alert('সঠিক ফোন নম্বর দিন');
          return;
        }
        const keys = [];
        if (identity && identity.key) keys.push(String(identity.key));
        if (identity && identity.titleKey) keys.push(String(identity.titleKey));
        if (identity && identity.name) keys.push(String(identity.name));
        if (!keys.length) {
          alert('চ্যাট কী পাওয়া যায়নি');
          return;
        }
        await setChatBindings(keys, digits);
        await loadSafe(panel, { ...(identity || {}), phone: digits });
      };
      return;
    }

    if (identity && !identity.nameMatch) {
      const keys = [];
      if (identity.key) keys.push(String(identity.key));
      if (identity.titleKey) keys.push(String(identity.titleKey));
      if (identity.name) keys.push(String(identity.name));
      if (keys.length) {
        await setChatBindings(keys, phoneDigits);
      }
    }

    const nameCandidate = ((identity && (identity.titleKey || identity.name)) ? String(identity.titleKey || identity.name) : '').trim();
    const lookup = await apiGet('ajax_customer_lookup', { phone: phoneDigits, name: nameCandidate });
    let ledger = null;
    if (lookup.ok && lookup.found && lookup.customer && lookup.customer.id) {
      ledger = await apiGet('ajax_customer_ledger_events', { customer_id: lookup.customer.id });
    }
    await render(panel, { ...(identity || {}), phone: phoneDigits }, lookup, ledger);
  }

  async function boot(forceRefresh) {
    const panel = ensurePanel();
    panel.classList.remove('ds-hidden'); // প্যানেলটি সবসময় দৃশ্যমান রাখুন

    const idNow = getChatIdentity();
    const keyNow = idNow ? String([idNow.key || '', idNow.titleKey || '', extractDigits(idNow.phone || '')].join('|')) : '';
    if (idNow && (forceRefresh || !panel.dataset.lastKey || panel.dataset.lastKey !== keyNow)) {
      panel.dataset.lastKey = keyNow;
      await loadSafe(panel, idNow);
    } else if (!idNow) {
      panel.querySelector('#ds-customer').innerHTML = '<div class="ds-muted">কাস্টমার লোড করার জন্য একটি চ্যাট ওপেন করুন</div>';
      panel.querySelector('#ds-actions').innerHTML = '';
      panel.querySelector('#ds-recent').innerHTML = '';
    }

    if (booted) return;
    booted = true;
    observer = new MutationObserver(async () => {
      const id = getChatIdentity();
      const key = id ? String([id.key || '', id.titleKey || '', extractDigits(id.phone || '')].join('|')) : '';
      if (key && panel.dataset.lastKey !== key) {
        panel.dataset.lastKey = key;
        await loadSafe(panel, id);
        panel.classList.remove('ds-hidden');
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        const id = getChatIdentity();
        const key = id ? String([id.key || '', id.titleKey || '', extractDigits(id.phone || '')].join('|')) : '';
        if (key && panel.dataset.lastKey !== key) {
          panel.dataset.lastKey = key;
          loadSafe(panel, id);
          panel.classList.remove('ds-hidden');
        }
      }, 800);
    }
  }

  document.addEventListener('ds-wa-boot', () => { boot(true); });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot(false);
  } else {
    window.addEventListener('DOMContentLoaded', () => boot(false));
  }
})();

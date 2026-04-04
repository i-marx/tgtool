/* ═══════════════════════════════════════════════
   TG Tool — SPA App Logic
   No server-side session storage. Everything lives
   in localStorage and is sent per-request.
═══════════════════════════════════════════════ */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const STATE = {
  session:        null,   // Telethon StringSession (localStorage)
  partialSession: null,   // mid-auth partial session
  phoneCodeHash:  null,
  user:           null,
  dialogs:        null,   // cached dialog list
  activeTool:     null,
  chatPickCallback: null,
  ws:             null,
  downloadToken:  null,
  tgsFiles:       [],     // files queued for TGS→GIF
};

const LS_SESSION = 'tg_session';
const LS_USER    = 'tg_user';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
}

function logLine(text, type = '') {
  const log = $('tool-log');
  const line = el('div', type ? `log-${type}` : '', escapeHtml(text));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearLog() {
  $('tool-log').innerHTML = '';
  $('tool-output-area').style.display = 'none';
  $('btn-download').style.display = 'none';
  STATE.downloadToken = null;
}

function showOutput() {
  $('tool-output-area').style.display = 'block';
}

function setLoading(btnId, loading, label = 'Run') {
  const btn = $(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spinner"></span> Running…`
    : label;
}

function apiBase() {
  return window.location.origin;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(apiBase() + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail.map(d => {
          const loc = Array.isArray(d.loc) ? d.loc.join('.') : '';
          return loc ? `[${loc}] ${d.msg}` : (d.msg || JSON.stringify(d));
        }).join('; ')
      : (typeof data.detail === 'string' ? data.detail : data.error || `HTTP ${res.status}`);
    throw new Error(detail);
  }
  return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function loadSession() {
  STATE.session = localStorage.getItem(LS_SESSION);
  STATE.user    = JSON.parse(localStorage.getItem(LS_USER) || 'null');
}

function saveSession(session, user) {
  STATE.session = session;
  STATE.user    = user;
  localStorage.setItem(LS_SESSION, session);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

function clearSession() {
  STATE.session = null;
  STATE.user    = null;
  STATE.dialogs = null;
  localStorage.removeItem(LS_SESSION);
  localStorage.removeItem(LS_USER);
}

function startApp() {
  loadSession();
  if (STATE.session) {
    enterHome();
  } else {
    showView('auth');
  }
}

function enterHome() {
  const name = STATE.user?.first_name || STATE.user?.username || '';
  $('header-username').textContent = name ? `@${STATE.user.username || name}` : '';
  showView('home');
}

// Auth step 1 — send code
$('btn-send-code').addEventListener('click', async () => {
  const apiId   = $('inp-api-id').value.trim();
  const apiHash = $('inp-api-hash').value.trim();
  const phone   = $('inp-phone').value.trim();
  $('auth-error-1').textContent = '';

  if (!apiId || !apiHash || !phone) {
    $('auth-error-1').textContent = 'All fields are required.';
    return;
  }

  $('btn-send-code').disabled = true;
  $('btn-send-code').innerHTML = '<span class="spinner"></span> Sending…';

  try {
    const data = await apiFetch('/api/auth/send_code', {
      method: 'POST',
      body: JSON.stringify({ api_id: Number(apiId), api_hash: apiHash, phone }),
    });
    STATE.phoneCodeHash  = data.phone_code_hash;
    STATE.partialSession = data.partial_session;
    // remember for sign_in
    STATE._apiId   = Number(apiId);
    STATE._apiHash = apiHash;
    STATE._phone   = phone;

    $('auth-step-1').style.display = 'none';
    $('auth-step-2').style.display = 'block';
  } catch (e) {
    $('auth-error-1').textContent = e.message;
    $('btn-send-code').disabled = false;
    $('btn-send-code').textContent = 'Send Code';
  }
});

// Auth step 2 — sign in
$('btn-sign-in').addEventListener('click', async () => {
  const code = $('inp-code').value.trim();
  const pwd  = $('inp-pwd').value;
  $('auth-error-2').textContent = '';

  if (!code) { $('auth-error-2').textContent = 'Enter the code.'; return; }

  $('btn-sign-in').disabled = true;
  $('btn-sign-in').innerHTML = '<span class="spinner"></span> Signing in…';

  try {
    const data = await apiFetch('/api/auth/sign_in', {
      method: 'POST',
      body: JSON.stringify({
        partial_session: STATE.partialSession,
        phone:           STATE._phone,
        phone_code_hash: STATE.phoneCodeHash,
        code,
        password: pwd || "",
        api_id:   STATE._apiId,
        api_hash: STATE._apiHash,
      }),
    });
    saveSession(data.session, data.user);
    enterHome();
  } catch (e) {
    if (e.message.toLowerCase().includes('password') || e.message.includes('2FA')) {
      $('pwd-row').style.display = 'block';
      $('auth-error-2').textContent = 'Enter your 2FA cloud password.';
    } else {
      $('auth-error-2').textContent = e.message;
    }
    $('btn-sign-in').disabled = false;
    $('btn-sign-in').textContent = 'Sign In';
  }
});

$('btn-api-help').addEventListener('click', () => {
  $('modal-api-help').style.display = 'flex';
});
$('api-help-close').addEventListener('click', () => {
  $('modal-api-help').style.display = 'none';
});
$('modal-api-help').addEventListener('click', e => {
  if (e.target === $('modal-api-help')) $('modal-api-help').style.display = 'none';
});

$('btn-back').addEventListener('click', () => {
  $('auth-step-1').style.display = 'block';
  $('auth-step-2').style.display = 'none';
  $('auth-error-2').textContent = '';
  $('inp-code').value = '';
  $('btn-send-code').disabled = false;
  $('btn-send-code').textContent = 'Send Code';
});

function logout() {
  clearSession();
  showView('auth');
  $('auth-step-1').style.display = 'block';
  $('auth-step-2').style.display = 'none';
  $('inp-code').value = '';
  $('inp-pwd').value = '';
  $('auth-error-1').textContent = '';
  $('auth-error-2').textContent = '';
  $('btn-send-code').disabled = false;
  $('btn-send-code').textContent = 'Send Code';
}
$('btn-logout').addEventListener('click', logout);
$('btn-logout-2').addEventListener('click', logout);

// ─── Tool Cards → Tool View ───────────────────────────────────────────────────
document.querySelectorAll('.tool-card').forEach(card => {
  card.addEventListener('click', () => {
    const tool = card.dataset.tool;
    openTool(tool);
  });
});

$('btn-back-home').addEventListener('click', () => {
  closeWs();
  showView('home');
});

// ─── Chat Picker ──────────────────────────────────────────────────────────────
$('modal-close').addEventListener('click', closeModal);
$('modal-chat').addEventListener('click', e => {
  if (e.target === $('modal-chat')) closeModal();
});

function closeModal() {
  $('modal-chat').style.display = 'none';
  STATE.chatPickCallback = null;
}

$('chat-search').addEventListener('input', e => {
  filterChatList(e.target.value.toLowerCase());
});

function filterChatList(q) {
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.dataset.name.toLowerCase();
    item.style.display = name.includes(q) ? '' : 'none';
  });
}

async function openChatPicker(callback) {
  STATE.chatPickCallback = callback;
  $('modal-chat').style.display = 'flex';
  $('chat-search').value = '';

  const chatList   = $('chat-list');
  const chatLoad   = $('chat-loading');
  chatList.innerHTML = '';
  chatLoad.style.display = 'block';

  try {
    if (!STATE.dialogs) {
      STATE.dialogs = await apiFetch('/api/dialogs', {
        method: 'POST',
        body: JSON.stringify({ session: STATE.session }),
      });
    }
    chatLoad.style.display = 'none';
    renderChatList(STATE.dialogs);
  } catch (e) {
    chatLoad.textContent = 'Failed to load chats: ' + e.message;
  }
}

function renderChatList(dialogs) {
  const chatList = $('chat-list');
  chatList.innerHTML = '';
  const icons = { group: '👥', supergroup: '👥', channel: '📢', bot: '🤖', user: '👤' };
  dialogs.forEach(d => {
    const item = el('div', 'chat-item');
    item.dataset.name = d.title.toLowerCase();
    item.innerHTML = `
      <div class="chat-item-icon">${icons[d.type] || '💬'}</div>
      <div>
        <div class="chat-item-name">${escapeHtml(d.title)}</div>
        <div class="chat-item-type">${d.type} · ${d.id}</div>
      </div>`;
    item.addEventListener('click', () => {
      if (STATE.chatPickCallback) STATE.chatPickCallback(d);
      closeModal();
    });
    chatList.appendChild(item);
  });
}

// ─── WebSocket runner ─────────────────────────────────────────────────────────
function closeWs() {
  if (STATE.ws) { STATE.ws.close(); STATE.ws = null; }
}

function runTool(params) {
  closeWs();
  clearLog();
  showOutput();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws/tool`;
  STATE.ws = new WebSocket(wsUrl);

  STATE.ws.onopen = () => {
    STATE.ws.send(JSON.stringify({ session: STATE.session, ...params }));
  };

  STATE.ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'log')  logLine(msg.text);
    if (msg.type === 'ok')   logLine(msg.text, 'ok');
    if (msg.type === 'err')  logLine(msg.text, 'err');
    if (msg.type === 'info') logLine(msg.text, 'info');
    if (msg.type === 'done') {
      logLine(msg.text || 'Done.', 'done');
      setLoading('btn-run', false);
      if (msg.token) {
        STATE.downloadToken = msg.token;
        $('btn-download').style.display = 'inline-flex';
      }
    }
    if (msg.type === 'error') {
      logLine(msg.text, 'err');
      setLoading('btn-run', false);
    }
  };

  STATE.ws.onerror = () => {
    logLine('Connection error.', 'err');
    setLoading('btn-run', false);
  };

  STATE.ws.onclose = () => {};
}

$('btn-download').addEventListener('click', () => {
  if (!STATE.downloadToken) return;
  window.location.href = `${apiBase()}/api/download/${STATE.downloadToken}`;
});

// ─── Tool Forms ───────────────────────────────────────────────────────────────
const TOOLS = {
  export_members: {
    title: 'Export Members',
    desc:  'Export all members from a single group or supergroup to CSV.',
    form: () => `
      <div class="form-group">
        <label>Chat</label>
        <button class="chat-pick-btn" id="pick-chat-1">💬 Click to select a chat…</button>
        <input type="hidden" id="hid-chat-id" />
      </div>
      <button class="btn-primary btn-full" id="btn-run">Run Export</button>`,
    init: () => {
      $('pick-chat-1').addEventListener('click', () => openChatPicker(d => {
        $('pick-chat-1').textContent = `${d.title}`;
        $('pick-chat-1').classList.add('selected');
        $('hid-chat-id').value = d.id;
      }));
      $('btn-run').addEventListener('click', () => {
        const cid = $('hid-chat-id').value;
        if (!cid) { alert('Select a chat first.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'export_members', params: { chat_id: cid } });
      });
    },
  },

  export_all: {
    title: 'Export All Chats',
    desc:  'Export a list of all your dialogs (chats, groups, channels) to CSV.',
    form: () => `
      <button class="btn-primary btn-full" id="btn-run">Export All Chats</button>`,
    init: () => {
      $('btn-run').addEventListener('click', () => {
        setLoading('btn-run', true);
        runTool({ tool: 'export_all', params: {} });
      });
    },
  },

  export_full: {
    title: 'Deep Member Scan',
    desc:  'Full/deep scan — exports members from multiple chats and deduplicates.',
    form: () => `
      <div class="form-group">
        <label>Chats (one per line — @username, t.me/link, or ID)</label>
        <textarea class="glass-input" id="inp-chats" placeholder="@mychat&#10;t.me/somechannel&#10;-1001234567890"></textarea>
      </div>
      <button class="btn-primary btn-full" id="btn-run">Run Deep Scan</button>`,
    init: () => {
      $('btn-run').addEventListener('click', () => {
        const lines = $('inp-chats').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) { alert('Enter at least one chat.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'export_full', params: { chats: lines } });
      });
    },
  },

  common_chats: {
    title: 'Groups in Common',
    desc:  'Find groups you share with another Telegram user.',
    form: () => `
      <div class="form-group">
        <label>Target User (@username or ID)</label>
        <input class="glass-input" id="inp-target" placeholder="@username" />
      </div>
      <button class="btn-primary btn-full" id="btn-run">Find Common Groups</button>`,
    init: () => {
      $('btn-run').addEventListener('click', () => {
        const t = $('inp-target').value.trim();
        if (!t) { alert('Enter a username or ID.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'common_chats', params: { target: t } });
      });
    },
  },

  boosters: {
    title: 'Export Boosters',
    desc:  'Get the list of users boosting a channel and export to CSV.',
    form: () => `
      <div class="form-group">
        <label>Channel</label>
        <button class="chat-pick-btn" id="pick-chat-b">📢 Click to select a channel…</button>
        <input type="hidden" id="hid-booster-id" />
      </div>
      <button class="btn-primary btn-full" id="btn-run">Export Boosters</button>`,
    init: () => {
      $('pick-chat-b').addEventListener('click', () => openChatPicker(d => {
        $('pick-chat-b').textContent = d.title;
        $('pick-chat-b').classList.add('selected');
        $('hid-booster-id').value = d.id;
      }));
      $('btn-run').addEventListener('click', () => {
        const cid = $('hid-booster-id').value;
        if (!cid) { alert('Select a channel first.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'boosters', params: { chat_id: cid } });
      });
    },
  },

  resolve_ids: {
    title: 'Resolve IDs',
    desc:  'Batch-resolve @usernames or t.me links to Telegram numeric IDs.',
    form: () => `
      <div class="form-group">
        <label>Entries (one per line — @username or t.me/link)</label>
        <textarea class="glass-input" id="inp-ids" placeholder="@user1&#10;t.me/channel&#10;@user2"></textarea>
      </div>
      <button class="btn-primary btn-full" id="btn-run">Resolve IDs</button>`,
    init: () => {
      $('btn-run').addEventListener('click', () => {
        const lines = $('inp-ids').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) { alert('Enter at least one entry.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'resolve_ids', params: { targets: lines } });
      });
    },
  },

  emoji_pack: {
    title: 'Download Emoji Pack',
    desc:  'Download all stickers/emojis from a Telegram sticker pack. PNG files zipped.',
    form: () => `
      <div class="form-group">
        <label>Pack Link or Short Name</label>
        <input class="glass-input" id="inp-pack" placeholder="t.me/addstickers/PackName  or  PackName" />
      </div>
      <div class="form-group">
        <label>Format</label>
        <select class="glass-input" id="sel-fmt">
          <option value="png">PNG (static)</option>
          <option value="gif">GIF (animated, TGS converted)</option>
        </select>
      </div>
      <button class="btn-primary btn-full" id="btn-run">Download Pack</button>`,
    init: () => {
      $('btn-run').addEventListener('click', () => {
        const pack = $('inp-pack').value.trim();
        const fmt  = $('sel-fmt').value;
        if (!pack) { alert('Enter a pack link or short name.'); return; }
        setLoading('btn-run', true);
        runTool({ tool: 'emoji_pack', params: { pack, format: fmt } });
      });
    },
  },

  tgs_to_gif: {
    title: 'TGS → GIF Converter',
    desc:  'Convert Telegram animated stickers (.tgs) to animated GIFs.',
    form: () => `
      <div class="form-group">
        <label>TGS Files</label>
        <div class="gif-drop-zone" id="drop-zone">
          <input type="file" id="tgs-file-input" accept=".tgs" multiple />
          <div class="drop-icon">🎞️</div>
          <div>Drop <strong>.tgs</strong> files here or <strong>click to browse</strong></div>
          <div class="drop-hint">Multiple files supported</div>
        </div>
        <div class="file-list" id="tgs-file-list"></div>
      </div>
      <div class="dim-row">
        <div class="form-group">
          <label>Width (px)</label>
          <input class="glass-input" id="inp-w" type="number" value="512" min="32" max="1024" />
        </div>
        <div class="form-group">
          <label>Height (px)</label>
          <input class="glass-input" id="inp-h" type="number" value="512" min="32" max="1024" />
        </div>
        <div class="form-group">
          <label>FPS</label>
          <input class="glass-input" id="inp-fps" type="number" value="30" min="1" max="60" />
        </div>
        <div class="form-group size-est">
          <label>Est. size / file</label>
          <div class="size-estimate-box" id="size-box">
            <div class="size-est-value" id="size-val">—</div>
            <div class="size-est-platforms" id="size-plats"></div>
          </div>
        </div>
      </div>
      <button class="btn-primary btn-full" id="btn-run">Convert to GIF</button>`,
    init: () => {
      // Drop zone
      const dz    = $('drop-zone');
      const finp  = $('tgs-file-input');
      dz.addEventListener('click', () => finp.click());
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('drag-over');
        addFiles([...e.dataTransfer.files]);
      });
      finp.addEventListener('change', () => {
        addFiles([...finp.files]);
        finp.value = '';
      });

      // Size estimator
      const updateEst = () => {
        const w   = parseInt($('inp-w').value)   || 512;
        const h   = parseInt($('inp-h').value)   || 512;
        const fps = parseInt($('inp-fps').value) || 30;
        updateSizeEstimate(w, h, fps);
      };
      ['inp-w','inp-h','inp-fps'].forEach(id => $(id).addEventListener('input', updateEst));
      updateEst(); // initial render

      // Run
      $('btn-run').addEventListener('click', async () => {
        if (!STATE.tgsFiles.length) { alert('Add at least one .tgs file.'); return; }
        setLoading('btn-run', true);
        clearLog();
        showOutput();

        const w   = $('inp-w').value   || '512';
        const h   = $('inp-h').value   || '512';
        const fps = $('inp-fps').value || '30';

        for (const file of STATE.tgsFiles) {
          logLine(`Converting ${file.name}…`, 'info');
          try {
            const fd = new FormData();
            fd.append('files', file, file.name);
            fd.append('width',  w);
            fd.append('height', h);
            fd.append('fps',    fps);
            const res  = await fetch(`${apiBase()}/api/tools/tgs_to_gif`, { method: 'POST', body: fd });
            const data = await res.json();
            if (data.ok) {
              logLine(`✓ ${data.filename}`, 'ok');
              // trigger download immediately per file
              window.location.href = `${apiBase()}/api/download/${data.token}`;
            } else {
              logLine(`✗ ${file.name}: ${data.err}`, 'err');
            }
          } catch (e) {
            logLine(`✗ ${file.name}: ${e.message}`, 'err');
          }
        }
        logLine('All conversions done.', 'done');
        setLoading('btn-run', false, 'Convert to GIF');
      });
    },
  },
};

// ─── File list management ─────────────────────────────────────────────────────
function addFiles(files) {
  files.forEach(f => {
    if (!f.name.endsWith('.tgs')) return;
    if (STATE.tgsFiles.find(x => x.name === f.name)) return;
    STATE.tgsFiles.push(f);
  });
  renderFileList();
  updateSizeEstimateFromInputs();
}

function removeFile(name) {
  STATE.tgsFiles = STATE.tgsFiles.filter(f => f.name !== name);
  renderFileList();
  updateSizeEstimateFromInputs();
}

function renderFileList() {
  const list = $('tgs-file-list');
  if (!list) return;
  list.innerHTML = '';
  STATE.tgsFiles.forEach(f => {
    const item = el('div', 'file-item');
    item.innerHTML = `
      <span class="file-item-name">${escapeHtml(f.name)}</span>
      <button class="file-item-rm" data-name="${escapeHtml(f.name)}">✕</button>`;
    item.querySelector('.file-item-rm').addEventListener('click', e => {
      removeFile(e.target.dataset.name);
    });
    list.appendChild(item);
  });
}

// ─── GIF Size Estimator ───────────────────────────────────────────────────────
// Formula: approximate GIF byte size using palette + LZW compression heuristic.
// GIF uses 256-colour palette per frame; for an animated sticker (~2.5s duration):
//   raw_bytes_per_frame = width × height × 1 (8bpp indexed)
//   LZW typically achieves ~40-55% compression on rasterized artwork → factor 0.50
//   plus frame overhead ~20 bytes/frame
//
// Platform limits:
const PLATFORMS = [
  { name: 'Slack',     limit: 2 * 1024 * 1024,        suffix: '2 MB' },
  { name: 'Discord',   limit: 256 * 1024,              suffix: '256 KB' },
  { name: 'WhatsApp',  limit: 500 * 1024,              suffix: '500 KB' },
  { name: 'Telegram',  limit: 1 * 1024 * 1024,         suffix: '1 MB' },
  { name: 'Twitter',   limit: 15 * 1024 * 1024,        suffix: '15 MB' },
];

function estimateGifBytes(w, h, fps) {
  const duration  = 2.5;                      // typical TGS duration (seconds)
  const frames    = Math.ceil(fps * duration);
  const rawFrame  = w * h;                    // 8-bit indexed pixels
  const compressed = rawFrame * 0.50;         // ~50% LZW compression
  const overhead  = frames * 20;              // frame/block overhead
  return Math.round(frames * compressed + overhead);
}

function formatBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  if (b >= 1024)        return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function updateSizeEstimate(w, h, fps) {
  const sizeBox  = $('size-box');
  const sizeVal  = $('size-val');
  const sizePlat = $('size-plats');
  if (!sizeBox) return;

  const bytes = estimateGifBytes(w, h, fps);
  sizeVal.textContent = formatBytes(bytes);

  sizePlat.innerHTML = '';
  PLATFORMS.forEach(p => {
    const pct  = bytes / p.limit;
    let cls = 'ok';
    if (pct > 1)    cls = 'over';
    else if (pct > 0.8) cls = 'warn';
    const badge = el('span', `plat-badge ${cls}`,
      `${p.name} ${pct > 1 ? '✗' : '✓'}`);
    badge.title = `${p.name} limit: ${p.suffix}`;
    sizePlat.appendChild(badge);
  });
}

function updateSizeEstimateFromInputs() {
  const w   = parseInt($('inp-w')?.value)   || 512;
  const h   = parseInt($('inp-h')?.value)   || 512;
  const fps = parseInt($('inp-fps')?.value) || 30;
  updateSizeEstimate(w, h, fps);
}

// ─── Open Tool ────────────────────────────────────────────────────────────────
function openTool(key) {
  const def = TOOLS[key];
  if (!def) return;

  STATE.activeTool = key;
  STATE.tgsFiles   = [];
  closeWs();

  $('tool-view-title').textContent = def.title;

  const formArea = $('tool-form-area');
  formArea.innerHTML = `
    <h2>${escapeHtml(def.title)}</h2>
    <p class="tool-form-desc">${escapeHtml(def.desc)}</p>
    ${def.form()}`;

  clearLog();
  def.init();
  showView('tool');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
startApp();

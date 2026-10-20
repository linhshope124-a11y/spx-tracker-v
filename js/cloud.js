import { state } from './state.js';
import { buildBackupPayload, countPayloadRecords, runImport, importDoneMessage } from './backup.js';
import { updateAllViews } from './render.js';
import { initRankUI, initRegionUI } from './ui.js';
import { showAlert, showConfirm } from './dialog.js';

const GH_API = 'https://api.github.com';
const GIST_FILENAME = 'spx-tracker-backup.json';

const TOKEN_WARN_ACK_KEY = 'spx_gh_token_warn_ack';

const getToken    = () => localStorage.getItem('spx_gh_token') || '';
const getGistId   = () => localStorage.getItem('spx_gist_id') || '';
const isAutoBackup = () => localStorage.getItem('spx_auto_backup') === '1';

function setStatus(msg, type) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.className = 'cloud-status ' + (type || 'idle');
  el.innerText = msg;
}

// ==================== TOKEN WARNING ====================
/**
 * Cảnh báo user token lưu dạng plaintext lần đầu.
 * Chỉ hiện 1 lần duy nhất (đã ack thì thôi).
 * @returns {Promise<boolean>} true = đồng ý lưu, false = hủy
 */
async function ensureTokenWarning() {
  if (localStorage.getItem(TOKEN_WARN_ACK_KEY) === '1') return true;

  const ok = await showConfirm(
    '⚠️ Lưu ý bảo mật\n\n' +
    'Token GitHub sẽ được lưu trên thiết bị này để tự động backup.\n\n' +
    '• Token được lưu dạng plaintext (chưa mã hóa)\n' +
    '• Nếu ai truy cập được máy bạn → có thể đọc được token\n' +
    '• Nếu nghi ngờ bị lộ → vào GitHub → Revoke token ngay\n\n' +
    'Bạn có muốn tiếp tục lưu token?',
    {
      title: '🔒 Lưu token',
      okText: 'Đồng ý lưu',
      cancelText: 'Hủy',
      danger: false
    }
  );

  if (ok) {
    try { localStorage.setItem(TOKEN_WARN_ACK_KEY, '1'); } catch {}
  }
  return ok;
}
// ==================== /TOKEN WARNING ====================

// ==================== TEST CONNECTION ====================
export async function testCloudConnection() {
  const input = document.getElementById('ghTokenInput');
  const token = (input?.value || '').trim() || getToken();

  if (!token) { setStatus('❌ Chưa nhập token', 'err'); return; }

  // Nếu user đang nhập token MỚI → cảnh báo bảo mật trước
  const isNewToken = !!(input?.value?.trim());
  if (isNewToken) {
    const ok = await ensureTokenWarning();
    if (!ok) { setStatus('Đã hủy lưu token', 'idle'); return; }
  }

  setStatus('⏳ Đang kiểm tra...', 'idle');
  try {
    const res = await fetch(`${GH_API}/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error('Token sai hoặc hết hạn');
    const user = await res.json();
    try { localStorage.setItem('spx_gh_token', token); } catch (storageError) { throw new Error('Token hợp lệ nhưng không lưu được trên thiết bị. Hãy kiểm tra bộ nhớ/trình duyệt.'); }
    if (input) input.value = '';
    updateTokenUI();
    setStatus(`✅ OK — ${user.login}`, 'ok');
  } catch (e) {
    setStatus(`❌ ${e.message}`, 'err');
  }
}

// ==================== TOKEN SAVE (chỉ sau khi token dùng được) ====================
function commitTypedToken(input, token) {
  if (!input || !input.value.trim()) return;
  try { localStorage.setItem('spx_gh_token', token); } catch {}
  input.value = '';
  updateTokenUI();
}

// ==================== PUSH TO CLOUD ====================
let _pushing = false;

/**
 * @param {{auto?: boolean}} [opts] auto=true khi gọi từ auto-backup (không bao giờ đẩy dữ liệu rỗng)
 */
export async function pushToCloud(opts) {
  const auto = !!(opts && opts.auto === true);
  if (_pushing) {
    if (!auto) setStatus('⏳ Đang backup, vui lòng đợi...', 'idle');
    return;
  }

  const input = document.getElementById('ghTokenInput');
  const typed = (input?.value || '').trim();
  const token = typed || getToken();

  if (!token) { setStatus('❌ Chưa có token', 'err'); return; }

  // ⚠️ Chặn đẩy bản RỖNG đè lên bản Cloud (vd vừa "Xóa toàn bộ" xong, auto-backup chạy sau 10s)
  const total = countPayloadRecords({ data: state.appData });
  if (total === 0) {
    if (auto) {
      console.warn('[Cloud] Bỏ qua auto-backup: không có bản ghi nào (tránh ghi đè bản Cloud bằng dữ liệu rỗng)');
      return;
    }
    const goOn = await showConfirm(
      'App đang KHÔNG có bản ghi nào.\n\nBackup bây giờ sẽ GHI ĐÈ bản trên Cloud bằng dữ liệu rỗng (có thể mất bản backup cũ).\n\nVẫn tiếp tục?',
      { title: '⚠️ Dữ liệu rỗng', okText: 'Vẫn backup', cancelText: 'Hủy', danger: true }
    );
    if (!goOn) { setStatus('Đã hủy backup', 'idle'); return; }
  }

  if (typed) {
    const ok = await ensureTokenWarning();
    if (!ok) { setStatus('Đã hủy lưu token', 'idle'); return; }
  }

  const gistId = (document.getElementById('gistIdInput')?.value.trim()) || getGistId();
  const payload = buildBackupPayload();
  const body = JSON.stringify({
    ...(gistId ? {} : { description: 'SPX Tracker auto-backup', public: false }),
    files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } }
  });

  _pushing = true;
  setStatus('⏳ Đang backup...', 'idle');

  try {
    const res = await fetch(gistId ? `${GH_API}/gists/${gistId}` : `${GH_API}/gists`, {
      method: gistId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const gist = await res.json();
    commitTypedToken(input, token);   // token đã dùng được → lúc này mới lưu
    try { localStorage.setItem('spx_gist_id', gist.id); } catch (e) { console.warn('[Cloud] Không lưu được Gist ID:', e); }
    const gistInput = document.getElementById('gistIdInput');
    if (gistInput) gistInput.value = gist.id;

    const now = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    try { localStorage.setItem('spx_last_backup', now); } catch (e) { console.warn('[Cloud] Không lưu được thời điểm backup:', e); }
    setStatus(`✅ Đã backup lúc ${now}`, 'ok');
  } catch (e) {
    setStatus(`❌ Lỗi: ${e.message}`, 'err');
  } finally {
    _pushing = false;
  }
}

// ==================== PULL FROM CLOUD ====================
export async function pullFromCloud() {
  const input = document.getElementById('ghTokenInput');
  const typed = (input?.value || '').trim();
  const token = typed || getToken();
  const gistId = (document.getElementById('gistIdInput')?.value.trim()) || getGistId();

  if (!token || !gistId) { setStatus('❌ Chưa cấu hình token/gist', 'err'); return; }

  const ok = await showConfirm(
    'Khôi phục từ Cloud sẽ áp dụng dữ liệu từ Gist.\n\nTiếp tục?',
    { title: 'Khôi phục từ Cloud', okText: 'Khôi phục', cancelText: 'Hủy' }
  );
  if (!ok) return;

  if (typed) {
    const warnOk = await ensureTokenWarning();
    if (!warnOk) { setStatus('Đã hủy lưu token', 'idle'); return; }
  }

  setStatus('⏳ Đang tải...', 'idle');
  try {
    const res = await fetch(`${GH_API}/gists/${gistId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gist = await res.json();
    const file = gist.files && gist.files[GIST_FILENAME];
    if (!file) throw new Error('Không tìm thấy dữ liệu trong Gist');

    // Gist cắt nội dung > ~1MB trong phản hồi API → phải tải bản đầy đủ từ raw_url
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const raw = await fetch(file.raw_url);
      if (!raw.ok) throw new Error(`Không tải được bản đầy đủ (HTTP ${raw.status})`);
      content = await raw.text();
    }
    if (!content) throw new Error('Không tìm thấy dữ liệu trong Gist');

    const parsed = JSON.parse(content);
    commitTypedToken(input, token);   // token đã dùng được → lưu

    const out = await runImport(parsed);   // kiểm tra định dạng / file rỗng / hỏi cách nạp
    if (out.status === 'cancel')  { setStatus('Đã hủy', 'idle'); return; }
    if (out.status === 'invalid') { setStatus('❌ Dữ liệu trong Gist không hợp lệ', 'err'); return; }
    if (out.status === 'empty')   { setStatus('❌ Gist không có bản ghi nào', 'err'); return; }

    initRankUI();
    initRegionUI();
    updateAllViews();

    setStatus('✅ Khôi phục thành công!', 'ok');
    await showAlert(importDoneMessage(out.mode, out.result, 'từ Cloud'), { title: '✅ Hoàn tất', okText: 'OK' });
  } catch (e) {
    setStatus(`❌ Lỗi: ${e.message}`, 'err');
  }
}

// ==================== TOKEN MANAGEMENT ====================
function updateTokenUI() {
  const hasToken = Boolean(getToken());
  const wrapper = document.getElementById('tokenStatusWrap');
  const savedLabel = document.getElementById('tokenSavedLabel');
  const clearBtn = document.getElementById('clearTokenBtn');

  if (wrapper) wrapper.style.display = hasToken ? 'flex' : 'none';
  if (savedLabel) savedLabel.textContent = hasToken ? '✅ Đã lưu token' : '';
  if (clearBtn) clearBtn.style.display = hasToken ? 'inline-flex' : 'none';
}

export async function clearCloudToken() {
  if (!getToken()) return;

  const ok = await showConfirm(
    'Xóa token GitHub đã lưu?\n\nBạn sẽ cần nhập lại token để backup Cloud.',
    {
      title: '🗑️ Xóa token',
      okText: 'Xóa',
      cancelText: 'Hủy',
      danger: true
    }
  );
  if (!ok) return;

  localStorage.removeItem('spx_gh_token');
  const input = document.getElementById('ghTokenInput');
  if (input) input.value = '';
  updateTokenUI();
  setStatus('Đã xóa token', 'idle');
}

// ==================== INIT CLOUD UI ====================
export function initCloudUI() {
  const gistId = getGistId();
  const autoBackup = isAutoBackup();
  const hasToken = Boolean(getToken());

  const tokenInput = document.getElementById('ghTokenInput');
  const gistInput  = document.getElementById('gistIdInput');
  const toggle     = document.getElementById('autoBackupToggle');

  if (tokenInput) {
    tokenInput.value = '';
    if (hasToken) {
      tokenInput.placeholder = '•••••••• (đã lưu — để trống nếu không đổi)';
    } else {
      tokenInput.placeholder = 'ghp_... (dán token mới)';
    }
  }

  if (gistInput) gistInput.value = gistId;

  if (toggle) {
    toggle.checked = autoBackup;
    toggle.onchange = () => {
      try {
        localStorage.setItem('spx_auto_backup', toggle.checked ? '1' : '0');
        setStatus(toggle.checked ? '✅ Đã bật auto-backup' : 'Đã tắt auto-backup', toggle.checked ? 'ok' : 'idle');
      } catch (e) {
        toggle.checked = !toggle.checked;
        setStatus('❌ Không lưu được tùy chọn auto-backup trên thiết bị', 'err');
      }
    };
  }

  updateTokenUI();

  if (!hasToken) {
    setStatus('Chưa cấu hình — cần tạo token', 'idle');
  } else if (!gistId) {
    setStatus('Đã có token — bấm "Backup" để tạo Gist lần đầu', 'idle');
  } else {
    const last = localStorage.getItem('spx_last_backup');
    setStatus(last ? `✅ Backup cuối: ${last}` : '✅ Đã cấu hình', 'ok');
  }
}

// ==================== AUTO BACKUP ====================
let autoBackupTimer = null;
export function scheduleAutoBackup() {
  if (!isAutoBackup() || !getToken()) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => {
    pushToCloud({ auto: true }).catch(e => console.warn('[Cloud] Auto-backup failed:', e));
  }, 10000);
}

window.addEventListener('spx:datachanged', scheduleAutoBackup);
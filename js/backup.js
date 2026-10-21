import {
  state,
  persistData,
  sanitizeRecords,
  persistSalaryByMonth,
  persistRankByMonth
} from './state.js';
import { STORAGE_KEYS, WEIGHT_KEYS, AUTO_BACKUP_DAYS } from './config.js';
import { getTodayIso, generateId } from './utils.js';
import { updateAllViews } from './render.js';
import { initRankUI, initRegionUI, showToast } from './ui.js';
import { showAlert, showConfirm, showChoice } from './dialog.js';

// ==================== CONFIG ====================
const AUTO_BACKUP_LAST_KEY = 'spx_last_auto_backup';
const AUTO_BACKUP_SNOOZE_KEY = 'spx_auto_backup_snooze';

// ==================== HELPERS ====================
function dedupeList(list) {
  const seen = new Set();
  return list.filter(r => {
    const key = r.date + '|' + WEIGHT_KEYS.map(k => parseInt(r.weights?.[k], 10) || 0).join('_');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function totalRecords(data) {
  return (data.delivery?.length || 0) + (data.pickup?.length || 0) + (data.return?.length || 0);
}

// Lấy phần "data" từ payload: hỗ trợ cả {data:{...}, settings} lẫn dạng trần {delivery,pickup,return}
function payloadSource(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
  const has = k => Array.isArray(src[k]);
  return (has('delivery') || has('pickup') || has('return')) ? src : null;
}

export function countPayloadRecords(parsed) {
  const src = payloadSource(parsed);
  if (!src) return 0;
  return (src.delivery?.length || 0) + (src.pickup?.length || 0) + (src.return?.length || 0);
}

// Chuẩn hoá settings nhập từ file/Cloud — không tin dữ liệu ngoài (kiểu, khoá, miền giá trị)
const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function sanitizeSalaryByMonth(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  Object.keys(src).forEach(m => {
    const c = src[m];
    if (!MONTH_KEY_RE.test(m) || !c || typeof c !== 'object') return;
    out[m] = {
      base:   Math.max(0, Number(c.base)   || 0),
      buuCuc: Math.max(0, Number(c.buuCuc) || 0),
      taiXe:  Math.max(0, Number(c.taiXe)  || 0)
    };
  });
  return out;
}
function sanitizeRankByMonth(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  Object.keys(src).forEach(m => {
    const c = src[m];
    if (!MONTH_KEY_RE.test(m) || !c || typeof c !== 'object') return;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 30) : '';
    if (!name || name === 'none') return;
    out[m] = { name, bonus: Math.min(1, Math.max(0, Number(c.bonus) || 0)) };
  });
  return out;
}

// Tạo payload backup (dùng chung cho file + Cloud)
export function buildBackupPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      rankByMonth:   state.rankByMonth,
      salaryByMonth: state.salaryByMonth,
      region:        state.region,
      theme:         localStorage.getItem(STORAGE_KEYS.theme) || 'light'
    },
    data: state.appData
  };
}

// ⭐ HÀM MỚI: Tải file thực sự — PHẢI gọi trong click handler đồng bộ
export function downloadBackupFile(prefix = 'SPX_Data') {
  const payload = buildBackupPayload();
  // Blob thay vì data: URL — data: URL lớn hơn ~2MB bị Chrome từ chối, đúng lúc dữ liệu nhiều nhất cần backup
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}_${getTodayIso()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);   // giữ URL đủ lâu để trình duyệt bắt đầu tải, tránh giữ timer 30 giây
  markBackupDone();
}

// ⭐ HÀM MỚI: Ghi timestamp lần backup gần nhất
export function markBackupDone() {
  try {
    localStorage.setItem(AUTO_BACKUP_LAST_KEY, String(Date.now()));
  } catch {}
}

// ⭐ HÀM MỚI: Check xem có cần auto backup không
function needsAutoBackup() {
  const total = totalRecords(state.appData);
  if (total === 0) return false;

  // Nếu hôm nay đã bấm "Để sau" → không hỏi lại
  try {
    const snooze = localStorage.getItem(AUTO_BACKUP_SNOOZE_KEY);
    if (snooze === getTodayIso()) return false;
  } catch {}

  let last = 0;
  try {
    last = parseInt(localStorage.getItem(AUTO_BACKUP_LAST_KEY) || '0', 10);
  } catch {}

  if (!Number.isFinite(last) || last === 0) return true;

  const daysSince = (Date.now() - last) / (1000 * 60 * 60 * 24);
  return daysSince >= AUTO_BACKUP_DAYS;
}

// ⭐ HÀM MỚI: Kiểm tra + hỏi user backup nếu quá hạn
export async function checkAutoBackup() {
  if (!needsAutoBackup()) return;

  const total = totalRecords(state.appData);
  const ok = await showConfirm(
    `📥 Đã ${AUTO_BACKUP_DAYS} ngày chưa backup.\n\n` +
    `Bạn đang có ${total} bản ghi.\n\n` +
    `Tải file backup về máy để phòng khi mất dữ liệu?\n\n` +
    `(File sẽ lưu vào thư mục Downloads)`,
    {
      title: '📥 Backup định kỳ',
      okText: '📥 Lưu file ngay',
      cancelText: 'Để sau',
      danger: false
    }
  );

  if (ok) {
    // ⚠️ KHÔNG await — phải trigger download ngay trong stack này
    // để browser cho phép (user gesture requirement)
    downloadBackupFile('SPX_Auto_Backup');
    showToast('Đã tải file backup về máy', 'success', 2500);
  } else {
    // Đánh dấu hôm nay đã snooze → không hỏi lại
    try {
      localStorage.setItem(AUTO_BACKUP_SNOOZE_KEY, getTodayIso());
    } catch {}
  }
}

// ==================== COPY / PASTE JSON ====================
export function copyDataJson() {
  const jsonStr = JSON.stringify(state.appData, null, 2);
  const btn = document.getElementById('copyJsonBtn');
  const ok = () => {
    if (!btn) { showToast('Đã chép dữ liệu', 'success', 1800); return; }
    btn.innerHTML = '✓ Đã chép!';
    btn.style.background = '#10b981'; btn.style.borderColor = '#10b981'; btn.style.color = '#fff';
    setTimeout(() => { btn.innerHTML = '📋 Chép'; btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
  };
  const fb = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = jsonStr; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      ok();
    } catch { showToast('Không chép được', 'error'); }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(jsonStr).then(ok).catch(fb);
  else fb();
}

export function openPasteJsonModal()  {
  document.getElementById('jsonPasteInput').value = '';
  document.getElementById('pasteJsonModal').classList.add('active');
}
export function closePasteJsonModal() { document.getElementById('pasteJsonModal').classList.remove('active'); }

// ==================== APPLY IMPORT ====================
export function applyImportedPayload(parsed, mode = 'overwrite') {
  const importedData = payloadSource(parsed);
  if (!importedData) return { success: false };
  const importedSettings = (parsed.data && typeof parsed.data === 'object' && parsed.settings && typeof parsed.settings === 'object')
    ? parsed.settings : null;

  const newDel  = dedupeList(sanitizeRecords(importedData.delivery));
  const newPick = dedupeList(sanitizeRecords(importedData.pickup));
  const newRet  = dedupeList(sanitizeRecords(importedData.return));

  let removedCount = 0;
  let addedCount = 0;

  if (mode === 'overwrite') {
    const oldTotal = totalRecords(state.appData);
    state.appData = {
      delivery: newDel,
      pickup:   newPick,
      return:   newRet
    };
    addedCount = totalRecords(state.appData);
    removedCount = 0;
    console.log(`[Import] OVERWRITE: ${oldTotal} → ${addedCount} bản ghi`);
  } else {
    const mergeList = (oldList, newList) => {
      const merged = [...oldList];
      const keyOf = r => r.date + '|' + WEIGHT_KEYS.map(k => r.weights[k]).join('_');
      const have = new Set(oldList.map(keyOf));
      const usedIds = new Set(oldList.map(r => r.id));
      let added = 0;
      newList.forEach(r => {
        const k = keyOf(r);
        if (have.has(k)) return;
        have.add(k);
        // id trùng với bản ghi đang có (vd nạp lại backup cũ sau khi đã sửa) → cấp id mới,
        // nếu không Sửa/Xóa sẽ luôn trúng bản ghi đầu tiên
        const rec = usedIds.has(r.id) ? { ...r, id: generateId() } : r;
        usedIds.add(rec.id);
        merged.push(rec);
        added++;
      });
      return { list: merged, added };
    };

    const m1 = mergeList(state.appData.delivery, newDel);
    const m2 = mergeList(state.appData.pickup,   newPick);
    const m3 = mergeList(state.appData.return,   newRet);

    state.appData = {
      delivery: m1.list,
      pickup:   m2.list,
      return:   m3.list
    };
    addedCount = m1.added + m2.added + m3.added;
    const newTotal = totalRecords({ delivery: newDel, pickup: newPick, return: newRet });
    removedCount = newTotal - addedCount;
    console.log(`[Import] MERGE: thêm ${addedCount}, skip ${removedCount} trùng`);
  }

  // ===== Settings =====
  if (importedSettings) {
    if (importedSettings.region === 'mien' || importedSettings.region === 'hcm_hn') {
      state.region = importedSettings.region;
      try { localStorage.setItem('spx_region', state.region); } catch {}
    }

    if (importedSettings.theme === 'light' || importedSettings.theme === 'dark') {
      try { localStorage.setItem(STORAGE_KEYS.theme, importedSettings.theme); } catch {}
      document.documentElement.setAttribute('data-theme', importedSettings.theme);
    }

    if (importedSettings.salaryByMonth && typeof importedSettings.salaryByMonth === 'object') {
      const incoming = sanitizeSalaryByMonth(importedSettings.salaryByMonth);
      if (mode === 'overwrite') {
        state.salaryByMonth = incoming;
      } else {
        Object.keys(incoming).forEach(m => {
          if (!state.salaryByMonth[m]) state.salaryByMonth[m] = incoming[m];
        });
      }
      persistSalaryByMonth();
    } else {
      const legacySalary = Number(importedSettings.manualSalary) || 0;
      const legacyBuuCuc = Number(importedSettings.manualPoints?.buuCuc) || 0;
      const legacyTaiXe  = Number(importedSettings.manualPoints?.taiXe)  || 0;
      if (legacySalary > 0 || legacyBuuCuc > 0 || legacyTaiXe > 0) {
        const m = state.currentMonth || new Date().toISOString().slice(0, 7);
        if (!state.salaryByMonth[m]) {
          state.salaryByMonth[m] = { base: legacySalary, buuCuc: legacyBuuCuc, taiXe: legacyTaiXe };
          persistSalaryByMonth();
        }
      }
    }

    if (importedSettings.rankByMonth && typeof importedSettings.rankByMonth === 'object') {
      const incoming = sanitizeRankByMonth(importedSettings.rankByMonth);
      if (mode === 'overwrite') {
        state.rankByMonth = incoming;
      } else {
        Object.keys(incoming).forEach(m => {
          if (!state.rankByMonth[m]) state.rankByMonth[m] = incoming[m];
        });
      }
      persistRankByMonth();
    } else if (typeof importedSettings.rankName === 'string' && importedSettings.rankName !== 'none') {
      const m = state.currentMonth || new Date().toISOString().slice(0, 7);
      if (!state.rankByMonth[m]) {
        state.rankByMonth[m] = {
          name: importedSettings.rankName.slice(0, 30),
          bonus: Math.min(1, Math.max(0, Number(importedSettings.rankBonus) || 0))
        };
        persistRankByMonth();
      }
    }

    // Lưu ý: importedSettings.salaryDays (bản cũ) bị bỏ qua — không còn dùng
  }

  persistData();
  return { success: true, addedCount, removedCount, mode };
}

/**
 * Hỏi cách nạp. Trả về 'overwrite' | 'merge' | 'cancel'.
 * Dùng dialog 3 nút — chạm ra ngoài / Esc = HỦY (trước đây bị hiểu là "THÊM VÀO").
 */
export async function askImportMode(newCount = 0) {
  const currentTotal = totalRecords(state.appData);
  if (currentTotal === 0) return 'overwrite';

  const newInfo = newCount > 0 ? `\n📁 File muốn nạp: ${newCount} bản ghi\n` : '';
  const msg =
    `App đang có ${currentTotal} bản ghi.` + newInfo + `\n` +
    `Chọn cách nạp:\n\n` +
    `• THÊM VÀO — giữ data cũ + thêm mới (bỏ qua bản ghi trùng)\n` +
    `• GHI ĐÈ — xóa hết data cũ, thay bằng dữ liệu mới`;

  const choice = await showChoice(msg, {
    title: 'Nạp dữ liệu',
    icon: '📥',
    buttons: [
      { id: 'cancel',    text: '← Hủy',                    variant: 'ghost'   },
      { id: 'merge',     text: '➕ Thêm vào (giữ data cũ)', variant: 'primary' },
      { id: 'overwrite', text: '♻️ Ghi đè (xóa data cũ)',   variant: 'danger'  }
    ]
  });
  return (choice === 'merge' || choice === 'overwrite') ? choice : 'cancel';
}

export function importDoneMessage(mode, result, sourceLabel = '') {
  const src = sourceLabel ? ` ${sourceLabel}` : '';
  return mode === 'overwrite'
    ? `Đã GHI ĐÈ${src}: ${result.addedCount} bản ghi`
    : `Đã THÊM VÀO${src}: +${result.addedCount} bản ghi` +
      (result.removedCount > 0 ? `\nBỏ qua ${result.removedCount} bản ghi trùng` : '');
}

/**
 * Luồng nạp dùng chung cho: dán JSON, chọn file, khôi phục Cloud.
 * Kiểm tra định dạng → file rỗng → hỏi cách nạp → áp dụng.
 * @returns {Promise<{status:'ok'|'cancel'|'invalid'|'empty', mode?:string, result?:object}>}
 */
export async function runImport(parsed) {
  if (!payloadSource(parsed)) {
    await showAlert('Dữ liệu không đúng định dạng sao lưu của app!', { title: 'Lỗi định dạng', okText: 'Đóng' });
    return { status: 'invalid' };
  }
  const newCount = countPayloadRecords(parsed);
  if (newCount === 0) {
    await showAlert('File không có bản ghi nào để nạp.\n\nDữ liệu hiện tại được giữ nguyên.', { title: 'File rỗng', okText: 'Đóng' });
    return { status: 'empty' };
  }
  const mode = await askImportMode(newCount);
  if (mode === 'cancel') return { status: 'cancel' };

  const result = applyImportedPayload(parsed, mode);
  if (!result.success) {
    await showAlert('Dữ liệu không đúng định dạng sao lưu của app!', { title: 'Lỗi định dạng', okText: 'Đóng' });
    return { status: 'invalid' };
  }
  return { status: 'ok', mode, result };
}

// ==================== IMPORT (paste JSON) ====================
export async function confirmImportJsonString() {
  const text = document.getElementById('jsonPasteInput').value.trim();
  if (!text) {
    await showAlert('Vui lòng dán chuỗi JSON!', { title: 'Thiếu dữ liệu', okText: 'Đóng' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    await showAlert('Dữ liệu JSON không hợp lệ!', { title: 'Lỗi định dạng', okText: 'Đóng' });
    return;
  }

  const out = await runImport(parsed);
  if (out.status !== 'ok') return;   // hủy / sai định dạng / rỗng → giữ nguyên form để người dùng sửa

  updateAllViews();
  initRankUI();
  initRegionUI();
  closePasteJsonModal();
  await showAlert(importDoneMessage(out.mode, out.result), { title: '✅ Hoàn tất', okText: 'OK' });
}

// ==================== EXPORT ====================
export function exportData() {
  downloadBackupFile('SPX_Data');
}

// ==================== IMPORT FILE ====================
export async function importData(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = async () => {
    input.value = '';
    await showAlert('Không đọc được file sao lưu!', { title: 'Lỗi file', okText: 'Đóng' });
  };
  reader.onload = async e => {
    input.value = '';   // cho phép chọn lại đúng file đó lần sau
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      await showAlert('Không đọc được file sao lưu!', { title: 'Lỗi file', okText: 'Đóng' });
      return;
    }

    const out = await runImport(parsed);
    if (out.status !== 'ok') return;

    updateAllViews();
    initRankUI();
    initRegionUI();
    await showAlert(importDoneMessage(out.mode, out.result), { title: '✅ Hoàn tất', okText: 'OK' });
  };
  reader.readAsText(file);
}

// ==================== RESTORE FROM VAULT ====================
export async function restoreFromVault() {
  let vault = null;
  try {
    vault = JSON.parse(localStorage.getItem(STORAGE_KEYS.vault));
  } catch {}

  const hasData = vault && (
    (vault.delivery && vault.delivery.length > 0) ||
    (vault.pickup   && vault.pickup.length   > 0) ||
    (vault.return   && vault.return.length   > 0)
  );
  if (!hasData) {
    await showAlert('Không tìm thấy dữ liệu tự động lưu trữ.', { title: 'Không có vault', okText: 'Đóng' });
    return;
  }

  const ok = await showConfirm(
    'Đã tìm thấy bản sao lưu tự động.\n\nBạn có muốn phục hồi không?',
    { title: 'Phục hồi vault', okText: 'Phục hồi', cancelText: 'Hủy' }
  );
  if (!ok) return;

  state.appData = {
    delivery: sanitizeRecords(vault.delivery),
    pickup:   sanitizeRecords(vault.pickup),
    return:   sanitizeRecords(vault.return)
  };
  persistData();
  updateAllViews();
  await showAlert('Đã phục hồi dữ liệu!', { title: '✅ Hoàn tất', okText: 'OK' });
}
import { state } from '../state.js';
import { WEIGHT_KEYS } from '../config.js';
import { getTodayIso, formatDateDisplay, generateId, isValidIsoDate, escapeHtml } from '../utils.js';
import { openAddModal, openEditModal, switchModalSubTab, showToast, isAutoSaveOCR } from '../ui.js';
import { updateAllViews } from '../render.js';
import { showConfirm, showAlert } from '../dialog.js';
import { processOneFile } from './processor.js';
import { newAbortController, checkAborted, clearAbortController, cancelOcr } from './worker.js';
import { clearOcrCache as _clearOcrCacheImpl } from '../ocr-cache.js';

const DISABLE_AUTO_SAVE = false;
const DRY_RUN_OCR = false;

let _lastOcrLog = '';
let batchResults = [];
let pendingAppend = false;
let _activeBatchItem = null;

export function setBatch(list) { batchResults = list; }
export function getBatch() { return batchResults; }

function buildWeights(r) {
  const suffixMap = { '0_2':'w0_2','2_4':'w2_4','4_6':'w4_6','6_8':'w6_8','8_10':'w8_10','10_12':'w10_12','12_15':'w12_15','over_15':'wover_15' };
  const w = {};
  WEIGHT_KEYS.forEach(wk => {
    const suffix = Object.keys(suffixMap).find(k => suffixMap[k] === wk);
    w[wk] = r.weights[suffix] || 0;
  });
  return w;
}

function getTypeFromResult(r) {
  if (r.detectedColorType === 'del')  return 'delivery';
  if (r.detectedColorType === 'pick') return 'pickup';
  if (r.detectedColorType === 'ret')  return 'return';
  return null;
}

function getTypeLabel(r) {
  if (r.detectedColorType === 'del')  return 'Giao';
  if (r.detectedColorType === 'pick') return 'Lấy';
  if (r.detectedColorType === 'ret')  return 'Hoàn';
  return 'Không rõ';
}

function findExactDuplicate(r) {
  const type = getTypeFromResult(r);
  if (!type) return null;
  const weights = buildWeights(r);
  return state.appData[type].find(rec => rec.date === r.parsedDate && WEIGHT_KEYS.every(k => (parseInt(rec.weights[k], 10) || 0) === (parseInt(weights[k], 10) || 0))) || null;
}

const EMPTY_THUMB = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1NiIgaGVpZ2h0PSI1NiI+PGRlZnM+PHBhdHRlcm4gaWQ9ImciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHJlY3Qgd2lkdGg9IjUiIGhlaWdodD0iNSIgZmlsbD0iI2U1ZTdlYiIvPjxyZWN0IHg9IjUiIHk9IjUiIHdpZHRoPSI1IiBoZWlnaHQ9IjUiIGZpbGw9IiNlNWU3ZWIiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSI1NiIgaGVpZ2h0PSI1NiIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==';

function _updateOcrProgress(pct, label) {
  const fill = document.getElementById('ocrProgressFill');
  const text = document.getElementById('ocrProgressText');
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (fill) fill.style.width = clamped + '%';
  if (text) text.innerText = label ? `${clamped}% · ${label}` : clamped + '%';
}

function _resetOcrProgress() { _updateOcrProgress(0, ''); }

function validateDistribution(weights) {
  const w = { '0_2': parseInt(weights['0_2'], 10) || 0, '2_4': parseInt(weights['2_4'], 10) || 0, '4_6': parseInt(weights['4_6'], 10) || 0, '6_8': parseInt(weights['6_8'], 10) || 0, '8_10': parseInt(weights['8_10'], 10) || 0, '10_12': parseInt(weights['10_12'], 10) || 0, '12_15': parseInt(weights['12_15'], 10) || 0, 'over_15': parseInt(weights['over_15'], 10) || 0 };
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total < 5) return { ok: true, warnings: [], suspectKeys: [] };
  const warnings = [];
  const suspects = new Set();
  if (w['0_2'] / total < 0.5) { warnings.push(`Dải 0-2 chỉ ${Math.round(w['0_2']/total*100)}% (thường ≥50%)`); suspects.add('0_2'); }
  if (w['2_4'] >= 10 && w['0_2'] < w['2_4'] * 0.33) { warnings.push('Dải 2-4 nhiều bất thường so với dải 0-2'); suspects.add('0_2'); suspects.add('2_4'); }
  if (w['4_6'] >= 5 && w['2_4'] < w['4_6'] * 0.33) { warnings.push('Dải 4-6 nhiều bất thường so với dải 2-4'); suspects.add('2_4'); suspects.add('4_6'); }
  const maxKey = Object.keys(w).reduce((a, b) => w[a] > w[b] ? a : b);
  if (w['0_2'] > 0 && w[maxKey] > w['0_2'] * 5) { warnings.push('Có dải cao bất thường'); suspects.add(maxKey); }
  const small = w['0_2'] + w['2_4'] + w['4_6'];
  if (small / total < 0.7) { warnings.push(`Dải nhỏ chỉ ${Math.round(small/total*100)}% (thường ≥70%)`); suspects.add('0_2'); suspects.add('2_4'); suspects.add('4_6'); }
  return { ok: warnings.length === 0, warnings, suspectKeys: [...suspects] };
}

async function tryAutoSave(r) {
  if (DISABLE_AUTO_SAVE) return false;
  if (!isAutoSaveOCR()) return false;
  if (String(r.mode || '').includes('+fix')) return false;
  const type = getTypeFromResult(r);
  if (!type) return false;
  const confs = Object.values(r.confidences).filter(c => c != null);
  if (confs.length === 0) return false;
  const allHigh = confs.every(c => c >= 85);
  if (!allHigh) return false;
  if (r.expectedTotal === null || r.expectedTotal !== r.totalFound) return false;
  if (r.tabDetected !== true || r.dateFound !== true) return false;
  if (r.totalFound <= 0) return false;
  if (!isValidIsoDate(r.parsedDate) || r.parsedDate > getTodayIso()) return false;
  const dist = validateDistribution(r.weights);
  if (!dist.ok) return false;
  if (DRY_RUN_OCR) return false;
  const weights = buildWeights(r);
  const newId = generateId();
  state.appData[type].unshift({ id: newId, date: r.parsedDate, weights });
  updateAllViews();
  return true;
}

export async function clearOcrCache() { return _clearOcrCacheImpl(); }

export async function copyOcrLog() {
  const debugEl = document.getElementById('ocrDebugText');
  let text = (debugEl && debugEl.innerText) ? debugEl.innerText.trim() : '';
  if (!text) text = (_lastOcrLog || '').trim();
  if (!text) { showToast('Không có log để copy', 'warning', 1500); return; }
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); showToast('Đã copy log (' + text.length + ' ký tự)', 'success', 1800); return; }
  } catch (e) { console.warn('[OCR] Clipboard API fail:', e); }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    if (ok) showToast('Đã copy log (' + text.length + ' ký tự)', 'success', 1800);
    else showToast('Không copy được — thử giữ tay vào log', 'error', 2500);
  } catch (e) { showToast('Không copy được: ' + e.message, 'error', 2500); }
}

function injectCopyLogButton() {
  const toggleBtn = document.getElementById('ocrDebugToggle');
  if (!toggleBtn) return;
  const old = document.getElementById('ocrCopyLogBtn');
  if (old) old.remove();
  const copyBtn = document.createElement('button');
  copyBtn.id = 'ocrCopyLogBtn'; copyBtn.type = 'button'; copyBtn.innerText = '📋 Copy log';
  copyBtn.style.cssText = `background: transparent; border: 1px solid var(--border); color: var(--text-3); font-size: 10px; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; font-weight: 600; margin-left: 6px;`;
  copyBtn.onclick = () => copyOcrLog();
  toggleBtn.parentNode.appendChild(copyBtn);
}

function ensureCancelButton() {
  const overlay = document.getElementById('ocrLoadingOverlay');
  if (!overlay || overlay.querySelector('.ocr-cancel-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'ocr-cancel-btn'; btn.innerText = '✕ Hủy';
  btn.style.cssText = `margin-top: 22px; padding: 10px 26px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer; backdrop-filter: blur(4px);`;
  btn.onclick = () => cancelOcr();
  overlay.appendChild(btn);
}

function _renderBatchSummary(summary) {
  const wrap = document.getElementById('batchSummary');
  const chipSaved = document.getElementById('batchSummarySaved');
  const chipDup = document.getElementById('batchSummaryDup');
  const chipNeed = document.getElementById('batchSummaryNeed');
  if (!wrap) return;
  const s = summary || { saved: 0, dup: 0, need: 0 };
  if (document.getElementById('batchSummarySavedCount')) document.getElementById('batchSummarySavedCount').innerText = s.saved;
  if (document.getElementById('batchSummaryDupCount')) document.getElementById('batchSummaryDupCount').innerText = s.dup;
  if (document.getElementById('batchSummaryNeedCount')) document.getElementById('batchSummaryNeedCount').innerText = s.need;
  if (chipSaved) chipSaved.style.display = s.saved > 0 ? '' : 'none';
  if (chipDup) chipDup.style.display = s.dup > 0 ? '' : 'none';
  if (chipNeed) chipNeed.style.display = s.need > 0 ? '' : 'none';
  wrap.style.display = (s.saved > 0 || s.dup > 0 || s.need > 0) ? '' : 'none';
}

async function _runOcrFromFiles(files, wasAppend = false) {
  if (!files || files.length === 0) return;
  const ctrl = newAbortController();
  const signal = ctrl.signal;
  const overlay = document.getElementById('ocrLoadingOverlay');
  if (overlay) overlay.style.display = 'flex';
  ensureCancelButton();
  _resetOcrProgress();

  try {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      checkAborted(signal);
      if (document.getElementById('ocrStatusTitle')) document.getElementById('ocrStatusTitle').innerText = `Ảnh ${i + 1}/${files.length}`;
      if (document.getElementById('ocrStatusDesc')) document.getElementById('ocrStatusDesc').innerText = 'Đang xử lý...';
      const basePct = (i / files.length) * 80;
      const stepPct = (1 / files.length) * 80;
      _updateOcrProgress(basePct, `Ảnh ${i + 1}/${files.length}`);
      let item;
      try {
        item = await processOneFile(files[i], signal, (passPct) => { _updateOcrProgress(basePct + (passPct / 100) * stepPct, `Ảnh ${i + 1}/${files.length}`); });
      } catch (err) {
        if (err && err.message === 'OCR_CANCELLED') throw err;
        item = { file: files[i]?.name || `ảnh ${i + 1}`, thumbnail: '', result: null, error: (err && err.message) || 'Lỗi không xác định' };
      }
      results.push(item);
    }

    _updateOcrProgress(85, 'Đang kiểm tra...');
    if (overlay) overlay.style.display = 'none';
    _resetOcrProgress();

    const autoSaved = [], duplicates = [], needAttention = [];
    for (const item of results) {
      if (item.error) { needAttention.push(item); continue; }
      const r = item.result;
      if (findExactDuplicate(r)) { duplicates.push(item); continue; }
      if (await tryAutoSave(r)) autoSaved.push(item);
      else needAttention.push(item);
    }

    const summary = { saved: autoSaved.length, dup: duplicates.length, need: needAttention.length };

    if (needAttention.length > 0) {
      if (wasAppend) { batchResults.push(...needAttention); openBatchOcrModal(summary); showSummaryToast(autoSaved.length, duplicates.length, needAttention.length); return; }
      if (files.length === 1) { const item = needAttention[0]; if (item.error) showToast('Không đọc được ảnh: ' + item.error, 'error', 3000); else fillModalFromResult(item); return; }
      batchResults = needAttention; _activeBatchItem = null;
      openBatchOcrModal(summary); showSummaryToast(autoSaved.length, duplicates.length, needAttention.length, 400); return;
    }

    if (files.length === 1) {
      const item = results[0]; const r = item.result;
      if (duplicates.length === 1) { showToast(`Ảnh đã tồn tại — ${getTypeLabel(r)} ${formatDateDisplay(r.parsedDate)}: ${r.totalFound} đơn`, 'warning', 2500); return; }
      if (autoSaved.length === 1) showToast(`Đã tự động lưu ${getTypeLabel(r)} ${formatDateDisplay(r.parsedDate)}: ${r.totalFound} đơn`, 'success', 2500);
      return;
    }
    if (autoSaved.length > 0 || duplicates.length > 0) showSummaryToast(autoSaved.length, duplicates.length, 0);
  } catch (err) {
    if (overlay) overlay.style.display = 'none'; _resetOcrProgress();
    if (err.message === 'OCR_CANCELLED') { showToast('Đã hủy quét ảnh', 'warning', 2000); return; }
    showToast('Lỗi khi quét ảnh: ' + err.message, 'error', 3000);
  } finally { clearAbortController(ctrl); }
}

function showFixWarning(fixInfo) {
  const old = document.getElementById('fixWarningBanner'); if (old) old.remove();
  const labels = { '0_2':'>0 - 2 kg', '2_4':'>2 - 4 kg', '4_6':'>4 - 6 kg', '6_8':'>6 - 8 kg', '8_10':'>8 - 10 kg', '10_12':'>10 - 12 kg', '12_15':'>12 - 15 kg', 'over_15':'>15 kg' };
  const label = labels[fixInfo.key] || fixInfo.key;
  const dir = fixInfo.delta > 0 ? 'tăng' : 'giảm'; const deltaAbs = Math.abs(fixInfo.delta); const isHeavy = fixInfo.isRisky;
  const banner = document.createElement('div'); banner.id = 'fixWarningBanner';
  banner.style.cssText = `margin-bottom: 14px; padding: 12px 14px; border-radius: 12px; border: 2px solid ${isHeavy ? '#dc2626' : '#ea580c'}; background: ${isHeavy ? '#fef2f2' : '#fff7ed'}; color: ${isHeavy ? '#991b1b' : '#9a3412'}; animation: fixPulse 1.4s ease-in-out 3;`;
  banner.innerHTML = `<div style="font-size:13.5px;font-weight:800;margin-bottom:6px;letter-spacing:-0.01em">${isHeavy ? '🚨' : '⚠️'} App đã ĐOÁN LẠI SỐ</div><div style="font-size:12.5px;line-height:1.55;font-weight:600">Dải <b>${label}</b>: OCR đọc <b>${fixInfo.oldVal}</b> → app tự sửa thành <b>${fixInfo.newVal}</b> (${dir} ${deltaAbs} đơn, ký tự ${fixInfo.from} → ${fixInfo.to})</div><div style="font-size:11.5px;margin-top:8px;padding-top:8px;border-top:1px dashed ${isHeavy ? 'rgba(153,27,27,0.3)' : 'rgba(154,52,18,0.3)'};font-weight:700">👉 <b>BẮT BUỘC</b> đối chiếu ảnh gốc bên dưới trước khi Lưu</div>`;
  if (!document.getElementById('fixWarningStyle')) { const style = document.createElement('style'); style.id = 'fixWarningStyle'; style.textContent = `@keyframes fixPulse { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(234, 88, 12, 0.4); } 50% { transform: scale(1.015); box-shadow: 0 0 0 6px rgba(234, 88, 12, 0); } }`; document.head.appendChild(style); }
  const tabs = document.getElementById('modalSubTabGroup'); if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(banner, tabs);
}

export function fillModalFromResult(item) {
  const r = item.result;
  state.lastOcrImageDataUrl = r.fullDataUrl || ''; state.isOcrScan = true;
  const distCheck = validateDistribution(r.weights);
  const modeStr = r.mode ? `[mode: ${r.mode}]` : '';
  const sumStr = r.expectedTotal !== null ? `[Sum: ${r.totalFound} / Total: ${r.expectedTotal} — diff: ${Math.abs(r.expectedTotal - r.totalFound)}]` : `[Sum: ${r.totalFound} / Total: (không đọc được)]`;
  _lastOcrLog = `${modeStr}\n${sumStr}\n\n${r.rawText || '(không có text)'}`;
  const debugEl = document.getElementById('ocrDebugText'); if (debugEl) { debugEl.innerText = _lastOcrLog; debugEl.style.display = 'none'; }
  openAddModal(); document.getElementById('inputDate').value = r.parsedDate; switchModalSubTab(r.detectedColorType);
  if (r.fixInfo) showFixWarning(r.fixInfo);
  const prefix = r.detectedColorType === 'del' ? 'del_inp' : r.detectedColorType === 'pick' ? 'pick_inp' : 'ret_inp';
  Object.keys(r.weights).forEach(k => { const el = document.getElementById(prefix + '_' + k); if (el) el.value = r.weights[k]; });
  applyConfidenceHighlight(r.confidences, r.detectedColorType); setTimeout(() => injectCopyLogButton(), 100);
  const typeText = getTypeLabel(r); let msg = `${typeText} ${formatDateDisplay(r.parsedDate)} · ${r.totalFound} đơn`;
  if (r.expectedTotal !== null && r.totalFound !== r.expectedTotal) msg += ` · lệch ${Math.abs(r.expectedTotal - r.totalFound)}`;
  let lowCount = 0, midCount = 0;
  Object.values(r.confidences).forEach(c => { if (c == null) return; if (c < 70) lowCount++; else if (c < 85) midCount++; });
  let toastType = 'success';
  if (lowCount > 0) { msg += ' · có dải đỏ'; toastType = 'error'; } else if (midCount > 0) { msg += ' · có dải vàng'; toastType = 'warning'; }
  if (!distCheck.ok) { msg += ' · ⚠️ phân bố bất thường'; toastType = 'error'; }
  if (r.fixInfo) { msg += ' · 🔧 app đã sửa số'; toastType = 'error'; }
  if (!distCheck.ok) showDistributionWarning(distCheck, r.detectedColorType);
  showToast(msg + ' — kiểm tra và lưu', toastType, 3500);
}

function showDistributionWarning(distCheck, detectedType) {
  const old = document.getElementById('distWarningBanner'); if (old) old.remove();
  const prefix = detectedType === 'del' ? 'del_inp' : detectedType === 'pick' ? 'pick_inp' : 'ret_inp';
  const suffixMap = { '0_2':'0_2','2_4':'2_4','4_6':'4_6','6_8':'6_8','8_10':'8_10','10_12':'10_12','12_15':'12_15','over_15':'over_15' };
  distCheck.suspectKeys.forEach(k => { const inp = document.getElementById(prefix + '_' + suffixMap[k]); if (inp) inp.classList.add('conf-suspect'); });
  const banner = document.createElement('div'); banner.id = 'distWarningBanner'; banner.className = 'dist-warning-banner';
  banner.innerHTML = `<div class="dist-warning-title">⚠️ Phân bố bất thường</div><ul class="dist-warning-list">${distCheck.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul><div class="dist-warning-hint">Đối chiếu với ảnh gốc bên dưới trước khi lưu</div>`;
  const tabs = document.getElementById('modalSubTabGroup'); if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(banner, tabs);
}

function buildCompareText(ocrW, existingW) {
  const suffixToWeight = { '0_2':'w0_2','2_4':'w2_4','4_6':'w4_6','6_8':'w6_8','8_10':'w8_10','10_12':'w10_12','12_15':'w12_15','over_15':'wover_15' };
  const labels = { '0_2':'>0-2kg','2_4':'>2-4','4_6':'>4-6','6_8':'>6-8','8_10':'>8-10','10_12':'>10-12','12_15':'>12-15','over_15':'>15' };
  let diffs = []; let matches = 0;
  Object.keys(suffixToWeight).forEach(k => {
    const ocr = parseInt(ocrW[k], 10) || 0; const ex = parseInt(existingW[suffixToWeight[k]], 10) || 0;
    if (ocr !== ex) diffs.push(`${labels[k]}: Đã lưu ${ex} ← OCR ${ocr}`); else if (ocr > 0 || ex > 0) matches++;
  });
  if (diffs.length === 0) return { text: `✅ Khớp hoàn toàn (${matches} dải)`, diffs: 0 };
  return { text: `⚠️ ${diffs.length} dải KHÁC BIỆT:\n\n${diffs.join('\n')}\n\n→ Xem ảnh gốc để đối chiếu.`, diffs: diffs.length };
}

export function openCompareModal(batchItem, existingRecord) {
  const r = batchItem.result; const type = getTypeFromResult(r);
  if (!type) { fillModalFromResult(batchItem); return; }
  openEditModal(type, existingRecord.id);
  setTimeout(() => {
    const previewBox = document.getElementById('ocrPreviewBox'); const previewImg = document.getElementById('ocrPreviewImg');
    if (previewBox && previewImg && r.fullDataUrl) { previewImg.src = r.fullDataUrl; previewBox.style.display = 'block'; }
    setTimeout(() => injectCopyLogButton(), 100);
    const cmp = buildCompareText(r.weights, existingRecord.weights);
    let msg = `📊 SO SÁNH NGÀY ${formatDateDisplay(r.parsedDate)}\n\n📁 Dữ liệu ĐÃ LƯU được hiển thị trong ô nhập.\n📷 Ảnh OCR được hiển thị bên dưới.\n\n${cmp.text}`;
    showAlert(msg, { title: 'So sánh dữ liệu', okText: 'Đóng' });
  }, 200);
}

export function openBatchOcrModal(summary) { _renderBatchSummary(summary); renderBatchList(); document.getElementById('batchOcrModal').classList.add('active'); }
export function closeBatchOcrModal() { document.getElementById('batchOcrModal').classList.remove('active'); }
export function appendBatchFiles() { pendingAppend = true; document.getElementById('ocrFileInput').click(); }

function renderBatchList() {
  const list = document.getElementById('batchList'); list.innerHTML = '';
  document.getElementById('batchCount').innerText = batchResults.length;
  if (batchResults.length === 0) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:12px">Không có ảnh nào.</div>'; return; }
  const typeMap = { del: ['Giao', 'tag-delivery'], pick: ['Lấy', 'tag-pickup'], ret: ['Hoàn', 'tag-return'] };
  batchResults.forEach((item, idx) => {
    const div = document.createElement('div');
    if (item.error) {
      div.className = 'batch-item error';
      div.innerHTML = `<div class="batch-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px">⚠️</div><div class="batch-info"><div class="batch-title">${escapeHtml(item.file)}</div><div class="batch-meta" style="color:var(--danger)">Lỗi: ${escapeHtml(item.error)}</div></div><div class="batch-actions"><button class="batch-btn batch-btn-remove" onclick="removeBatchItem(${idx})">Bỏ</button></div>`;
    } else {
      const r = item.result; const [typeLabel, typeClass] = typeMap[r.detectedColorType] || ['?', 'tag-delivery'];
      let lowCount = 0, midCount = 0;
      Object.values(r.confidences).forEach(c => { if (c == null) return; if (c < 70) lowCount++; else if (c < 85) midCount++; });
      const distCheck = validateDistribution(r.weights);
      const confIcon = lowCount > 0 ? ' 🔴' : midCount > 0 ? ' 🟡' : ' 🟢';
      const warnIcon = (r.expectedTotal !== null && r.totalFound !== r.expectedTotal) ? ' ⚠️' : '';
      const distIcon = !distCheck.ok ? ' 🟠' : '';
      const fixIcon = r.fixInfo ? (r.fixInfo.isRisky ? ' 🚨' : ' 🔧') : '';
      const cacheIcon = item.fromCache ? ' ⚡' : '';
      const type = getTypeFromResult(r);
      const existing = type ? state.appData[type].find(rec => rec.date === r.parsedDate) : null;
      const actionBtn = existing ? `<button class="batch-btn batch-btn-compare" onclick="importBatchItem(${idx})">🔍 So sánh</button>` : `<button class="batch-btn batch-btn-import" onclick="importBatchItem(${idx})">📝 Nhập</button>`;
      const existingBadge = existing ? ` <span style="font-size:9px;padding:1px 6px;border-radius:4px;background:var(--warning-bg);border:1px solid var(--warning-bd);color:var(--warning);font-weight:700">Đã có</span>` : '';
      div.className = 'batch-item';
      div.innerHTML = `<img class="batch-thumb" src="${item.thumbnail || EMPTY_THUMB}" alt=""><div class="batch-info"><div class="batch-title"><span class="hist-badge-tag ${typeClass}">${typeLabel}</span><span>${formatDateDisplay(r.parsedDate)}${confIcon}${warnIcon}${distIcon}${fixIcon}${cacheIcon}${existingBadge}</span></div><div class="batch-meta">${escapeHtml(item.file)}</div><div class="batch-total">${r.totalFound} đơn</div></div><div class="batch-actions">${actionBtn}<button class="batch-btn batch-btn-remove" onclick="removeBatchItem(${idx})">Bỏ</button></div>`;
    }
    list.appendChild(div);
  });
}

window.addEventListener('spx:entry-closed', () => { _activeBatchItem = null; });

export function completeActiveBatchItem() {
  if (!_activeBatchItem) return false;
  const idx = batchResults.indexOf(_activeBatchItem); if (idx !== -1) batchResults.splice(idx, 1);
  _activeBatchItem = null; showBackToBatchBtn(false); return true;
}

export function removeBatchItem(idx) {
  if (batchResults[idx] && batchResults[idx] === _activeBatchItem) _activeBatchItem = null;
  batchResults.splice(idx, 1);
  if (batchResults.length === 0) { closeBatchOcrModal(); return; }
  renderBatchList();
}

export function importBatchItem(idx) {
  const item = batchResults[idx]; if (!item || item.error) return;
  const r = item.result; const type = getTypeFromResult(r);
  const existing = type ? state.appData[type].find(rec => rec.date === r.parsedDate) : null;
  closeBatchOcrModal(); if (existing) openCompareModal(item, existing); else fillModalFromResult(item);
  _activeBatchItem = item; showBackToBatchBtn(true);
}

export function backToBatch() {
  if (batchResults.length === 0) { showToast('Batch đã trống', 'warning'); showBackToBatchBtn(false); return; }
  _activeBatchItem = null; const entryModal = document.getElementById('entryModal'); if (entryModal) entryModal.classList.remove('active');
  showBackToBatchBtn(false); openBatchOcrModal();
}

export function showBackToBatchBtn(show) { const btn = document.getElementById('backToBatchBtn'); if (btn) btn.style.display = show ? 'inline-flex' : 'none'; }
export function hasBatchPending() { return batchResults.length > 0; }

export async function saveBatchAll() {
  const valid = batchResults.filter(r => !r.error);
  if (valid.length === 0) { showToast('Không có dữ liệu hợp lệ', 'error'); return; }
  const today = getTodayIso();
  const sigOf = (type, date, w) => type + '|' + date + '|' + WEIGHT_KEYS.map(k => parseInt(w[k], 10) || 0).join('_');
  const seen = new Set(), toSave = [], dropped = new Set();
  let dupCount = 0, reviewCount = 0;
  for (const item of valid) {
    const r = item.result; const type = getTypeFromResult(r);
    if (!type || !isValidIsoDate(r.parsedDate) || r.parsedDate > today) { reviewCount++; continue; }
    const weights = buildWeights(r); const sig = sigOf(type, r.parsedDate, weights);
    if (seen.has(sig) || state.appData[type].some(rec => sigOf(type, rec.date, rec.weights) === sig)) { dropped.add(item); dupCount++; continue; }
    const sameDayExisting = state.appData[type].some(rec => rec.date === r.parsedDate);
    const sameDayInBatch = toSave.some(x => x.type === type && x.item.result.parsedDate === r.parsedDate);
    if (sameDayExisting || sameDayInBatch) { reviewCount++; continue; }
    if (!validateDistribution(r.weights).ok) { reviewCount++; continue; }
    seen.add(sig); toSave.push({ item, type, weights });
  }
  if (toSave.length === 0 && dropped.size === 0) { showToast(reviewCount > 0 ? `Không có ảnh nào tự lưu được — ${reviewCount} ảnh cần xem lại` : 'Không có gì để lưu', '
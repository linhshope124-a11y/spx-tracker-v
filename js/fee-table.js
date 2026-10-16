// =============================================================
// FEE TABLE MODAL — Bảng phí dịch vụ (Plan D — tối giản)
// - 2 mode: Bảng đầy đủ / Tra cứu
// - 3 type: Giao / Lấy / Hoàn
// - Mode calc: input to editable + 2 nút flanking (−10 / +10)
// - Search + highlight + sticky table
// =============================================================

import { TABLE_4_DATA, TABLE_5_DATA, TABLE_6_DATA, WEIGHT_LABELS } from './config.js';
import { _fmt } from './utils.js';
import { showToast } from './ui.js';

// ==================== STATE ====================
let feeMode  = 'table';
let feeType  = 'del';
let feeValue = 0;
let searchValue = '';

const LS_KEYS = {
  mode:  'spx_fee_modal_mode',
  type:  'spx_fee_modal_type',
  value: 'spx_fee_modal_value'
};

// ==================== CONSTANTS ====================
const TYPE_LABELS = {
  del:  'Giao',
  pick: 'Lấy',
  ret:  'Hoàn'
};

const TYPE_MAX = {
  del:  50000,
  pick: 100000,
  ret:  100000
};

// ==================== HELPERS ====================
function getTableData(type) {
  if (type === 'del')  return TABLE_5_DATA;
  if (type === 'pick') return TABLE_4_DATA;
  return TABLE_6_DATA;
}

function formatNum(n) {
  return _fmt(Math.max(0, Math.floor(Number(n) || 0)));
}

function clampValue(v, type) {
  const num = Math.floor(Number(v) || 0);
  if (num <= 0) return 0;
  const max = TYPE_MAX[type] || 50000;
  return Math.min(num, max);
}

// ==================== PERSIST ====================
function loadFeeState() {
  try {
    const m = localStorage.getItem(LS_KEYS.mode);
    if (m === 'table' || m === 'calc') feeMode = m;

    const t = localStorage.getItem(LS_KEYS.type);
    if (t === 'del' || t === 'pick' || t === 'ret') feeType = t;

    const v = parseInt(localStorage.getItem(LS_KEYS.value) || '0', 10);
    feeValue = Number.isFinite(v) && v > 0 ? v : 0;
    feeValue = clampValue(feeValue, feeType);
  } catch {}
}

function persistFeeState() {
  try {
    localStorage.setItem(LS_KEYS.mode, feeMode);
    localStorage.setItem(LS_KEYS.type, feeType);
    localStorage.setItem(LS_KEYS.value, String(feeValue));
  } catch {}
}

// ==================== UI SYNC ====================
function syncModeUI() {
  document.querySelectorAll('.fee-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === feeMode);
  });

  const panelTable = document.getElementById('feePanelTable');
  const panelCalc  = document.getElementById('feePanelCalc');
  if (panelTable) panelTable.hidden = feeMode !== 'table';
  if (panelCalc)  panelCalc.hidden  = feeMode !== 'calc';
}

function syncTypeUI() {
  document.querySelectorAll('.fee-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === feeType);
  });
}

function syncCalcUI() {
  const displayInput = document.getElementById('feeCalcDisplay');
  if (!displayInput) return;

  // Không ghi đè khi user đang gõ
  if (document.activeElement === displayInput) return;

  if (feeValue > 0) {
    displayInput.value = formatNum(feeValue);
    displayInput.removeAttribute('data-empty');
  } else {
    displayInput.value = '0';
    displayInput.setAttribute('data-empty', '1');
  }
}

// ==================== TABLE RENDER ====================
function renderTable() {
  const thead = document.getElementById('feeTableHead');
  const tbody = document.getElementById('feeTableBody');
  if (!thead || !tbody) return;

  const data = getTableData(feeType);

  let headHtml = '<tr><th>ĐƠN</th>';
  for (let i = 0; i < 8; i++) {
    headHtml += `<th>${WEIGHT_LABELS[i].replace('>', '').replace(' kg', '')}</th>`;
  }
  headHtml += '</tr>';
  thead.innerHTML = headHtml;

  let bodyHtml = '';
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    bodyHtml += `<tr data-min="${row.min}" data-max="${row.max}">`;
const compact = String(row.range)
  .replace(/[.,]/g, '')     // bỏ dấu . và ,
  .replace(/ - /g, '-')      // "1 - 15" → "1-15"
  .replace(/≥ /g, '≥');      // "≥ 12"  → "≥12"
bodyHtml += `<td>${compact}</td>`;
    for (let c = 0; c < 8; c++) {
      bodyHtml += `<td>${formatNum(row.pts[c] || 0)}</td>`;
    }
    bodyHtml += '</tr>';
  }
  tbody.innerHTML = bodyHtml;
}

// ==================== CALC RESULT RENDER ====================
function renderCalcResult() {
  const resultEl = document.getElementById('feeResult');
  const emptyEl  = document.getElementById('feeEmpty');
  if (!resultEl || !emptyEl) return;

  if (feeValue <= 0) {
    resultEl.classList.remove('fee-result-show');
    resultEl.innerHTML = '';
    emptyEl.classList.add('fee-empty-show');
    return;
  }

  emptyEl.classList.remove('fee-empty-show');
  resultEl.classList.add('fee-result-show');

  const data = getTableData(feeType);

  let rowData = data[data.length - 1];
  for (const row of data) {
    if (feeValue >= row.min && feeValue < row.max) {
      rowData = row;
      break;
    }
  }

  const typeLabel = TYPE_LABELS[feeType] || '';

  let html = `<div class="fee-result-head">Kết quả — <b>${typeLabel} · ${formatNum(feeValue)} đơn</b></div>`;

  let total = 0;
  for (let c = 0; c < 8; c++) {
    const pts = rowData.pts[c] || 0;
    total += pts;
    html += `<div class="fee-result-row">
      <span class="fee-result-lbl">${WEIGHT_LABELS[c]}</span>
      <span class="fee-result-val">${formatNum(pts)}</span>
    </div>`;
  }

  html += `<div class="fee-result-total">
    <span class="fee-result-total-lbl">TỔNG (8 dải)</span>
    <span class="fee-result-total-val">${formatNum(total)}</span>
  </div>`;

  resultEl.innerHTML = html;
}

// ==================== SEARCH — MODE TABLE ====================
function applySearch(rawValue) {
  const input = document.getElementById('feeSearchInput');
  const clearBtn = document.getElementById('feeSearchClear');

  const digitsOnly = String(rawValue || '').replace(/[^\d]/g, '');

  if (rawValue && !digitsOnly && String(rawValue).trim() !== '') {
    if (input) input.value = '';
    if (clearBtn) clearBtn.hidden = true;
    searchValue = '';
    highlightRow(null);
    showToast('⚠️ Vui lòng nhập số', 'warning', 2000);
    return;
  }

  if (input && input.value !== digitsOnly) input.value = digitsOnly;
  if (clearBtn) clearBtn.hidden = !digitsOnly;
  searchValue = digitsOnly;

  if (!digitsOnly) {
    highlightRow(null);
    return;
  }

  const num = parseInt(digitsOnly, 10);
  if (!Number.isFinite(num) || num <= 0) {
    highlightRow(null);
    showToast('⚠️ Số đơn phải ≥ 1', 'warning', 2000);
    return;
  }

  const data = getTableData(feeType);
  const maxRow = data[data.length - 1];
  const highestMin = maxRow.min;

  if (num >= highestMin && !Number.isFinite(maxRow.max)) {
    highlightRow(num, true);
    return;
  }

  if (Number.isFinite(maxRow.max) && num >= maxRow.max) {
    highlightRow(null);
    showToast(`⚠️ Số ${formatNum(num)} vượt dải cao nhất (tối đa ${formatNum(maxRow.max - 1)})`, 'warning', 3000);
    return;
  }

  let matchIdx = -1;
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (num >= row.min && num < row.max) {
      matchIdx = r;
      break;
    }
  }

  if (matchIdx === -1) {
    highlightRow(null);
    showToast(`⚠️ Số ${formatNum(num)} không nằm trong dải nào`, 'warning', 3000);
    return;
  }

  highlightRow(num, false, matchIdx);
}

function highlightRow(num, isTopRow, matchIdx) {
  const tbody = document.getElementById('feeTableBody');
  const scrollWrap = document.getElementById('feeTableScroll');
  if (!tbody) return;

  tbody.querySelectorAll('.fee-row-match').forEach(tr => {
    tr.classList.remove('fee-row-match');
  });

  if (num === null || num === undefined) return;

  const rows = tbody.querySelectorAll('tr');
  let targetRow = null;

  if (typeof matchIdx === 'number' && matchIdx >= 0 && matchIdx < rows.length) {
    targetRow = rows[matchIdx];
  } else if (isTopRow) {
    targetRow = rows[rows.length - 1];
  }

  if (!targetRow) return;

  targetRow.classList.add('fee-row-match');

  if (scrollWrap) {
    const rowTop = targetRow.offsetTop;
    const rowHeight = targetRow.offsetHeight;
    const wrapTop = scrollWrap.scrollTop;
    const wrapHeight = scrollWrap.clientHeight;
    const headerHeight = tbody.parentElement.querySelector('thead')?.offsetHeight || 0;

    if (rowTop < wrapTop + headerHeight || rowTop + rowHeight > wrapTop + wrapHeight) {
      scrollWrap.scrollTo({
        top: Math.max(0, rowTop - headerHeight - 40),
        behavior: 'smooth'
      });
    }
  }
}
// ==================== SET VALUE ====================
function setFeeValue(newValue, sourceEl) {
  const clamped = clampValue(newValue, feeType);
  feeValue = clamped;

  const displayInput = document.getElementById('feeCalcDisplay');

  if (displayInput && displayInput !== sourceEl && document.activeElement !== displayInput) {
    if (feeValue > 0) {
      displayInput.value = formatNum(feeValue);
      displayInput.removeAttribute('data-empty');
    } else {
      displayInput.value = '0';
      displayInput.setAttribute('data-empty', '1');
    }
  }

  renderCalcResult();
  persistFeeState();
}

// ==================== ADJUST BUTTONS — AUTO-REPEAT ====================
const _adjTimers = new WeakMap();

function startAdjRepeat(btn) {
  // Chặn double-start
  if (_adjTimers.has(btn)) return;

  const delta = parseInt(btn.dataset.delta, 10);
  if (!Number.isFinite(delta)) return;

  // Nhấn lần đầu — apply ngay
  setFeeValue(feeValue + delta);

  const state = { timeout: null, interval: null };
  _adjTimers.set(btn, state);

  state.timeout = setTimeout(() => {
    state.timeout = null;
    state.interval = setInterval(() => {
      setFeeValue(feeValue + delta);
    }, 100);
  }, 500);
}

function stopAdjRepeat(btn) {
  const state = _adjTimers.get(btn);
  if (!state) return;
  if (state.timeout)  clearTimeout(state.timeout);
  if (state.interval) clearInterval(state.interval);
  _adjTimers.delete(btn);
}

function stopAllAdjRepeat() {
  document.querySelectorAll('.fee-adj-btn').forEach(btn => stopAdjRepeat(btn));
}

function attachAdjustButtons() {
  document.querySelectorAll('.fee-adj-btn').forEach(btn => {
    if (btn.dataset.adjAttached === '1') return;
    btn.dataset.adjAttached = '1';

    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      startAdjRepeat(btn);
    });
    btn.addEventListener('pointerup',     () => stopAdjRepeat(btn));
    btn.addEventListener('pointercancel', () => stopAdjRepeat(btn));
    btn.addEventListener('pointerleave',  () => stopAdjRepeat(btn));

    // Fallback touch cho browser cũ
    btn.addEventListener('touchstart', e => {
      if (e.pointerType) return;
      e.preventDefault();
      startAdjRepeat(btn);
    }, { passive: false });
    btn.addEventListener('touchend',    () => stopAdjRepeat(btn));
    btn.addEventListener('touchcancel', () => stopAdjRepeat(btn));
  });

  // Global catch — chỉ hook 1 lần
  if (!window.__feeAdjGlobalHooked) {
    window.__feeAdjGlobalHooked = true;

    window.addEventListener('pointerup', stopAllAdjRepeat);
    window.addEventListener('pointercancel', stopAllAdjRepeat);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAllAdjRepeat();
    });

    window.addEventListener('blur', stopAllAdjRepeat);
  }
}

// ==================== INPUT EVENTS ====================
function attachCalcInputs() {
  const displayInput = document.getElementById('feeCalcDisplay');
  if (!displayInput || displayInput.dataset.feeAttached === '1') return;
  displayInput.dataset.feeAttached = '1';

  displayInput.addEventListener('focus', () => {
    // Cho user gõ raw số, bỏ format dấu chấm
    displayInput.value = feeValue > 0 ? String(feeValue) : '';
  });

  displayInput.addEventListener('input', () => {
    const cleaned = displayInput.value.replace(/[^\d]/g, '');
    if (displayInput.value !== cleaned) displayInput.value = cleaned;
  });

  displayInput.addEventListener('blur', () => {
    const raw = parseInt(displayInput.value, 10);
    const newVal = Number.isFinite(raw) && raw > 0 ? raw : 0;
    setFeeValue(newVal, displayInput);

    if (feeValue > 0) {
      displayInput.value = formatNum(feeValue);
      displayInput.removeAttribute('data-empty');
    } else {
      displayInput.value = '0';
      displayInput.setAttribute('data-empty', '1');
    }
  });

  displayInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      displayInput.blur();
    }
  });
}

// ==================== SEARCH EVENT ====================
function attachSearch() {
  const input = document.getElementById('feeSearchInput');
  if (!input || input.dataset.feeAttached === '1') return;
  input.dataset.feeAttached = '1';

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => applySearch(input.value), 250);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      applySearch(input.value);
      input.blur();
    }
  });
}

// ==================== MODE SWITCH + TYPE TABS ====================
function attachModeSwitch() {
  document.querySelectorAll('.fee-mode-btn').forEach(btn => {
    if (btn.dataset.feeAttached === '1') return;
    btn.dataset.feeAttached = '1';
    btn.addEventListener('click', () => setFeeMode(btn.dataset.mode));
  });
}

function attachTypeTabs() {
  document.querySelectorAll('.fee-type-btn').forEach(btn => {
    if (btn.dataset.feeAttached === '1') return;
    btn.dataset.feeAttached = '1';
    btn.addEventListener('click', () => setFeeType(btn.dataset.type));
  });
}

// ==================== PUBLIC API ====================
export function openFeeTableModal() {
  loadFeeState();

  syncModeUI();
  syncTypeUI();
  syncCalcUI();

  if (feeMode === 'table') {
    renderTable();
    const input = document.getElementById('feeSearchInput');
    if (input) {
      input.value = searchValue || '';
      if (searchValue) applySearch(searchValue);
    }
  } else {
    renderCalcResult();
  }

  attachAdjustButtons();
  attachCalcInputs();
  attachSearch();
  attachModeSwitch();
  attachTypeTabs();

  const modal = document.getElementById('feeTableModal');
  if (modal) modal.classList.add('active');
}

export function closeFeeTableModal() {
  const modal = document.getElementById('feeTableModal');
  if (modal) modal.classList.remove('active');

  stopAllAdjRepeat();
  persistFeeState();
}

export function setFeeMode(mode) {
  if (mode !== 'table' && mode !== 'calc') return;
  if (feeMode === mode) return;

  feeMode = mode;
  syncModeUI();
  persistFeeState();

  if (mode === 'table') {
    renderTable();
    const input = document.getElementById('feeSearchInput');
    if (input && input.value) applySearch(input.value);
  } else {
    syncCalcUI();
    renderCalcResult();
  }
}

export function setFeeType(type) {
  if (type !== 'del' && type !== 'pick' && type !== 'ret') return;
  if (feeType === type) return;

  feeType = type;
  feeValue = clampValue(feeValue, type);

  syncTypeUI();
  persistFeeState();

  if (feeMode === 'table') {
    renderTable();
    const input = document.getElementById('feeSearchInput');
    if (input) input.value = '';
    searchValue = '';
    const clearBtn = document.getElementById('feeSearchClear');
    if (clearBtn) clearBtn.hidden = true;
  } else {
    syncCalcUI();
    renderCalcResult();
  }
}

export function clearFeeSearch() {
  const input = document.getElementById('feeSearchInput');
  if (input) input.value = '';
  searchValue = '';
  const clearBtn = document.getElementById('feeSearchClear');
  if (clearBtn) clearBtn.hidden = true;
  highlightRow(null);
  input?.focus();
}

// ==================== INIT ====================
let _feeInited = false;

export function initFeeTable() {
  if (_feeInited) return;
  _feeInited = true;

  loadFeeState();
  attachModeSwitch();
  attachTypeTabs();
  attachAdjustButtons();
  attachCalcInputs();
  attachSearch();

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('feeTableModal');
    if (modal && modal.classList.contains('active')) {
      closeFeeTableModal();
    }
  });

  const modal = document.getElementById('feeTableModal');
  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === modal) closeFeeTableModal();
    });
  }

  console.log('[FeeTable] Đã khởi tạo');
}

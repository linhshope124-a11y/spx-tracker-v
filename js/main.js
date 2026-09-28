import { state, loadState } from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import {
  switchMainTab, switchModalSubTab, setOverviewFilter, setPeriodFilter, setHistFilter,
  setRankTier, initRankUI,
  openAddModal, openEditModal, closeModal,
  openSettingsModal, closeSettingsModal,
  openCoffeeModal, closeCoffeeModal, copyPhoneNumber, copyBankNumber
} from './ui.js';
import {
  handleOcrImage, preloadTesseractWorker,
  openOcrLightbox, closeOcrLightbox,
  openBatchOcrModal, closeBatchOcrModal, appendBatchFiles,
  saveBatchAll, importBatchItem, removeBatchItem,
  backToBatch, hasBatchPending, showBackToBatchBtn
} from './ocr.js';
import { saveRecord, deleteRecord, clearAllHistory } from './entry.js';
import {
  copyDataJson, openPasteJsonModal, closePasteJsonModal,
  confirmImportJsonString, exportData, importData, restoreFromVault
} from './backup.js';
import { updateAllViews } from './render.js';
import { testCloudConnection, pushToCloud, pullFromCloud, initCloudUI } from './cloud.js';
import { undoLast } from './undo.js';
import { toggleCharts } from './charts.js';

function attachAutoClearInputs() {
  document.querySelectorAll('.auto-clear').forEach(input => {
    input.addEventListener('focus', function () { if (this.value === '0') this.value = ''; });
    input.addEventListener('blur',  function () { if (this.value.trim() === '') this.value = '0'; });
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    fetch('./sw.js', { method: 'HEAD' })
      .then(r => {
        if (!r.ok) throw new Error('sw.js không tồn tại');
        return navigator.serviceWorker.register('./sw.js', { scope: './' });
      })
      .then(reg => console.log('[PWA] SW đã đăng ký:', reg.scope))
      .catch(err => console.warn('[PWA] Bỏ qua SW:', err.message));
  });
}

Object.assign(window, {
  toggleTheme,
  switchMainTab, switchModalSubTab, setOverviewFilter, setPeriodFilter, setHistFilter,
  setRankTier,
  openAddModal, openEditModal, closeModal,
  openSettingsModal, closeSettingsModal,
  openCoffeeModal, closeCoffeeModal, copyPhoneNumber, copyBankNumber,
  handleOcrImage, openOcrLightbox, closeOcrLightbox,
  openBatchOcrModal, closeBatchOcrModal, appendBatchFiles,
  saveBatchAll, importBatchItem, removeBatchItem,
  backToBatch, hasBatchPending, showBackToBatchBtn,
  saveRecord, deleteRecord, clearAllHistory,
  copyDataJson, openPasteJsonModal, closePasteJsonModal,
  confirmImportJsonString, exportData, importData, restoreFromVault,
  testCloudConnection, pushToCloud, pullFromCloud, initCloudUI,
  undoLast, toggleCharts,

  saveManualPoints: function() {
    state.manualPoints.buuCuc = parseInt(document.getElementById('manualBuuCucInput').value, 10) || 0;
    state.manualPoints.taiXe  = parseInt(document.getElementById('manualTaiXeInput').value, 10) || 0;
    localStorage.setItem('spx_manual_points', JSON.stringify(state.manualPoints));
    updateAllViews();
  },
  saveSalaryConfig: function() {
    state.manualSalary = parseFloat(document.getElementById('salaryBaseInput').value) || 0;
    state.salaryDays   = parseInt(document.getElementById('salaryDaysInput').value, 10) || 26;
    localStorage.setItem('spx_manual_salary', state.manualSalary);
    localStorage.setItem('spx_salary_days', state.salaryDays);
    updateAllViews();
  }
});

(function init() {
  loadState();
  initTheme();
  initRankUI();
  attachAutoClearInputs();
  updateAllViews();
  setTimeout(() => preloadTesseractWorker(), 2000);
})();
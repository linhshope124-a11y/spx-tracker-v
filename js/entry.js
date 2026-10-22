import { state, persistData } from './state.js';
import { WEIGHT_KEYS, WEIGHT_SUFFIXES } from './config.js';
import { sanitizeInt, generateId, getTodayIso, getCurrentMonthIso, formatDateDisplay, deepClone, isValidIsoDate } from './utils.js';
import { closeModal, showToast } from './ui.js';
import { updateAllViews } from './render.js';
import { hasBatchPending, backToBatch, completeActiveBatchItem } from './ocr/index.js';
import { showAlert, showConfirm, showChoice } from './dialog.js';
import { downloadBackupFile } from './backup.js';

function parseWeights(prefix) {
  const out = {};
  WEIGHT_SUFFIXES.forEach((sfx, i) => {
    out[WEIGHT_KEYS[i]] = sanitizeInt(document.getElementById(`${prefix}_${sfx}`).value);
  });
  return out;
}

function weightsEqual(a, b) {
  return WEIGHT_KEYS.every(k => (parseInt(a[k], 10) || 0) === (parseInt(b[k], 10) || 0));
}

function findDuplicate(type, date, weights) {
  return state.appData[type].find(r => r.date === date && weightsEqual(r.weights, weights));
}

export async function saveRecord() {
  const date = document.getElementById('inputDate').value || getTodayIso();
  if (!isValidIsoDate(date)) {
    await showAlert('Ngày không hợp lệ!', { title: 'Lỗi', okText: 'Đóng' });
    return;
  }

  const editId   = document.getElementById('editEntryId').value;
  const editType = document.getElementById('editEntryType').value;

  // Có id nhưng thiếu loại → trạng thái form hỏng; nếu để rơi xuống nhánh "thêm mới" sẽ tạo bản ghi rác
  if (editId && !editType) {
    await showAlert('Không xác định được loại bản ghi đang sửa.\n\nHãy đóng form và mở lại.', { title: 'Lỗi', okText: 'Đóng' });
    return;
  }

  if (editId && editType) {
    // === SỬA ===
    const numId  = parseInt(editId, 10);
    const prefix = editType === 'delivery' ? 'del_inp'
                 : editType === 'pickup'   ? 'pick_inp'
                 : 'ret_inp';
    const weights = parseWeights(prefix);

    // Không cho lưu bản ghi toàn số 0 (sẽ thành bản ghi "ma" trong nhật ký)
    if (Object.values(weights).reduce((a, b) => a + b, 0) === 0) {
      await showAlert(
        'Bản ghi này không còn đơn nào.\n\nNếu muốn bỏ bản ghi, hãy bấm Xóa trong Nhật ký.',
        { title: 'Thiếu dữ liệu', okText: 'Đóng' }
      );
      return;
    }

    const idx = state.appData[editType].findIndex(it => it.id === numId);
    if (idx === -1) {
      await showAlert('Không tìm thấy bản ghi để cập nhật.', { title: 'Lỗi', okText: 'Đóng' });
      closeModal(true);
      updateAllViews();
      return;
    }

    const dup = state.appData[editType].find(r =>
      r.id !== numId && r.date === date && weightsEqual(r.weights, weights)
    );
    if (dup) {
      const typeLabel = editType === 'delivery' ? 'Giao' : editType === 'pickup' ? 'Lấy' : 'Hoàn';
      await showAlert(
        `Bản ghi ${typeLabel} ngày ${formatDateDisplay(date)} đã tồn tại với CÙNG số liệu.\n\n` +
        `Hãy sửa số liệu khác hoặc xóa bản ghi cũ trước.`,
        { title: '🚫 Không thể lưu', okText: 'Đã hiểu' }
      );
      return;
    }

    state.appData[editType][idx].date    = date;
    state.appData[editType][idx].weights = weights;
  } else {
    // === THÊM MỚI ===
    const delW  = parseWeights('del_inp');
    const pickW = parseWeights('pick_inp');
    const retW  = parseWeights('ret_inp');
    const delT  = Object.values(delW).reduce((a, b) => a + b, 0);
    const pickT = Object.values(pickW).reduce((a, b) => a + b, 0);
    const retT  = Object.values(retW).reduce((a, b) => a + b, 0);
    if (delT + pickT + retT === 0) {
      await showAlert('Chưa nhập số liệu nào!', { title: 'Thiếu dữ liệu', okText: 'Đóng' });
      return;
    }

    const dups = [];
    if (delT  > 0 && findDuplicate('delivery', date, delW))  dups.push('Giao');
    if (pickT > 0 && findDuplicate('pickup',   date, pickW)) dups.push('Lấy');
    if (retT  > 0 && findDuplicate('return',   date, retW))  dups.push('Hoàn');

    if (dups.length > 0) {
      await showAlert(
        `Ngày ${formatDateDisplay(date)} đã tồn tại bản ghi ${dups.join(', ')} với CÙNG số liệu.\n\n` +
        `Hãy:\n• Sửa số liệu khác\n• Hoặc xóa bản ghi cũ trước`,
        { title: '🚫 Không thể lưu', okText: 'Đã hiểu' }
      );
      return;
    }

    if (delT  > 0) {
      const id = generateId();
      state.appData.delivery.unshift({ id, date, weights: delW });
    }
    if (pickT > 0) {
      const id = generateId();
      state.appData.pickup.unshift({ id, date, weights: pickW });
    }
    if (retT  > 0) {
      const id = generateId();
      state.appData.return.unshift({ id, date, weights: retW });
    }
  }

  // Nếu form này mở từ 1 ảnh trong batch OCR → bỏ ảnh đó khỏi batch (đã lưu xong)
  // TRƯỚC khi đóng modal (closeModal sẽ hủy liên kết ảnh batch)
  const fromBatch = completeActiveBatchItem();

  closeModal(true);
  updateAllViews();

  if (fromBatch) {
    if (hasBatchPending()) setTimeout(() => backToBatch(), 200);
    else showToast('Đã xử lý xong tất cả ảnh', 'success', 2200);
  }
}

export async function deleteRecord(type, id) {
  const arr = state.appData[type];
  const idx = arr.findIndex(it => it.id === id);
  if (idx === -1) return;

  const ok = await showConfirm('Bạn muốn xóa bản ghi này?', {
    title: 'Xóa bản ghi',
    okText: 'Xóa',
    cancelText: 'Hủy',
    danger: true
  });
  if (!ok) return;

  arr.splice(idx, 1);
  updateAllViews();
}

// ⭐ Xóa toàn bộ — chỉ HỎI, không bắt buộc backup
export async function clearAllHistory() {
  const total = state.appData.delivery.length + state.appData.pickup.length + state.appData.return.length;
  if (total === 0) {
    await showAlert('Không có bản ghi nào để xóa.', { title: 'Không có dữ liệu', okText: 'Đóng' });
    return;
  }

  // ═══════════════════════════════════════════════════════════
  //  DIALOG 1: Hỏi có muốn lưu backup trước không? (3 lựa chọn)
  // ═══════════════════════════════════════════════════════════
  const choice = await showChoice(
    `Bạn sắp xóa TOÀN BỘ ${total} bản ghi.\n\n` +
    `Hành động này KHÔNG THỂ KHÔI PHỤC.\n\n` +
    `Bạn muốn lưu file backup về máy trước khi xóa không?`,
    {
      title: '⚠️ Xóa toàn bộ nhật ký',
      icon: '⚠️',
      buttons: [
        { id: 'cancel',             text: '← Hủy',                variant: 'ghost'   },
        { id: 'backup_then_delete', text: '📥 Có, lưu backup',     variant: 'primary' },
        { id: 'delete_now',         text: '🗑️ Không, xóa luôn',   variant: 'danger'  }
      ]
    }
  );

  if (choice === 'cancel') return;

  // ═══════════════════════════════════════════════════════════
  //  Nếu chọn "Có lưu backup": lưu file + xác nhận đã lưu xong
  // ═══════════════════════════════════════════════════════════
  if (choice === 'backup_then_delete') {
    // ⚠️ Trigger download NGAY trong stack này để browser cho phép (user gesture)
    downloadBackupFile('SPX_BeforeDelete');

    // Đợi browser bắt đầu tải
    await new Promise(r => setTimeout(r, 800));

    // DIALOG 2: Xác nhận đã lưu xong chưa
    const confirmDelete = await showConfirm(
      `📁 File backup đã lưu về thư mục Downloads chưa?\n\n` +
      `Nếu đã thấy file → bấm ĐÃ LƯU, XÓA LUÔN.\n` +
      `Nếu chưa thấy → bấm HỦY XÓA để kiểm tra lại.`,
      {
        title: '🚨 Xác nhận xóa',
        okText: '🗑️ Đã lưu xong, xóa luôn',
        cancelText: '← Chưa lưu, hủy xóa',
        danger: true
      }
    );

    if (!confirmDelete) return;   // user chưa thấy file → không xóa
  }

  // ═══════════════════════════════════════════════════════════
  //  Tiến hành xóa
  // ═══════════════════════════════════════════════════════════
  state.appData = { delivery: [], pickup: [], return: [] };
  try {
    localStorage.removeItem('spx_backup_vault');
    localStorage.removeItem('spx_dual_records');
  } catch {}
  persistData();      // ghi NGAY (không chờ debounce) → thoát app sớm cũng không "sống lại" dữ liệu cũ
  updateAllViews();

  // Toast xác nhận
  const finalMsg = choice === 'backup_then_delete'
    ? `✅ Đã lưu backup và xóa ${total} bản ghi`
    : `⚠️ Đã xóa ${total} bản ghi (không backup)`;
  showToast(finalMsg, choice === 'backup_then_delete' ? 'success' : 'warning', 3000);
}

/**
 * Xóa toàn bộ dữ liệu (Giao + Lấy + Hoàn) của tháng đang xem. Dữ liệu các tháng khác giữ nguyên.
 */
export async function deleteCurrentMonthHistory() {
  const cm = state.currentMonth || getCurrentMonthIso();
  const [y, m] = cm.split('-');
  const label = `${parseInt(m, 10)}/${y}`;
  const inMonth = r => r.date.startsWith(cm + '-');

  const count = ['delivery', 'pickup', 'return'].reduce((n, t) => n + state.appData[t].filter(inMonth).length, 0);
  if (count === 0) {
    await showAlert(`Không có dữ liệu trong tháng ${label} để xóa.`, { title: 'Không có dữ liệu', okText: 'Đóng' });
    return;
  }

  const choice = await showChoice(
    `Thao tác này sẽ xóa vĩnh viễn ${count} bản ghi của tháng ${label}.\n\n` +
    `Dữ liệu các tháng khác được giữ nguyên.\n\n` +
    `Bạn có muốn sao lưu dữ liệu trước khi xóa không?`,
    {
      title: `⚠️ Xóa dữ liệu tháng ${label}`,
      icon: '⚠️',
      buttons: [
        { id: 'cancel',             text: '← Hủy bỏ',          variant: 'ghost'   },
        { id: 'backup_then_delete', text: '📥 Sao lưu & Xóa',  variant: 'primary' },
        { id: 'delete_now',         text: '🗑️ Xóa vĩnh viễn', variant: 'danger'  }
      ]
    }
  );
  if (choice === 'cancel') return;

  if (choice === 'backup_then_delete') {
    // Phải gọi ngay trong luồng của thao tác bấm nút để trình duyệt cho phép tải file
    downloadBackupFile('SPX_BeforeDeleteMonth');
    await new Promise(r => setTimeout(r, 800));
    const confirmDelete = await showConfirm(
      `File sao lưu đã được tải xuống chưa?\n\n` +
      `Chọn "Xác nhận xóa" để hoàn tất, hoặc "Hủy" nếu bạn chưa thấy file.`,
      { title: '🚨 Xác nhận xóa', okText: 'Xác nhận xóa', cancelText: 'Hủy', danger: true }
    );
    if (!confirmDelete) return;
  }

  ['delivery', 'pickup', 'return'].forEach(t => {
    state.appData[t] = state.appData[t].filter(r => !inMonth(r));
  });

  updateAllViews();
  showToast(`Đã xóa dữ liệu tháng ${label}`, 'success', 3000);
}

// =============================================================
// Global Error Handler
// Bắt mọi lỗi JS không được catch → hiện dialog thay vì trắng màn hình
// Chống spam: chỉ hiện 1 dialog / phiên, có rate-limit 30s
// =============================================================

let _initialized = false;
let _dialogShown = false;
let _lastShowTime = 0;
const SHOW_COOLDOWN_MS = 30 * 1000;   // 30 giây — tránh spam dialog khi lỗi lặp

/**
 * Init global error handler.
 * Gọi 1 lần trong main.js sau khi DOM ready.
 */
export function initErrorHandler() {
  if (_initialized) return;
  _initialized = true;

  // 1. Lỗi runtime đồng bộ + async chưa catch
  window.addEventListener('error', e => {
    // Bỏ qua lỗi từ extension / cross-origin scripts (không có filename)
    if (!e || !e.error) return;
    // Bỏ qua AbortError (OCR cancel chủ động)
    if (e.error.name === 'AbortError') return;
    // Bỏ qua lỗi đã được OCR_CANCELLED xử lý
    if (String(e.error.message || '').includes('OCR_CANCELLED')) return;

    handleError({
      type: 'error',
      message: e.message || 'Lỗi không xác định',
      source:  e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
      stack:   e.error?.stack || '',
      error:   e.error
    });
  });

  // 2. Promise rejection không có catch
  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    // Bỏ qua AbortError
    if (reason && reason.name === 'AbortError') return;
    if (String(reason?.message || reason || '').includes('OCR_CANCELLED')) return;

    handleError({
      type: 'promise',
      message: reason?.message || String(reason) || 'Promise bị reject',
      source:  '',
      stack:   reason?.stack || '',
      error:   reason
    });
  });

  console.log('[ErrorHandler] Đã kích hoạt');
}

/**
 * Xử lý lỗi — log console + hiện dialog (rate-limited)
 */
function handleError(info) {
  // Luôn log ra console để dev xem được
  console.error('[ErrorHandler]', info.type, info.message, '\n', info.stack || info.source);

  // Rate-limit: không hiện dialog nếu vừa hiện xong
  const now = Date.now();
  if (now - _lastShowTime < SHOW_COOLDOWN_MS) return;
  if (_dialogShown) return;   // chỉ hiện 1 lần / phiên

  _dialogShown = true;
  _lastShowTime = now;

  _showErrorDialog(info);
}

/**
 * Hiện dialog lỗi.
 * Ưu tiên dùng dialog.js của app — nếu lỗi luôn dialog.js thì fallback native.
 */
async function _showErrorDialog(info) {
  // Build detail string để copy
  const detail = [
    `[${new Date().toISOString()}]`,
    `Type: ${info.type}`,
    `Message: ${info.message}`,
    info.source ? `Source: ${info.source}` : '',
    info.stack ? `Stack:\n${info.stack}` : '',
    `URL: ${location.href}`,
    `UA: ${navigator.userAgent}`
  ].filter(Boolean).join('\n');

  const message =
    'Ứng dụng gặp lỗi không mong muốn.\n\n' +
    'Bạn có thể:\n' +
    '• Tải lại app để thử lại\n' +
    '• Copy chi tiết lỗi để báo dev\n\n' +
    'Dữ liệu của bạn vẫn được lưu an toàn.';

  try {
    // Dynamic import để tránh circular dependency (dialog.js → có thể import error-handler)
    const { showChoice } = await import('./dialog.js');

    const choice = await showChoice(message, {
      title: '⚠️ Có lỗi xảy ra',
      icon: '⚠️',
      buttons: [
        { id: 'cancel',  text: '← Đóng',                variant: 'ghost'   },
        { id: 'copy',    text: '📋 Copy chi tiết lỗi',  variant: 'ghost'   },
        { id: 'reload',  text: '🔄 Tải lại app',        variant: 'primary' }
      ]
    });

    if (choice === 'reload') {
      location.reload();
      return;
    }

    if (choice === 'copy') {
      await _copyDetail(detail);
      // Sau khi copy → cho phép hiện dialog lại (user có thể muốn reload)
      _dialogShown = false;
      _lastShowTime = 0;
    }
  } catch (dialogErr) {
    // Fallback nếu dialog.js cũng fail
    console.warn('[ErrorHandler] Dialog fail, dùng native:', dialogErr);
    const ok = window.confirm(
      'Ứng dụng gặp lỗi:\n\n' + info.message + '\n\nBấm OK để tải lại.'
    );
    if (ok) location.reload();
  }
}

/**
 * Copy chi tiết lỗi vào clipboard.
 */
async function _copyDetail(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      _showToastSafe('Đã copy chi tiết lỗi');
      return true;
    }
  } catch (e) {
    console.warn('[ErrorHandler] Clipboard API fail:', e);
  }

  // Fallback: textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      _showToastSafe('Đã copy chi tiết lỗi');
      return true;
    }
  } catch (e) {
    console.warn('[ErrorHandler] execCommand fail:', e);
  }

  _showToastSafe('Không copy được — xem Console để lấy log', 'warning');
  return false;
}

/**
 * Hiện toast — tự fallback nếu ui.js chưa load được.
 */
async function _showToastSafe(msg, type = 'success') {
  try {
    const { showToast } = await import('./ui.js');
    showToast(msg, type, 2500);
  } catch {
    console.log('[ErrorHandler]', msg);
  }
}

/**
 * Reset cờ (dùng khi user cố tình test error handler)
 */
export function resetErrorHandlerFlag() {
  _dialogShown = false;
  _lastShowTime = 0;
}
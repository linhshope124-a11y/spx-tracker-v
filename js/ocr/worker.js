import { OCR_TIMEOUT_MS } from '../config.js';

let _ocrAbortController = null;

export function cancelOcr() {
  if (_ocrAbortController) {
    _ocrAbortController.abort();
    _ocrAbortController = null;
    // abort chỉ dừng phần "chờ" — job Tesseract đang chạy vẫn tiếp tục ngốn CPU và chặn hàng đợi
    // của lần quét sau. Terminate worker để dừng hẳn (lần sau sẽ tự tạo lại, tài nguyên đã cache).
    resetTesseractWorker().catch(() => {});
    return true;
  }
  return false;
}

export function newAbortController() {
  _ocrAbortController = new AbortController();
  return _ocrAbortController;
}

export function checkAborted(signal) {
  if (signal && signal.aborted) throw new Error('OCR_CANCELLED');
}

export function clearAbortController(ctrl) {
  if (_ocrAbortController === ctrl) _ocrAbortController = null;
}

// ==================== TESSERACT WORKER ====================
let _tessLibPromise = null;
// Ghim phiên bản cụ thể: worker + core lấy theo phiên bản của thư viện này nên chỉ cần ghim ở đây
// (và cùng URL trong sw.js). Đổi phiên bản → sửa cả hai nơi.
const TESSERACT_LIB_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function ensureTesseractLib() {
  if (window.Tesseract) return Promise.resolve();
  if (_tessLibPromise) return _tessLibPromise;
  _tessLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_LIB_URL;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => {
      _tessLibPromise = null;
      s.remove();
      reject(new Error('Không tải được thư viện OCR — kiểm tra mạng'));
    };
    document.head.appendChild(s);
  });
  return _tessLibPromise;
}

let cachedTesseractWorker = null;
let workerLoadingPromise = null;

async function getTesseractWorker() {
  if (cachedTesseractWorker) return cachedTesseractWorker;
  if (workerLoadingPromise) return workerLoadingPromise;
  workerLoadingPromise = (async () => {
    await ensureTesseractLib();
    const worker = await Tesseract.createWorker('vie', 1, {
      logger: m => {
        const overlay = document.getElementById('ocrLoadingOverlay');
        if (!overlay || overlay.style.display !== 'flex') return;
        const desc = document.getElementById('ocrStatusDesc');
        if (!desc) return;
        let text = '';
        if (m.status === 'loading tesseract core')            text = 'Đang tải engine...';
        else if (m.status === 'initializing tesseract')       text = 'Đang khởi tạo...';
        else if (m.status === 'loading language traineddata') text = `Đang tải tiếng Việt ${Math.round((m.progress || 0) * 100)}%...`;
        else if (m.status === 'initializing api')             text = 'Đang chuẩn bị API...';
        else if (m.status === 'recognizing text')             text = `Đang nhận diện... ${Math.round((m.progress || 0) * 100)}%`;
        if (text) desc.innerText = text;
      }
    });
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
      tessedit_do_invert: '0'
    });
    cachedTesseractWorker = worker;
    return worker;
  })();
  try { return await workerLoadingPromise; }
  catch (e) { workerLoadingPromise = null; throw e; }
}

export async function resetTesseractWorker() {
  if (cachedTesseractWorker) {
    try { await cachedTesseractWorker.terminate(); } catch {}
  }
  cachedTesseractWorker = null;
  workerLoadingPromise = null;
}

export async function preloadTesseractWorker() {
  try { await getTesseractWorker(); console.log('[OCR] Worker sẵn sàng'); }
  catch (e) { console.warn('[OCR] Preload thất bại:', e); }
}

// ==================== TIMEOUT WRAPPER ====================
function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OCR timeout sau ${ms / 1000}s`)),
      ms
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('OCR_CANCELLED'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    promise.then(v => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    }).catch(e => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

// ==================== OCR RECOGNIZE ====================
export async function ocrRecognize(preprocessedDataUrl, signal) {
  checkAborted(signal);

  try {
    const worker = await getTesseractWorker();
    checkAborted(signal);
    const result = await withTimeout(
      worker.recognize(preprocessedDataUrl),
      OCR_TIMEOUT_MS,
      signal
    );
    return result.data.text || '';
  } catch (err) {
    if (err.message === 'OCR_CANCELLED') throw err;

    console.warn('[OCR] Attempt 1 fail → reset worker + retry:', err.message);
    await resetTesseractWorker();
    checkAborted(signal);

    try {
      const worker = await getTesseractWorker();
      checkAborted(signal);
      const result = await withTimeout(
        worker.recognize(preprocessedDataUrl),
        OCR_TIMEOUT_MS,
        signal
      );
      return result.data.text || '';
    } catch (err2) {
      if (err2.message === 'OCR_CANCELLED') throw err2;
      console.warn('[OCR] Attempt 2 fail:', err2.message);
      throw new Error('Không đọc được ảnh — ' + err2.message);
    }
  }
}
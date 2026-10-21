import { cacheGetAsync, cacheSet } from '../ocr-cache.js';
import { checkAborted, ocrRecognize } from './worker.js';
import { preprocessImage } from './preprocess.js';
import { detectActiveTabByOrangeLine } from './detect.js';
import { parseOcrText, postProcessFixDigits, extractDateStrict, extractDate } from './parser.js';

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.onerror = () => reject(new Error('Không đọc được file'));
    r.readAsDataURL(file);
  });
}

function makeThumbnail(dataUrl, maxW = 96) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale  = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.floor(img.width * scale);
        canvas.height = Math.floor(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.65));
      } catch { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

async function hashBlob(file) {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return 'fb_' + file.size + '_' + (file.name || '').length + '_' + (file.lastModified || 0);
  }
  try {
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'fb_' + Date.now().toString(16) + '_' + file.size + '_' + (file.name || '').length;
  }
}

// ==================== PROCESS ONE FILE — 6-PASS SMART PIPELINE ====================
export async function processOneFile(file, signal, onProgress) {
  checkAborted(signal);

  const hash = await hashBlob(file);
  const cached = await cacheGetAsync(hash);

  if (cached) {
    checkAborted(signal);
    if (onProgress) onProgress(100);
    const rawDataUrl = await readFileAsDataURL(file);
    const cachedResult = { ...cached.result, fullDataUrl: rawDataUrl };
    return {
      file: file.name,
      thumbnail: cached.thumbnail,
      result: cachedResult,
      error: null,
      fromCache: true
    };
  }

  checkAborted(signal);
  const rawDataUrl = await readFileAsDataURL(file);

  checkAborted(signal);
  const thumbnail = await makeThumbnail(rawDataUrl, 96);

  checkAborted(signal);
  const detectedType = await detectActiveTabByOrangeLine(rawDataUrl);

  checkAborted(signal);
  const statusDesc = document.getElementById('ocrStatusDesc');

  let bestResult = null;
  let bestText = '';
  let bestDiff = 9999;
  let knownTotal = null;   // 'Tổng' đọc được ở BẤT KỲ lần quét nào
  let passCount = 0;
  const TOTAL_PASSES = 6;

  function _reportProgress() {
    if (onProgress) onProgress(Math.min(100, Math.round((passCount / TOTAL_PASSES) * 100)));
  }

  async function runPass(label, opt) {
    checkAborted(signal);
    if (statusDesc) statusDesc.innerText = `Quét ${label}...`;
    const pre = await preprocessImage(rawDataUrl, opt, signal);
    checkAborted(signal);
    const text = await ocrRecognize(pre.dataUrl, signal);
    const parsed = parseOcrText(text);
    if (parsed.expectedTotal === null && knownTotal !== null) parsed.expectedTotal = knownTotal;
    if (parsed.expectedTotal !== null && knownTotal === null) knownTotal = parsed.expectedTotal;
    // Kết quả tốt nhất trước đó chưa có "Tổng" để đối chiếu → chấm lại với Tổng vừa đọc được
    if (bestResult && bestResult.expectedTotal === null && knownTotal !== null) {
      bestResult.expectedTotal = knownTotal;
      bestDiff = Math.abs(bestResult.totalFound - knownTotal);
    }
    const diff = parsed.expectedTotal !== null
      ? Math.abs(parsed.totalFound - parsed.expectedTotal)
      : 9999;
    if (!bestResult || diff < bestDiff) {
      bestResult = parsed;
      bestText = text;
      bestDiff = diff;
    }
    passCount++;
    _reportProgress();
    return diff;
  }

  // Còn nên quét thêm không?
  function _shouldRunMore() {
    if (bestDiff === 0) return false;
    if (bestDiff === 9999) return passCount < 3;
    return true;
  }

  await runPass('1/6', { upscale: 2.0, useOtsu: true });
  if (_shouldRunMore()) await runPass('2/6', { upscale: 2.0, useOtsu: false, threshold: 70 });
  if (_shouldRunMore()) await runPass('3/6', { upscale: 2.0, raw: true });
  if (_shouldRunMore()) await runPass('4/6', { upscale: 1.5, raw: true });
  if (_shouldRunMore()) await runPass('5/6', { upscale: 2.25, useOtsu: true });
  if (_shouldRunMore()) await runPass('6/6', { upscale: 1.75, useOtsu: true });

  // Post-process: đoán chữ số nếu vẫn lệch
  if (bestResult && bestDiff > 0) {
    const fixed = postProcessFixDigits(bestResult);
    if (fixed) { bestResult = fixed; bestDiff = 0; }
  }

  // Fallback nếu không pass nào chạy
  if (!bestResult) {
    const pre = await preprocessImage(rawDataUrl, { upscale: 2.0, useOtsu: true }, signal);
    const text = await ocrRecognize(pre.dataUrl, signal);
    bestResult = parseOcrText(text);
    bestText = text;
  }

  if (onProgress) onProgress(100);

  const result = {
    detectedColorType: detectedType || 'del',
    tabDetected: !!detectedType,
    dateFound: extractDateStrict(bestText) !== null,
    parsedDate: extractDate(bestText),
    weights: bestResult.weights,
    confidences: bestResult.confidences,
    expectedTotal: bestResult.expectedTotal,
    totalFound: bestResult.totalFound,
    mode: bestResult.mode,
    rawText: bestText,
    fullDataUrl: rawDataUrl,
    fixInfo: bestResult.fixInfo || null
  };

  // Chỉ cache kết quả đã đối chiếu được
  const verified = !result.fixInfo
    && result.expectedTotal !== null
    && result.totalFound === result.expectedTotal
    && result.tabDetected && result.dateFound;
  if (verified) {
    cacheSet(hash, {
      thumbnail,
      result: { ...result, fullDataUrl: '' }
    });
  }

  return { file: file.name, thumbnail, result, error: null };
}
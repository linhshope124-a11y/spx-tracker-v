import { state } from './state.js';
import { WEIGHT_KEYS } from './config.js';
import { getTodayIso, formatDateDisplay, generateId } from './utils.js';
import { openAddModal, openEditModal, switchModalSubTab } from './ui.js';
import { updateAllViews } from './render.js';

// ==================== TESSERACT WORKER ====================
let cachedTesseractWorker = null;
let workerLoadingPromise = null;

async function getTesseractWorker() {
  if (cachedTesseractWorker) return cachedTesseractWorker;
  if (workerLoadingPromise) return workerLoadingPromise;
  workerLoadingPromise = (async () => {
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
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      tessedit_do_invert: '0'
    });
    cachedTesseractWorker = worker;
    return worker;
  })();
  try { return await workerLoadingPromise; }
  catch (e) { workerLoadingPromise = null; throw e; }
}

export async function preloadTesseractWorker() {
  try { await getTesseractWorker(); console.log('[OCR] Worker sẵn sàng'); }
  catch (e) { console.warn('[OCR] Preload thất bại:', e); }
}

// ==================== HELPERS ====================
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

// ==================== OTSU THRESHOLD ====================
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0;
  let maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

// ==================== PREPROCESSING ====================
async function preprocessImage(rawDataUrl, options = {}) {
  const { upscale = 1.5, useOtsu = true } = options;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const scale = Math.min(2, upscale * (2000 / Math.max(img.width, 1)));
        const canvas = document.createElement('canvas');
        canvas.width  = Math.floor(img.width  * scale);
        canvas.height = Math.floor(img.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        const w = canvas.width, h = canvas.height;

        const gray = new Uint8Array(w * h);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          gray[j] = Math.round(data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
        }

        const sharpened = new Uint8Array(w * h);
        const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            let sum = 0, ki = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                sum += gray[(y + dy) * w + (x + dx)] * kernel[ki++];
              }
            }
            sharpened[y * w + x] = Math.max(0, Math.min(255, sum));
          }
        }
        for (let x = 0; x < w; x++) {
          sharpened[x] = gray[x];
          sharpened[(h - 1) * w + x] = gray[(h - 1) * w + x];
        }
        for (let y = 0; y < h; y++) {
          sharpened[y * w] = gray[y * w];
          sharpened[y * w + w - 1] = gray[y * w + w - 1];
        }

        const threshold = useOtsu ? otsuThreshold(sharpened) : 145;
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          const val = sharpened[j] > threshold ? 255 : 0;
          data[i] = data[i+1] = data[i+2] = val;
          data[i+3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = rawDataUrl;
  });
}

// ==================== PHÁT HIỆN TAB ====================
function detectActiveTabByOrangeLine(imageSource) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const scanHeight = Math.floor(img.height * 0.20);
        const imgData = ctx.getImageData(0, 0, img.width, scanHeight);
        const data = imgData.data;
        const colCount = new Array(img.width).fill(0);
        let totalOrange = 0;
        for (let y = 0; y < scanHeight; y++) {
          for (let x = 0; x < img.width; x++) {
            const idx = (y * img.width + x) * 4;
            const r = data[idx], g = data[idx+1], b = data[idx+2];
            if (r > 180 && g >= 40 && g <= 155 && b <= 90 && (r - g) > 45) { colCount[x]++; totalOrange++; }
          }
        }
        if (totalOrange < 20) { resolve(null); return; }
        const winSize = 40;
        let maxSum = 0, bestCenter = 0;
        for (let x = 0; x < img.width; x++) {
          let sum = 0;
          const l = Math.max(0, x - winSize);
          const r = Math.min(img.width - 1, x + winSize);
          for (let k = l; k <= r; k++) sum += colCount[k];
          if (sum > maxSum) { maxSum = sum; bestCenter = x; }
        }
        const rel = bestCenter / img.width;
        if (rel < 0.25) resolve('del');
        else if (rel < 0.42) resolve('pick');
        else resolve('ret');
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imageSource;
  });
}

// ==================== OCR VỚI WORDS ====================
async function ocrWithWords(preprocessedDataUrl) {
  const worker = await getTesseractWorker();
  const result = await worker.recognize(preprocessedDataUrl);
  const words = [];
  if (result.data.words && result.data.words.length) {
    result.data.words.forEach(word => {
      const text = (word.text || '').trim();
      if (!text) return;
      const digits = text.replace(/[^\d]/g, '');
      if (!digits) return;
      words.push({
        text: text,
        digits: digits,
        value: parseInt(digits, 10),
        confidence: word.confidence || 0,
        y0: word.bbox.y0,
        y1: word.bbox.y1,
        x0: word.bbox.x0,
        x1: word.bbox.x1,
        cy: (word.bbox.y0 + word.bbox.y1) / 2
      });
    });
  }
  return { words, text: result.data.text || '' };
}

// ==================== PARSE CHÍNH — MATCH THEO VỊ TRÍ TEXT ====================
function parseByRowLayout(words, detectedColorType, cleanText) {
  const weights = { '0_2':0,'2_4':0,'4_6':0,'6_8':0,'8_10':0,'10_12':0,'12_15':0,'over_15':0 };
  const confidences = {};

  const text = cleanText.replace(/[–—]/g, '-');

  // 1. Tìm Tổng đơn kỳ vọng
  const totalRegex = /T[oổ]ng\s*[:\-]?\s*(\d{1,6})\s*[đd][ơơ]n/i;
  const totalMatch = text.match(totalRegex);
  let expectedTotal = totalMatch ? parseInt(totalMatch[1], 10) : null;
  if (!Number.isFinite(expectedTotal)) expectedTotal = null;
  const totalPos = totalMatch ? totalMatch.index : -1;

  // 2. Tìm tất cả RANGE (X.XXX - Y.YYY hoặc X - Y)
  const rangeRegex = /(\d{1,2})(?:\.\d{1,3})?\s*-\s*(\d{1,2})(?:\.\d{1,3})?/g;
  const rangeMatches = [];
  let m;
  while ((m = rangeRegex.exec(text)) !== null) {
    const minV = parseInt(m[1], 10);
    const maxV = parseInt(m[2], 10);
    const rangeDefs = [
      { key: '0_2', min: 0, max: 2 },
      { key: '2_4', min: 2, max: 4 },
      { key: '4_6', min: 4, max: 6 },
      { key: '6_8', min: 6, max: 8 },
      { key: '8_10', min: 8, max: 10 },
      { key: '10_12', min: 10, max: 12 },
      { key: '12_15', min: 12, max: 15 }
    ];
    const def = rangeDefs.find(d => d.min === minV && d.max === maxV);
    if (def) {
      rangeMatches.push({ key: def.key, pos: m.index, full: m[0] });
    } else if (minV === 15 && maxV > 15) {
      rangeMatches.push({ key: 'over_15', pos: m.index, full: m[0] });
    }
  }

  // 3. Tìm tất cả COUNTS (N Đơn hàng)
  const countRegex = /(\d{1,6})\s*(?:[Đđ]ơn|[đd]on)\s*(?:hàng|hang)?/g;
  const countMatches = [];
  while ((m = countRegex.exec(text)) !== null) {
    const value = parseInt(m[1], 10);
    if (totalPos >= 0 && Math.abs(m.index - totalPos) < 15) continue;
    if (value < 0 || value > 99999) continue;
    countMatches.push({ value, pos: m.index, raw: m[0] });
  }

  // 4. Match range ↔ count gần nhất
  const usedCounts = new Set();
  rangeMatches.forEach(r => {
    if (weights[r.key] > 0) return;
    let best = null, bestDist = 9999;
    countMatches.forEach(c => {
      if (usedCounts.has(c.pos)) return;
      const dist = Math.abs(c.pos - r.pos);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    });
    if (best && bestDist < 150) {
      weights[r.key] = best.value;
      confidences[r.key] = 88;
      usedCounts.add(best.pos);
    }
  });

  // 5. Fallback: match theo words[] nếu regex không đủ
  const matchedCount = Object.values(weights).filter(v => v > 0).length;
  if (matchedCount < 3 && words && words.length > 0) {
    const sorted = [...words].sort((a, b) => a.cy - b.cy);
    const lines = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].cy - cur[cur.length - 1].cy) <= 25) cur.push(sorted[i]);
      else { lines.push(cur); cur = [sorted[i]]; }
    }
    if (cur.length) lines.push(cur);

    const rangeDefs = [
      { key: '0_2', min: 0, max: 2 }, { key: '2_4', min: 2, max: 4 },
      { key: '4_6', min: 4, max: 6 }, { key: '6_8', min: 6, max: 8 },
      { key: '8_10', min: 8, max: 10 }, { key: '10_12', min: 10, max: 12 },
      { key: '12_15', min: 12, max: 15 }, { key: 'over_15', min: 15, max: 999 }
    ];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      for (let i = 0; i < line.length - 1; i++) {
        const a = parseInt(line[i].digits, 10);
        const b = parseInt(line[i + 1].digits, 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const def = rangeDefs.find(d => d.min === a && (d.max === b || (d.key === 'over_15' && b > 15)));
        if (!def || weights[def.key] > 0) continue;

        const yRange = (line[i].cy + line[i + 1].cy) / 2;
        let best = null, bestDist = 99999;
        lines.forEach((otherLine, oi) => {
          const txt = otherLine.map(w => w.text).join(' ');
          if (!/[Đđ]ơn|[đd]on/i.test(txt)) return;
          otherLine.forEach(w => {
            const v = parseInt(w.digits, 10);
            if (!Number.isFinite(v) || v < 1 || v > 99999) return;
            const dist = Math.abs(w.cy - yRange) + Math.abs(oi - li) * 50;
            if (dist < bestDist) { bestDist = dist; best = { value: v, conf: w.confidence }; }
          });
        });
        if (best) {
          weights[def.key] = best.value;
          confidences[def.key] = best.conf;
        }
      }
    }
  }

  const totalFound = Object.values(weights).reduce((a, b) => a + b, 0);
  return { weights, confidences, expectedTotal, totalFound };
}

// ==================== CACHE ====================
const ocrCache = new Map();
const OCR_CACHE_MAX = 30;

async function hashDataUrl(dataUrl) {
  try {
    const buf = new TextEncoder().encode(dataUrl);
    const hashBuf = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0;
    for (let i = 0; i < dataUrl.length; i++) h = (h * 31 + dataUrl.charCodeAt(i)) | 0;
    return 'fb_' + h.toString(16);
  }
}

function cacheGet(hash) {
  if (!ocrCache.has(hash)) return null;
  const v = ocrCache.get(hash);
  ocrCache.delete(hash);
  ocrCache.set(hash, v);
  return v;
}

function cacheSet(hash, value) {
  ocrCache.set(hash, value);
  if (ocrCache.size > OCR_CACHE_MAX) {
    const oldest = ocrCache.keys().next().value;
    ocrCache.delete(oldest);
  }
}

// ==================== BATCH STATE ====================
let batchResults = [];
let pendingAppend = false;

// ==================== MAIN ====================
export async function handleOcrImage(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (files.length === 0) { pendingAppend = false; return; }

  const wasAppend = pendingAppend;
  pendingAppend = false;

  const overlay = document.getElementById('ocrLoadingOverlay');
  overlay.style.display = 'flex';

  try {
    const newResults = await processFiles(files);
    overlay.style.display = 'none';

    if (wasAppend) {
      batchResults.push(...newResults);
      renderBatchList();
      document.getElementById('batchOcrModal').classList.add('active');
      return;
    }

    const validCount = newResults.filter(r => !r.error).length;

    if (files.length === 1 && validCount === 1) {
      fillModalFromResult(newResults[0]);
      return;
    }
    if (files.length === 1 && validCount === 0) {
      alert('❌ Không đọc được ảnh: ' + newResults[0].error);
      return;
    }

    batchResults = newResults;
    openBatchOcrModal();
  } catch (err) {
    console.error(err);
    overlay.style.display = 'none';
    alert('Lỗi khi quét ảnh: ' + (err && err.message ? err.message : err));
  }
}

async function processFiles(files) {
  const out = [];
  const statusTitle = document.getElementById('ocrStatusTitle');
  const statusDesc  = document.getElementById('ocrStatusDesc');
  statusTitle.innerText = 'Đang khởi tạo...';
  statusDesc.innerText  = cachedTesseractWorker ? 'Worker sẵn sàng' : 'Lần đầu tải ~15MB...';

  await getTesseractWorker();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    statusTitle.innerText = `Ảnh ${i + 1}/${files.length}`;
    statusDesc.innerText  = 'Đang đọc file...';

    try {
      const rawDataUrl = await readFileAsDataURL(file);
      const hash   = await hashDataUrl(rawDataUrl);
      const cached = cacheGet(hash);

      if (cached) {
        statusDesc.innerText = '⚡ Dùng cache...';
        out.push({ file: file.name, thumbnail: cached.thumbnail, result: cached.result, error: null, fromCache: true });
        continue;
      }

      statusDesc.innerText = 'Xử lý ảnh...';
      const thumbnail = await makeThumbnail(rawDataUrl, 96);

      statusDesc.innerText = 'Xác định tab...';
      const detectedType = await detectActiveTabByOrangeLine(rawDataUrl);

      statusDesc.innerText = 'Tiền xử lý ảnh...';
      const pre1 = await preprocessImage(rawDataUrl, { upscale: 1.5, useOtsu: true });

      statusDesc.innerText = 'Đang quét (lần 1)...';
      const ocr1 = await ocrWithWords(pre1.dataUrl);
      const parsed1 = parseByRowLayout(ocr1.words, detectedType || 'del', ocr1.text);

      let finalResult = parsed1;
      const needRetry = parsed1.totalFound === 0 ||
                        (parsed1.expectedTotal !== null && Math.abs(parsed1.totalFound - parsed1.expectedTotal) > 5);

      if (needRetry) {
        statusDesc.innerText = 'Đang quét lại (lần 2)...';
        const pre2 = await preprocessImage(rawDataUrl, { upscale: 2.0, useOtsu: false });
        const ocr2 = await ocrWithWords(pre2.dataUrl);
        const parsed2 = parseByRowLayout(ocr2.words, detectedType || 'del', ocr2.text);

        const diff1 = parsed1.expectedTotal !== null ? Math.abs(parsed1.totalFound - parsed1.expectedTotal) : 9999;
        const diff2 = parsed2.expectedTotal !== null ? Math.abs(parsed2.totalFound - parsed2.expectedTotal) : 9999;
        finalResult = diff2 < diff1 ? parsed2 : parsed1;
      }

      const result = {
        detectedColorType: detectedType || 'del',
        parsedDate: extractDate(ocr1.text),
        weights: finalResult.weights,
        confidences: finalResult.confidences,
        expectedTotal: finalResult.expectedTotal,
        totalFound: finalResult.totalFound,
        fullDataUrl: rawDataUrl
      };

      out.push({ file: file.name, thumbnail, result, error: null });

      cacheSet(hash, { thumbnail, result: { ...result, fullDataUrl: '' } });
    } catch (err) {
      console.error('[OCR]', file.name, err);
      out.push({ file: file.name, thumbnail: '', result: null, error: err.message });
    }
  }
  return out;
}

function extractDate(text) {
  const cleanText = text.replace(/,/g, '.');
  const dateMatch = cleanText.match(/(?:ngày|ngay)?\s*[-–:]?\s*(\d{1,2})[\/\-\.](\d{1,2})/i);
  if (dateMatch) {
    return new Date().getFullYear() + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0');
  }
  return getTodayIso();
}

// ==================== FILL MODAL ====================
export function fillModalFromResult(batchItem) {
  const r = batchItem.result;
  state.lastOcrImageDataUrl = r.fullDataUrl || '';
  state.isOcrScan = true;

  openAddModal();
  document.getElementById('inputDate').value = r.parsedDate;
  switchModalSubTab(r.detectedColorType);

  const prefix = r.detectedColorType === 'del' ? 'del_inp'
               : r.detectedColorType === 'pick' ? 'pick_inp'
               : 'ret_inp';
  Object.keys(r.weights).forEach(k => {
    const el = document.getElementById(prefix + '_' + k);
    if (el) el.value = r.weights[k];
  });

  applyConfidenceHighlight(r.confidences, r.detectedColorType);

  const typeText = r.detectedColorType === 'del'  ? 'Đã giao hàng'
                 : r.detectedColorType === 'pick' ? 'Đã lấy'
                 : 'Đã trả hàng';

  let warnMsg = '';
  if (r.expectedTotal !== null && r.totalFound !== r.expectedTotal) {
    warnMsg = '\n\n⚠️ Ảnh ghi: ' + r.expectedTotal + ' đơn · Đọc được: ' + r.totalFound
            + ' (lệch ' + Math.abs(r.expectedTotal - r.totalFound) + ')';
  }

  let lowCount = 0, midCount = 0, highCount = 0;
  Object.values(r.confidences).forEach(c => {
    if (c == null) return;
    if (c >= 85) highCount++;
    else if (c >= 70) midCount++;
    else lowCount++;
  });
  let confMsg = '';
  if (lowCount > 0)       confMsg = '\n\n🔴 ' + lowCount + ' dải cần kiểm tra (viền đỏ)';
  else if (midCount > 0)  confMsg = '\n\n🟡 ' + midCount + ' dải nên xem lại (viền vàng)';
  else if (highCount > 0) confMsg = '\n\n🟢 ' + highCount + ' dải đọc chắc chắn';

  alert('✅ Quét xong!\n- Tab: ' + typeText
      + '\n- Ngày: ' + formatDateDisplay(r.parsedDate)
      + '\n- Tổng: ' + r.totalFound + ' đơn' + warnMsg + confMsg
      + '\n\n📷 Kéo xuống xem ẢNH GỐC để đối chiếu.');
}

// ==================== COMPARE ====================
function buildCompareText(ocrW, existingW) {
  const suffixToWeight = {
    '0_2':'w0_2','2_4':'w2_4','4_6':'w4_6','6_8':'w6_8',
    '8_10':'w8_10','10_12':'w10_12','12_15':'w12_15','over_15':'wover_15'
  };
  const labels = {
    '0_2':'>0-2kg','2_4':'>2-4','4_6':'>4-6','6_8':'>6-8',
    '8_10':'>8-10','10_12':'>10-12','12_15':'>12-15','over_15':'>15'
  };
  let diffs = [];
  let matches = 0;
  Object.keys(suffixToWeight).forEach(k => {
    const ocr = parseInt(ocrW[k], 10) || 0;
    const ex  = parseInt(existingW[suffixToWeight[k]], 10) || 0;
    if (ocr !== ex) diffs.push(`${labels[k]}: Đã lưu ${ex} ← OCR ${ocr}`);
    else if (ocr > 0 || ex > 0) matches++;
  });
  if (diffs.length === 0) return { text: `✅ Khớp hoàn toàn (${matches} dải)`, diffs: 0 };
  return {
    text: `⚠️ ${diffs.length} dải KHÁC BIỆT:\n\n${diffs.join('\n')}\n\n→ Xem ảnh gốc để đối chiếu.`,
    diffs: diffs.length
  };
}

export function openCompareModal(batchItem, existingRecord) {
  const r = batchItem.result;
  const type = r.detectedColorType === 'del'  ? 'delivery'
             : r.detectedColorType === 'pick' ? 'pickup'
             : 'return';

  openEditModal(type, existingRecord.id);

  setTimeout(() => {
    const previewBox = document.getElementById('ocrPreviewBox');
    const previewImg = document.getElementById('ocrPreviewImg');
    if (previewBox && previewImg && r.fullDataUrl) {
      previewImg.src = r.fullDataUrl;
      previewBox.style.display = 'block';
    }
    const cmp = buildCompareText(r.weights, existingRecord.weights);
    const dateStr = formatDateDisplay(r.parsedDate);
    let msg = `📊 SO SÁNH NGÀY ${dateStr}\n\n`;
    msg += `📁 Dữ liệu ĐÃ LƯU được hiển thị trong ô nhập.\n`;
    msg += `📷 Ảnh OCR được hiển thị bên dưới.\n\n`;
    msg += cmp.text;
    alert(msg);
  }, 200);
}

// ==================== BATCH MODAL ====================
export function openBatchOcrModal() {
  renderBatchList();
  document.getElementById('batchOcrModal').classList.add('active');
}

export function closeBatchOcrModal() {
  document.getElementById('batchOcrModal').classList.remove('active');
}

export function appendBatchFiles() {
  pendingAppend = true;
  document.getElementById('ocrFileInput').click();
}

function renderBatchList() {
  const list = document.getElementById('batchList');
  list.innerHTML = '';
  document.getElementById('batchCount').innerText = batchResults.length;
  if (batchResults.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">Không có ảnh nào.</div>';
    return;
  }
  const typeMap = { del: ['Giao', 'tag-delivery'], pick: ['Lấy', 'tag-pickup'], ret: ['Hoàn', 'tag-return'] };
  batchResults.forEach((item, idx) => {
    const div = document.createElement('div');
    if (item.error) {
      div.className = 'batch-item error';
      div.innerHTML = `
        <div class="batch-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px">⚠️</div>
        <div class="batch-info">
          <div class="batch-title">${escapeHtml(item.file)}</div>
          <div class="batch-meta" style="color:var(--glass-rose-text)">Lỗi: ${escapeHtml(item.error)}</div>
        </div>
        <div class="batch-actions">
          <button class="batch-btn batch-btn-remove" onclick="removeBatchItem(${idx})">✕ Bỏ</button>
        </div>`;
    } else {
      const r = item.result;
      const [typeLabel, typeClass] = typeMap[r.detectedColorType];
      let lowCount = 0, midCount = 0;
      Object.values(r.confidences).forEach(c => {
        if (c == null) return;
        if (c < 70) lowCount++;
        else if (c < 85) midCount++;
      });
      const confIcon  = lowCount > 0 ? ' 🔴' : midCount > 0 ? ' 🟡' : ' 🟢';
      const warnIcon  = (r.expectedTotal !== null && r.totalFound !== r.expectedTotal) ? ' ⚠️' : '';
      const cacheIcon = item.fromCache ? ' ⚡' : '';
      const type = r.detectedColorType === 'del' ? 'delivery' : r.detectedColorType === 'pick' ? 'pickup' : 'return';
      const existing = state.appData[type].find(rec => rec.date === r.parsedDate);
      const actionBtn = existing
        ? `<button class="batch-btn batch-btn-compare" onclick="importBatchItem(${idx})">🔍 So sánh</button>`
        : `<button class="batch-btn batch-btn-import" onclick="importBatchItem(${idx})">📝 Nhập</button>`;
      const existingBadge = existing
        ? ` <span style="font-size:9px;padding:1px 5px;border-radius:4px;background:var(--glass-amber);border:1px solid var(--glass-amber-border);color:var(--glass-amber-text);font-weight:700">Đã có</span>`
        : '';
      div.className = 'batch-item';
      div.innerHTML = `
        <img class="batch-thumb" src="${item.thumbnail}" alt="">
        <div class="batch-info">
          <div class="batch-title">
            <span class="hist-badge-tag ${typeClass}">${typeLabel}</span>
            <span>${formatDateDisplay(r.parsedDate)}${confIcon}${warnIcon}${cacheIcon}${existingBadge}</span>
          </div>
          <div class="batch-meta">${escapeHtml(item.file)}</div>
          <div class="batch-total">${r.totalFound} đơn</div>
        </div>
        <div class="batch-actions">
          ${actionBtn}
          <button class="batch-btn batch-btn-remove" onclick="removeBatchItem(${idx})">✕ Bỏ</button>
        </div>`;
    }
    list.appendChild(div);
  });
}

export function removeBatchItem(idx) {
  batchResults.splice(idx, 1);
  if (batchResults.length === 0) { closeBatchOcrModal(); return; }
  renderBatchList();
}

export function importBatchItem(idx) {
  const item = batchResults[idx];
  if (!item || item.error) return;
  const r = item.result;
  const type = r.detectedColorType === 'del'  ? 'delivery'
             : r.detectedColorType === 'pick' ? 'pickup'
             : 'return';
  const existing = state.appData[type].find(rec => rec.date === r.parsedDate);
  closeBatchOcrModal();
  if (existing) openCompareModal(item, existing);
  else fillModalFromResult(item);
  showBackToBatchBtn(true);
}

export function backToBatch() {
  if (batchResults.length === 0) {
    alert('Batch đã trống. Hãy quét ảnh mới.');
    showBackToBatchBtn(false);
    return;
  }
  const entryModal = document.getElementById('entryModal');
  if (entryModal) entryModal.classList.remove('active');
  showBackToBatchBtn(false);
  openBatchOcrModal();
}

export function showBackToBatchBtn(show) {
  const btn = document.getElementById('backToBatchBtn');
  if (btn) btn.style.display = show ? 'inline-flex' : 'none';
}

export function hasBatchPending() { return batchResults.length > 0; }

// ==================== SAVE BATCH ====================
export function saveBatchAll() {
  const valid = batchResults.filter(r => !r.error);
  if (valid.length === 0) { alert('Không có dữ liệu hợp lệ để lưu!'); return; }
  const suffixMap = {
    '0_2':'w0_2','2_4':'w2_4','4_6':'w4_6','6_8':'w6_8',
    '8_10':'w8_10','10_12':'w10_12','12_15':'w12_15','over_15':'wover_15'
  };
  function buildWeights(r) {
    const w = {};
    WEIGHT_KEYS.forEach(wk => {
      const suffix = Object.keys(suffixMap).find(k => suffixMap[k] === wk);
      w[wk] = r.weights[suffix] || 0;
    });
    return w;
  }
  function getType(r) {
    return r.detectedColorType === 'del' ? 'delivery'
         : r.detectedColorType === 'pick' ? 'pickup' : 'return';
  }
  const seenInBatch = new Set();
  const dedupedBatch = [];
  let dupInBatch = 0;
  valid.forEach(item => {
    const r = item.result;
    const key = getType(r) + '|' + r.parsedDate;
    if (seenInBatch.has(key)) { dupInBatch++; return; }
    seenInBatch.add(key);
    dedupedBatch.push(item);
  });
  const finalList = [];
  let dupExisting = 0;
  dedupedBatch.forEach(item => {
    const r = item.result;
    const type = getType(r);
    const existing = state.appData[type].find(rec => rec.date === r.parsedDate);
    if (existing) { dupExisting++; return; }
    finalList.push({ item, type, weights: buildWeights(r) });
  });
  const totalSkipped = dupInBatch + dupExisting;
  if (finalList.length === 0) {
    let msg = '⚠️ Không có gì để lưu!\n';
    if (dupInBatch > 0)  msg += `\n• ${dupInBatch} ảnh trùng trong batch`;
    if (dupExisting > 0) msg += `\n• ${dupExisting} ảnh đã có ngày tồn tại trong Nhật ký`;
    msg += '\n\n💡 Bấm "🔍 So sánh" để đối chiếu.';
    alert(msg);
    return;
  }
  let confirmMsg = `Lưu ${finalList.length} bản ghi mới?`;
  if (totalSkipped > 0) {
    confirmMsg += `\n\n⚠️ Bỏ qua ${totalSkipped} ảnh:`;
    if (dupInBatch > 0)  confirmMsg += `\n  • ${dupInBatch} ảnh trùng trong batch`;
    if (dupExisting > 0) confirmMsg += `\n  • ${dupExisting} ảnh đã có ngày (giữ data cũ)`;
  }
  if (!confirm(confirmMsg)) return;
  finalList.forEach(({ item, type, weights }) => {
    state.appData[type].unshift({ id: generateId(), date: item.result.parsedDate, weights });
  });
  batchResults = [];
  showBackToBatchBtn(false);
  closeBatchOcrModal();
  updateAllViews();
  let doneMsg = `✅ Đã lưu ${finalList.length} bản ghi!`;
  if (totalSkipped > 0) doneMsg += `\n(Đã bỏ qua ${totalSkipped} ảnh)`;
  alert(doneMsg);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// ==================== HIGHLIGHT ====================
export function applyConfidenceHighlight(confMap, detectedType) {
  const prefix = detectedType === 'del' ? 'del_inp'
               : detectedType === 'pick' ? 'pick_inp' : 'ret_inp';
  const keys = ['0_2','2_4','4_6','6_8','8_10','10_12','12_15','over_15'];
  keys.forEach(k => {
    const input = document.getElementById(prefix + '_' + k);
    if (!input) return;
    input.classList.remove('conf-high', 'conf-mid', 'conf-low');
    const parent = input.closest('.weight-input-item');
    if (parent) {
      const old = parent.querySelector('.conf-badge');
      if (old) old.remove();
    }
    if (confMap[k] == null) return;
    const conf = confMap[k];
    const level = conf >= 85 ? 'high' : conf >= 70 ? 'mid' : 'low';
    input.classList.add('conf-' + level);
    if (parent) {
      const badge = document.createElement('span');
      badge.className = 'conf-badge ' + level;
      badge.textContent = Math.round(conf) + '%';
      parent.appendChild(badge);
    }
  });
}

export function clearAllConfidenceHighlights() {
  const prefixes = ['del_inp', 'pick_inp', 'ret_inp'];
  const keys = ['0_2','2_4','4_6','6_8','8_10','10_12','12_15','over_15'];
  prefixes.forEach(pfx => keys.forEach(k => {
    const input = document.getElementById(pfx + '_' + k);
    if (!input) return;
    input.classList.remove('conf-high', 'conf-mid', 'conf-low');
    const parent = input.closest('.weight-input-item');
    if (parent) {
      const badge = parent.querySelector('.conf-badge');
      if (badge) badge.remove();
    }
  }));
}

export function openOcrLightbox() {
  const src = document.getElementById('ocrPreviewImg').src;
  if (!src) return;
  document.getElementById('ocrLightboxImg').src = src;
  document.getElementById('ocrLightbox').classList.add('active');
}
export function closeOcrLightbox() {
  document.getElementById('ocrLightbox').classList.remove('active');
}
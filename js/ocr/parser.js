import { getTodayIso, isValidIsoDate } from '../utils.js';

const RANGE_DEFS = [
  { key: '0_2',     min: 0,  max: 2 }, { key: '2_4',     min: 2,  max: 4 },
  { key: '4_6',     min: 4,  max: 6 }, { key: '6_8',     min: 6,  max: 8 },
  { key: '8_10',    min: 8,  max: 10 }, { key: '10_12',   min: 10, max: 12 },
  { key: '12_15',   min: 12, max: 15 }, { key: 'over_15', min: 15, max: 999 }
];

export function identifyRangeKey(minV, maxV) {
  for (const d of RANGE_DEFS) { if (d.min === minV && d.max === maxV) return d.key; }
  // Fallback: OCR đọc sai số cuối của dải (vd "12 - 16"). Chỉ chấp nhận khi hai số cách nhau
  // hợp lý (≤ 4), tránh nhận nhầm các cặp số cách xa nhau thành dải cân.
  const span = maxV - minV;
  const plausible = (span >= 1 && span <= 4) || (minV === 15 && maxV >= 15);
  if (!plausible) return null;
  const hit = RANGE_DEFS.find(d => d.min === minV);
  return hit ? hit.key : null;
}

export function parseOcrText(cleanText) {
  const weights = { '0_2':0,'2_4':0,'4_6':0,'6_8':0,'8_10':0,'10_12':0,'12_15':0,'over_15':0 };
  const confidences = {};
  
  // FIX 1: Thêm Ì, Í vào replace (OCR đọc số 1 thành Ì)
  const text = cleanText
    .replace(/[–—]/g, '-')
    .replace(/,/g, '.')
    .replace(/[¡ÌÍ]/g, '1')
    .split('\n')
    .filter(line => {
      if (/\b\d{1,2}:\d{2}\b/.test(line)) return false;
      if (/^\s*\d{4,}/.test(line)) return false;
      if (/Ch[iỉ]\s*ti[eế]t/i.test(line)) return false;
      return true;
    })
    .join('\n');

  const totalRegex = /T[oôổ]ng\s*[:\-]?\s*(\d{1,6})/i;
  const totalMatch = text.match(totalRegex);
  let expectedTotal = totalMatch ? parseInt(totalMatch[1], 10) : null;
  if (!Number.isFinite(expectedTotal)) expectedTotal = null;

  const rangeRegex = /(\d{1,3})(?:[.,]\d{1,3})?\s*[-–~]\s*(\d{1,6})(?:[.,]\d{1,3})?/g;
  const ranges = [];
  let m;
  while ((m = rangeRegex.exec(text)) !== null) {
    // Số có số 0 đứng đầu ("06-10") là ngày/tháng chứ không phải dải cân
    if (/^0\d/.test(m[1]) || /^0\d/.test(m[2])) continue;
    const minV = parseInt(m[1], 10);
    const maxV = parseInt(m[2], 10);
    const key = identifyRangeKey(minV, maxV);
    if (key) ranges.push({ key, pos: m.index, endPos: m.index + m[0].length });
  }
  ranges.sort((a, b) => a.pos - b.pos);

  const totalPos = totalMatch ? totalMatch.index : -1;
  const totalEnd = totalMatch ? totalMatch.index + totalMatch[0].length : -1;

  // FIX 2: donRegex accept ¡ Ì Í l I | khi đứng trước "Đơn"
  const donNums = [];
  const donRegex = /([\d¡ÌÍlI|]{1,5})\s*[ĐDđdB]\s*[ơo]n\b/gi;
  while ((m = donRegex.exec(text)) !== null) {
    if (!/[ĐDB]/.test(m[0])) continue; // chữ thường = dòng "Tổng N đơn hàng", không phải thẻ
    const cleaned = m[1].replace(/[¡ÌÍlI|]/g, '1');
    const val = parseInt(cleaned, 10);
    if (!Number.isFinite(val)) continue;
    const pos = m.index;
    const endPos = pos + m[0].length;
    if (ranges.some(r => pos < r.endPos && endPos > r.pos)) continue;
    if (totalPos >= 0 && pos < totalEnd && endPos > totalPos) continue;
    if (val > 99999) continue;
    donNums.push({ value: val, pos, endPos });
  }
  donNums.sort((a, b) => a.pos - b.pos);

  const nums = [];
  const numRegex = /\d{1,6}/g;
  while ((m = numRegex.exec(text)) !== null) {
    const val = parseInt(m[0], 10);
    const pos = m.index;
    const endPos = pos + m[0].length;
    if (ranges.some(r => pos < r.endPos && endPos > r.pos)) continue;
    if (totalPos >= 0 && pos >= totalPos && pos <= totalEnd + 3) continue;
    if (val === 0) continue;
    if (val > 99999) continue;
    // FIX 3: Bỏ số dính chữ (h2, ab3) — nhưng CHO PHÉP nếu ký tự trước là "h" và theo sau là "Đơn"
    if (pos > 0 && /[A-Za-zÀ-ỹ]/.test(text[pos - 1])) {
      const beforeChar = text[pos - 1];
      const afterText = text.slice(endPos, endPos + 12);
      if (!/[hH]/.test(beforeChar) || !/[ĐDđd]\s*[ơo]n/i.test(afterText)) continue;
    }
    nums.push({ value: val, pos, endPos });
  }
  nums.sort((a, b) => a.pos - b.pos);

  function distanceMatch(numList, mode) {
    const result = {};
    const used = new Set();
    ranges.forEach(r => {
      let best = null, bestDist = 9999;
      numList.forEach((n, idx) => {
        if (used.has(idx)) return;
        let dist;
        if (mode === 'before') { if (n.endPos > r.pos) return; dist = r.pos - n.endPos; }
        else if (mode === 'after') { if (n.pos < r.endPos) return; dist = n.pos - r.endPos; }
        else { dist = Math.min(Math.abs(n.pos - r.pos), Math.abs(n.endPos - r.endPos)); }
        if (dist < bestDist && dist < 800) { bestDist = dist; best = { idx, value: n.value }; }
      });
      if (best) { result[r.key] = best.value; used.add(best.idx); }
    });
    return result;
  }

  const orderedResult = {};
  for (let i = 0; i < ranges.length && i < nums.length; i++) orderedResult[ranges[i].key] = nums[i].value;

  const sumOf = r => Object.values(r).reduce((a, b) => a + b, 0);
  const countOf = r => Object.keys(r).length;

  const donResult = distanceMatch(donNums, 'closest');
  const donOrdered = {};
  if (donNums.length === ranges.length) ranges.forEach((r, i) => { donOrdered[r.key] = donNums[i].value; });
  
  const mClosest = distanceMatch(nums, 'closest');
  const mBefore  = distanceMatch(nums, 'before');
  const mAfter   = distanceMatch(nums, 'after');

  const candidates = [
    { name: 'don-ordered', res: donOrdered,    cnt: countOf(donOrdered),    priority: 0 },
    { name: 'don-pattern', res: donResult,     cnt: countOf(donResult),     priority: 1 },
    { name: 'closest',     res: mClosest,      cnt: countOf(mClosest),      priority: 2 },
    { name: 'ordered',     res: orderedResult, cnt: countOf(orderedResult), priority: 3 },
    { name: 'before',      res: mBefore,       cnt: countOf(mBefore),       priority: 4 },
    { name: 'after',       res: mAfter,        cnt: countOf(mAfter),        priority: 5 }
  ];

  candidates.forEach(c => { c.diff = expectedTotal !== null ? Math.abs(sumOf(c.res) - expectedTotal) : 0; });
  candidates.sort((a, b) => {
    if (a.diff !== b.diff) return a.diff - b.diff;
    if (expectedTotal === null && a.cnt !== b.cnt) return b.cnt - a.cnt;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.cnt - a.cnt;
  });

  const best = candidates[0];
  let baseConf = 88;
  if (best.diff === 0) baseConf = 95;
  else if (best.diff <= 2) baseConf = 92;

  Object.keys(best.res).forEach(k => { weights[k] = best.res[k]; confidences[k] = baseConf; });

  const totalFound = Object.values(weights).reduce((a, b) => a + b, 0);
  return { weights, confidences, expectedTotal, totalFound, mode: best.name };
}

export function postProcessFixDigits(parsed) {
  if (parsed.expectedTotal === null || parsed.totalFound === parsed.expectedTotal) return null;

  const SUBS = [
    { from: '3', to: '9' }, { from: '2', to: '9' }, { from: '1', to: '7' },
    { from: '8', to: '6' }, { from: '6', to: '5' }, { from: '8', to: '3' }
  ];

  const keys = ['0_2', '2_4', '4_6', '6_8', '8_10', '10_12', '12_15', 'over_15'];
  const ordered = ['0_2', ...keys.filter(k => k !== '0_2')];

  for (const strictMode of [true, false]) {
    const solutions = new Map();
    for (const key of ordered) {
      const oldVal = parsed.weights[key];
      if (!oldVal || oldVal === 0) continue;
      const str = String(oldVal);
      for (let i = 0; i < str.length; i++) {
        for (const s of SUBS) {
          if (str[i] !== s.from) continue;
          const newVal = parseInt(str.substring(0, i) + s.to + str.substring(i + 1), 10);
          if (!Number.isFinite(newVal)) continue;
          const ratio = newVal / Math.max(1, oldVal);
          if (strictMode && ratio > 3) continue;
          const newTotal = parsed.totalFound - oldVal + newVal;
          if (newTotal !== parsed.expectedTotal) continue;
          const id = key + ':' + newVal;
          if (solutions.has(id)) continue;
          solutions.set(id, {
            weights: { ...parsed.weights, [key]: newVal },
            confidences: { ...parsed.confidences, [key]: 75 },
            expectedTotal: parsed.expectedTotal, totalFound: newTotal,
            mode: parsed.mode + '+fix' + s.from + s.to,
            fixInfo: { key, oldVal, newVal, from: s.from, to: s.to, delta: newVal - oldVal, isRisky: ratio > 3 }
          });
        }
      }
    }
    if (solutions.size === 1) return [...solutions.values()][0];
    if (solutions.size > 1) { console.warn('[OCR] Nhiều cách sửa số đều khớp tổng → không tự sửa'); return null; }
  }
  return null;
}

function _pad2(n) { return String(n).padStart(2, '0'); }

function _buildDateIso(day, month, year) {
  let y = year;
  if (y === undefined) {
    y = new Date().getFullYear();
    if (`${y}-${_pad2(month)}-${_pad2(day)}` > getTodayIso()) y -= 1;
  }
  const iso = `${y}-${_pad2(month)}-${_pad2(day)}`;
  return isValidIsoDate(iso) ? iso : null;
}

export function extractDateStrict(text) {
  const cleanText = text.replace(/,/g, '.');
  const isDigit = ch => ch !== undefined && ch >= '0' && ch <= '9';
  const endOf = m => m.index + m[0].length;

  for (const im of cleanText.matchAll(/(20\d{2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/g)) {
    if (isDigit(cleanText[endOf(im)])) continue;
    const iso = _buildDateIso(parseInt(im[3], 10), parseInt(im[2], 10), parseInt(im[1], 10));
    if (iso) return iso;
  }
  for (const fm of cleanText.matchAll(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4}|\d{2})/g)) {
    if (isDigit(cleanText[fm.index - 1])) continue;
    const day = parseInt(fm[1], 10), month = parseInt(fm[2], 10);
    let year = parseInt(fm[3], 10);
    if (year < 100) year += 2000;
    if (year < 2020 || year > 2099) continue;
    const iso = _buildDateIso(day, month, year);
    if (iso) return iso;
  }
  const dayMatch = cleanText.match(/(?:ngày|ngay)\s*[-–:]?\s*(\d{1,2})[\/\-\.](\d{1,2})/i);
  if (dayMatch) {
    const iso = _buildDateIso(parseInt(dayMatch[1], 10), parseInt(dayMatch[2], 10));
    if (iso) return iso;
  }
  for (const m of cleanText.matchAll(/(\d{1,2})([\/\-\.])(\d{1,2})/g)) {
    if (isDigit(cleanText[m.index - 1]) || isDigit(cleanText[endOf(m)])) continue;
    const day = parseInt(m[1], 10), month = parseInt(m[3], 10);
    const noLeadingZero = m[1] === String(day) && m[3] === String(month);
    if (m[2] === '-' && noLeadingZero && RANGE_DEFS.some(d => d.min === day && d.max === month)) continue;
    const iso = _buildDateIso(day, month);
    if (iso) return iso;
  }
  return null;
}

export function extractDate(text) {
  return extractDateStrict(text) || getTodayIso();
}
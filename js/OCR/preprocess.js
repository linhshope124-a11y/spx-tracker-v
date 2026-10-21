import { MAX_CANVAS_PX } from '../config.js';
import { checkAborted } from './worker.js';

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

export async function preprocessImage(rawDataUrl, options = {}, signal) {
  checkAborted(signal);
  const { upscale = 2.0, useOtsu = true, threshold = 145, raw = false } = options;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        checkAborted(signal);
        let scale = Math.min(4, upscale);
        const srcPx = img.width * img.height;
        if (srcPx * scale * scale > MAX_CANVAS_PX) scale = Math.sqrt(MAX_CANVAS_PX / srcPx);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.floor(img.width  * scale);
        canvas.height = Math.floor(img.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;

        if (raw) {
          for (let i = 0; i < data.length; i += 4) {
            const g = Math.round(data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
            data[i] = data[i+1] = data[i+2] = g;
          }
        } else {
          const gray = new Uint8Array(data.length / 4);
          for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            gray[j] = Math.round(data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
          }
          const th = useOtsu ? otsuThreshold(gray) : threshold;
          for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            const val = gray[j] > th ? 255 : 0;
            data[i] = data[i+1] = data[i+2] = val;
            data[i+3] = 255;
          }
        }

        ctx.putImageData(imgData, 0, 0);
        const out = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
        canvas.width = canvas.height = 0;
        resolve(out);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = rawDataUrl;
  });
}
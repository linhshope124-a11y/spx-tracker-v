// ==================== PHÁT HIỆN TAB ====================
// Tìm thanh chỉ báo màu cam (orange indicator) của tab đang active.
//
// Cải tiến so với bản cũ:
//   1. Quét Y = 8% → 35% (bỏ status bar + header title, lấy vùng tab bar + buffer)
//   2. Tìm HÀNG có nhiều pixel cam nhất (tab underline là dải NGANG ~2-4px)
//      thay vì chỉ tìm cột có mật độ cam cao nhất → tránh nhầm với chữ "Tổng: 92"
//   3. Chia X thành 3 phần đều (33% / 33% / 33%) — tương ứng Giao | Lấy | Hoàn
//   4. Ghi diagnostic vào window.__spxLastTabDetect để debug
export function detectActiveTabByOrangeLine(imageSource) {
  if (typeof window !== 'undefined') window.__spxLastTabDetect = null;

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const W = img.width, H = img.height;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Vùng quét Y: 8% → 35%
        const yStart = Math.floor(H * 0.08);
        const yEnd   = Math.floor(H * 0.35);
        const scanH  = Math.max(1, yEnd - yStart);
        const data = ctx.getImageData(0, yStart, W, scanH).data;

        const isOrange = (r, g, b) =>
          r > 200 && g >= 40 && g <= 160 && b <= 110 && (r - g) > 60;

        // Đếm pixel cam theo HÀNG (tìm tab underline) và tổng
        const rowCount = new Array(scanH).fill(0);
        let totalOrange = 0;

        for (let y = 0; y < scanH; y++) {
          let rowOr = 0;
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (isOrange(data[i], data[i + 1], data[i + 2])) {
              rowOr++;
              totalOrange++;
            }
          }
          rowCount[y] = rowOr;
        }

        if (totalOrange < 30) { resolve(null); return; }

        // Tìm HÀNG nhiều cam nhất & đủ rộng (>= 15% W) → coi là underline
        const minRowWidth = W * 0.15;
        let bestRow = -1, bestRowCount = 0;
        for (let y = 0; y < scanH; y++) {
          if (rowCount[y] > bestRowCount && rowCount[y] >= minRowWidth) {
            bestRowCount = rowCount[y];
            bestRow = y;
          }
        }

        let centerX;
        let method;

        if (bestRow === -1) {
          // Không thấy underline rõ → fallback về peak theo cột (giữ khả năng
          // detect cho UI có nền cam khối — vd tab active tô nền cam)
          method = 'column-peak';
          const colCount = new Array(W).fill(0);
          for (let y = 0; y < scanH; y++) {
            for (let x = 0; x < W; x++) {
              const i = (y * W + x) * 4;
              if (isOrange(data[i], data[i + 1], data[i + 2])) colCount[x]++;
            }
          }
          const winSize = 60;
          let maxSum = 0, bestCenter = 0;
          for (let x = 0; x < W; x++) {
            let sum = 0;
            const l = Math.max(0, x - winSize);
            const r = Math.min(W - 1, x + winSize);
            for (let k = l; k <= r; k++) sum += colCount[k];
            if (sum > maxSum) { maxSum = sum; bestCenter = x; }
          }
          centerX = bestCenter;
        } else {
          // Có underline rõ → dải bestRow ±3, tính trung bình có trọng số theo X
          method = 'row-band';
          const bandTop = Math.max(0, bestRow - 3);
          const bandBot = Math.min(scanH - 1, bestRow + 3);
          let sumW = 0, sumWX = 0;
          for (let x = 0; x < W; x++) {
            let c = 0;
            for (let y = bandTop; y <= bandBot; y++) {
              const i = (y * W + x) * 4;
              if (isOrange(data[i], data[i + 1], data[i + 2])) c++;
            }
            sumW += c;
            sumWX += x * c;
          }
          centerX = sumW > 0 ? sumWX / sumW : W / 2;
        }

        // Chia 3 phần đều: < 33% = Giao, < 66% = Lấy, >= 66% = Hoàn
        const rel = centerX / W;
        let tab;
        if (rel < 0.33) tab = 'del';
        else if (rel < 0.66) tab = 'pick';
        else tab = 'ret';

        // Diagnostic — đọc được từ console hoặc "Xem log" trong modal OCR
        if (typeof window !== 'undefined') {
          window.__spxLastTabDetect = {
            imgW: W, imgH: H,
            yScan: [yStart, yEnd],
            bestRow: bestRow === -1 ? null : yStart + bestRow,
            bestRowCount,
            minRowWidth: Math.round(minRowWidth),
            totalOrange,
            centerX: Math.round(centerX),
            relPct: +(rel * 100).toFixed(1),
            method,
            tab
          };
        }
        resolve(tab);
      } catch (e) {
        console.warn('[OCR] detectActiveTab error:', e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageSource;
  });
}
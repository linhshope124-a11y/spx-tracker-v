// =============================================================
// SPX Tracker — Service Worker
// Cache: app shell (CACHE) + Tesseract (TESS_CACHE) + Share Target
//
// ⚠️ MỖI LẦN SỬA FILE TRONG CORE → BUMP CACHE VERSION
//    - spx-tracker-v2 → spx-tracker-v2.1 → ... → spx-tracker-v2.3   (tests/repo.test.mjs kiểm tra khớp với version.json)
//    - TESS_CACHE và SHARE_CACHE KHÔNG cần bump (dữ liệu không đổi)
// =============================================================

const CACHE       = 'spx-tracker-v2.4';    // v2.3 (đồng bộ version.json)
const TESS_CACHE  = 'spx-tesseract-v1';    // giữ nguyên — Tesseract không đổi
const SHARE_CACHE = 'spx-shared-files';    // giữ nguyên — dữ liệu tạm

const CORE = [
  './',
  './index.html',
  './guide.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './css/style.css',
  './js/main.js',
  './js/config.js',
  './js/utils.js',
  './js/state.js',
  './js/calc.js',
  './js/theme.js',
  './js/ocr.js',
  './js/ocr-cache.js',
  './js/sw-bridge.js',
  './js/ui.js',
  './js/render.js',
  './js/entry.js',
  './js/backup.js',
  './js/cloud.js',
  './js/error-handler.js',   // ⭐ Phase 4 — thay cho undo.js đã xóa
  './js/dialog.js'
];

// ==================== TESSERACT RUNTIME URLs ====================
// Chỉ precache thư viện chính + dữ liệu tiếng Việt khi user bấm 📷 lần đầu.
// Worker + core KHÔNG precache theo URL cố định: Tesseract tự gọi URL có phiên bản đầy đủ
// (vd tesseract.js@v5.x.x/...) nên URL "@5" cố định sẽ không bao giờ khớp. Thay vào đó mọi URL
// thuộc TESS_URL_PREFIXES được cache lúc chạy (lần OCR online đầu tiên) → các lần sau chạy offline.
const TESS_RUNTIME_URLS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',   // phải trùng TESSERACT_LIB_URL trong ocr.js
  'https://tessdata.projectnaptha.com/4.0.0/vie.traineddata.gz'
];
const TESS_URL_PREFIXES = [
  'https://cdn.jsdelivr.net/npm/tesseract.js',   // gồm cả tesseract.js@… và tesseract.js-core@…
  'https://tessdata.projectnaptha.com/'
];

// ==================== INSTALL ====================
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE))
    // KHÔNG skipWaiting — chờ user bấm "Cập nhật"
  );
});

// ==================== ACTIVATE ====================
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE && k !== TESS_CACHE && k !== SHARE_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({
            type: 'SW_UPDATED',
            version: CACHE
          }));
        });
      })
  );
});

// ==================== MESSAGE ====================
self.addEventListener('message', e => {
  const data = e.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // 📷 Precache Tesseract khi user thực sự dùng OCR
  if (data.type === 'PRECACHE_TESSERACT') {
    e.waitUntil(
      caches.open(TESS_CACHE).then(async cache => {
        const results = await Promise.allSettled(
          TESS_RUNTIME_URLS.map(async url => {
            const existing = await cache.match(url);
            if (existing) return 'cached';
            try {
              const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
              if (res.ok) {
                await cache.put(url, res.clone());
                return 'fetched';
              }
              return 'failed:' + res.status;
            } catch (err) {
              return 'error:' + err.message;
            }
          })
        );
        return results.map(r => r.value || r.reason);
      })
    );
  }
});

// ==================== SHARE TARGET ====================
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const rawFiles = formData.getAll('images');
    const files = rawFiles.filter(f =>
      f && typeof f === 'object' && typeof f.size === 'number' && f.size > 0
    );

    const cache = await caches.open(SHARE_CACHE);
    const oldKeys = await cache.keys();
    await Promise.all(oldKeys.map(k => cache.delete(k)));

    if (files.length > 0) {
      const meta = {
        count: files.length,
        names: files.map(f => f.name || `shared_${Date.now()}.jpg`),
        types: files.map(f => f.type || 'image/jpeg'),
        savedAt: Date.now()
      };

      await cache.put(
        new Request('./spx-shared-meta'),
        new Response(JSON.stringify(meta), {
          headers: { 'Content-Type': 'application/json' }
        })
      );

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        await cache.put(
          new Request(`./spx-shared-file-${i}`),
          new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' }
          })
        );
      }

      console.log(`[SW] Share target: đã lưu ${files.length} file`);
    }
  } catch (e) {
    console.warn('[SW] Share target error:', e);
  }

  const redirectUrl = new URL('index.html?shared=1', self.registration.scope).href;
  return Response.redirect(redirectUrl, 303);
}

// ==================== STATIC DETECT ====================
function _isStaticAsset(pathname) {
  if (pathname.endsWith('/version.json')) return false;
  return /\.(html|css|js|png|jpg|jpeg|svg|webp|gif|ico|woff|woff2|ttf|otf)$/i.test(pathname);
}

function _isTesseractUrl(url) {
  return TESS_URL_PREFIXES.some(p => url.startsWith(p));
}

// ==================== FETCH ====================
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // POST /share-target
  if (req.method === 'POST') {
    if (url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
      e.respondWith(handleShareTarget(req));
    }
    return;
  }

  if (req.method !== 'GET') return;

  // ===== Tesseract URLs (cross-origin) =====
  // Cache-first từ TESS_CACHE. Nếu chưa có → fetch rồi cache.
  if (_isTesseractUrl(req.url)) {
    e.respondWith(
      caches.open(TESS_CACHE).then(async cache => {
        const cached = await cache.match(req.url);
        if (cached) return cached;
        try {
          // importScripts() trong worker gửi request kiểu no-cors → phản hồi 'opaque' (không cache được).
          // Gọi lại bằng CORS (jsdelivr / tessdata đều cho phép) để có phản hồi cache được,
          // rồi trả chính phản hồi đó cho trang — dùng được cho cả request no-cors.
          const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
          if (res && res.status === 200) {
            cache.put(req.url, res.clone()).catch(() => {});
          }
          return res;
        } catch (err) {
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // ===== Same-origin requests =====
  if (url.origin !== self.location.origin) return;

  // version.json → luôn network (no-store)
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Static assets → cache-first
  if (_isStaticAsset(url.pathname)) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(cached => {
        if (cached) return cached;
        return fetch(req)
          .then(res => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Còn lại → network-first
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
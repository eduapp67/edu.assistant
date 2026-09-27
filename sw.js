/* ============================================================
   EDU ASSISTANT — Service Worker
   - Mở được app khi mất mạng (lưu sẵn "vỏ" ứng dụng).
   - File của app (HTML/JS/CSS): ưu tiên mạng → luôn lấy bản mới
     nhất khi có mạng, mất mạng thì dùng bản đã lưu.
   - Font và thư viện Firebase (link có số phiên bản cố định):
     ưu tiên bản đã lưu cho nhanh.
   - KHÔNG can thiệp các yêu cầu tới Firestore/đăng nhập — phần đó
     Firebase tự đệm và tự đồng bộ.
   Khi sửa app: tăng CACHE_VERSION để máy người dùng nhận bản mới.
============================================================ */
const CACHE_VERSION = 'edu-assistant-v1.0.1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const CACHE_FIRST_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(()=> self.skipWaiting())
  );
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))))
      .then(()=> self.clients.claim())
  );
});

self.addEventListener('fetch', (event)=>{
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // Tài nguyên cùng tên miền (file của app): mạng trước, mất mạng thì dùng bản lưu
  if(url.origin === self.location.origin){
    event.respondWith(networkFirst(req));
    return;
  }
  // Font + thư viện Firebase: bản lưu trước
  if(CACHE_FIRST_HOSTS.includes(url.hostname)){
    event.respondWith(cacheFirst(req));
  }
  // Còn lại (Firestore, đăng nhập...) để trình duyệt tự xử lý
});

async function networkFirst(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const res = await fetch(req);
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }catch(e){
    const cached = await cache.match(req, {ignoreSearch:true});
    if(cached) return cached;
    if(req.mode === 'navigate') return cache.match('./index.html');
    throw e;
  }
}

async function cacheFirst(req){
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if(cached) return cached;
  const res = await fetch(req);
  if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

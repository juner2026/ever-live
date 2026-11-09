/* Ever · 网页版 PWA 的 service worker（8.49 新增）
   ------------------------------------------------------------------
   目的（就三条）：
     1. 打开秒进：ever.html 是 17MB 单文件，每次从局域网/网络重下太浪费 —— 命中缓存直接给；
     2. 装得像 App：Chrome 要求「有 SW + fetch 处理 + 方图标」才允许安装（WebAPK）；
     3. 断网也能看手帐（已经加载过的部分）。

   策略：
     · 导航 / ever.html  → stale-while-revalidate（先用缓存秒开，后台拉新版更新缓存）
     · 图片/字体/css/js  → cache-first（这些基本不变）
     · 其它              → 照常走网络

   发新版时：把 VER 里的版本号改掉（旧缓存会在 activate 时清掉）。
   注意：SW 只在 https 或 localhost 生效；局域网 http://192.168.x.x 会静默不注册。
*/
const VER = 'ever-852'
const PRECACHE = [
  './',
  './ever.html',
  './manifest.webmanifest',
  './aset/pwa/icon-192.png',
  './aset/pwa/icon-512.png',
  './aset/pwa/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    /* 逐个加，任何一个失败都不该让整个安装废掉（17MB 那个最容易超时） */
    await Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (x) { return; }
  if (u.origin !== self.location.origin) return;   /* 第三方接口一律不碰 */

  const isPage = req.mode === 'navigate' ||
                 u.pathname.endsWith('/') ||
                 u.pathname.endsWith('/ever.html') ||
                 u.pathname.endsWith('/index.html');

  if (isPage) {
    e.respondWith((async () => {
      const c = await caches.open(VER);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((r) => {
        if (r && r.ok) c.put(req, r.clone()).catch(() => {});
        return r;
      }).catch(() => null);
      return hit || (await net) || new Response('离线，且这台设备还没缓存过页面。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  if (/\.(png|jpe?g|webp|gif|svg|woff2?|ttf|otf|css|js)$/i.test(u.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(VER);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && r.ok) c.put(req, r.clone()).catch(() => {});
        return r;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
  }
});

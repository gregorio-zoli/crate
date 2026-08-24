/* Crate - service worker
   Fa due cose:
   1. tiene l'app usabile offline (cache dello shell)
   2. intercetta le condivisioni da Android e passa l'immagine alla pagina  */

const V = 'crate-v45';
const SHARE_CACHE = 'crate-share';
const MODEL_CACHE = 'crate-modelli';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== V && k !== SHARE_CACHE && k !== MODEL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* --- ricezione di una condivisione dal sistema --- */
async function handleShare(request) {
  const cache = await caches.open(SHARE_CACHE);
  let payload = { text: '', url: '', title: '', count: 0 };
  try {
    const fd = await request.formData();
    payload.title = fd.get('title') || '';
    payload.text = fd.get('text') || '';
    payload.url = fd.get('url') || '';
    // dalla galleria si possono selezionare piu screenshot: li prendo tutti
    const isImg = v => v && typeof v === 'object' && v.size &&
      (String(v.type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(v.name || ''));
    const files = fd.getAll('image').filter(isImg);
    if (!files.length) {
      // alcune app usano un nome di campo diverso: passo in rassegna tutto
      for (const v of fd.values()) if (isImg(v)) files.push(v);
    }
    for (let i = 0; i < files.length; i++) {
      await cache.put('shared-image-' + i, new Response(files[i], {
        headers: { 'Content-Type': files[i].type || 'image/png' }
      }));
    }
    payload.count = files.length;
  } catch (err) { /* condivisione malformata: si apre l'app normalmente */ }
  await cache.put('shared-meta', new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  }));
  // URL assoluto: Response.redirect e' pignolo sui relativi
  return Response.redirect(new URL('./?shared=1', self.location).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  // Modelli e runtime del secondo motore OCR: pesano qualche MB e vengono da
  // un CDN. Li tengo in cache a parte, cosi' dal secondo uso in poi la lettura
  // parte subito e funziona anche senza rete.
  if (url.origin !== self.location.origin) {
    if (/ppu-paddle-ocr|onnxruntime|\.onnx($|\?)|\.wasm($|\?)|ppocr.*dict/i.test(req.url)) {
      e.respondWith((async () => {
        const c = await caches.open(MODEL_CACHE);
        const hit = await c.match(req);
        if (hit) return hit;
        const fresh = await fetch(req);
        if (fresh && (fresh.ok || fresh.type === 'opaque')) c.put(req, fresh.clone());
        return fresh;
      })());
    }
    return;
  }

  // niente cache per la sincronizzazione o per i dati
  if (url.pathname.endsWith('.json') && !url.pathname.endsWith('manifest.json')) return;

  // navigazioni e shell: rete prima, cache se offline
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const c = await caches.open(V);
        c.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/* Crate - service worker
   Fa due cose:
   1. tiene l'app usabile offline (cache dello shell)
   2. intercetta le condivisioni da Android e passa l'immagine alla pagina  */

const V = 'crate-v119';
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
  // "campi" e' il verbale di quello che Android ha effettivamente mandato.
  // Se non riconosco nessuna immagine, la pagina lo mostra invece di restare
  // ferma senza spiegazioni: senza questo si puo' solo tirare a indovinare.
  // Firmo il verbale con la mia versione e con l'ora. La versione serve
  // perche' sw.js si aggiorna per conto suo e puo' restare indietro rispetto
  // alla pagina: senza la firma non si sa chi ha gestito la condivisione.
  // L'ora serve alla pagina per non ripescare una condivisione di ieri.
  let payload = { text: '', url: '', title: '', count: 0, campi: [],
                  sw: V, quando: Date.now(),
                  tipo: request.headers.get('content-type') || '' };
  try {
    const fd = await request.formData();
    payload.title = fd.get('title') || '';
    payload.text = fd.get('text') || '';
    payload.url = fd.get('url') || '';
    // dalla galleria si possono selezionare piu screenshot: li prendo tutti
    const isImg = v => v && typeof v === 'object' && v.size &&
      (String(v.type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(v.name || ''));
    for (const [k, v] of fd.entries()) {
      payload.campi.push(k + ': ' + (v && typeof v === 'object'
        ? ((v.type || 'tipo ignoto') + ', ' + (v.size || 0) + ' byte')
        : 'testo'));
    }
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
  } catch (err) {
    payload.errore = String((err && err.message) || err || 'errore sconosciuto');
  }
  await cache.put('shared-meta', new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  }));
  // URL assoluto: Response.redirect e' pignolo sui relativi
  return Response.redirect(new URL('./?shared=1', self.location).href, 303);
}

// La pagina chiede "che versione sei?": e' l'unico modo per sapere quale
// service worker sta davvero rispondendo, e quindi se e' aggiornato.
self.addEventListener('message', e => {
  if (e.data === 'versione' && e.source && e.source.postMessage) {
    e.source.postMessage({ crateSw: V });
  }
});

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
  //
  // GitHub Pages dice al browser di tenersi la pagina per dieci minuti. Con la
  // rete disponibile la richiesta finiva nella cache del browser e tornava
  // indietro la versione vecchia: l'app restava ferma a un numero di versione
  // superato pur essendo online. Per la pagina chiedo esplicitamente una
  // verifica al server, che costa una richiesta condizionale e niente piu'.
  const eShell = req.mode === 'navigate' ||
    url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  e.respondWith((async () => {
    try {
      const fresh = await fetch(eShell
        ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        : req);
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

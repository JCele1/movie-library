/* Movie Check UPC lookup (Cloudflare Worker), v3.
   GET /?upc=<8-14 digits>  ->  {found, upc, title, brand, rawTitle, formats[], images[], source}
   Sources, tried in order until one finds the barcode (all free, no keys):
     1. UPCitemdb trial API  (100 lookups/day per source IP; Worker IPs are shared, so it is often used up by others)
     2. upcitemdb.com product page  (separate, much looser limit than the API)
     3. go-upc.com product page
     4. DuckDuckGo HTML search for the barcode (last resort)
   Hits are cached 30 days, confirmed misses 1 day, in this data centre's Cache API. When the API says "limit"
   that fact is remembered (up to 1 h) so we stop wasting calls on it. A 429 is returned only if every source failed.
   CORS is allowed only for https://jcele1.github.io. No secrets are stored or needed. */
const ALLOWED_ORIGIN = 'https://jcele1.github.io';
const UA = 'Mozilla/5.0 (compatible; MovieCheckUPC/1.0; +https://jcele1.github.io/movie-library/)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TIMEOUT_MS = 7000;
const TTL_FOUND = 30 * 86400;
const TTL_MISS = 86400;

function corsHeaders(origin) {
  const h = { Vary: 'Origin' };
  if (origin === ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

function sortFormats(a) {
  return ['4K UHD', 'Blu-ray', 'DVD', 'Digital'].filter((f) => a.indexOf(f) >= 0);
}
function detectFormats(name) {
  const t = ' ' + String(name || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ') + ' ';
  let out = [];
  if (/\b(4k|uhd|ultra hd)\b/.test(t)) out.push('4K UHD');
  const rest = t.replace(/\b(4k|uhd|ultra hd)\s*(blu ?ray|bd)?\b/g, ' ');
  if (/\b(blu ?ray|bd)\b/.test(rest)) out.push('Blu-ray');
  if (/\bdvd\b/.test(rest)) out.push('DVD');
  if (/\bdigital\b/.test(t)) out.push('Digital');
  if (/\bcombo\b/.test(t)) {
    if (!out.length) out = ['Blu-ray', 'DVD', 'Digital'];
    else if (out.indexOf('Digital') < 0 && /\bdigital|\bcopy\b/.test(t)) out.push('Digital');
  }
  return sortFormats(out);
}
function yearOf(raw) {
  const m = String(raw || '').match(/[\[(]\s*((?:19|20)\d\d)\s*[\])]/);
  return m ? m[1] : '';
}
function cleanTitle(raw) {
  let t = String(raw || '').split(/\s{2,}/)[0]; // UPCitemdb separates its genre/studio keyword tail with double spaces
  const sm=t.match(/^(.{2,45}?)\s+[-\u2013]\s+(.+)$/);
  if(sm&&/\b(pictures|entertainment|studios?|home (video|entertainment)|warner|universal|paramount|disney|lionsgate|20th century|fox|mgm|columbia|dreamworks|miramax|criterion|shout|kino|sony|a24|lucasfilm|pixar|new line|touchstone|summit|focus features|magnolia|anchor bay|arrow|scream factory|vinegar syndrome)\b/i.test(sm[1]))t=sm[2];
  t = t.replace(/\s*[\[(][^\])]*(blu-?ray|dvd|4k|uhd|ultra\s*hd|digital|combo|steelbook|widescreen|special edition|collector|ultraviolet|\d+\s*discs?)[^\])]*[\])]/gi, '');
  t = t.replace(/(?:[\s\-\u2013:,+&\/]*(?:4k(?:\s*ultra\s*hd)?|ultra\s*hd|uhd|blu-?ray|bd|dvd|digital(?:\s*(?:code|copy|hd))?|combo(?:\s*pack)?|\d+-?disc(?:\s*set)?))+\s*$/gi, '');
  t = t.replace(/\s*[\[(]\s*(?:19|20)\d\d\s*[\])]/g, '');
  return t.replace(/\s{2,}/g, ' ').replace(/[\s\-\u2013:,+&\/]+$/, '').trim();
}


/* ---------- sources ---------- */
function checksumOk(u) {
  if (![12, 13, 14].includes(u.length)) return true; // 8-digit UPC-E uses a different scheme; skip
  let sum = 0;
  for (let i = 0; i < u.length - 1; i++) sum += Number(u[u.length - 2 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(u[u.length - 1]);
}
const zs = (u) => String(u).replace(/^0+/, '');
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '));
const httpsOnly = (list) => list.filter((u) => /^https:\/\//.test(u)).slice(0, 3);
async function fetchText(url, ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua || UA, Accept: 'text/html,application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
/* every source resolves to {s:'found'|'notfound'|'limited'|'error', title?, raw?, brand?, images?, retry?} */
async function srcApi(upc) {
  let res;
  try {
    res = await fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(upc), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) { return { s: 'error' }; }
  if (res.status === 429) return { s: 'limited', retry: Number(res.headers.get('Retry-After')) || 3600 };
  let d = null;
  try { d = await res.json(); } catch (e) {}
  if (d && d.code === 'EXCEED_LIMIT') return { s: 'limited', retry: Number(res.headers.get('Retry-After')) || 3600 };
  if (!d || res.status >= 500) return { s: 'error' };
  if (d.code === 'OK' && d.items && d.items.length) {
    const it = d.items[0];
    return { s: 'found', raw: String(it.title || ''), brand: it.brand || '', images: httpsOnly(it.images || []) };
  }
  if (d.code === 'OK' || d.code === 'INVALID_UPC' || d.code === 'NOT_FOUND' || res.status === 404 || res.status === 400) return { s: 'notfound' };
  return { s: 'error' };
}
async function srcUpcitemdbPage(upc) {
  let r;
  try { r = await fetchText('https://www.upcitemdb.com/upc/' + encodeURIComponent(upc), BROWSER_UA); } catch (e) { return { s: 'error' }; }
  if (r.status === 404) return { s: 'notfound' };
  if (r.status !== 200 || !/<title>[^<]*upcitemdb/i.test(r.text)) return { s: 'error' };
  const m = r.text.match(/class="detailtitle"[^>]*>\s*UPC\s+\d+\s+is associated with\s*<b>([\s\S]*?)<\/b>/i);
  const raw = m ? stripTags(m[1]) : '';
  if (!raw) return { s: 'notfound' };
  const imgs = [];
  const re = /<img[^>]+src="(https:\/\/[^"]+)"[^>]*>/gi;
  let x;
  while ((x = re.exec(r.text)) && imgs.length < 6) if (/class="(product|amzn)"|upc \d+ product image/i.test(x[0])) imgs.push(x[1]);
  return { s: 'found', raw, brand: '', images: httpsOnly(imgs) };
}
async function srcGoUpc(upc) {
  let r;
  try { r = await fetchText('https://go-upc.com/search?q=' + encodeURIComponent(upc), BROWSER_UA); } catch (e) { return { s: 'error' }; }
  if (r.status !== 200) return { s: 'error' };
  const t = (r.text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  if (/Product Not Found|Invalid Barcode/i.test(t)) return { s: 'notfound' };
  const code = (t.match(/UPC\s+(\d{6,14})/i) || [])[1];
  if (!code) return { s: 'error' };
  if (zs(code) !== zs(upc)) return { s: 'notfound' }; // go-upc "corrects" bad numbers to a different product
  const h = r.text.match(/class="product-name"[^>]*>([\s\S]*?)<\/h1>/i);
  let raw = h ? stripTags(h[1]) : '';
  raw = raw.replace(/^Menu\s+/, '').replace(/^(warner bros\.?( home entertainment)?|walt disney (video|studios home entertainment)|disney|sony pictures( home entertainment)?|universal (studios )?(home entertainment|pictures)?|paramount( home entertainment| pictures)?|20th century (fox|studios)( home entertainment)?|lionsgate( films)?|mgm( home entertainment)?|criterion( collection)?|shout! factory|kino lorber|twentieth century fox)\s+(?=\S)/i, '');
  if (!raw) return { s: 'notfound' };
  const im = r.text.match(/<img[^>]+src="(https:\/\/go-upc\.s3\.amazonaws\.com\/[^"]+)"/i);
  return { s: 'found', raw, brand: '', images: im ? [im[1]] : [] };
}
async function srcDdg(upc) {
  let r;
  try { r = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(upc + ' upc'), UA); } catch (e) { return { s: 'error' }; }
  if (r.status !== 200 || !/result__a/.test(r.text)) return { s: 'error' };
  const re = /class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const z = zs(upc);
  while ((m = re.exec(r.text))) {
    const t = stripTags(m[1]);
    const um = t.match(/\bUPC[ :]*0*(\d{6,13})\b/i);
    if (!um || um[1] !== z) continue;
    let name = t.replace(/^.*?\bUPC[ :]*\d+\s*[-\u2013:]?\s*/i, '');
    name = name.replace(/\s*[|\-\u2013]\s*(upcitemdb(\.com)?|barcode index|upcindex(\.com)?|buycott|go-upc|barcodelookup).*$/i, '').replace(/\s*\.\.\.$/, '').trim();
    if (!name) {
      name = t.replace(/\s*[-\u2013]\s*UPC.*$/i, '').replace(/\bUPC[ :]*\d+\s*[-\u2013:]?\s*/i, '').trim();
    }
    name = name.replace(/\s*[\[(][^\])]*$/, '').trim();
    if (name.length >= 2) return { s: 'found', raw: name, brand: '', images: [] };
  }
  return { s: 'notfound' };
}
const SOURCES = [
  ['upcitemdb', srcApi],
  ['upcitemdb-page', srcUpcitemdbPage],
  ['go-upc', srcGoUpc],
  ['duckduckgo', srcDdg],
];
const jsonHeaders = (extra) => Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {});
const LIMIT_KEY = new Request('https://movie-check-upc.invalid/v4/limited/upcitemdb-api');
const inflight = new Map();

async function resolveUpc(upc, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://movie-check-upc.invalid/v4/' + zs(upc));
  const hit = await cache.match(cacheKey);
  if (hit) return { body: await hit.text(), cache: 'HIT' };

  const apiLimited = await cache.match(LIMIT_KEY);
  const tried = [];
  let notFoundVotes = 0, limitedSeen = !!apiLimited, found = null;
  for (const [name, fn] of SOURCES) {
    if (name === 'upcitemdb' && apiLimited) { tried.push('upcitemdb:skipped-limited'); continue; }
    const r = await fn(upc);
    tried.push(name + ':' + r.s);
    if (r.s === 'found') { found = Object.assign({ name }, r); break; }
    if (r.s === 'notfound') {
      notFoundVotes++;
    } else if (r.s === 'limited') {
      limitedSeen = true;
      ctx.waitUntil(cache.put(LIMIT_KEY, new Response('1', { headers: { 'Cache-Control': 'public, max-age=' + Math.min(Math.max(Math.ceil(r.retry || 3600), 120), 3600) } })));
    }
  }
  let out, ttl;
  if (found) {
    out = {
      found: true, upc, title: cleanTitle(found.raw) || found.raw, brand: found.brand || '', rawTitle: found.raw,
      formats: detectFormats(found.raw), year: yearOf(found.raw), images: found.images || [], source: found.name,
    };
    ttl = TTL_FOUND;
  } else if (notFoundVotes >= 1) {
    out = { found: false, upc, title: '', brand: '', rawTitle: '', formats: [], images: [], source: 'all' };
    ttl = limitedSeen ? 6 * 3600 : TTL_MISS;
  } else {
    return { busy: true, tried };
  }
  const body = JSON.stringify(out);
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + ttl } })));
  return { body, cache: 'MISS', tried };
}

export { checksumOk, cleanTitle, detectFormats, srcApi, srcUpcitemdbPage, srcGoUpc, srcDdg, resolveUpc };

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: 'forbidden_origin' }, 403, { Vary: 'Origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);
    const url = new URL(request.url);
    if (url.pathname !== '/') return json({ error: 'not_found' }, 404, cors);
    const upc = (url.searchParams.get('upc') || '').trim();
    if (!/^\d{8,14}$/.test(upc)) return json({ error: 'bad_upc', message: 'upc must be 8-14 digits' }, 400, cors);

    if (!checksumOk(upc)) {
      return json({ found: false, upc, title: '', brand: '', rawTitle: '', formats: [], year: '', images: [], source: 'invalid_checksum' }, 200, Object.assign({ 'Cache-Control': 'public, max-age=3600' }, cors));
    }
    // one upstream lookup per barcode at a time, even if the phone double-sends
    const k = zs(upc);
    let p = inflight.get(k);
    if (!p) { p = resolveUpc(upc, ctx).finally(() => inflight.delete(k)); inflight.set(k, p); }
    const r = await p;
    if (r.busy) {
      return json({ error: 'rate_limited', message: 'The free barcode lookup services are busy right now. Try again in a few minutes, or search by title.', retryAfter: 300, tried: r.tried }, 429,
        Object.assign({ 'Retry-After': '300' }, cors));
    }
    return new Response(r.body, {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': r.cache, 'X-Sources': (r.tried || []).join(','), 'Cache-Control': 'public, max-age=3600' }, cors),
    });
  },
};

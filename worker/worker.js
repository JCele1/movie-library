/* Movie Check UPC lookup (Cloudflare Worker).
   GET /?upc=<8-14 digits>  ->  {found, upc, title, brand, rawTitle, formats[], images[]}
   Proxies the free UPCitemdb trial API server-side (it blocks browser CORS), caches hits 30 days and misses 1 day.
   CORS is allowed only for https://jcele1.github.io. No secrets are stored or needed. */
const ALLOWED_ORIGIN = 'https://jcele1.github.io';
const UA = 'Mozilla/5.0 (compatible; MovieCheckUPC/1.0; +https://jcele1.github.io/movie-library/)';
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
function cleanTitle(raw) {
  let t = String(raw || '');
  const sm=t.match(/^(.{2,45}?)\s+[-\u2013]\s+(.+)$/);
  if(sm&&/\b(pictures|entertainment|studios?|home (video|entertainment)|warner|universal|paramount|disney|lionsgate|20th century|fox|mgm|columbia|dreamworks|miramax|criterion|shout|kino|sony|a24|lucasfilm|pixar|new line|touchstone|summit|focus features|magnolia|anchor bay|arrow|scream factory|vinegar syndrome)\b/i.test(sm[1]))t=sm[2];
  t = t.replace(/\s*[\[(][^\])]*(blu-?ray|dvd|4k|uhd|ultra\s*hd|digital|combo|steelbook|widescreen|special edition|collector)[^\])]*[\])]/gi, '');
  t = t.replace(/(?:[\s\-\u2013:,+&\/]*(?:4k(?:\s*ultra\s*hd)?|ultra\s*hd|uhd|blu-?ray|bd|dvd|digital(?:\s*(?:code|copy|hd))?|combo(?:\s*pack)?|\d+-?disc(?:\s*set)?))+\s*$/gi, '');
  return t.replace(/\s{2,}/g, ' ').replace(/[\s\-\u2013:,+&\/]+$/, '').trim();
}

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

    const cacheKey = new Request('https://movie-check-upc.invalid/v2/' + upc.replace(/^0+/, ''));
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(await hit.text(), {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=3600' }, cors),
      });
    }

    let res;
    try {
      res = await fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(upc), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
    } catch (e) {
      return json({ error: 'upstream_unreachable', message: 'Could not reach UPCitemdb.' }, 502, cors);
    }
    const limited = (retry) =>
      json({ error: 'rate_limited', message: 'The free UPCitemdb trial quota is used up for now (about 100 lookups/day, 6/min). Try again later or enter the title by hand.', retryAfter: retry || null }, 429,
        Object.assign({ 'Retry-After': String(Math.ceil(Number(retry) || 3600)) }, cors));
    if (res.status === 429) return limited(res.headers.get('Retry-After'));
    let d = null;
    try { d = await res.json(); } catch (e) {}
    if (d && d.code === 'EXCEED_LIMIT') return limited(res.headers.get('Retry-After'));
    if (!d || res.status >= 500) return json({ error: 'upstream_error', status: res.status }, 502, cors);

    let out, ttl;
    if (d.code === 'OK' && d.items && d.items.length) {
      const it = d.items[0], raw = String(it.title || '');
      out = {
        found: true, upc, title: cleanTitle(raw) || raw, brand: it.brand || '', rawTitle: raw,
        formats: detectFormats(raw),
        images: (it.images || []).filter((u) => /^https:\/\//.test(u)).slice(0, 3),
        source: 'upcitemdb',
      };
      ttl = TTL_FOUND;
    } else if (d.code === 'OK' || d.code === 'INVALID_UPC' || d.code === 'NOT_FOUND' || res.status === 404 || res.status === 400) {
      out = { found: false, upc, title: '', brand: '', rawTitle: '', formats: [], images: [], source: 'upcitemdb' };
      ttl = TTL_MISS;
    } else {
      return json({ error: 'upstream_error', status: res.status, code: d.code || null }, 502, cors);
    }
    const body = JSON.stringify(out);
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + ttl } })));
    return new Response(body, {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=3600' }, cors),
    });
  },
};

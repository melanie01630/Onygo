/* Onygo — prépare à l'avance hôtels, activités et restos des villes populaires (liste : data/cities.json).
   Lancé par GitHub Actions en 4 équipes parallèles ; chaque ville est enregistrée dès qu'elle est prête.
   FULL=1 : tout refaire (mise à jour du lundi). Sinon : seulement les villes qui manquent. */
import fs from 'fs';
import { execSync } from 'child_process';

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const SHARD = +(process.env.SHARD || 0), SHARDS = +(process.env.SHARDS || 1), FULL = process.env.FULL === '1';
const CITIES = JSON.parse(fs.readFileSync('data/cities.json', 'utf8'));
const KEEP = new Set(['name', 'name:fr', 'tourism', 'historic', 'leisure', 'natural', 'amenity', 'cuisine', 'diet:vegan', 'diet:vegetarian', 'stars', 'website', 'contact:website', 'url', 'phone', 'contact:phone', 'email', 'rooms', 'internet_access', 'wheelchair', 'opening_hours', 'fee', 'outdoor_seating', 'takeaway', 'description', 'wikipedia', 'wikidata', 'heritage']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => execSync(c, { stdio: 'pipe' }).toString();

let turn = SHARD;
async function overpass(q) {
  let last;
  for (let i = 0; i < 4; i++) {
    const url = SERVERS[turn++ % SERVERS.length];
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'onygo-data-builder (github.com/melanie01630/onygo)' }, signal: AbortSignal.timeout(150000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.remark && /error|timed out|out of memory/i.test(j.remark)) throw new Error(j.remark.slice(0, 120));
      console.log(`    ✓ ${new URL(url).host} ${Math.round((Date.now() - t0) / 1000)} s`);
      return j.elements || [];
    } catch (e) { last = e; console.log(`    ⚠️ ${new URL(url).host} ${Math.round((Date.now() - t0) / 1000)} s : ${e.message}`); await sleep(5000); }
  }
  throw last;
}
function slim(els) {
  const seen = new Set();
  return els.map(e => {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon, src = e.tags || {}, t = {};
    for (const k in src) if (KEEP.has(k) || k.startsWith('addr:')) t[k] = src[k];
    return { type: e.type[0], id: e.id, lat: lat == null ? null : +lat.toFixed(6), lon: lon == null ? null : +lon.toFixed(6), tags: t };
  }).filter(e => e.lat != null && e.tags.name && !seen.has(e.type + e.id) && seen.add(e.type + e.id));
}
const A = (km, c) => `(around:${km * 1000},${c.lat},${c.lon})`;
const Q = {
  h: c => `[out:json][timeout:140];(nwr["tourism"~"^(hotel|hostel|guest_house|motel|apartment|chalet|camp_site)$"]["name"]${A(c.h, c)};nwr["leisure"="resort"]["name"]${A(c.h, c)};);out tags center;`,
  a: c => `[out:json][timeout:140];(
nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"]["name"]${A(c.a, c)};
nwr["historic"~"^(monument|castle|ruins|archaeological_site|fort|city_gate|palace|manor|tower|citywalls)$"]["name"]${A(c.a, c)};
nwr["historic"="memorial"]["name"]["wikidata"]${A(c.a, c)};
nwr["leisure"~"^(water_park|beach_resort)$"]["name"]${A(c.a, c)};
nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"]${A(c.a, c)};
nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]${A(c.ap, c)};
nwr["natural"~"^(beach|waterfall)$"]["name"]${A(c.a, c)};
node["natural"="peak"]["name"]["wikidata"]${A(c.a, c)};
node["natural"="peak"]["name"]${A(c.ap, c)};
nwr["amenity"~"^(theatre|arts_centre|cinema)$"]["name"]${A(c.a, c)};
nwr["amenity"="place_of_worship"]["name"]["wikidata"]${A(c.a, c)};
);out tags center;`,
  r: c => `[out:json][timeout:140];nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|biergarten|food_court)$"]["name"]${A(c.r, c)};out tags center;`
};
function save(c) {
  try { sh(`git add data/${c.s}-*.json`); } catch (e) { return; }
  if (!sh('git diff --cached --name-only').trim()) return;
  sh(`git commit -qm "Données : ${c.n}"`);
  for (let i = 0; i < 6; i++) {
    try { sh('git pull -q --rebase origin main'); sh('git push -q origin HEAD:main'); console.log('  💾 enregistré'); return; }
    catch (e) { try { sh('git rebase --abort'); } catch (_) {} execSync('sleep ' + (3 + i * 4)); }
  }
  console.log('  ❌ enregistrement impossible');
}

const mine = CITIES.filter((c, i) => i % SHARDS === SHARD);
for (const c of mine) {
  const todo = ['h', 'a', 'r'].filter(k => FULL || !fs.existsSync(`data/${c.s}-${k}.json`));
  if (!todo.length) continue;
  console.log('🏙️ ', c.n);
  for (const k of todo) {
    try {
      const els = slim(await overpass(Q[k](c)));
      if (els.length) { fs.writeFileSync(`data/${c.s}-${k}.json`, JSON.stringify(els)); console.log(`  ${k} : ${els.length} lieux`); }
    } catch (e) { console.log(`  ❌ ${k} abandonné`); }
    await sleep(2000);
  }
  save(c);
}
console.log('✅ équipe', SHARD, 'terminée');

/* Onygo — prépare à l'avance les hôtels, activités et restos des villes populaires.
   Lancé chaque semaine par GitHub Actions : le site charge ensuite ces fichiers instantanément. */
import fs from 'fs';

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Rayons couverts (km autour du centre) : h = hôtels, a = activités, ap = petits parcs et sommets, r = restos
const COVER = { h: 12, a: 25, ap: 18, r: 10 };
const CITIES = [
  ['paris', 'Paris', 48.8566, 2.3522], ['rome', 'Rome', 41.8933, 12.4829], ['barcelone', 'Barcelone', 41.3874, 2.1686], ['lisbonne', 'Lisbonne', 38.7223, -9.1393],
  ['marrakech', 'Marrakech', 31.6295, -7.9811], ['londres', 'Londres', 51.5072, -0.1276], ['amsterdam', 'Amsterdam', 52.3728, 4.8936], ['istanbul', 'Istanbul', 41.0082, 28.9784],
  ['new-york', 'New York', 40.758, -73.9855], ['tokyo', 'Tokyo', 35.6812, 139.7671], ['dubai', 'Dubaï', 25.1972, 55.2744], ['ubud', 'Ubud', -8.5069, 115.2625],
  ['kuta', 'Kuta (Bali)', -8.718, 115.1686], ['madrid', 'Madrid', 40.4168, -3.7038], ['seville', 'Séville', 37.3891, -5.9845], ['malaga', 'Malaga', 36.7213, -4.4214],
  ['valence', 'Valence', 39.4699, -0.3763], ['porto', 'Porto', 41.1579, -8.6291], ['florence', 'Florence', 43.7696, 11.2558], ['venise', 'Venise', 45.4408, 12.3155],
  ['milan', 'Milan', 45.4642, 9.19], ['naples', 'Naples', 40.8518, 14.2681], ['berlin', 'Berlin', 52.52, 13.405], ['munich', 'Munich', 48.1351, 11.582],
  ['vienne', 'Vienne', 48.2082, 16.3738], ['prague', 'Prague', 50.0755, 14.4378], ['budapest', 'Budapest', 47.4979, 19.0402], ['bruxelles', 'Bruxelles', 50.8467, 4.3525],
  ['athenes', 'Athènes', 37.9838, 23.7275], ['dublin', 'Dublin', 53.3498, -6.2603], ['edimbourg', 'Édimbourg', 55.9533, -3.1883], ['copenhague', 'Copenhague', 55.6761, 12.5683],
  ['nice', 'Nice', 43.7102, 7.262], ['marseille', 'Marseille', 43.2965, 5.3698], ['lyon', 'Lyon', 45.764, 4.8357], ['bordeaux', 'Bordeaux', 44.8378, -0.5792],
  ['montreal', 'Montréal', 45.5019, -73.5674], ['los-angeles', 'Los Angeles', 34.0522, -118.2437], ['miami', 'Miami', 25.7617, -80.1918], ['las-vegas', 'Las Vegas', 36.1147, -115.1728],
  ['bangkok', 'Bangkok', 13.7563, 100.5018], ['singapour', 'Singapour', 1.2903, 103.8519], ['le-caire', 'Le Caire', 30.0444, 31.2357], ['agadir', 'Agadir', 30.4278, -9.5981],
  ['tunis', 'Tunis', 36.8065, 10.1815], ['dakar', 'Dakar', 14.7167, -17.4677], ['abidjan', 'Abidjan', 5.36, -4.0083], ['cancun', 'Cancún', 21.1619, -86.8515],
  ['rio', 'Rio de Janeiro', -22.9068, -43.1729]
];
const KEEP = new Set(['name', 'name:fr', 'tourism', 'historic', 'leisure', 'natural', 'amenity', 'cuisine', 'diet:vegan', 'diet:vegetarian', 'stars', 'website', 'contact:website', 'url', 'phone', 'contact:phone', 'email', 'rooms', 'internet_access', 'wheelchair', 'opening_hours', 'fee', 'outdoor_seating', 'takeaway', 'description', 'wikipedia', 'wikidata', 'heritage']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let turn = 0;
async function overpass(q) {
  let last;
  for (let i = 0; i < 8; i++) {
    const url = SERVERS[turn++ % SERVERS.length];
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'onygo-data-builder (github.com/melanie01630/onygo)' }, signal: AbortSignal.timeout(240000) });
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      const j = await r.json();
      if (j.remark && /error|timed out|out of memory/i.test(j.remark)) throw new Error(url + ' ' + j.remark);
      return j.elements || [];
    } catch (e) { last = e; console.log('  ⚠️ ', e.message); await sleep(8000 + i * 6000); }
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
const A = (km, c) => `(around:${km * 1000},${c[2]},${c[3]})`;
const Q = {
  h: c => `[out:json][timeout:200];(nwr["tourism"~"^(hotel|hostel|guest_house|motel|apartment|chalet|camp_site)$"]["name"]${A(COVER.h, c)};nwr["leisure"="resort"]["name"]${A(COVER.h, c)};);out tags center;`,
  a: c => `[out:json][timeout:200];(
nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"]["name"]${A(COVER.a, c)};
nwr["historic"~"^(monument|castle|ruins|archaeological_site|fort|city_gate|palace|manor|tower|citywalls)$"]["name"]${A(COVER.a, c)};
nwr["historic"="memorial"]["name"]["wikidata"]${A(COVER.a, c)};
nwr["leisure"~"^(water_park|beach_resort)$"]["name"]${A(COVER.a, c)};
nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"]${A(COVER.a, c)};
nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]${A(COVER.ap, c)};
nwr["natural"~"^(beach|waterfall)$"]["name"]${A(COVER.a, c)};
node["natural"="peak"]["name"]["wikidata"]${A(COVER.a, c)};
node["natural"="peak"]["name"]${A(COVER.ap, c)};
nwr["amenity"~"^(theatre|arts_centre|cinema)$"]["name"]${A(COVER.a, c)};
nwr["amenity"="place_of_worship"]["name"]["wikidata"]${A(COVER.a, c)};
);out tags center;`,
  r: c => `[out:json][timeout:200];nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|biergarten|food_court)$"]["name"]${A(COVER.r, c)};out tags center;`
};

fs.mkdirSync('data', { recursive: true });
const only = process.argv[2] ? process.argv[2].split(',') : null;
for (const c of CITIES) {
  if (only && !only.includes(c[0])) continue;
  console.log('🏙️ ', c[1]);
  for (const k of ['h', 'a', 'r']) {
    try {
      const els = slim(await overpass(Q[k](c)));
      if (els.length) { fs.writeFileSync(`data/${c[0]}-${k}.json`, JSON.stringify(els)); console.log(`  ${k} : ${els.length}`); }
    } catch (e) { console.log(`  ❌ ${k} : garde l'ancienne version`); }
    await sleep(4000);
  }
}
// index : seules les villes dont les 3 fichiers existent
const index = CITIES.filter(c => ['h', 'a', 'r'].every(k => fs.existsSync(`data/${c[0]}-${k}.json`)))
  .map(c => ({ s: c[0], n: c[1], lat: c[2], lon: c[3], ...COVER }));
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log('✅ ', index.length, 'villes prêtes');

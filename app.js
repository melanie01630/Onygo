/* Onygo — ton voyage du début à la fin.
   Données : OpenStreetMap (Nominatim pour les destinations, Overpass pour les lieux). */
(function () {
'use strict';

/* ---------- outils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const store = {
  get(k, d) { try { const v = localStorage.getItem('onygo-' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('onygo-' + k, JSON.stringify(v)); } catch (e) {} }
};
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2400); }
function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const d1 = r(b.lat - a.lat), d2 = r(b.lon - a.lon);
  const h = Math.sin(d1 / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(d2 / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = d => d < 1 ? Math.round(d * 1000 / 10) * 10 + ' m' : (d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)) + ' km';
function fmtMin(m) { m = Math.max(1, Math.round(m)); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') : ''); }

/* ---------- état ---------- */
const S = {
  view: 'explorer',
  dest: store.get('dest', null),
  hotels: null, hotelsErr: null, cities: null,
  hotel: store.get('hotel', null),
  hq: '', htype: 'all', hsort: 'stars', hshow: 30, hmode: 'list',
  radius: Math.min(store.get('radius', 3), 20), acts: null, actsErr: null, acat: 'all', aq: '', ashow: 30, amode: 'list',
  rradius: store.get('rradius', 1), restos: null, restosErr: null, rcui: 'all', rtype: 'all', rq: '', rshow: 30, rmode: 'list',
  transit: null, transitErr: null,
  trip: store.get('trip', { items: [], days: 3 })
};
function saveTrip() { store.set('trip', S.trip); updateBadge(); }
function updateBadge() { $('#tripN').textContent = S.trip.items.length || ''; }

/* ---------- accès aux données (OpenStreetMap) ---------- */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const memo = {};
/* Un serveur répond avec un message d'erreur (temps dépassé, trop de monde) : on essaie le suivant. */
async function askServer(url, q, ms) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.remark && /error|timed out|out of memory/i.test(j.remark)) throw new Error(j.remark);
    return j.elements || [];
  } finally { clearTimeout(tm); }
}
/* On interroge le premier serveur ; s'il traîne, on en lance un 2e en parallèle et on garde la 1re réponse. */
async function overpass(q) {
  if (memo[q]) return memo[q];
  if (!memo['p' + q]) {
    memo['p' + q] = new Promise((resolve, reject) => {
      let i = 0, pending = 0, done = false, last, timer;
      const launch = () => {
        if (done || i >= OVERPASS.length) return;
        const url = OVERPASS[i++]; pending++;
        clearTimeout(timer); timer = setTimeout(launch, 7000);
        askServer(url, q, 35000).then(els => { if (done) return; done = true; clearTimeout(timer); resolve(memo[q] = els); })
          .catch(e => { last = e; pending--; if (done) return; if (i < OVERPASS.length) launch(); else if (!pending) { done = true; clearTimeout(timer); reject(last); } });
      };
      launch();
    }).finally(() => { delete memo['p' + q]; });
  }
  return memo['p' + q];
}
/* ---------- données prêtes à l'avance (villes populaires, mises à jour chaque lundi) ---------- */
const CDN = 'https://cdn.jsdelivr.net/gh/melanie01630/onygo@main/';
async function getJSON(path) {
  for (const base of ['', CDN]) {
    try { const r = await fetch(base + path); if (r.ok) return await r.json(); } catch (e) {}
  }
  return null;
}
let packIdx = null; const packMemo = {};
function packIndex() { return packIdx || (packIdx = getJSON('data/index.json').then(x => Array.isArray(x) ? x : [])); }
/* Renvoie les lieux prêts à l'avance si la ville couvre le rayon demandé, sinon null (=> recherche en direct). */
async function pack(kind, p, need, cover) {
  const idx = await packIndex();
  const c = idx.find(e => km(e, p) + need <= e[cover || kind]);
  if (!c) return null;
  const k = c.s + '-' + kind;
  if (!packMemo[k]) packMemo[k] = getJSON('data/' + k + '.json');
  const els = await packMemo[k];
  if (!els) { delete packMemo[k]; return null; }
  return els;
}
async function geocode(q) {
  const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=fr&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'Accept-Language': 'fr' } });
  if (!r.ok) throw new Error('nominatim');
  return r.json();
}
function norm(el) {
  const t = el.tags || {};
  const lat = el.lat != null ? el.lat : el.center && el.center.lat;
  const lon = el.lon != null ? el.lon : el.center && el.center.lon;
  return { id: el.type[0] + el.id, name: t['name:fr'] || t.name || '', lat, lon, t };
}
const around = (r, p) => `(around:${Math.round(r)},${p.lat},${p.lon})`;

/* ---------- textes et catégories ---------- */
const HTYPES = { hotel: ['Hôtel', '🏨'], hostel: ['Auberge de jeunesse', '🛏️'], guest_house: ["Maison d'hôtes", '🏡'], motel: ['Motel', '🚗'], apartment: ['Appartement', '🏢'], chalet: ['Chalet', '🛖'], camp_site: ['Camping', '⛺'], resort: ['Club et resort', '🌴'] };
function htype(t) { if (t.leisure === 'resort') return 'resort'; return HTYPES[t.tourism] ? t.tourism : 'hotel'; }

const ACATS = [
  { k: 'monu', l: 'Monuments', e: '🏛️', c: '#F3E3C3', m: t => /^(monument|castle|memorial|ruins|archaeological_site|fort|city_gate|palace|manor|tower|citywalls)$/.test(t.historic || '') },
  { k: 'musee', l: 'Musées et expos', e: '🖼️', c: '#E6DDF7', m: t => t.tourism === 'museum' || t.tourism === 'gallery' },
  { k: 'vue', l: 'Points de vue', e: '🌄', c: '#FFE0C2', m: t => t.tourism === 'viewpoint' || t.natural === 'peak' },
  { k: 'plage', l: 'Plages', e: '🏖️', c: '#CDEFF5', m: t => t.natural === 'beach' || t.leisure === 'beach_resort' },
  { k: 'nature', l: 'Parcs et nature', e: '🌳', c: '#D9F0D3', m: t => /^(park|garden|nature_reserve)$/.test(t.leisure || '') || t.natural === 'waterfall' },
  { k: 'fun', l: 'Loisirs et attractions', e: '🎢', c: '#FFD9E1', m: t => /^(theme_park|zoo|aquarium)$/.test(t.tourism || '') || t.leisure === 'water_park' },
  { k: 'culte', l: 'Lieux de culte', e: '⛪', c: '#E9E3DA', m: t => t.amenity === 'place_of_worship' },
  { k: 'spect', l: 'Spectacles et culture', e: '🎭', c: '#F7DCEF', m: t => /^(theatre|arts_centre|cinema)$/.test(t.amenity || '') },
  { k: 'autre', l: 'À découvrir', e: '✨', c: '#FFF0B8', m: () => true }
];
const acat = t => ACATS.find(c => c.m(t));

const RTYPES = { restaurant: ['Restaurant', '🍽️'], cafe: ['Café', '☕'], fast_food: ['Restauration rapide', '🍔'], bar: ['Bar', '🍸'], pub: ['Pub', '🍺'], ice_cream: ['Glacier', '🍦'], biergarten: ['Brasserie en plein air', '🍻'], food_court: ['Food court', '🥡'] };
const CUI = { french: 'Française', regional: 'Régionale', italian: 'Italienne', pizza: 'Pizza', japanese: 'Japonaise', sushi: 'Sushi', ramen: 'Ramen', chinese: 'Chinoise', indian: 'Indienne', thai: 'Thaïlandaise', vietnamese: 'Vietnamienne', korean: 'Coréenne', asian: 'Asiatique', mexican: 'Mexicaine', spanish: 'Espagnole', tapas: 'Tapas', portuguese: 'Portugaise', greek: 'Grecque', turkish: 'Turque', kebab: 'Kebab', lebanese: 'Libanaise', moroccan: 'Marocaine', african: 'Africaine', ethiopian: 'Éthiopienne', american: 'Américaine', burger: 'Burgers', steak_house: 'Grill et viandes', bbq: 'Barbecue', seafood: 'Poissons et fruits de mer', fish: 'Poisson', crepe: 'Crêpes', sandwich: 'Sandwichs', coffee_shop: 'Café', ice_cream: 'Glaces', cake: 'Pâtisserie', vegetarian: 'Végétarienne', vegan: 'Végane', international: 'Internationale', brazilian: 'Brésilienne', peruvian: 'Péruvienne', german: 'Allemande', british: 'Britannique', mediterranean: 'Méditerranéenne', middle_eastern: 'Orientale', georgian: 'Géorgienne', russian: 'Russe', caribbean: 'Antillaise', tex_mex: 'Tex-mex', noodle: 'Nouilles', dessert: 'Desserts', breakfast: 'Petit-déjeuner', brunch: 'Brunch', chicken: 'Poulet', creole: 'Créole', argentinian: 'Argentine', polish: 'Polonaise', hungarian: 'Hongroise', austrian: 'Autrichienne', swiss: 'Suisse', belgian: 'Belge', indonesian: 'Indonésienne', malaysian: 'Malaisienne', filipino: 'Philippine', persian: 'Persane', syrian: 'Syrienne', tunisian: 'Tunisienne', algerian: 'Algérienne', senegalese: 'Sénégalaise' };
function cuisines(t) {
  const out = (t.cuisine || '').split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (t['diet:vegan'] === 'yes' || t['diet:vegan'] === 'only') out.push('vegan');
  if (t['diet:vegetarian'] === 'yes' || t['diet:vegetarian'] === 'only') out.push('vegetarian');
  return [...new Set(out)];
}
const cuiLabel = c => CUI[c] || (c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' '));

const DAYS = { Mo: 'lun', Tu: 'mar', We: 'mer', Th: 'jeu', Fr: 'ven', Sa: 'sam', Su: 'dim', PH: 'jours fériés' };
const hours = h => h === '24/7' ? 'Ouvert 24 h/24' : h.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, d => DAYS[d]).replace(/\boff\b/g, 'fermé').replace(/;\s*/g, ' · ').replace(/,/g, ', ');
function addr(t) {
  const a = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return a || t['addr:full'] || '';
}
const site = t => t.website || t['contact:website'] || t.url || '';
const phone = t => t.phone || t['contact:phone'] || '';
const stars = t => { const n = parseInt(t.stars, 10); return n >= 1 && n <= 7 ? n : 0; };

/* ---------- liens externes ---------- */
const gmapsDir = (a, b, mode) => `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}&travelmode=${mode}`;
const webSearch = q => 'https://www.google.com/search?q=' + encodeURIComponent(q);
const booking = (name, city) => 'https://www.booking.com/searchresults.fr.html?ss=' + encodeURIComponent(name + ' ' + (city || ''));
function placeLink(p) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.lat + ',' + p.lon); }

/* ---------- temps de trajet estimés ---------- */
function modes(d) {
  const road = d * 1.3;
  const m = [];
  if (d <= 6) m.push({ k: 'walking', e: '🚶', l: 'À pied', min: road / 4.8 * 60 });
  if (d <= 25) m.push({ k: 'bicycling', e: '🚲', l: 'À vélo', min: road / 15 * 60 + 2 });
  if (d >= 0.6) m.push({ k: 'transit', e: '🚌', l: 'Transports en commun', min: road / (d > 15 ? 35 : 18) * 60 + 8 });
  if (d >= 0.8) m.push({ k: 'driving', e: '🚗', l: 'En voiture', min: road / (d > 15 ? 60 : 28) * 60 + 3 });
  if (d >= 0.8) m.push({ k: 'driving', e: '🚕', l: 'En taxi ou VTC', min: road / (d > 15 ? 60 : 28) * 60 + 5, taxi: 1 });
  return m;
}

/* ---------- routage ---------- */
const VIEWS = ['explorer', 'autour', 'restos', 'bouger', 'voyage'];
function go(v) { if (location.hash !== '#' + v) location.hash = v; else render(); }
window.addEventListener('hashchange', render);
$$('#tabs button').forEach(b => b.onclick = () => go(b.dataset.v));

function header() {
  const c = $('#ctx');
  if (S.hotel) c.innerHTML = `<b>${esc(S.hotel.name)}</b><br>${esc(S.dest ? S.dest.name : '')}`;
  else if (S.dest) c.innerHTML = `<b>${esc(S.dest.name)}</b><br>${esc(S.dest.country || '')}`;
  else c.textContent = 'Ton voyage du début à la fin';
}

let map = null;
function killMap() { if (map) { map.remove(); map = null; } }
function render() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'explorer';
  S.view = v;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  killMap(); header(); updateBadge();
  ({ explorer: vExplorer, autour: vAutour, restos: vRestos, bouger: vBouger, voyage: vVoyage })[v]();
  window.scrollTo(0, 0);
}

const loader = m => `<div class="loader"><div class="spin"></div><div>${esc(m)}</div></div>`;
const errBox = (m, id) => `<div class="empty"><b>🌧️</b>${esc(m)}<div style="margin-top:12px"><button class="btn" id="${id}">Réessayer</button></div></div>`;
const needHotel = what => `<div class="empty"><b>🏨</b>Choisis d'abord une destination et un hôtel :<br>Onygo te montrera ${esc(what)} autour de lui.<div style="margin-top:14px"><button class="btn" data-goto="explorer">Choisir mon hôtel</button></div></div>`;
function bindGoto() { $$('[data-goto]').forEach(b => b.onclick = () => go(b.dataset.goto)); }
function hotelBar() {
  if (!S.hotel) return '';
  return `<div class="hotelbar"><div class="ico" style="background:rgba(255,255,255,.14)">🏨</div><div class="t"><small>Au départ de</small><b>${esc(S.hotel.name)}</b></div><button class="btn small" data-goto="explorer">Changer</button></div>`;
}

/* ---------- carte ---------- */
function pinIcon(e, color) {
  return L.divIcon({ className: '', html: `<div class="pin" style="background:${color}"><span>${e}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
}
function drawMap(id, center, pts, onPick, radiusKm) {
  if (!window.L) { $('#' + id).innerHTML = '<div class="empty">La carte ne peut pas se charger pour le moment.</div>'; return; }
  map = L.map(id, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  const b = [[center.lat, center.lon]];
  if (S.hotel) L.marker([S.hotel.lat, S.hotel.lon], { icon: pinIcon('🏨', '#12302E'), zIndexOffset: 1000 }).addTo(map).bindPopup(esc(S.hotel.name));
  if (radiusKm && S.hotel) L.circle([S.hotel.lat, S.hotel.lon], { radius: radiusKm * 1000, color: '#0B7A75', weight: 1.5, fillOpacity: .05 }).addTo(map);
  pts.slice(0, 300).forEach(p => {
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.e, p.c || '#0E9A93') }).addTo(map);
    m.bindPopup(`<b>${esc(p.name)}</b><br><a href="#" data-pick="${esc(p.id)}">Voir la fiche</a>`);
    m.on('popupopen', ev => { const a = ev.popup.getElement().querySelector('[data-pick]'); if (a) a.onclick = e => { e.preventDefault(); onPick(p.id); }; });
    b.push([p.lat, p.lon]);
  });
  if (b.length > 1) map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
}

/* ---------- fenêtre (fiche) ---------- */
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="grab"></div><button class="close" aria-label="Fermer">×</button>' + html;
  $('#back').hidden = false; document.body.style.overflow = 'hidden';
  $('#sheet .close').onclick = closeSheet;
}
function closeSheet() { $('#back').hidden = true; document.body.style.overflow = ''; }
$('#back').addEventListener('click', e => { if (e.target.id === 'back') closeSheet(); });

/* ---------- favoris / mon voyage ---------- */
const inTrip = id => S.trip.items.some(i => i.id === id);
function toggleTrip(p, kind) {
  const i = S.trip.items.findIndex(x => x.id === p.id);
  if (i >= 0) { S.trip.items.splice(i, 1); toast('Retiré de Mon voyage'); }
  else { S.trip.items.push({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, kind, e: p.e, day: 0 }); toast('Ajouté à Mon voyage ❤'); }
  saveTrip();
}
const favBtn = (p) => `<button class="fav ${inTrip(p.id) ? 'on' : ''}" data-fav="${esc(p.id)}" aria-label="Ajouter à Mon voyage">${inTrip(p.id) ? '♥' : '♡'}</button>`;
function bindFav(list, kind) {
  $$('[data-fav]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const p = list.find(x => x.id === b.dataset.fav); if (!p) return;
    toggleTrip(p, kind); const on = inTrip(p.id); b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡';
  });
}

/* ================= EXPLORER : destination + hôtels ================= */
const POP = [
  ['Paris', 'France', '', '#0B7A75', 'Eiffel_Tower'], ['Rome', 'Italie', '🏛️', '#E07A3F', 'Colosseum'], ['Barcelone', 'Espagne', '🌞', '#E9A300', 'Sagrada_Família'], ['Lisbonne', 'Portugal', '🚋', '#C9504A', 'Belém_Tower'],
  ['Marrakech', 'Maroc', '🕌', '#B65A2E', 'Koutoubia_Mosque'], ['Londres', 'Royaume-Uni', '🎡', '#335C81', 'Big_Ben'], ['Amsterdam', 'Pays-Bas', '🚲', '#D9622B', 'Rijksmuseum'], ['Istanbul', 'Turquie', '', '#2E6FA8', 'Hagia_Sophia'],
  ['New York', 'États-Unis', '🗽', '#3D5A80', 'Statue_of_Liberty'], ['Tokyo', 'Japon', '🗾', '#C2185B', 'Tokyo_Tower'], ['Dubaï', 'Émirats arabes unis', '🏙️', '#A67C00', 'Burj_Khalifa'], ['Bali', 'Indonésie', '🌺', '#2E8B57', 'Tanah_Lot']
];
/* Photo du monument : image principale de l'article Wikipédia, gardée en mémoire sur le téléphone. */
async function monumentPhoto(title) {
  const k = 'img-' + title, have = store.get(k, null);
  if (have) return have;
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
  if (!r.ok) throw new Error('wiki');
  const j = await r.json(), src = j.thumbnail && j.thumbnail.source;
  if (src) store.set(k, src);
  return src;
}
function loadPhotos() {
  $$('[data-img]').forEach(b => {
    monumentPhoto(b.dataset.img).then(src => {
      if (!src) return;
      const im = new Image(); im.alt = ''; im.decoding = 'async';
      im.onload = () => im.classList.add('ok'); im.src = src; b.prepend(im);
    }).catch(() => {});
  });
}
function vExplorer() {
  if (!S.dest) return vHome();
  vHotels();
}
function vHome(results) {
  app.innerHTML = `
  <section class="hero">
    <h1>Où pars-tu en vacances ?</h1>
    <p>Choisis ta destination, puis ton hôtel : Onygo te montre tout ce qu'il y a autour.</p>
    <form class="search" id="sform"><input id="sq" placeholder="Une ville, une île, un pays…" autocomplete="off" enterkeyhint="search" aria-label="Destination"><button class="btn coral">Chercher</button></form>
  </section>
  <div id="sres"></div>
  <h2>Destinations populaires</h2>
  <div class="grid">${POP.map(([c, p, e, col, w]) => `<button class="dest" data-q="${esc(c + ', ' + p)}" data-img="${esc(w)}" style="background:${col}">${e ? `<i>${e}</i>` : ''}<span>${esc(c)}</span><small>${esc(p)}</small></button>`).join('')}</div>
  <div class="info" style="margin-top:16px">✈️ <b>Comment ça marche ?</b><br>1. Choisis une destination · 2. Choisis ton hôtel · 3. Découvre les activités, les restos et les transports autour de lui · 4. Garde tes coups de cœur dans <b>Mon voyage</b>.</div>
  <footer>Données © contributeurs OpenStreetMap. Photos : Wikipédia / Wikimedia Commons. Vérifie toujours les horaires et les prix sur le site officiel.</footer>`;
  loadPhotos();
  $('#sform').onsubmit = e => { e.preventDefault(); const q = $('#sq').value.trim(); if (q.length > 1) search(q); };
  $$('[data-q]').forEach(b => b.onclick = () => search(b.dataset.q, true));
  if (results) showResults(results);
}
async function search(q, auto) {
  const box = $('#sres'); if (box) box.innerHTML = loader('Je cherche « ' + q + ' »…');
  try {
    const r = (await geocode(q)).filter(x => x.lat && x.lon);
    if (!r.length) { box.innerHTML = '<div class="notice">Je n\'ai rien trouvé. Essaie avec le nom de la ville et du pays, par exemple « Nice, France ».</div>'; return; }
    if (auto) return pickDest(r[0]);
    showResults(r);
  } catch (e) { box.innerHTML = '<div class="notice">La recherche ne répond pas pour le moment. Réessaie dans quelques secondes.</div>'; }
}
const PLACE_ICO = { city: '🏙️', town: '🏘️', village: '🏡', country: '🌍', state: '🗺️', island: '🏝️', suburb: '📍', administrative: '🗺️' };
function showResults(r) {
  const box = $('#sres');
  box.innerHTML = '<h2>Choisis ta destination</h2>' + r.map((x, i) => {
    const t = x.addresstype || x.type;
    return `<div class="card item" data-r="${i}"><div class="ico">${PLACE_ICO[t] || '📍'}</div><div class="t"><h3>${esc(x.name || x.display_name.split(',')[0])}</h3><div class="meta">${esc(x.display_name)}</div></div></div>`;
  }).join('');
  $$('[data-r]', box).forEach(c => c.onclick = () => pickDest(r[+c.dataset.r]));
}
/* Nouvelle destination : l'ancien hôtel ne compte plus (sinon restos et activités restent autour de l'ancien). */
function dropHotelIfFar() {
  if (S.hotel && (!S.dest || km(S.dest, S.hotel) > 40)) {
    S.hotel = null; store.set('hotel', null);
    S.acts = S.restos = S.transit = null; S.actsErr = S.restosErr = S.transitErr = null;
  }
}
function pickDest(x) {
  const bb = (x.boundingbox || []).map(Number);
  const a = x.address || {};
  S.dest = {
    name: x.name || x.display_name.split(',')[0], country: a.country || '', lat: +x.lat, lon: +x.lon,
    bbox: bb.length === 4 ? bb : null, kind: x.addresstype || x.type || ''
  };
  store.set('dest', S.dest); dropHotelIfFar();
  S.hotels = null; S.cities = null; S.hq = ''; S.htype = 'all'; S.hshow = 30;
  if (location.hash !== '#explorer') location.hash = 'explorer'; else render();
}
function destTooBig(d) {
  if (/^(country|state|region|province|continent)$/.test(d.kind)) return true;
  if (!d.bbox) return false;
  return (d.bbox[1] - d.bbox[0]) > 1.2 || (d.bbox[3] - d.bbox[2]) > 1.6;
}
function hotelBox(d) {
  if (d.bbox) {
    let [s, n, w, e] = d.bbox; const mlat = .09, mlon = .12;
    s = Math.max(s, d.lat - mlat); n = Math.min(n, d.lat + mlat); w = Math.max(w, d.lon - mlon); e = Math.min(e, d.lon + mlon);
    if (n - s < .03) { s = d.lat - .03; n = d.lat + .03; } if (e - w < .04) { w = d.lon - .04; e = d.lon + .04; }
    return `(${s},${w},${n},${e})`;
  }
  return around(8000, d);
}

function vHotels() {
  const d = S.dest;
  const top = `<div class="tools"><button class="btn ghost small" id="chg">← Autre destination</button></div><h2 style="margin-top:4px">${esc(d.name)}${d.country && d.country !== d.name ? ' <span class="sub">· ' + esc(d.country) + '</span>' : ''}</h2>`;
  if (destTooBig(d)) return vCities(top);
  if (S.hotelsErr) { app.innerHTML = top + errBox('Les hôtels ne se chargent pas pour le moment (les serveurs de cartes sont très demandés).', 'retry'); $('#chg').onclick = resetDest; $('#retry').onclick = () => { S.hotelsErr = null; loadHotels(); }; return; }
  if (!S.hotels) { app.innerHTML = top + loader('Je cherche tous les hôtels de ' + d.name + '…'); $('#chg').onclick = resetDest; return loadHotels(); }

  const all = S.hotels;
  const counts = {}; all.forEach(h => counts[h.type] = (counts[h.type] || 0) + 1);
  const q = S.hq.toLowerCase();
  let list = all.filter(h => (S.htype === 'all' || h.type === S.htype) && (!q || h.name.toLowerCase().includes(q) || h.addr.toLowerCase().includes(q)));
  const c = { lat: d.lat, lon: d.lon };
  list.forEach(h => h.dc = km(c, h));
  list.sort(S.hsort === 'stars' ? (a, b) => b.st - a.st || a.dc - b.dc : S.hsort === 'center' ? (a, b) => a.dc - b.dc : (a, b) => a.name.localeCompare(b.name, 'fr'));

  app.innerHTML = top + `<p class="sub">${all.length} hébergement${all.length > 1 ? 's' : ''} trouvé${all.length > 1 ? 's' : ''}. Choisis le tien pour découvrir tout ce qu'il y a autour.</p>
  <div class="chips">${[['all', 'Tous', all.length], ...Object.keys(HTYPES).filter(k => counts[k]).map(k => [k, HTYPES[k][1] + ' ' + HTYPES[k][0], counts[k]])].map(([k, l, n]) => `<button class="chip ${S.htype === k ? 'on' : ''}" data-ht="${k}">${esc(l)}<span class="n">${n}</span></button>`).join('')}</div>
  <div class="tools"><input id="hq" placeholder="Nom de l'hôtel, rue…" value="${esc(S.hq)}" aria-label="Rechercher un hôtel">
  <select id="hs" aria-label="Trier"><option value="stars"${S.hsort === 'stars' ? ' selected' : ''}>Étoiles</option><option value="center"${S.hsort === 'center' ? ' selected' : ''}>Près du centre</option><option value="name"${S.hsort === 'name' ? ' selected' : ''}>A → Z</option></select></div>
  <div class="tools"><div class="seg"><button data-hm="list" class="${S.hmode === 'list' ? 'on' : ''}">Liste</button><button data-hm="map" class="${S.hmode === 'map' ? 'on' : ''}">Carte</button></div><span class="sub" style="margin:0">${list.length} résultat${list.length > 1 ? 's' : ''}</span></div>
  ${S.hmode === 'map' ? '<div id="hmap" class="map"></div>' : ''}
  <div id="hlist">${list.slice(0, S.hshow).map(hotelCard).join('') || '<div class="empty"><b>🔎</b>Aucun hébergement ne correspond.</div>'}</div>
  ${list.length > S.hshow ? `<button class="btn alt more" id="hmore">Voir plus d'hôtels (${list.length - S.hshow})</button>` : ''}
  <div class="info">ℹ️ Ces hôtels viennent d'OpenStreetMap, la grande carte collaborative mondiale. Certains petits établissements peuvent manquer : tu peux aussi chercher sur Booking avec le bouton de la fiche.</div>
  <footer>Données © contributeurs OpenStreetMap</footer>`;
  $('#chg').onclick = resetDest;
  $$('[data-ht]').forEach(b => b.onclick = () => { S.htype = b.dataset.ht; S.hshow = 30; vHotels(); });
  $('#hq').oninput = e => { S.hq = e.target.value; clearTimeout(vHotels._t); vHotels._t = setTimeout(() => { const pos = e.target.selectionStart; vHotels(); const i = $('#hq'); i.focus(); i.setSelectionRange(pos, pos); }, 350); };
  $('#hs').onchange = e => { S.hsort = e.target.value; vHotels(); };
  $$('[data-hm]').forEach(b => b.onclick = () => { S.hmode = b.dataset.hm; killMap(); vHotels(); });
  if ($('#hmore')) $('#hmore').onclick = () => { S.hshow += 30; vHotels(); };
  $$('[data-h]').forEach(c => c.onclick = () => hotelSheet(c.dataset.h));
  if (S.hmode === 'map') drawMap('hmap', c, list.map(h => ({ id: h.id, lat: h.lat, lon: h.lon, name: h.name, e: HTYPES[h.type][1], c: '#0B7A75' })), id => hotelSheet(id));
}
function hotelCard(h) {
  const sel = S.hotel && S.hotel.id === h.id;
  return `<div class="card item" data-h="${esc(h.id)}" ${sel ? 'style="outline:2px solid var(--sea)"' : ''}><div class="ico">${HTYPES[h.type][1]}</div><div class="t"><h3>${esc(h.name)}</h3>
  <div class="meta">${h.st ? `<span class="stars">${'★'.repeat(h.st)}</span>` : ''}<span>${esc(HTYPES[h.type][0])}</span>${h.addr ? `<span>${esc(h.addr)}</span>` : ''}${h.dc != null ? `<span>${fmtKm(h.dc)} du centre</span>` : ''}</div>
  ${sel ? '<div class="meta" style="color:var(--sea);font-weight:600">✓ Ton hôtel</div>' : ''}</div></div>`;
}
async function loadHotels() {
  const d = S.dest, box = hotelBox(d);
  const q = `[out:json][timeout:30];(nwr["tourism"~"^(hotel|hostel|guest_house|motel|apartment|chalet|camp_site)$"]["name"]${box};nwr["leisure"="resort"]["name"]${box};);out tags center 1500;`;
  try {
    const els = (await pack('h', d, 4)) || await overpass(q);
    if (S.dest !== d) return;
    const seen = new Set();
    S.hotels = els.map(norm).filter(h => h.name && h.lat != null && !seen.has(h.name + h.lat.toFixed(3)) && seen.add(h.name + h.lat.toFixed(3)))
      .map(h => Object.assign(h, { type: htype(h.t), st: stars(h.t), addr: addr(h.t) }));
  } catch (e) { S.hotelsErr = e; }
  if (S.view === 'explorer' && S.dest === d) vHotels();
}
function resetDest() { S.dest = null; S.hotels = null; S.hotelsErr = null; store.set('dest', null); render(); }

async function vCities(top) {
  const d = S.dest;
  if (!S.cities) {
    app.innerHTML = top + loader('Je cherche les villes à visiter…'); $('#chg').onclick = resetDest;
    const bb = d.bbox ? `(${d.bbox[0]},${d.bbox[2]},${d.bbox[1]},${d.bbox[3]})` : around(150000, d);
    try {
      const els = await overpass(`[out:json][timeout:30];(node["place"="city"]${bb};node["place"="town"]["population"]${bb};);out tags 300;`);
      S.cities = els.map(norm).filter(c => c.name).map(c => Object.assign(c, { pop: parseInt(String(c.t.population || '0').replace(/\D/g, ''), 10) || 0, cap: c.t.capital === 'yes' || c.t.capital === '2' }))
        .sort((a, b) => b.cap - a.cap || b.pop - a.pop).slice(0, 40);
    } catch (e) { S.cities = []; S.citiesErr = 1; }
    if (S.dest !== d || S.view !== 'explorer') return;
  }
  app.innerHTML = top + `<div class="info">🗺️ <b>${esc(d.name)}</b> est une grande destination. Choisis la ville où tu dors pour voir les hôtels :</div>
  <form class="tools" id="cf"><input id="cq" placeholder="Ou tape une ville de ${esc(d.name)}…"><button class="btn small">OK</button></form>
  ${S.cities.length ? '<div class="grid">' + S.cities.map((c, i) => `<button class="card" style="text-align:left;cursor:pointer;margin:0" data-c="${i}"><b>${c.cap ? '⭐ ' : ''}${esc(c.name)}</b>${c.pop ? `<div class="meta">${c.pop.toLocaleString('fr-FR')} habitants</div>` : ''}</button>`).join('') + '</div>' : (S.citiesErr ? '<div class="notice">La liste des villes ne se charge pas pour le moment : tape directement le nom de la ville ci-dessus.</div>' : '')}`;
  $('#chg').onclick = resetDest;
  $('#cf').onsubmit = e => { e.preventDefault(); const v = $('#cq').value.trim(); if (v) { S.dest = null; vHome(); $('#sq').value = v + ', ' + d.name; search(v + ', ' + d.name, true); } };
  $$('[data-c]').forEach(b => b.onclick = () => {
    const c = S.cities[+b.dataset.c];
    S.dest = { name: c.name, country: d.country || d.name, lat: c.lat, lon: c.lon, bbox: null, kind: 'city' };
    store.set('dest', S.dest); dropHotelIfFar(); S.hotels = null; S.cities = null; header(); vHotels();
  });
}

function hotelSheet(id) {
  const h = (S.hotels || []).find(x => x.id === id); if (!h) return;
  const t = h.t, w = site(t), ph = phone(t);
  openSheet(`<div class="ico" style="width:56px;height:56px;font-size:28px;margin-bottom:8px">${HTYPES[h.type][1]}</div>
  <h2>${esc(h.name)}</h2>
  <div class="meta">${h.st ? `<span class="stars">${'★'.repeat(h.st)}</span>` : ''}<span class="tag">${esc(HTYPES[h.type][0])}</span></div>
  <dl class="kv">
    ${h.addr ? `<dt>Adresse</dt><dd>${esc(h.addr)}</dd>` : ''}
    ${ph ? `<dt>Téléphone</dt><dd><a href="tel:${esc(ph.replace(/\s/g, ''))}">${esc(ph)}</a></dd>` : ''}
    ${t.email ? `<dt>E-mail</dt><dd>${esc(t.email)}</dd>` : ''}
    ${t.rooms ? `<dt>Chambres</dt><dd>${esc(t.rooms)}</dd>` : ''}
    ${t.internet_access && t.internet_access !== 'no' ? '<dt>Wi-Fi</dt><dd>Oui</dd>' : ''}
    ${t.wheelchair === 'yes' ? '<dt>Accessible</dt><dd>Fauteuil roulant ♿</dd>' : ''}
    ${h.dc != null ? `<dt>Centre-ville</dt><dd>à ${fmtKm(h.dc)}</dd>` : ''}
  </dl>
  <button class="btn" id="pick" style="width:100%;margin-bottom:8px">${S.hotel && S.hotel.id === h.id ? '✓ C\'est mon hôtel · voir les activités' : '✓ Choisir cet hôtel'}</button>
  <div class="row">
    ${w ? `<a class="btn coral" href="${esc(w)}" target="_blank" rel="noopener">🌐 Site de l'hôtel</a>` : `<a class="btn coral" href="${esc(webSearch(h.name + ' ' + S.dest.name))}" target="_blank" rel="noopener">🔎 Trouver son site</a>`}
    <a class="btn ghost" href="${esc(booking(h.name, S.dest.name))}" target="_blank" rel="noopener">Voir les prix</a>
    <a class="btn ghost" href="${esc(placeLink(h))}" target="_blank" rel="noopener">📍 Carte</a>
  </div>`);
  $('#pick').onclick = () => {
    S.hotel = { id: h.id, name: h.name, lat: h.lat, lon: h.lon, city: S.dest.name };
    store.set('hotel', S.hotel); S.acts = null; S.restos = null; S.transit = null; S.actsErr = S.restosErr = S.transitErr = null;
    closeSheet(); toast('Hôtel choisi 🏨'); go('autour');
  };
}

/* ================= ACTIVITÉS autour de l'hôtel ================= */
const RADII = [1, 3, 5, 10, 20];
function vAutour() {
  if (!S.hotel) { app.innerHTML = needHotel('les activités'); return bindGoto(); }
  const head = hotelBar() + `<h2 style="margin-top:4px">Que faire autour ?</h2>
  <div class="chips">${RADII.map(r => `<button class="chip ${S.radius === r ? 'on' : ''}" data-rad="${r}">${r} km</button>`).join('')}</div>`;
  if (S.actsErr) { app.innerHTML = head + errBox('Les activités ne se chargent pas pour le moment.', 'retry'); bindHead(); $('#retry').onclick = () => { S.actsErr = null; vAutour(); }; return; }
  if (!S.acts) { app.innerHTML = head + loader('Je cherche tout ce qu\'il y a à découvrir dans un rayon de ' + S.radius + ' km…'); bindHead(); return loadActs(); }

  const counts = {}; S.acts.forEach(a => counts[a.cat.k] = (counts[a.cat.k] || 0) + 1);
  const q = S.aq.toLowerCase();
  const list = S.acts.filter(a => (S.acat === 'all' || a.cat.k === S.acat) && (!q || a.name.toLowerCase().includes(q)));
  app.innerHTML = head + `<div class="chips">${[['all', 'Tout', S.acts.length], ...ACATS.filter(c => counts[c.k]).map(c => [c.k, c.e + ' ' + c.l, counts[c.k]])].map(([k, l, n]) => `<button class="chip ${S.acat === k ? 'on' : ''}" data-ac="${k}">${esc(l)}<span class="n">${n}</span></button>`).join('')}</div>
  <div class="tools"><input id="aq" placeholder="Rechercher une activité…" value="${esc(S.aq)}"><div class="seg"><button data-am="list" class="${S.amode === 'list' ? 'on' : ''}">Liste</button><button data-am="map" class="${S.amode === 'map' ? 'on' : ''}">Carte</button></div></div>
  ${S.amode === 'map' ? '<div id="amap" class="map"></div>' : ''}
  ${list.slice(0, S.ashow).map(actCard).join('') || '<div class="empty"><b>🧭</b>Rien trouvé ici. Agrandis le rayon pour voir plus loin.</div>'}
  ${list.length > S.ashow ? `<button class="btn alt more" id="amore">Voir plus (${list.length - S.ashow})</button>` : ''}
  <footer>Données © contributeurs OpenStreetMap. Les temps de trajet sont des estimations.</footer>`;
  bindHead();
  $$('[data-ac]').forEach(b => b.onclick = () => { S.acat = b.dataset.ac; S.ashow = 30; vAutour(); });
  $('#aq').oninput = e => { S.aq = e.target.value; clearTimeout(vAutour._t); vAutour._t = setTimeout(() => { const p = e.target.selectionStart; killMap(); vAutour(); const i = $('#aq'); i.focus(); i.setSelectionRange(p, p); }, 350); };
  $$('[data-am]').forEach(b => b.onclick = () => { S.amode = b.dataset.am; killMap(); vAutour(); });
  if ($('#amore')) $('#amore').onclick = () => { S.ashow += 30; killMap(); vAutour(); };
  $$('[data-a]').forEach(c => c.onclick = () => placeSheet(S.acts.find(a => a.id === c.dataset.a), 'act'));
  bindFav(S.acts, 'act');
  if (S.amode === 'map') drawMap('amap', S.hotel, list.slice(0, 300).map(a => ({ id: a.id, lat: a.lat, lon: a.lon, name: a.name, e: a.cat.e, c: '#FF6B5A' })), id => placeSheet(S.acts.find(a => a.id === id), 'act'), S.radius);
  function bindHead() {
    bindGoto();
    $$('[data-rad]').forEach(b => b.onclick = () => { S.radius = +b.dataset.rad; store.set('radius', S.radius); S.acts = null; S.actsErr = null; S.ashow = 30; killMap(); vAutour(); });
  }
}
function actCard(a) {
  const best = modes(a.d)[0];
  return `<div class="card item" data-a="${esc(a.id)}"><div class="ico" style="background:${a.cat.c}">${a.cat.e}</div><div class="t"><h3>${esc(a.name)}</h3>
  <div class="meta"><span class="tag">${esc(a.cat.l)}</span><span>${fmtKm(a.d)}</span>${best ? `<span>${best.e} ${fmtMin(best.min)}</span>` : ''}${a.star ? '<span>⭐ Incontournable</span>' : ''}</div></div>${favBtn(a)}</div>`;
}
async function loadActs() {
  const h = S.hotel, R = S.radius * 1000, A = around(R, h);
  const big = S.radius > 5;
  const q = `[out:json][timeout:30];(
nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"]["name"]${A};
nwr["historic"~"^(monument|castle|ruins|archaeological_site|fort|city_gate|palace|manor|tower|citywalls)$"]["name"]${A};
nwr["historic"="memorial"]["name"]["wikidata"]${A};
nwr["leisure"~"^(water_park|beach_resort)$"]["name"]${A};
nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]${big ? '["wikidata"]' : ''}${A};
nwr["natural"~"^(beach|waterfall)$"]["name"]${A};
node["natural"="peak"]["name"]${big ? '["wikidata"]' : ''}${A};
nwr["amenity"~"^(theatre|arts_centre)$"]["name"]${A};
nwr["amenity"="cinema"]["name"]${A};
nwr["amenity"="place_of_worship"]["name"]["wikidata"]${A};
);out tags center qt 900;`;
  try {
    let els = await pack('a', h, S.radius, big ? 'a' : 'ap');
    if (els) {
      els = els.filter(e => km(h, e) <= S.radius);
      if (big) els = els.filter(e => { const t = e.tags; return !((/^(park|garden|nature_reserve)$/.test(t.leisure || '') || t.natural === 'peak') && !t.wikidata); });
    } else els = await overpass(q);
    if (S.hotel !== h || S.radius * 1000 !== R) return;
    const seen = new Set();
    S.acts = els.map(norm).filter(a => a.name && a.lat != null).filter(a => { const k = a.name + '|' + a.lat.toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(a => { a.cat = acat(a.t); a.d = km(h, a); a.star = !!(a.t.wikipedia || a.t.wikidata || a.t.heritage); a.e = a.cat.e; return a; })
      .filter(a => !(a.cat.k === 'nature' && !a.star && a.t.leisure === 'park' && a.d > 3 && !a.t.website))
      .sort((x, y) => (y.star - x.star) || (x.d - y.d));
  } catch (e) { S.actsErr = e; }
  if (S.view === 'autour') vAutour();
}

/* ---------- fiche d'un lieu (activité ou resto) + comment y aller ---------- */
function placeSheet(p, kind) {
  if (!p) return;
  const t = p.t, w = site(t), ph = phone(t), h = S.hotel;
  const ms = modes(p.d);
  const wiki = t.wikipedia ? t.wikipedia.split(':') : null;
  const isR = kind === 'resto';
  const cu = isR ? cuisines(t) : [];
  openSheet(`<div class="ico" style="width:56px;height:56px;font-size:28px;margin-bottom:8px;background:${isR ? 'var(--coral-l)' : p.cat.c}">${p.e}</div>
  <h2>${esc(p.name)}</h2>
  <div class="meta"><span class="tag">${esc(isR ? RTYPES[p.type][0] : p.cat.l)}</span>${cu.slice(0, 4).map(c => `<span class="tag">${esc(cuiLabel(c))}</span>`).join('')}<span>à ${fmtKm(p.d)} de ton hôtel</span></div>
  ${t.description ? `<p>${esc(t.description)}</p>` : ''}
  <dl class="kv">
    ${addr(t) ? `<dt>Adresse</dt><dd>${esc(addr(t))}</dd>` : ''}
    ${t.opening_hours ? `<dt>Horaires</dt><dd>${esc(hours(t.opening_hours))}</dd>` : ''}
    ${t.fee ? `<dt>Entrée</dt><dd>${t.fee === 'no' ? 'Gratuite' : t.fee === 'yes' ? 'Payante' : esc(t.fee)}</dd>` : ''}
    ${ph ? `<dt>Téléphone</dt><dd><a href="tel:${esc(ph.replace(/\s/g, ''))}">${esc(ph)}</a></dd>` : ''}
    ${t.outdoor_seating === 'yes' ? '<dt>Terrasse</dt><dd>Oui ☀️</dd>' : ''}
    ${t.takeaway === 'yes' ? '<dt>À emporter</dt><dd>Oui</dd>' : ''}
    ${t.wheelchair === 'yes' ? '<dt>Accessible</dt><dd>Fauteuil roulant ♿</dd>' : ''}
  </dl>
  <h3 style="margin-top:14px">Comment y aller depuis ton hôtel</h3>
  <div class="modes">${ms.map(m => `<a class="mode" href="${esc(gmapsDir(h, p, m.k))}" target="_blank" rel="noopener"><i>${m.e}</i><div><b>${fmtMin(m.min)}</b><small>${esc(m.l)}</small></div></a>`).join('')}</div>
  <div id="near" class="sub">Je cherche les arrêts de transport les plus proches…</div>
  <div class="row" style="margin-top:12px">
    <button class="btn coral" id="addt">${inTrip(p.id) ? '♥ Dans Mon voyage' : '♡ Ajouter à Mon voyage'}</button>
    ${w ? `<a class="btn ghost" href="${esc(w)}" target="_blank" rel="noopener">🌐 Site officiel</a>` : ''}
    ${wiki && wiki.length === 2 ? `<a class="btn ghost" href="https://${esc(wiki[0])}.wikipedia.org/wiki/${esc(encodeURIComponent(wiki[1]))}" target="_blank" rel="noopener">📖 En savoir plus</a>` : `<a class="btn ghost" href="${esc(webSearch(p.name + ' ' + (S.dest ? S.dest.name : '')))}" target="_blank" rel="noopener">🔎 En savoir plus</a>`}
    <a class="btn ghost" href="${esc(placeLink(p))}" target="_blank" rel="noopener">📍 Carte</a>
  </div>
  <p class="sub" style="margin-top:12px">Temps estimés. Appuie sur un moyen de transport pour l'itinéraire exact.</p>`);
  $('#addt').onclick = () => {
    toggleTrip(p, kind); const on = inTrip(p.id);
    $('#addt').textContent = on ? '♥ Dans Mon voyage' : '♡ Ajouter à Mon voyage';
    $$('[data-fav]').filter(b => b.dataset.fav === p.id).forEach(b => { b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡'; });
  };
  nearStops(p).then(html => { const n = $('#near'); if (n) n.innerHTML = html; });
}
const STOP_KIND = t => {
  if (t.station === 'subway' || t.railway === 'subway_entrance' || t.subway === 'yes') return ['🚇', 'Métro'];
  if (t.railway === 'tram_stop' || t.tram === 'yes') return ['🚊', 'Tram'];
  if (t.railway === 'station' || t.railway === 'halt' || t.train === 'yes') return ['🚆', 'Train'];
  if (t.amenity === 'ferry_terminal') return ['⛴️', 'Bateau'];
  return ['🚏', 'Bus'];
};
async function nearStops(p) {
  try {
    const els = await overpass(`[out:json][timeout:25];(node["highway"="bus_stop"]["name"]${around(450, p)};nwr["railway"~"^(station|halt|tram_stop|subway_entrance)$"]["name"]${around(900, p)};nwr["amenity"="ferry_terminal"]${around(900, p)};);out tags center 60;`);
    const seen = new Set();
    const st = els.map(norm).filter(s => s.name && s.lat != null).map(s => Object.assign(s, { d: km(p, s), k: STOP_KIND(s.t) }))
      .sort((a, b) => a.d - b.d).filter(s => { const k = s.k[1] + s.name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    if (!st.length) return 'Aucun arrêt de transport en commun très proche : le taxi ou la voiture sera plus simple.';
    return '<b>Arrêts les plus proches du lieu :</b><ul class="list">' + st.map(s => `<li><span>${s.k[0]} ${esc(s.k[1])} · ${esc(s.name)}</span><span>${fmtKm(s.d)} · ${fmtMin(s.d * 1.3 / 4.8 * 60)} à pied</span></li>`).join('') + '</ul>';
  } catch (e) { return ''; }
}

/* ================= RESTOS ================= */
const RRADII = [0.5, 1, 2, 5];
function vRestos() {
  if (!S.hotel) { app.innerHTML = needHotel('les restaurants'); return bindGoto(); }
  const head = hotelBar() + `<h2 style="margin-top:4px">Où manger ?</h2>
  <div class="chips">${RRADII.map(r => `<button class="chip ${S.rradius === r ? 'on' : ''}" data-rr="${r}">${r < 1 ? '500 m' : r + ' km'}</button>`).join('')}</div>`;
  if (S.restosErr) { app.innerHTML = head + errBox('Les restaurants ne se chargent pas pour le moment.', 'retry'); bindHead(); $('#retry').onclick = () => { S.restosErr = null; vRestos(); }; return; }
  if (!S.restos) { app.innerHTML = head + loader('Je cherche tous les restos autour de ton hôtel…'); bindHead(); return loadRestos(); }

  const tc = {}, cc = {};
  S.restos.forEach(r => { tc[r.type] = (tc[r.type] || 0) + 1; r.cu.forEach(c => cc[c] = (cc[c] || 0) + 1); });
  const topC = Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const q = S.rq.toLowerCase();
  const list = S.restos.filter(r => (S.rtype === 'all' || r.type === S.rtype) && (S.rcui === 'all' || r.cu.includes(S.rcui)) && (!q || r.name.toLowerCase().includes(q) || r.cu.some(c => cuiLabel(c).toLowerCase().includes(q))));
  app.innerHTML = head + `<div class="chips">${[['all', 'Tous', S.restos.length], ...Object.keys(RTYPES).filter(k => tc[k]).map(k => [k, RTYPES[k][1] + ' ' + RTYPES[k][0], tc[k]])].map(([k, l, n]) => `<button class="chip ${S.rtype === k ? 'on' : ''}" data-rt="${k}">${esc(l)}<span class="n">${n}</span></button>`).join('')}</div>
  ${topC.length ? `<div class="chips">${[['all', 'Toutes les cuisines']].concat(topC.map(([c]) => [c, cuiLabel(c)])).map(([k, l]) => `<button class="chip ${S.rcui === k ? 'on' : ''}" data-rc="${esc(k)}">${esc(l)}</button>`).join('')}</div>` : ''}
  <div class="tools"><input id="rq" placeholder="Nom, cuisine (pizza, sushi…)" value="${esc(S.rq)}"><div class="seg"><button data-rm="list" class="${S.rmode === 'list' ? 'on' : ''}">Liste</button><button data-rm="map" class="${S.rmode === 'map' ? 'on' : ''}">Carte</button></div></div>
  ${S.rmode === 'map' ? '<div id="rmap" class="map"></div>' : ''}
  ${list.slice(0, S.rshow).map(restoCard).join('') || '<div class="empty"><b>🍽️</b>Aucun resto ne correspond. Agrandis le rayon.</div>'}
  ${list.length > S.rshow ? `<button class="btn alt more" id="rmore">Voir plus (${list.length - S.rshow})</button>` : ''}
  <footer>Données © contributeurs OpenStreetMap. Pense à réserver pour le soir.</footer>`;
  bindHead();
  $$('[data-rt]').forEach(b => b.onclick = () => { S.rtype = b.dataset.rt; S.rshow = 30; vRestos(); });
  $$('[data-rc]').forEach(b => b.onclick = () => { S.rcui = b.dataset.rc; S.rshow = 30; vRestos(); });
  $('#rq').oninput = e => { S.rq = e.target.value; clearTimeout(vRestos._t); vRestos._t = setTimeout(() => { const p = e.target.selectionStart; killMap(); vRestos(); const i = $('#rq'); i.focus(); i.setSelectionRange(p, p); }, 350); };
  $$('[data-rm]').forEach(b => b.onclick = () => { S.rmode = b.dataset.rm; killMap(); vRestos(); });
  if ($('#rmore')) $('#rmore').onclick = () => { S.rshow += 30; killMap(); vRestos(); };
  $$('[data-r]').forEach(c => c.onclick = () => placeSheet(S.restos.find(r => r.id === c.dataset.r), 'resto'));
  bindFav(S.restos, 'resto');
  if (S.rmode === 'map') drawMap('rmap', S.hotel, list.slice(0, 300).map(r => ({ id: r.id, lat: r.lat, lon: r.lon, name: r.name, e: r.e, c: '#E07A3F' })), id => placeSheet(S.restos.find(r => r.id === id), 'resto'), S.rradius);
  function bindHead() {
    bindGoto();
    $$('[data-rr]').forEach(b => b.onclick = () => { S.rradius = +b.dataset.rr; store.set('rradius', S.rradius); S.restos = null; S.restosErr = null; S.rshow = 30; killMap(); vRestos(); });
  }
}
function restoCard(r) {
  return `<div class="card item" data-r="${esc(r.id)}"><div class="ico" style="background:var(--coral-l)">${r.e}</div><div class="t"><h3>${esc(r.name)}</h3>
  <div class="meta"><span>${esc(RTYPES[r.type][0])}</span>${r.cu.slice(0, 2).map(c => `<span class="tag">${esc(cuiLabel(c))}</span>`).join('')}<span>${fmtKm(r.d)} · 🚶 ${fmtMin(r.d * 1.3 / 4.8 * 60)}</span>${r.t.outdoor_seating === 'yes' ? '<span>☀️ Terrasse</span>' : ''}</div></div>${favBtn(r)}</div>`;
}
async function loadRestos() {
  const h = S.hotel, R = S.rradius * 1000;
  const q = `[out:json][timeout:30];nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|biergarten|food_court)$"]["name"]${around(R, h)};out tags center qt 1200;`;
  try {
    let els = await pack('r', h, S.rradius);
    els = els ? els.filter(e => km(h, e) <= S.rradius) : await overpass(q);
    if (S.hotel !== h || S.rradius * 1000 !== R) return;
    S.restos = els.map(norm).filter(r => r.name && r.lat != null).map(r => { r.type = RTYPES[r.t.amenity] ? r.t.amenity : 'restaurant'; r.e = RTYPES[r.type][1]; r.cu = cuisines(r.t); r.d = km(h, r); return r; })
      .sort((a, b) => (a.type === 'restaurant' ? 0 : 1) - (b.type === 'restaurant' ? 0 : 1) || a.d - b.d);
  } catch (e) { S.restosErr = e; }
  if (S.view === 'restos') vRestos();
}

/* ================= TRANSPORTS autour de l'hôtel ================= */
const TGROUPS = [
  { k: 'metro', e: '🚇', l: 'Métro' }, { k: 'tram', e: '🚊', l: 'Tram' }, { k: 'train', e: '🚆', l: 'Gares et trains' }, { k: 'bus', e: '🚏', l: 'Arrêts de bus' },
  { k: 'velo', e: '🚲', l: 'Vélos en libre-service et location' }, { k: 'trott', e: '🛴', l: 'Trottinettes' }, { k: 'taxi', e: '🚕', l: 'Stations de taxis' },
  { k: 'voiture', e: '🚙', l: 'Location de voitures' }, { k: 'bateau', e: '⛴️', l: 'Bateaux et ferries' }, { k: 'avion', e: '✈️', l: 'Aéroports' }
];
function tkind(t) {
  if (t.aeroway === 'aerodrome') return 'avion';
  if (t.amenity === 'ferry_terminal') return 'bateau';
  if (t.amenity === 'bicycle_rental') return 'velo';
  if (t.amenity === 'kick-scooter_rental') return 'trott';
  if (t.amenity === 'taxi') return 'taxi';
  if (t.amenity === 'car_rental') return 'voiture';
  const k = STOP_KIND(t)[1];
  return k === 'Métro' ? 'metro' : k === 'Tram' ? 'tram' : k === 'Train' ? 'train' : k === 'Bateau' ? 'bateau' : 'bus';
}
function vBouger() {
  if (!S.hotel) { app.innerHTML = needHotel('les moyens de transport'); return bindGoto(); }
  const h = S.hotel;
  const head = hotelBar() + '<h2 style="margin-top:4px">Se déplacer depuis ton hôtel</h2><p class="sub">Tous les moyens de transport proches, pour rejoindre tes activités et tes restos.</p>';
  if (S.transitErr) { app.innerHTML = head + errBox('Les transports ne se chargent pas pour le moment.', 'retry'); bindGoto(); $('#retry').onclick = () => { S.transitErr = null; vBouger(); }; return; }
  if (!S.transit) { app.innerHTML = head + loader('Je cherche les métros, bus, vélos, taxis…'); bindGoto(); return loadTransit(); }
  const by = {}; S.transit.forEach(x => (by[x.k] = by[x.k] || []).push(x));
  const blocks = TGROUPS.filter(g => by[g.k]).map(g => {
    const it = by[g.k].slice(0, g.k === 'bus' ? 8 : 6);
    return `<div class="card"><h3>${g.e} ${esc(g.l)} <span class="sub">· ${by[g.k].length}</span></h3><ul class="list">${it.map(x => `<li><span>${esc(x.label)}</span><span>${fmtKm(x.d)}${x.d < 3 ? ' · 🚶 ' + fmtMin(x.d * 1.3 / 4.8 * 60) : ''}</span></li>`).join('')}</ul></div>`;
  }).join('');
  app.innerHTML = head + (blocks || '<div class="empty"><b>🚕</b>Aucun transport public trouvé tout près : le taxi ou la location de voiture seront plus pratiques.</div>') + `
  <div class="card"><h3>📱 Applis utiles sur place</h3><p class="sub" style="margin:6px 0 0">Pour les horaires en direct et les itinéraires exacts, utilise Google Maps (bouton ci-dessous) ou l'appli officielle des transports de la ville. Pour les taxis, une appli de VTC disponible dans le pays.</p>
  <div class="row" style="margin-top:10px"><a class="btn" href="https://www.google.com/maps/@?api=1&map_action=map&center=${h.lat},${h.lon}&zoom=15&layer=transit" target="_blank" rel="noopener">🗺️ Plan des transports</a></div></div>
  <footer>Données © contributeurs OpenStreetMap</footer>`;
  bindGoto();
}
async function loadTransit() {
  const h = S.hotel;
  const q = `[out:json][timeout:45];(
node["highway"="bus_stop"]["name"]${around(700, h)};
nwr["railway"~"^(station|halt|tram_stop|subway_entrance)$"]["name"]${around(1500, h)};
nwr["public_transport"="station"]["name"]${around(1500, h)};
nwr["amenity"~"^(bicycle_rental|kick-scooter_rental|taxi|car_rental)$"]${around(2000, h)};
nwr["amenity"="ferry_terminal"]${around(5000, h)};
nwr["aeroway"="aerodrome"]["iata"]${around(60000, h)};
);out tags center 400;`;
  try {
    const els = await overpass(q);
    if (S.hotel !== h) return;
    const seen = new Set();
    S.transit = els.map(norm).filter(x => x.lat != null).map(x => {
      x.k = tkind(x.t); x.d = km(h, x);
      const op = x.t.operator || x.t.network || x.t.brand || '';
      x.label = x.k === 'avion' ? (x.name || 'Aéroport') + (x.t.iata ? ' (' + x.t.iata + ')' : '') : (x.name || op || ({ velo: 'Station de vélos', trott: 'Trottinettes', taxi: 'Station de taxis', voiture: 'Agence de location', bateau: 'Embarcadère' }[x.k] || 'Arrêt'));
      if (x.t.route_ref && (x.k === 'bus' || x.k === 'tram')) x.label += ' · lignes ' + x.t.route_ref.replace(/;/g, ', ');
      return x;
    }).sort((a, b) => a.d - b.d).filter(x => { const k = x.k + x.label; if (seen.has(k)) return false; seen.add(k); return true; });
  } catch (e) { S.transitErr = e; }
  if (S.view === 'bouger') vBouger();
}

/* ================= MON VOYAGE ================= */
function vVoyage() {
  const T = S.trip, h = S.hotel;
  if (!h && !T.items.length) {
    app.innerHTML = `<div class="empty"><b>🧳</b><h2 style="margin:0 0 6px">Mon voyage</h2>Ici, tu retrouveras ton hôtel et tous tes coups de cœur (♡), rangés jour par jour.<div style="margin-top:14px"><button class="btn" data-goto="explorer">Commencer mon voyage</button></div></div>`;
    return bindGoto();
  }
  const days = Array.from({ length: T.days }, (_, i) => i + 1);
  const group = d => T.items.filter(i => i.day === d);
  const item = i => `<div class="card item"><div class="ico" style="background:${i.kind === 'resto' ? 'var(--coral-l)' : 'var(--sea-l)'}">${i.e || '📍'}</div><div class="t"><h3>${esc(i.name)}</h3><div class="meta">${h ? `<span>${fmtKm(km(h, i))} de l'hôtel</span>` : ''}<a href="${esc(placeLink(i))}" target="_blank" rel="noopener">Carte</a></div>
    <div style="margin-top:6px"><select class="daysel" data-day="${esc(i.id)}"><option value="0">Pas encore prévu</option>${days.map(d => `<option value="${d}"${i.day === d ? ' selected' : ''}>Jour ${d}</option>`).join('')}</select></div></div>
    <button class="fav on" data-del="${esc(i.id)}" aria-label="Retirer">♥</button></div>`;
  const route = d => {
    const it = group(d); if (!h || !it.length) return '';
    const wp = it.slice(0, 9).map(i => i.lat + ',' + i.lon).join('|');
    return `https://www.google.com/maps/dir/?api=1&origin=${h.lat},${h.lon}&destination=${h.lat},${h.lon}&waypoints=${encodeURIComponent(wp)}&travelmode=walking`;
  };
  app.innerHTML = `<h2 style="margin-top:4px">Mon voyage${S.dest ? ' à ' + esc(S.dest.name) : ''}</h2>
  ${h ? `<div class="hotelbar"><div class="ico" style="background:rgba(255,255,255,.14)">🏨</div><div class="t"><small>Mon hôtel</small><b>${esc(h.name)}</b></div><button class="btn small" data-goto="explorer">Changer</button></div>` : ''}
  <div class="tools"><span>Durée du séjour</span><select id="ndays">${Array.from({ length: 21 }, (_, i) => i + 1).map(n => `<option${n === T.days ? ' selected' : ''}>${n}</option>`).join('')}</select><span>jour${T.days > 1 ? 's' : ''}</span></div>
  ${days.map(d => { const g = group(d); const r = route(d); return `<div class="day"><span>📅 Jour ${d}</span>${r ? `<a class="btn small alt" href="${esc(r)}" target="_blank" rel="noopener">🗺️ Itinéraire du jour</a>` : ''}</div>${g.map(item).join('') || '<p class="sub">Rien de prévu. Choisis un jour sous tes coups de cœur.</p>'}`; }).join('')}
  ${group(0).length ? `<div class="day"><span>💡 Coups de cœur à placer</span></div>${group(0).map(item).join('')}` : ''}
  ${T.items.length ? '' : '<div class="info">Ajoute des activités et des restos avec le ♡ pour les retrouver ici.</div>'}
  <div class="row" style="margin:16px 0"><button class="btn coral" id="share">📤 Partager mon voyage</button>${T.items.length ? '<button class="btn ghost" id="clear">Tout effacer</button>' : ''}</div>
  <footer>Ton voyage est enregistré sur ce téléphone.</footer>`;
  bindGoto();
  $('#ndays').onchange = e => { T.days = +e.target.value; T.items.forEach(i => { if (i.day > T.days) i.day = 0; }); saveTrip(); vVoyage(); };
  $$('[data-day]').forEach(s => s.onchange = () => { const i = T.items.find(x => x.id === s.dataset.day); if (i) { i.day = +s.value; saveTrip(); vVoyage(); } });
  $$('[data-del]').forEach(b => b.onclick = () => { T.items = T.items.filter(x => x.id !== b.dataset.del); saveTrip(); vVoyage(); });
  if ($('#clear')) $('#clear').onclick = () => {
    openSheet(`<h2>Tout effacer ?</h2><p>Tes coups de cœur seront supprimés de ce téléphone.</p><div class="row"><button class="btn coral" id="yes">Oui, tout effacer</button><button class="btn ghost" id="no">Annuler</button></div>`);
    $('#yes').onclick = () => { T.items = []; saveTrip(); closeSheet(); vVoyage(); };
    $('#no').onclick = closeSheet;
  };
  $('#share').onclick = async () => {
    const txt = `Mon voyage${S.dest ? ' à ' + S.dest.name : ''} avec Onygo ✈️\n` + (h ? `🏨 ${h.name}\n` : '') +
      days.map(d => { const g = group(d); return g.length ? `\nJour ${d} :\n` + g.map(i => `• ${i.name}`).join('\n') : ''; }).join('') +
      (group(0).length ? '\n\nÀ voir aussi :\n' + group(0).map(i => '• ' + i.name).join('\n') : '') + '\n\n' + location.origin + location.pathname;
    try { if (navigator.share) { await navigator.share({ title: 'Mon voyage', text: txt }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(txt); toast('Voyage copié : colle-le dans un message 📋'); } catch (e) { toast('Impossible de copier sur cet appareil'); }
  };
}

/* ---------- démarrage ---------- */
dropHotelIfFar();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

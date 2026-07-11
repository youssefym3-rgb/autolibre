'use strict';
/* ============================================================================
   sync.js — MOTOR DE SINCRONIZACIÓN + COLA DE TRABAJOS + CRON
   ----------------------------------------------------------------------------
   Orquesta la importación de stock, desacoplado del resto de la app:
     connectors (formato)  →  normalize (mapeo)  →  store (persistencia)
   Expone una interfaz de COLA (queue.add) y de PLANIFICADOR (startScheduler)
   pensadas para ser sustituidas por BullMQ + Redis sin cambiar los llamadores:
   solo hay que reimplementar `queue` y `startScheduler` con BullMQ.
   ========================================================================== */
const store = require('./store.js');
const connectors = require('./connectors.js');

/* Campos de destino que el profesional puede mapear desde su feed. */
const FIELDS = ['external_ref', 'brand', 'model', 'year', 'price', 'km', 'fuel', 'gear', 'body', 'power', 'color', 'province', 'doors', 'seats', 'desc', 'photos', 'extras', 'warranty', 'noAccidents'];

/* Sugerencia automática de mapeo por nombre de columna (acelera el alta). */
const HINTS = {
  external_ref: ['ref', 'referencia', 'id', 'idvehiculo', 'stocknumber', 'codigo', 'sku'],
  brand: ['marca', 'make', 'brand', 'fabricante'],
  model: ['modelo', 'model', 'version', 'modelo_version'],
  year: ['año', 'ano', 'anio', 'year', 'matriculacion', 'fecha'],
  price: ['precio', 'price', 'pvp', 'importe'],
  km: ['km', 'kms', 'kilometros', 'mileage', 'kilometraje'],
  fuel: ['combustible', 'fuel', 'carburante'],
  gear: ['cambio', 'gearbox', 'transmision', 'transmission'],
  body: ['carroceria', 'body', 'tipo', 'bodytype'],
  power: ['cv', 'potencia', 'power', 'hp', 'caballos'],
  color: ['color', 'colour'],
  province: ['provincia', 'province', 'ubicacion', 'location', 'ciudad', 'city'],
  doors: ['puertas', 'doors'],
  seats: ['plazas', 'seats', 'asientos'],
  desc: ['descripcion', 'description', 'observaciones', 'comentarios', 'desc'],
  photos: ['fotos', 'photos', 'imagenes', 'images', 'imagen', 'image', 'foto', 'url_imagenes'],
  extras: ['extras', 'equipamiento', 'options', 'equipment']
};
/* Normaliza texto para comparar nombres de columna: quita tildes/ñ y símbolos
   ("Año", "año", "AÑO", "precio_€" → "ano", "ano", "ano", "precio"). */
const normTxt = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
function suggestMapping(columns) {
  const map = {};
  const low = columns.map(c => ({ raw: c, norm: normTxt(c) }));
  for (const field of Object.keys(HINTS)) {
    const hs = HINTS[field].map(normTxt);
    const hit = low.find(c => hs.some(h => c.norm === h)) || low.find(c => hs.some(h => c.norm.includes(h)));
    if (hit) map[field] = hit.raw;
  }
  return map;
}

/* Etiqueta ambiental DGT aproximada (misma lógica que el alta manual). */
function envFor(fuel, year) {
  fuel = (fuel || '').toLowerCase();
  if (fuel.includes('eléctric') || fuel.includes('electric') || fuel.includes('enchuf')) return '0';
  if (fuel.includes('híbr') || fuel.includes('hibr') || fuel.includes('glp') || fuel.includes('gnc')) return 'ECO';
  if (fuel.includes('diés') || fuel.includes('dies')) return year >= 2015 ? 'C' : 'B';
  return year >= 2006 ? 'C' : 'B';
}

const toInt = v => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; };
function splitPhotos(v) {
  if (!v) return [];
  return String(v).split(/[|,;\s]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)).slice(0, 20);
}

/* Convierte una fila cruda del feed en un coche normalizado, según el mapeo. */
function normalize(raw, mapping) {
  const g = field => { const col = mapping[field]; return col ? raw[col] : undefined; };
  const year = toInt(g('year')) || null;
  const fuel = (g('fuel') || '').toString().trim();
  const car = {
    external_ref: (g('external_ref') || '').toString().trim(),
    brand: (g('brand') || '').toString().trim(),
    model: (g('model') || '').toString().trim(),
    year: year,
    price: toInt(g('price')),
    km: toInt(g('km')),
    power: toInt(g('power')) || 100,
    fuel, gear: (g('gear') || '').toString().trim(),
    body: (g('body') || 'Berlina').toString().trim(),
    color: (g('color') || '—').toString().trim(),
    province: (g('province') || '').toString().trim(),
    doors: toInt(g('doors')) || 5,
    seats: toInt(g('seats')) || 5,
    desc: (g('desc') || '').toString().trim(),
    photos: splitPhotos(g('photos')),
    extras: (g('extras') ? String(g('extras')).split(/[|,;]+/).map(s => s.trim()).filter(Boolean) : []),
    warranty: false, noAccidents: false
  };
  car.env = envFor(fuel, year || 0);
  return car;
}

/* Validación mínima de una fila para no crear anuncios basura. */
function validate(car) {
  if (!car.external_ref) return 'sin referencia externa (external_ref)';
  if (!car.brand || !car.model) return 'falta marca o modelo';
  if (!car.price) return 'falta precio';
  return null;
}

/* -------------------- PREVIEW (para la pantalla de mapeo) -------------------- */
async function previewFeed({ type, source, text, item_path }) {
  const rows = await connectors.parse(type, { source, text, item_path });
  const columns = connectors.detectColumns(rows);
  return {
    total: rows.length,
    columns,
    sample: rows.slice(0, 5),
    suggestedMapping: suggestMapping(columns),
    fields: FIELDS
  };
}

/* -------------------- NÚCLEO: ejecutar una sincronización --------------------
   opts.text -> contenido en línea (para feeds de archivo/pegado CSV/XML/JSON).
   Los feeds de tipo 'url' se releen desde su fuente y por tanto son re-sync-ables;
   los de archivo solo se importan una vez (no hay origen al que volver). */
async function runSync(feedId, opts = {}) {
  const feed = await store.getFeed(feedId);
  if (!feed) throw new Error('Feed no encontrado');
  const mapping = JSON.parse(feed.mapping || '{}');
  const report = { total: 0, created: 0, updated: 0, sold: 0, errors: [], ts: Date.now() };
  await store.updateFeed(feedId, { status: 'running' });
  try {
    const seller_type = await store.ownerType(feed.owner_id);
    if (feed.type !== 'url' && !opts.text) throw new Error('Este feed es de archivo y no puede resincronizarse. Para sincronización automática usa una URL de feed.');
    const rows = await connectors.parse(feed.type, { source: feed.source, text: opts.text, item_path: feed.item_path });
    report.total = rows.length;
    const seenRefs = new Set();
    for (const raw of rows) {
      const car = normalize(raw, mapping);
      const err = validate(car);
      if (err) { if (report.errors.length < 50) report.errors.push({ ref: car.external_ref || '?', error: err }); continue; }
      seenRefs.add(car.external_ref);
      car.owner_id = feed.owner_id; car.feed_id = feedId; car.seller_type = seller_type;
      try {
        const existing = await store.findCarIdByRef(feed.owner_id, car.external_ref);
        if (existing) { await store.updateCarFromFeed(existing, car); report.updated++; }
        else { await store.insertCar(car); report.created++; }
      } catch (e) { if (report.errors.length < 50) report.errors.push({ ref: car.external_ref, error: e.message }); }
    }
    // Bajas: coches activos del feed que ya NO aparecen → marcar como vendidos
    const active = await store.activeRefsByFeed(feedId);
    const goneIds = active.filter(a => !seenRefs.has(a.external_ref)).map(a => a.id);
    report.sold = await store.markSold(goneIds);

    const next = feed.auto ? Date.now() + (feed.interval_min || 360) * 60000 : 0;
    await store.updateFeed(feedId, { status: 'ok', last_sync: report.ts, next_sync: next, last_result: report });
  } catch (e) {
    report.fatal = e.message;
    await store.updateFeed(feedId, { status: 'error', last_sync: report.ts, last_result: report });
  }
  return report;
}

/* ============================================================================
   COLA DE TRABAJOS  (interfaz sustituible por BullMQ)
   ----------------------------------------------------------------------------
   Implementación actual: cola en memoria con un único worker secuencial (no
   satura la instancia). Para escalar: reimplementar `add` publicando en BullMQ
   y mover `worker` a un proceso aparte consumiendo la misma cola Redis.
   ========================================================================== */
const queue = (() => {
  const jobs = [];
  let running = false;
  async function worker() {
    if (running) return;
    running = true;
    while (jobs.length) {
      const job = jobs.shift();
      try { await runSync(job.feedId); }
      catch (e) { console.error('[sync] job error', e.message); }
    }
    running = false;
  }
  return {
    add(feedId) { jobs.push({ feedId, ts: Date.now() }); setImmediate(worker); return true; },
    size() { return jobs.length; }
  };
})();

/* ============================================================================
   PLANIFICADOR / CRON  (interfaz sustituible por BullMQ repeatable jobs)
   ----------------------------------------------------------------------------
   Revisa periódicamente los feeds con auto-sync vencidos y los encola.
   Para escalar: sustituir por jobs repetibles de BullMQ (cron por feed).
   NOTA: en Render Free la instancia se duerme sin tráfico; para cron fiable a
   escala conviene un worker dedicado o un ping keep-alive.
   ========================================================================== */
function startScheduler(everyMs = 60000) {
  setInterval(async () => {
    try {
      const due = await store.feedsDue(Date.now());
      for (const f of due) queue.add(f.id);
    } catch (e) { console.error('[scheduler]', e.message); }
  }, everyMs).unref();
}

module.exports = { previewFeed, runSync, queue, startScheduler, suggestMapping, FIELDS };
/* fin del módulo de sincronización · v1.0.1 */

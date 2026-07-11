'use strict';
/* ============================================================================
   store.js — CAPA DE ACCESO A DATOS (Data Access Layer)
   ----------------------------------------------------------------------------
   Aísla TODO el acceso a base de datos del subsistema de importación/stock.
   Hoy usa node:sqlite (síncrono) pero expone una interfaz ASÍNCRONA (Promesas),
   de modo que migrar a PostgreSQL en el futuro consiste en reescribir SOLO este
   archivo (por ejemplo con `pg`), sin tocar sync.js, connectors.js ni server.js.

   Contrato: todos los métodos devuelven Promesas. Los que consultan devuelven
   filas planas (objetos). No hay lógica de negocio aquí, solo persistencia.
   ========================================================================== */
const { db } = require('./db.js');

/* Envoltorio para dejar explícito el "punto de swap" a un driver asíncrono. */
const P = v => Promise.resolve(v);

const store = {
  /* ---------------- FEEDS ---------------- */
  listFeeds(ownerId) {
    return P(db.prepare('SELECT * FROM feeds WHERE owner_id=? ORDER BY created DESC').all(ownerId));
  },
  getFeed(id) {
    return P(db.prepare('SELECT * FROM feeds WHERE id=?').get(id) || null);
  },
  createFeed(f) {
    const info = db.prepare(`INSERT INTO feeds(owner_id,name,type,source,mapping,item_path,auto,interval_min,next_sync,status,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.owner_id, f.name || 'Mi stock', f.type || 'csv', f.source || '',
      JSON.stringify(f.mapping || {}), f.item_path || '',
      f.auto ? 1 : 0, +f.interval_min || 360, 0, 'idle', Date.now());
    return P(info.lastInsertRowid);
  },
  updateFeed(id, patch) {
    const cols = ['name', 'type', 'source', 'mapping', 'item_path', 'auto', 'interval_min', 'last_sync', 'next_sync', 'last_result', 'status'];
    const sets = [], args = [];
    for (const c of cols) if (patch[c] !== undefined) {
      sets.push(`${c}=?`);
      args.push(c === 'mapping' || c === 'last_result' ? JSON.stringify(patch[c]) : (c === 'auto' ? (patch[c] ? 1 : 0) : patch[c]));
    }
    if (sets.length) { args.push(id); db.prepare(`UPDATE feeds SET ${sets.join(',')} WHERE id=?`).run(...args); }
    return P(true);
  },
  deleteFeed(id) {
    db.prepare('DELETE FROM feeds WHERE id=?').run(id);
    return P(true);
  },
  /* Feeds con auto-sync cuya próxima ejecución ya venció (para el cron). */
  feedsDue(now) {
    return P(db.prepare("SELECT * FROM feeds WHERE auto=1 AND status<>'running' AND next_sync>0 AND next_sync<=?").all(now));
  },

  /* ---------------- COCHES (upsert por referencia externa) ---------------- */
  /* Devuelve el id interno de un coche por (propietario, referencia del feed). */
  findCarIdByRef(ownerId, extRef) {
    const r = db.prepare('SELECT id FROM cars WHERE owner_id=? AND external_ref=?').get(ownerId, extRef);
    return P(r ? r.id : null);
  },
  /* Todas las referencias externas activas de un feed (para detectar bajas). */
  activeRefsByFeed(feedId) {
    const rows = db.prepare("SELECT id, external_ref FROM cars WHERE feed_id=? AND status='active' AND external_ref IS NOT NULL").all(feedId);
    return P(rows);
  },
  insertCar(c) {
    const info = db.prepare(`INSERT INTO cars(owner_id,feed_id,external_ref,brand,model,year,fuel,gear,body,price,km,power,color,province,doors,seats,env,extras,photos,warranty,certified,no_accidents,seller_type,descr,featured,status,views,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.owner_id, c.feed_id, c.external_ref, c.brand, c.model, c.year, c.fuel, c.gear, c.body,
      c.price, c.km, c.power, c.color, c.province, c.doors, c.seats, c.env,
      JSON.stringify(c.extras || []), JSON.stringify(c.photos || []),
      c.warranty ? 1 : 0, 0, c.noAccidents ? 1 : 0, c.seller_type || 'pro',
      c.desc || '', 0, 'active', 0, Date.now());
    return P(info.lastInsertRowid);
  },
  updateCarFromFeed(id, c) {
    db.prepare(`UPDATE cars SET brand=?,model=?,year=?,fuel=?,gear=?,body=?,price=?,km=?,power=?,color=?,province=?,doors=?,seats=?,env=?,extras=?,photos=?,warranty=?,no_accidents=?,descr=?,status='active' WHERE id=?`).run(
      c.brand, c.model, c.year, c.fuel, c.gear, c.body, c.price, c.km, c.power, c.color, c.province,
      c.doors, c.seats, c.env, JSON.stringify(c.extras || []), JSON.stringify(c.photos || []),
      c.warranty ? 1 : 0, c.noAccidents ? 1 : 0, c.desc || '', id);
    return P(true);
  },
  /* Marca coches como vendidos (los que ya no vienen en el feed). */
  markSold(ids) {
    if (!ids.length) return P(0);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE cars SET status='sold' WHERE id IN (${ph})`).run(...ids);
    return P(ids.length);
  },
  ownerType(ownerId) {
    const r = db.prepare('SELECT type FROM users WHERE id=?').get(ownerId);
    return P(r ? r.type : 'pro');
  }
};

module.exports = store;

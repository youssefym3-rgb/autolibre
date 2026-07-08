'use strict';
const { DatabaseSync } = require('node:sqlite');
const { scryptSync, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.AUTOLIBRE_DATA || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'autolibre.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'private', plan TEXT NOT NULL DEFAULT 'Free',
  phone TEXT DEFAULT '', city TEXT DEFAULT '', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cars(
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL,
  brand TEXT, model TEXT, year INTEGER, fuel TEXT, gear TEXT, body TEXT,
  price INTEGER, km INTEGER, power INTEGER, color TEXT, province TEXT,
  doors INTEGER, seats INTEGER, env TEXT,
  extras TEXT DEFAULT '[]', photos TEXT DEFAULT '[]',
  warranty INTEGER DEFAULT 0, certified INTEGER DEFAULT 0, no_accidents INTEGER DEFAULT 0,
  seller_type TEXT DEFAULT 'private',
  descr TEXT DEFAULT '', featured INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
  views INTEGER DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites(
  user_id INTEGER NOT NULL, car_id INTEGER NOT NULL, PRIMARY KEY(user_id, car_id)
);
CREATE TABLE IF NOT EXISTS threads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL, seller_id INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL, from_id INTEGER NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL,
  created INTEGER NOT NULL, notified INTEGER DEFAULT 0
);
`);

/* ---- Migraciones (columnas nuevas sobre bases existentes) ---- */
function addCol(table, colDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch (e) { /* ya existe */ }
}
addCol('users', "role TEXT NOT NULL DEFAULT 'user'");        // 'user' | 'admin'
addCol('users', 'verified INTEGER NOT NULL DEFAULT 0');      // email verificado
addCol('users', 'banned INTEGER NOT NULL DEFAULT 0');        // bloqueado por admin

/* Índices para rendimiento con muchos anuncios */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_cars_status ON cars(status);
CREATE INDEX IF NOT EXISTS idx_cars_owner ON cars(owner_id);
CREATE INDEX IF NOT EXISTS idx_cars_brand ON cars(brand);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
`);

/* El email indicado en ADMIN_EMAIL se convierte en administrador al arrancar */
function promoteAdmin() {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) return;
  try { db.prepare("UPDATE users SET role='admin' WHERE email=?").run(adminEmail); } catch (e) {}
}

/* Limpieza de los datos de demostración (usuarios y anuncios falsos del prototipo) */
function cleanDemoData() {
  const DEMO_EMAILS = ['ventas@autopremium.es', 'info@auto-norte.es', 'carlos@email.com'];
  try {
    const demoIds = DEMO_EMAILS
      .map(e => db.prepare('SELECT id FROM users WHERE email=?').get(e))
      .filter(Boolean).map(r => r.id);
    if (!demoIds.length) return;
    const ph = demoIds.map(() => '?').join(',');
    const carIds = db.prepare(`SELECT id FROM cars WHERE owner_id IN (${ph})`).all(...demoIds).map(r => r.id);
    if (carIds.length) {
      const cph = carIds.map(() => '?').join(',');
      const threadIds = db.prepare(`SELECT id FROM threads WHERE car_id IN (${cph})`).all(...carIds).map(r => r.id);
      if (threadIds.length) {
        const tph = threadIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM messages WHERE thread_id IN (${tph})`).run(...threadIds);
        db.prepare(`DELETE FROM threads WHERE id IN (${tph})`).run(...threadIds);
      }
      db.prepare(`DELETE FROM favorites WHERE car_id IN (${cph})`).run(...carIds);
      db.prepare(`DELETE FROM cars WHERE id IN (${cph})`).run(...carIds);
    }
    db.prepare(`DELETE FROM favorites WHERE user_id IN (${ph})`).run(...demoIds);
    db.prepare(`DELETE FROM alerts WHERE user_id IN (${ph})`).run(...demoIds);
    db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...demoIds);
    console.log(`Datos de demostración eliminados: ${demoIds.length} usuarios, ${carIds.length} anuncios.`);
  } catch (e) { console.error('cleanDemoData:', e.message); }
}

function hashPassword(pass, salt) {
  salt = salt || randomBytes(16).toString('hex');
  const hash = scryptSync(pass, salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(pass, salt, hash) {
  const test = scryptSync(pass, salt, 32).toString('hex');
  const a = Buffer.from(test, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* Arranque: ya no se siembran datos falsos; solo limpieza y promoción de admin */
function seedIfEmpty() {
  cleanDemoData();
  promoteAdmin();
}

module.exports = { db, hashPassword, verifyPassword, seedIfEmpty, promoteAdmin };

'use strict';
// Silenciar el aviso "ExperimentalWarning" de node:sqlite (es normal y no afecta)
const _emit = process.emit;
process.emit = function(name, data, ...rest){ if(name==='warning' && data && data.name==='ExperimentalWarning') return false; return _emit.call(this, name, data, ...rest); };
/* ================================================================
   AUTOLIBRE · Servidor (sin dependencias externas)
   Node.js puro: http + node:sqlite + node:crypto
   ================================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword, seedIfEmpty } = require('./db.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.AUTOLIBRE_DATA || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = __dirname;
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

seedIfEmpty();

/* ---------- Secreto para firmar tokens ---------- */
const SECRET_FILE = path.join(DATA_DIR, '.secret');
let SECRET = process.env.AUTOLIBRE_SECRET;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET); }
}

/* ---------- Tokens tipo JWT (HMAC-SHA256) ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
function signToken(payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + 30 * 864e5 }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (p.exp < Date.now()) return null; return p; }
  catch { return null; }
}

/* ---------- Helpers de coche ---------- */
function carOut(c) {
  const owner = db.prepare('SELECT id,name,type,city,phone FROM users WHERE id=?').get(c.owner_id) || {};
  return {
    id: c.id, ownerId: c.owner_id, brand: c.brand, model: c.model, year: c.year,
    fuel: c.fuel, gear: c.gear, body: c.body, price: c.price, km: c.km, power: c.power,
    color: c.color, province: c.province, doors: c.doors, seats: c.seats, env: c.env,
    extras: JSON.parse(c.extras || '[]'), photos: JSON.parse(c.photos || '[]'),
    warranty: !!c.warranty, certified: !!c.certified, noAccidents: !!c.no_accidents,
    sellerType: c.seller_type, desc: c.descr, featured: !!c.featured, status: c.status,
    views: c.views, created: c.created,
    owner: { id: owner.id, name: owner.name, type: owner.type, city: owner.city, phone: owner.phone }
  };
}
function userOut(u) {
  return { id: u.id, name: u.name, email: u.email, type: u.type, plan: u.plan, phone: u.phone, city: u.city };
}

/* ---------- Utilidades HTTP ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', ch => { size += ch.length; if (size > 25e6) { reject(new Error('too big')); req.destroy(); } data += ch; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = verifyToken(token);
  if (!p) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(p.uid) || null;
}

/* ---------- Guardar fotos (data URL -> fichero) ---------- */
function savePhotos(carId, photos) {
  if (!Array.isArray(photos)) return [];
  const urls = [];
  photos.forEach((p, i) => {
    if (typeof p !== 'string') return;
    if (p.startsWith('/uploads/')) { urls.push(p); return; }
    const m = p.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `car${carId}_${Date.now()}_${i}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
    urls.push('/uploads/' + name);
  });
  return urls;
}

/* ---------- Construcción de consulta con filtros ---------- */
function queryCars(q) {
  let sql = "SELECT * FROM cars WHERE status='active'";
  const args = [];
  const scalar = { brand: 'brand', model: 'model', province: 'province' };
  for (const k in scalar) if (q[k]) { sql += ` AND ${scalar[k]}=?`; args.push(q[k]); }
  if (q.priceMin) { sql += ' AND price>=?'; args.push(+q.priceMin); }
  if (q.priceMax) { sql += ' AND price<=?'; args.push(+q.priceMax); }
  if (q.yearMin) { sql += ' AND year>=?'; args.push(+q.yearMin); }
  if (q.yearMax) { sql += ' AND year<=?'; args.push(+q.yearMax); }
  if (q.kmMax) { sql += ' AND km<=?'; args.push(+q.kmMax); }
  if (q.powerMin) { sql += ' AND power>=?'; args.push(+q.powerMin); }
  if (q.powerMax) { sql += ' AND power<=?'; args.push(+q.powerMax); }
  if (q.certified) sql += ' AND certified=1';
  if (q.warranty) sql += ' AND warranty=1';
  if (q.noAccidents) sql += ' AND no_accidents=1';
  let rows = db.prepare(sql).all(...args);
  const arr = v => Array.isArray(v) ? v : (v ? String(v).split(',') : []);
  const inList = (val, list) => !list.length || list.includes(String(val));
  rows = rows.filter(c => {
    if (!inList(c.fuel, arr(q.fuels))) return false;
    if (!inList(c.gear, arr(q.gears))) return false;
    if (!inList(c.body, arr(q.bodies))) return false;
    if (!inList(c.env, arr(q.envs))) return false;
    if (!inList(c.color, arr(q.colors))) return false;
    if (!inList(c.doors, arr(q.doors))) return false;
    if (!inList(c.seats, arr(q.seats))) return false;
    if (!inList(c.seller_type, arr(q.sellerTypes))) return false;
    const wantExtras = arr(q.extras);
    if (wantExtras.length) { const has = JSON.parse(c.extras || '[]'); if (!wantExtras.every(x => has.includes(x))) return false; }
    if (q.withPhotos && JSON.parse(c.photos || '[]').length === 0) return false;
    if (q.q) { const s = (c.brand + ' ' + c.model).toLowerCase(); if (!s.includes(String(q.q).toLowerCase())) return false; }
    return true;
  });
  const sort = q.sort || 'relevance';
  const by = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    'km-asc': (a, b) => a.km - b.km,
    'year-desc': (a, b) => b.year - a.year,
    'recent': (a, b) => b.created - a.created,
    'relevance': (a, b) => (b.featured - a.featured) || (b.created - a.created)
  };
  rows.sort(by[sort] || by.relevance);
  return rows;
}

/* ================================================================
   RUTAS
   ================================================================ */
async function api(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const method = req.method;

  // ----- AUTH -----
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const name = (b.name || '').trim(), email = (b.email || '').trim().toLowerCase(), pass = b.pass || '';
    if (!name || !email || pass.length < 4) return send(res, 400, { error: 'Rellena nombre, email y contraseña (mínimo 4).' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return send(res, 409, { error: 'Ese email ya está registrado.' });
    const { salt, hash } = hashPassword(pass);
    const type = b.type === 'pro' ? 'pro' : 'private';
    const info = db.prepare('INSERT INTO users(name,email,pass_hash,salt,type,plan,phone,city,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(name, email, hash, salt, type, 'Free', b.phone || '', b.city || '', Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    return send(res, 201, { token: signToken({ uid: u.id }), user: userOut(u) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const email = (b.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !verifyPassword(b.pass || '', u.salt, u.pass_hash)) return send(res, 401, { error: 'Email o contraseña incorrectos.' });
    return send(res, 200, { token: signToken({ uid: u.id }), user: userOut(u) });
  }
  if (p === '/api/auth/me' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    return send(res, 200, { user: userOut(u) });
  }
  if (p === '/api/auth/plan' && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const b = await readBody(req);
    db.prepare('UPDATE users SET type=?, plan=? WHERE id=?').run('pro', b.plan || 'Profesional', u.id);
    const nu = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    return send(res, 200, { user: userOut(nu) });
  }

  // ----- CARS -----
  if (p === '/api/cars' && method === 'GET') {
    const rows = queryCars(q);
    return send(res, 200, { total: rows.length, cars: rows.map(carOut) });
  }
  if (p === '/api/cars' && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'Inicia sesión para publicar' });
    const b = await readBody(req);
    if (!b.brand || !b.model || !b.year || !b.price) return send(res, 400, { error: 'Faltan datos obligatorios (marca, modelo, año, precio).' });
    const envFor = (fuel, year) => (fuel === 'Eléctrico' || fuel === 'Híbrido enchufable') ? '0' : (fuel === 'Híbrido' || fuel === 'GLP') ? 'ECO' : (fuel === 'Diésel' ? (year >= 2015 ? 'C' : 'B') : (year >= 2006 ? 'C' : 'B'));
    const info = db.prepare(`INSERT INTO cars(owner_id,brand,model,year,fuel,gear,body,price,km,power,color,province,doors,seats,env,extras,photos,warranty,certified,no_accidents,seller_type,descr,featured,status,views,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      u.id, b.brand, b.model, +b.year, b.fuel || '', b.gear || '', b.body || 'Berlina',
      +b.price, +b.km || 0, +b.power || 100, b.color || '—', b.province || '',
      +b.doors || 5, +b.seats || 5, envFor(b.fuel, +b.year), JSON.stringify(b.extras || []), '[]',
      b.warranty ? 1 : 0, 0, b.noAccidents ? 1 : 0, u.type,
      b.desc || (b.brand + ' ' + b.model + ' en venta. Precio al contado.'), 0, 'active', 0, Date.now());
    const carId = info.lastInsertRowid;
    const urls = savePhotos(carId, b.photos || []);
    db.prepare('UPDATE cars SET photos=? WHERE id=?').run(JSON.stringify(urls), carId);
    return send(res, 201, { car: carOut(db.prepare('SELECT * FROM cars WHERE id=?').get(carId)) });
  }
  let m;
  if ((m = p.match(/^\/api\/cars\/(\d+)$/))) {
    const id = +m[1];
    const car = db.prepare('SELECT * FROM cars WHERE id=?').get(id);
    if (!car) return send(res, 404, { error: 'Anuncio no encontrado' });
    if (method === 'GET') {
      db.prepare('UPDATE cars SET views=views+1 WHERE id=?').run(id);
      car.views++;
      return send(res, 200, { car: carOut(car) });
    }
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    if (car.owner_id !== u.id) return send(res, 403, { error: 'No es tu anuncio' });
    if (method === 'DELETE') { db.prepare('DELETE FROM cars WHERE id=?').run(id); return send(res, 200, { ok: true }); }
    if (method === 'PUT') {
      const b = await readBody(req);
      const fields = ['brand','model','year','fuel','gear','body','price','km','power','color','province','doors','seats','desc'];
      const map = { desc: 'descr' };
      const sets = [], args = [];
      fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${map[f]||f}=?`); args.push(b[f]); } });
      if (b.extras !== undefined) { sets.push('extras=?'); args.push(JSON.stringify(b.extras)); }
      if (b.warranty !== undefined) { sets.push('warranty=?'); args.push(b.warranty ? 1 : 0); }
      if (b.noAccidents !== undefined) { sets.push('no_accidents=?'); args.push(b.noAccidents ? 1 : 0); }
      if (b.photos !== undefined) { sets.push('photos=?'); args.push(JSON.stringify(savePhotos(id, b.photos))); }
      if (sets.length) { args.push(id); db.prepare(`UPDATE cars SET ${sets.join(',')} WHERE id=?`).run(...args); }
      return send(res, 200, { car: carOut(db.prepare('SELECT * FROM cars WHERE id=?').get(id)) });
    }
  }
  if ((m = p.match(/^\/api\/cars\/(\d+)\/(status|feature)$/)) && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const id = +m[1];
    const car = db.prepare('SELECT * FROM cars WHERE id=?').get(id);
    if (!car || car.owner_id !== u.id) return send(res, 403, { error: 'No es tu anuncio' });
    if (m[2] === 'status') db.prepare("UPDATE cars SET status=? WHERE id=?").run(car.status === 'active' ? 'paused' : 'active', id);
    else db.prepare('UPDATE cars SET featured=? WHERE id=?').run(car.featured ? 0 : 1, id);
    return send(res, 200, { car: carOut(db.prepare('SELECT * FROM cars WHERE id=?').get(id)) });
  }
  if (p === '/api/my/cars' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const rows = db.prepare('SELECT * FROM cars WHERE owner_id=? ORDER BY created DESC').all(u.id);
    return send(res, 200, { cars: rows.map(carOut) });
  }

  // ----- FAVORITES -----
  if (p === '/api/favorites' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const ids = db.prepare('SELECT car_id FROM favorites WHERE user_id=?').all(u.id).map(r => r.car_id);
    const cars = ids.map(id => db.prepare('SELECT * FROM cars WHERE id=?').get(id)).filter(Boolean).map(carOut);
    return send(res, 200, { ids, cars });
  }
  if ((m = p.match(/^\/api\/favorites\/(\d+)$/)) && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const id = +m[1];
    const ex = db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND car_id=?').get(u.id, id);
    if (ex) { db.prepare('DELETE FROM favorites WHERE user_id=? AND car_id=?').run(u.id, id); return send(res, 200, { fav: false }); }
    db.prepare('INSERT INTO favorites(user_id,car_id) VALUES(?,?)').run(u.id, id);
    return send(res, 200, { fav: true });
  }

  // ----- MESSAGES -----
  if (p === '/api/threads' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const rows = db.prepare('SELECT * FROM threads WHERE buyer_id=? OR seller_id=? ORDER BY created DESC').all(u.id, u.id);
    const out = rows.map(t => {
      const car = db.prepare('SELECT brand,model FROM cars WHERE id=?').get(t.car_id) || {};
      const otherId = t.buyer_id === u.id ? t.seller_id : t.buyer_id;
      const other = db.prepare('SELECT id,name FROM users WHERE id=?').get(otherId) || {};
      const last = db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY ts DESC LIMIT 1').get(t.id);
      return { id: t.id, carId: t.car_id, car, other, last };
    });
    return send(res, 200, { threads: out });
  }
  if ((m = p.match(/^\/api\/threads\/(\d+)$/)) && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const t = db.prepare('SELECT * FROM threads WHERE id=?').get(+m[1]);
    if (!t || (t.buyer_id !== u.id && t.seller_id !== u.id)) return send(res, 403, { error: 'Sin acceso' });
    const msgs = db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY ts').all(t.id);
    return send(res, 200, { messages: msgs.map(x => ({ from: x.from_id, txt: x.body, ts: x.ts })) });
  }
  if (p === '/api/threads' && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'Inicia sesión' });
    const b = await readBody(req);
    const car = db.prepare('SELECT * FROM cars WHERE id=?').get(+b.carId);
    if (!car) return send(res, 404, { error: 'Anuncio no encontrado' });
    if (car.owner_id === u.id) return send(res, 400, { error: 'Es tu propio anuncio' });
    let t = db.prepare('SELECT * FROM threads WHERE car_id=? AND buyer_id=?').get(car.id, u.id);
    if (!t) { const info = db.prepare('INSERT INTO threads(car_id,buyer_id,seller_id,created) VALUES(?,?,?,?)').run(car.id, u.id, car.owner_id, Date.now()); t = { id: info.lastInsertRowid }; }
    db.prepare('INSERT INTO messages(thread_id,from_id,body,ts) VALUES(?,?,?,?)').run(t.id, u.id, (b.body || '').trim(), Date.now());
    return send(res, 201, { threadId: t.id });
  }
  if ((m = p.match(/^\/api\/threads\/(\d+)\/messages$/)) && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const t = db.prepare('SELECT * FROM threads WHERE id=?').get(+m[1]);
    if (!t || (t.buyer_id !== u.id && t.seller_id !== u.id)) return send(res, 403, { error: 'Sin acceso' });
    const b = await readBody(req);
    if (!(b.body || '').trim()) return send(res, 400, { error: 'Mensaje vacío' });
    db.prepare('INSERT INTO messages(thread_id,from_id,body,ts) VALUES(?,?,?,?)').run(t.id, u.id, b.body.trim(), Date.now());
    return send(res, 201, { ok: true });
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

/* ---------- Archivos estáticos ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- Servidor ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }); return res.end(); }
  if (url.pathname.startsWith('/api/')) { api(req, res, url).catch(e => { console.error(e); send(res, 500, { error: 'Error del servidor' }); }); return; }
  if (url.pathname.startsWith('/uploads/')) {
    const f = path.join(UPLOAD_DIR, path.basename(url.pathname));
    return serveStatic(res, f);
  }
  // Estructura plana: cualquier ruta que no sea API ni /uploads sirve la web (index.html)
  return serveStatic(res, path.join(__dirname, 'index.html'));
});
server.listen(PORT, () => console.log(`\n  AutoLibre en marcha  ->  http://localhost:${PORT}\n`));

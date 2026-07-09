'use strict';
// Silenciar el aviso "ExperimentalWarning" de node:sqlite (es normal y no afecta)
const _emit = process.emit;
process.emit = function(name, data, ...rest){ if(name==='warning' && data && data.name==='ExperimentalWarning') return false; return _emit.call(this, name, data, ...rest); };
/* ================================================================
   MERCACOCHES · Servidor (sin dependencias externas)
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
const BASE_URL = (process.env.BASE_URL || 'https://mercacoches.es').replace(/\/$/, '');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'mart17yusef@gmail.com';
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
function signToken(payload, ttlMs) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + (ttlMs || 30 * 864e5) }));
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

/* ---------- Email (Resend API vía fetch; sin dependencias) ----------
   Para activar el envío real: crea una cuenta en resend.com, verifica el
   dominio mercacoches.es y define en Render las variables:
     RESEND_API_KEY = re_xxxxx
     EMAIL_FROM     = "MercaCoches <no-reply@mercacoches.es>"
---------------------------------------------------------------------- */
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('[mail no configurado]', to, subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'MercaCoches <onboarding@resend.dev>', to: [to], subject, html })
    });
    if (!r.ok) { console.error('[mail error]', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('[mail error]', e.message); return false; }
}
const mailWrap = (title, inner) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e3e8ef;border-radius:12px;overflow:hidden">
  <div style="background:#0b2540;color:#fff;padding:18px 24px;font-size:19px;font-weight:800">◈ MercaCoches</div>
  <div style="padding:24px"><h2 style="margin:0 0 12px;color:#0b2540">${title}</h2>${inner}
  <p style="color:#8a97a5;font-size:12px;margin-top:24px">Si no has solicitado esto, ignora este mensaje. · mercacoches.es</p></div></div>`;

/* ---------- Límite de peticiones (auth) ---------- */
const rl = new Map();
function rateLimited(ip, key, max = 20, windowMs = 10 * 60e3) {
  const k = ip + '|' + key, now = Date.now();
  const e = rl.get(k);
  if (!e || now > e.reset) { rl.set(k, { n: 1, reset: now + windowMs }); return false; }
  e.n++;
  return e.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rl) if (now > v.reset) rl.delete(k); }, 60e3).unref();

/* ---------- Etiqueta de precio (comparado con anuncios similares) ---------- */
function priceLabelFor(c) {
  try {
    let cmp = db.prepare("SELECT AVG(price) a, COUNT(*) n FROM cars WHERE status='active' AND id<>? AND brand=? AND model=? AND year BETWEEN ? AND ?")
      .get(c.id, c.brand, c.model, c.year - 2, c.year + 2);
    if (!cmp || cmp.n < 3) {
      cmp = db.prepare("SELECT AVG(price) a, COUNT(*) n FROM cars WHERE status='active' AND id<>? AND body=? AND fuel=? AND year BETWEEN ? AND ?")
        .get(c.id, c.body, c.fuel, c.year - 2, c.year + 2);
    }
    if (!cmp || cmp.n < 3 || !cmp.a) return null;
    if (c.price <= cmp.a * 0.92) return 'good';
    if (c.price <= cmp.a * 1.05) return 'fair';
    return null;
  } catch (e) { return null; }
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
    views: c.views, created: c.created, priceLabel: priceLabelFor(c),
    owner: { id: owner.id, name: owner.name, type: owner.type, city: owner.city, phone: owner.phone }
  };
}
function userOut(u) {
  return { id: u.id, name: u.name, email: u.email, type: u.type, plan: u.plan, phone: u.phone, city: u.city, role: u.role || 'user', verified: !!u.verified };
}

/* ---------- Utilidades HTTP ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...SEC_HEADERS });
  res.end(body);
}
function sendHtml(res, code, html, extra) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS, ...(extra || {}) });
  res.end(html);
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
  if (!p || p.purpose) return null; // los tokens de reset/verify no sirven como sesión
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.uid) || null;
  if (u && u.banned) return null;
  return u;
}
function adminAuth(req) {
  const u = auth(req);
  return (u && u.role === 'admin') ? u : null;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/* ---------- Alertas: nombre automático y comprobación de coincidencia ---------- */
function alertName(q) {
  const parts = [];
  if (q.brand) parts.push(q.brand + (q.model ? ' ' + q.model : ''));
  else if (q.q) parts.push('"' + q.q + '"');
  else parts.push('Cualquier coche');
  if (q.priceMax) parts.push('hasta ' + (+q.priceMax).toLocaleString('es-ES') + ' €');
  if (q.yearMin) parts.push('desde ' + q.yearMin);
  if (q.kmMax) parts.push('máx ' + (+q.kmMax).toLocaleString('es-ES') + ' km');
  if (q.province) parts.push('en ' + q.province);
  return parts.join(' · ');
}
function carMatchesAlert(q, c) {
  if (q.brand && q.brand !== c.brand) return false;
  if (q.model && q.model !== c.model) return false;
  if (q.province && q.province !== c.province) return false;
  if (q.priceMin && c.price < +q.priceMin) return false;
  if (q.priceMax && c.price > +q.priceMax) return false;
  if (q.yearMin && c.year < +q.yearMin) return false;
  if (q.yearMax && c.year > +q.yearMax) return false;
  if (q.kmMax && c.km > +q.kmMax) return false;
  if (q.fuels && q.fuels.length && !q.fuels.includes(c.fuel)) return false;
  if (q.gears && q.gears.length && !q.gears.includes(c.gear)) return false;
  if (q.bodies && q.bodies.length && !q.bodies.includes(c.body)) return false;
  if (q.q && !((c.brand + ' ' + c.model).toLowerCase().includes(String(q.q).toLowerCase()))) return false;
  return true;
}
async function notifyAlerts(car) {
  const rows = db.prepare('SELECT a.*, u.email uemail, u.name uname FROM alerts a JOIN users u ON u.id=a.user_id WHERE u.banned=0').all();
  for (const a of rows) {
    if (a.user_id === car.owner_id) continue;
    let q; try { q = JSON.parse(a.query); } catch { continue; }
    if (!carMatchesAlert(q, car)) continue;
    db.prepare('UPDATE alerts SET notified=notified+1 WHERE id=?').run(a.id);
    await sendMail(a.uemail, `🔔 Nuevo: ${car.brand} ${car.model} ${car.year} — ${car.price.toLocaleString('es-ES')} €`,
      mailWrap('Tu alerta tiene un resultado nuevo',
        `<p>Hola ${esc(a.uname)}, se acaba de publicar un coche que encaja con tu alerta <b>"${esc(a.name)}"</b>:</p>
         <p style="font-size:17px"><b>${esc(car.brand)} ${esc(car.model)} ${car.year}</b> · ${car.km.toLocaleString('es-ES')} km · ${esc(car.fuel)} · ${esc(car.province || '')}<br>
         <span style="color:#e85d04;font-size:22px;font-weight:800">${car.price.toLocaleString('es-ES')} €</span></p>
         <p><a href="${BASE_URL}/#car-${car.id}" style="background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver anuncio</a></p>
         <p style="color:#8a97a5;font-size:12px">Puedes borrar tus alertas desde tu panel en MercaCoches.</p>`));
  }
}

/* ================================================================
   RUTAS API
   ================================================================ */
async function api(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const method = req.method;
  const ip = clientIp(req);

  // ----- AUTH -----
  if (p.startsWith('/api/auth/') && method === 'POST' && rateLimited(ip, 'auth')) {
    return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
  }
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const name = (b.name || '').trim(), email = (b.email || '').trim().toLowerCase(), pass = b.pass || '';
    if (!name || !email || pass.length < 6) return send(res, 400, { error: 'Rellena nombre, email y contraseña (mínimo 6 caracteres).' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Email no válido.' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return send(res, 409, { error: 'Ese email ya está registrado.' });
    const { salt, hash } = hashPassword(pass);
    const type = b.type === 'pro' ? 'pro' : 'private';
    const info = db.prepare('INSERT INTO users(name,email,pass_hash,salt,type,plan,phone,city,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(name, email, hash, salt, type, 'Free', b.phone || '', b.city || '', Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    // email de verificación (si hay servicio de correo configurado)
    const vtoken = signToken({ uid: u.id, purpose: 'verify' }, 7 * 864e5);
    sendMail(email, 'Confirma tu email en MercaCoches', mailWrap('Confirma tu email',
      `<p>Hola ${esc(name)}, pulsa el botón para verificar tu cuenta:</p>
       <p><a href="${BASE_URL}/api/auth/verify?token=${vtoken}" style="background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Verificar mi email</a></p>`));
    return send(res, 201, { token: signToken({ uid: u.id }), user: userOut(u) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const email = (b.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !verifyPassword(b.pass || '', u.salt, u.pass_hash)) return send(res, 401, { error: 'Email o contraseña incorrectos.' });
    if (u.banned) return send(res, 403, { error: 'Esta cuenta ha sido suspendida. Contacta con soporte.' });
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
  // Recuperar contraseña: solicitar enlace
  if (p === '/api/auth/forgot' && method === 'POST') {
    const b = await readBody(req);
    const email = (b.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (u) {
      const rtoken = signToken({ uid: u.id, purpose: 'reset' }, 30 * 60e3); // 30 min
      const sent = await sendMail(email, 'Recupera tu contraseña de MercaCoches', mailWrap('Recuperar contraseña',
        `<p>Hola ${esc(u.name)}, pulsa el botón para crear una contraseña nueva (caduca en 30 minutos):</p>
         <p><a href="${BASE_URL}/#reset=${rtoken}" style="background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Crear contraseña nueva</a></p>`));
      if (!sent) console.log('[reset link]', email, BASE_URL + '/#reset=' + rtoken);
    }
    return send(res, 200, { ok: true, msg: 'Si el email existe, te hemos enviado un enlace para recuperar la contraseña.' });
  }
  // Recuperar contraseña: aplicar nueva
  if (p === '/api/auth/reset' && method === 'POST') {
    const b = await readBody(req);
    const t = verifyToken(b.token || '');
    if (!t || t.purpose !== 'reset') return send(res, 400, { error: 'Enlace no válido o caducado. Solicita uno nuevo.' });
    if ((b.pass || '').length < 6) return send(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    const { salt, hash } = hashPassword(b.pass);
    db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, t.uid);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(t.uid);
    return send(res, 200, { token: signToken({ uid: u.id }), user: userOut(u) });
  }
  // Verificación de email (enlace del correo)
  if (p === '/api/auth/verify' && method === 'GET') {
    const t = verifyToken(q.token || '');
    if (!t || t.purpose !== 'verify') return sendHtml(res, 400, pageShell('Enlace no válido', '<h1>Enlace no válido o caducado</h1><p>Vuelve a solicitar la verificación desde tu panel.</p>'));
    db.prepare('UPDATE users SET verified=1 WHERE id=?').run(t.uid);
    res.writeHead(302, { Location: '/#verificado' }); return res.end();
  }
  // Reenviar verificación
  if (p === '/api/auth/resend-verify' && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    if (u.verified) return send(res, 200, { ok: true, msg: 'Tu email ya está verificado.' });
    const vtoken = signToken({ uid: u.id, purpose: 'verify' }, 7 * 864e5);
    const sent = await sendMail(u.email, 'Confirma tu email en MercaCoches', mailWrap('Confirma tu email',
      `<p><a href="${BASE_URL}/api/auth/verify?token=${vtoken}" style="background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Verificar mi email</a></p>`));
    return send(res, 200, { ok: true, msg: sent ? 'Email de verificación enviado.' : 'El envío de emails aún no está configurado.' });
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
    const newCar = db.prepare('SELECT * FROM cars WHERE id=?').get(carId);
    notifyAlerts(newCar).catch(e => console.error('alerts:', e.message));
    return send(res, 201, { car: carOut(newCar) });
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
    if (car.owner_id !== u.id && u.role !== 'admin') return send(res, 403, { error: 'No es tu anuncio' });
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
    if (!car || (car.owner_id !== u.id && u.role !== 'admin')) return send(res, 403, { error: 'No es tu anuncio' });
    if (m[2] === 'status') db.prepare("UPDATE cars SET status=? WHERE id=?").run(car.status === 'active' ? 'paused' : 'active', id);
    else db.prepare('UPDATE cars SET featured=? WHERE id=?').run(car.featured ? 0 : 1, id);
    return send(res, 200, { car: carOut(db.prepare('SELECT * FROM cars WHERE id=?').get(id)) });
  }
  if (p === '/api/my/cars' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const rows = db.prepare('SELECT * FROM cars WHERE owner_id=? ORDER BY created DESC').all(u.id);
    return send(res, 200, { cars: rows.map(carOut) });
  }

  // ----- ALERTS (búsquedas guardadas con aviso por email) -----
  if (p === '/api/alerts' && method === 'GET') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    const rows = db.prepare('SELECT * FROM alerts WHERE user_id=? ORDER BY created DESC').all(u.id);
    return send(res, 200, { alerts: rows.map(a => ({ id: a.id, name: a.name, query: JSON.parse(a.query), created: a.created, notified: a.notified })) });
  }
  if (p === '/api/alerts' && method === 'POST') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'Inicia sesión para crear alertas' });
    const n = db.prepare('SELECT COUNT(*) c FROM alerts WHERE user_id=?').get(u.id).c;
    if (n >= 10) return send(res, 400, { error: 'Máximo 10 alertas. Borra alguna para crear otra.' });
    const b = await readBody(req);
    const q2 = b.query || {};
    const clean = {};
    ['brand','model','province','q','priceMin','priceMax','yearMin','yearMax','kmMax'].forEach(k => { if (q2[k]) clean[k] = String(q2[k]); });
    ['fuels','gears','bodies'].forEach(k => { if (Array.isArray(q2[k]) && q2[k].length) clean[k] = q2[k].map(String); });
    const name = (b.name || '').trim() || alertName(clean);
    db.prepare('INSERT INTO alerts(user_id,name,query,created) VALUES(?,?,?,?)').run(u.id, name.slice(0, 80), JSON.stringify(clean), Date.now());
    return send(res, 201, { ok: true });
  }
  if ((m = p.match(/^\/api\/alerts\/(\d+)$/)) && method === 'DELETE') {
    const u = auth(req); if (!u) return send(res, 401, { error: 'No autenticado' });
    db.prepare('DELETE FROM alerts WHERE id=? AND user_id=?').run(+m[1], u.id);
    return send(res, 200, { ok: true });
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
    // aviso por email al vendedor (si hay servicio de correo)
    const seller = db.prepare('SELECT * FROM users WHERE id=?').get(car.owner_id);
    if (seller) sendMail(seller.email, `Nuevo mensaje sobre tu ${car.brand} ${car.model}`, mailWrap('Tienes un mensaje nuevo',
      `<p><b>${esc(u.name)}</b> te ha escrito sobre tu <b>${esc(car.brand)} ${esc(car.model)}</b>:</p>
       <p style="background:#f4f6f9;border-radius:8px;padding:12px">${esc((b.body || '').slice(0, 300))}</p>
       <p><a href="${BASE_URL}/#messages" style="background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Responder</a></p>`));
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

  // ----- ADMIN -----
  if (p.startsWith('/api/admin/')) {
    const admin = adminAuth(req);
    if (!admin) return send(res, 403, { error: 'Solo administradores' });
    if (p === '/api/admin/stats' && method === 'GET') {
      const g = s => db.prepare(s).get();
      return send(res, 200, {
        users: g('SELECT COUNT(*) c FROM users').c,
        usersPro: g("SELECT COUNT(*) c FROM users WHERE type='pro'").c,
        usersBanned: g('SELECT COUNT(*) c FROM users WHERE banned=1').c,
        cars: g('SELECT COUNT(*) c FROM cars').c,
        carsActive: g("SELECT COUNT(*) c FROM cars WHERE status='active'").c,
        carsFeatured: g('SELECT COUNT(*) c FROM cars WHERE featured=1').c,
        messages: g('SELECT COUNT(*) c FROM messages').c,
        threads: g('SELECT COUNT(*) c FROM threads').c,
        views: g('SELECT COALESCE(SUM(views),0) c FROM cars').c,
        avgPrice: Math.round(g("SELECT COALESCE(AVG(price),0) c FROM cars WHERE status='active'").c),
        last7d: db.prepare('SELECT COUNT(*) c FROM cars WHERE created>?').get(Date.now() - 7 * 864e5).c
      });
    }
    if (p === '/api/admin/users' && method === 'GET') {
      let rows = db.prepare('SELECT * FROM users ORDER BY created DESC LIMIT 500').all();
      if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(s)); }
      return send(res, 200, { users: rows.map(u => ({ ...userOut(u), banned: !!u.banned, created: u.created, cars: db.prepare('SELECT COUNT(*) c FROM cars WHERE owner_id=?').get(u.id).c })) });
    }
    if ((m = p.match(/^\/api\/admin\/users\/(\d+)\/ban$/)) && method === 'POST') {
      const id = +m[1];
      if (id === admin.id) return send(res, 400, { error: 'No puedes suspenderte a ti mismo.' });
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!u) return send(res, 404, { error: 'Usuario no encontrado' });
      db.prepare('UPDATE users SET banned=? WHERE id=?').run(u.banned ? 0 : 1, id);
      if (!u.banned) db.prepare("UPDATE cars SET status='paused' WHERE owner_id=?").run(id);
      return send(res, 200, { banned: !u.banned });
    }
    if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
      const id = +m[1];
      if (id === admin.id) return send(res, 400, { error: 'No puedes borrarte a ti mismo.' });
      db.prepare('DELETE FROM cars WHERE owner_id=?').run(id);
      db.prepare('DELETE FROM favorites WHERE user_id=?').run(id);
      db.prepare('DELETE FROM users WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/cars' && method === 'GET') {
      let rows = db.prepare('SELECT * FROM cars ORDER BY created DESC LIMIT 500').all();
      if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(c => (c.brand + ' ' + c.model).toLowerCase().includes(s)); }
      return send(res, 200, { cars: rows.map(carOut) });
    }
    return send(res, 404, { error: 'Ruta admin no encontrada' });
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

/* ================================================================
   SEO: robots, sitemap, ficha de coche indexable y páginas legales
   ================================================================ */
function pageShell(title, body, meta) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${meta || ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#1c2733;line-height:1.65;background:#fff}
a{color:#0b5ed7}.container{max-width:820px;margin:0 auto;padding:0 20px}
header{background:#0b2540;color:#fff}.nav{display:flex;align-items:center;justify-content:space-between;height:58px;max-width:1080px;margin:0 auto;padding:0 20px}
.logo{font-size:19px;font-weight:800;color:#fff;text-decoration:none}.logo b{color:#4d94ff}
main{padding:36px 0 60px}h1{color:#0b2540;font-size:28px;margin-bottom:16px}
h2{color:#0b2540;font-size:19px;margin:24px 0 8px}p,li{font-size:15px;color:#3a4756;margin:8px 0}ul{padding-left:22px}
.note{background:#fff8e1;border:1px solid #ffe08a;border-radius:8px;padding:10px 14px;font-size:13px;color:#8a6d00;margin:14px 0}
.btn{display:inline-block;background:#e85d04;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:10px}
footer{background:#0b2540;color:#b9c7d6;padding:24px 0;font-size:13px;text-align:center;margin-top:40px}footer a{color:#b9c7d6}
table{border-collapse:collapse;width:100%;margin:10px 0}td{border:1px solid #e3e8ef;padding:8px 10px;font-size:14px}
.wide{max-width:1080px}
.grid-seo{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px;margin:18px 0}
.card-seo{border:1px solid #e3e8ef;border-radius:12px;overflow:hidden;text-decoration:none;color:#1c2733;display:block}
.card-seo img{width:100%;height:150px;object-fit:cover;display:block;background:#eef2f7}
.card-seo .ph{width:100%;height:150px;display:grid;place-items:center;background:#eef2f7;color:#9aa8b7;font-size:34px}
.card-seo .in{padding:10px 12px}.card-seo .t{font-weight:700;font-size:15px;color:#0b2540}
.card-seo .pr{color:#e85d04;font-weight:800;font-size:17px;margin-top:2px}
.card-seo .mt{color:#6b7a89;font-size:12.5px;margin-top:3px}
.linkbox{margin:26px 0}.linkbox h2{margin-bottom:10px}
.linkbox a{display:inline-block;background:#f2f5f9;border:1px solid #e3e8ef;border-radius:20px;padding:6px 14px;margin:0 8px 8px 0;font-size:13.5px;text-decoration:none;color:#0b5ed7}
</style>
</head>
<body>
<header><div class="nav"><a class="logo" href="/">◈ Merca<b>Coches</b></a><a href="/" style="color:#b9c7d6;font-size:14px">← Volver a la web</a></div></header>
<main><div class="container ${meta && meta.includes('__WIDE__') ? 'wide' : ''}">${body}</div></main>
<footer><div class="container"><p>© 2026 MercaCoches (mercacoches.es)</p>
<p><a href="/aviso-legal">Aviso legal</a> · <a href="/terminos">Términos de uso</a> · <a href="/privacidad">Privacidad</a> · <a href="/cookies">Cookies</a></p></div></footer>
</body></html>`;
}

const PEND = '<b>[NOMBRE Y APELLIDOS / RAZÓN SOCIAL — pendiente de completar]</b>, NIF/DNI: <b>[pendiente]</b>, domicilio: <b>[pendiente]</b>';
const LEGAL_PAGES = {
  '/aviso-legal': ['Aviso legal — MercaCoches', `
<h1>Aviso legal</h1>
<div class="note">Completa los datos del titular marcados como [pendiente] (art. 10 Ley 34/2002, LSSI-CE).</div>
<h2>Titular del sitio web</h2>
<p>Titular: ${PEND}.<br>Correo de contacto: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br>Sitio web: https://mercacoches.es</p>
<h2>Objeto</h2>
<p>MercaCoches es una plataforma de anuncios clasificados de compraventa de vehículos entre usuarios (particulares y profesionales). MercaCoches no es parte en las operaciones de compraventa, no interviene en el precio ni en el pago y no garantiza el estado de los vehículos anunciados: la transacción se realiza directamente entre comprador y vendedor.</p>
<h2>Responsabilidad sobre los anuncios</h2>
<p>Los anuncios son publicados por los usuarios, que son los únicos responsables de la veracidad de los datos, fotografías y precio. MercaCoches actúa como prestador de servicios de intermediación (arts. 13-17 LSSI-CE) y retirará contenidos ilícitos o fraudulentos en cuanto tenga conocimiento efectivo de ellos. Puedes denunciar un anuncio escribiendo a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
<h2>Propiedad intelectual</h2>
<p>El diseño y el software de la plataforma pertenecen a su titular. Las marcas de vehículos citadas pertenecen a sus respectivos fabricantes y se usan solo con fines descriptivos.</p>
<h2>Legislación</h2>
<p>Este sitio se rige por la legislación española.</p>`],
  '/terminos': ['Términos de uso — MercaCoches', `
<h1>Términos y condiciones de uso</h1>
<h2>1. El servicio</h2>
<p>MercaCoches permite publicar y consultar anuncios de vehículos, y poner en contacto a compradores y vendedores mediante mensajería interna. Publicar anuncios básicos es gratuito.</p>
<h2>2. Registro</h2>
<p>Para publicar o contactar necesitas una cuenta con datos veraces. Eres responsable de custodiar tu contraseña. Edad mínima: 18 años.</p>
<h2>3. Normas de publicación</h2>
<ul>
<li>Solo se admiten anuncios reales de vehículos que tengas derecho a vender.</li>
<li>Prohibido: información falsa, vehículos con documentación irregular, contenido ofensivo, spam o enlaces a otras plataformas de venta.</li>
<li>Un mismo vehículo no puede publicarse en varios anuncios.</li>
</ul>
<h2>4. Moderación</h2>
<p>MercaCoches puede retirar anuncios o suspender cuentas que incumplan estas normas o la ley, sin derecho a indemnización.</p>
<h2>5. Papel de MercaCoches</h2>
<p>MercaCoches NO participa en la compraventa: no cobra comisión, no gestiona pagos ni entregas, y no ofrece garantía sobre los vehículos. Recomendamos ver el vehículo en persona, comprobar su documentación (permiso de circulación, ITV, informe de la DGT) y firmar contrato de compraventa.</p>
<h2>6. Responsabilidad</h2>
<p>El servicio se presta "tal cual". MercaCoches no responde de los daños derivados de las transacciones entre usuarios ni de interrupciones técnicas del servicio.</p>
<h2>7. Contacto</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`],
  '/privacidad': ['Política de privacidad — MercaCoches', `
<h1>Política de privacidad</h1>
<div class="note">Completa los datos del responsable marcados como [pendiente] (RGPD UE 2016/679 y LOPDGDD 3/2018).</div>
<h2>Responsable</h2>
<p>${PEND}.<br>Contacto: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
<h2>Datos que tratamos</h2>
<table>
<tr><td><b>Cuenta</b></td><td>Nombre, email, teléfono (opcional), ciudad, contraseña (cifrada con scrypt; nunca en claro).</td></tr>
<tr><td><b>Anuncios</b></td><td>Datos del vehículo, fotos, provincia y descripción que tú publicas. El teléfono y la ciudad se muestran a otros usuarios junto a tus anuncios.</td></tr>
<tr><td><b>Mensajes</b></td><td>Conversaciones de la mensajería interna entre comprador y vendedor.</td></tr>
<tr><td><b>Técnicos</b></td><td>Dirección IP y datos de navegación necesarios para la seguridad del servicio.</td></tr>
</table>
<h2>Finalidad y base legal</h2>
<p>Prestar el servicio (ejecución del contrato de uso), prevenir el fraude y mantener la seguridad (interés legítimo), y enviarte emails transaccionales como verificación, recuperación de contraseña o avisos de mensajes (ejecución del contrato). No enviamos publicidad sin tu consentimiento.</p>
<h2>Destinatarios</h2>
<p>Tus datos se alojan en Render Services, Inc. (EE. UU., con cláusulas contractuales tipo). Los emails transaccionales se envían a través del proveedor de correo configurado. No vendemos tus datos.</p>
<h2>Conservación</h2>
<p>Mientras mantengas tu cuenta. Puedes pedir la eliminación de tu cuenta y tus anuncios escribiendo a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
<h2>Tus derechos</h2>
<p>Acceso, rectificación, supresión, oposición, limitación y portabilidad: escríbenos a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. También puedes reclamar ante la AEPD (<a href="https://www.aepd.es" target="_blank" rel="noopener">aepd.es</a>).</p>`],
  '/cookies': ['Política de cookies — MercaCoches', `
<h1>Política de cookies</h1>
<h2>Qué usamos</h2>
<ul>
<li><b>Almacenamiento local esencial (no requiere consentimiento):</b> tu sesión iniciada (token) y tu preferencia de cookies. Sin esto la web no puede funcionar.</li>
<li><b>Analítica:</b> solo si algún día se activa una herramienta de medición y la aceptas expresamente. A día de hoy no usamos cookies de publicidad ni de seguimiento de terceros.</li>
</ul>
<h2>Gestionar</h2>
<p>Puedes borrar los datos del sitio desde la configuración de tu navegador en cualquier momento (se cerrará tu sesión). Dudas: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`]
};

function ssrCarPage(id, res) {
  const c = db.prepare("SELECT * FROM cars WHERE id=? AND status='active'").get(id);
  if (!c) return sendHtml(res, 404, pageShell('Anuncio no encontrado — MercaCoches', '<h1>Anuncio no disponible</h1><p>Este anuncio ya no existe o fue retirado.</p><a class="btn" href="/coches">Ver coches disponibles</a>'));
  const car = carOut(c);
  const title = `${car.brand} ${car.model} ${car.year} — ${car.price.toLocaleString('es-ES')} € | MercaCoches`;
  const desc = `${car.brand} ${car.model} de ${car.year}, ${car.km.toLocaleString('es-ES')} km, ${car.fuel}, ${car.gear}, en ${car.province}. ${car.price.toLocaleString('es-ES')} € al contado. Anuncio de ${car.sellerType === 'pro' ? 'concesionario' : 'particular'} en MercaCoches.`;
  const img = car.photos[0] ? (BASE_URL + car.photos[0]) : (BASE_URL + '/og.png');
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: `${car.brand} ${car.model} ${car.year}`,
    description: desc, image: car.photos.map(p => BASE_URL + p),
    offers: { '@type': 'Offer', price: car.price, priceCurrency: 'EUR', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/UsedCondition' },
    brand: { '@type': 'Brand', name: car.brand },
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Año', value: car.year },
      { '@type': 'PropertyValue', name: 'Kilómetros', value: car.km },
      { '@type': 'PropertyValue', name: 'Combustible', value: car.fuel },
      { '@type': 'PropertyValue', name: 'Cambio', value: car.gear },
      { '@type': 'PropertyValue', name: 'Potencia (CV)', value: car.power }
    ]
  };
  const meta = `
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${BASE_URL}/coche/${car.id}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${BASE_URL}/coche/${car.id}">
<meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<script>if(typeof navigator!=='undefined'&&!/bot|crawl|spider|slurp|bing|duckduck|baidu|yandex|facebook|whatsapp|telegram|preview/i.test(navigator.userAgent)){location.replace('/#car-${car.id}')}</script>`;
  const rows = [['Año', car.year], ['Kilómetros', car.km.toLocaleString('es-ES') + ' km'], ['Combustible', car.fuel], ['Cambio', car.gear], ['Carrocería', car.body], ['Potencia', car.power + ' CV'], ['Color', car.color], ['Provincia', car.province], ['Etiqueta ambiental', car.env], ['Vendedor', car.sellerType === 'pro' ? 'Profesional' : 'Particular']];
  const body = `
<h1>${esc(car.brand)} ${esc(car.model)} ${car.year}</h1>
<p style="font-size:26px;font-weight:800;color:#e85d04">${car.price.toLocaleString('es-ES')} €</p>
${car.photos[0] ? `<img src="${esc(car.photos[0])}" alt="${esc(car.brand)} ${esc(car.model)}" style="max-width:100%;border-radius:10px">` : ''}
<table>${rows.map(r => `<tr><td><b>${r[0]}</b></td><td>${esc(r[1])}</td></tr>`).join('')}</table>
<p>${esc(car.desc)}</p>
${car.extras.length ? `<h2>Equipamiento</h2><ul>${car.extras.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
<p style="margin-top:14px"><a href="/coches/${slugify(car.brand)}">Más ${esc(car.brand)} de segunda mano</a>${car.province ? ` · <a href="/coches/${slugify(car.province)}">Más coches en ${esc(car.province)}</a>` : ''}</p>
<a class="btn" href="/#car-${car.id}">Ver anuncio completo y contactar →</a>`;
  return sendHtml(res, 200, pageShell(title, body, meta));
}

/* ================================================================
   SEO: páginas de listado indexables (marca / provincia / combinadas)
   URLs: /coches · /coches/bmw · /coches/madrid · /coches/bmw/madrid
   ================================================================ */
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function distinctActive(col) {
  return db.prepare(`SELECT DISTINCT ${col} v FROM cars WHERE status='active' AND ${col} IS NOT NULL AND ${col}<>'' ORDER BY ${col}`).all().map(r => r.v);
}
function bySlug(list, s) { return list.find(v => slugify(v) === s) || null; }

function seoCarCard(car) {
  const t = `${car.brand} ${car.model} ${car.year}`;
  const img = car.photos[0]
    ? `<img src="${esc(car.photos[0])}" alt="${esc(t)}" loading="lazy">`
    : `<div class="ph">🚗</div>`;
  return `<a class="card-seo" href="/coche/${car.id}">${img}<div class="in">
    <div class="t">${esc(t)}</div>
    <div class="pr">${car.price.toLocaleString('es-ES')} €</div>
    <div class="mt">${car.km.toLocaleString('es-ES')} km · ${esc(car.fuel || '—')} · ${esc(car.province || 'España')}</div>
  </div></a>`;
}

function ssrListPage(res, opts) {
  const brand = opts.brand || '', province = opts.province || '';
  const rows = queryCars({ brand, province, sort: 'recent' }).map(carOut);
  const pathUrl = '/coches' + (brand ? '/' + slugify(brand) : '') + (province ? '/' + slugify(province) : '');
  const what = brand ? `${brand} de segunda mano` : 'Coches de segunda mano';
  const where = province ? ` en ${province}` : (brand ? '' : ' en España');
  const title = `${what}${where} — MercaCoches`;
  const desc = rows.length
    ? `${rows.length} ${brand ? 'anuncios de ' + brand : 'coches de segunda mano'}${where}. Compra directamente al vendedor: publicar es gratis y sin comisiones en MercaCoches.`
    : `Compra y vende ${brand || 'coches'}${where} de segunda mano. Publicar tu anuncio es gratis y sin comisiones en MercaCoches.`;
  const shown = rows.slice(0, 48);
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: `${what}${where}`, numberOfItems: rows.length,
    itemListElement: shown.slice(0, 24).map((c, i) => ({
      '@type': 'ListItem', position: i + 1, url: `${BASE_URL}/coche/${c.id}`,
      name: `${c.brand} ${c.model} ${c.year}`
    }))
  };
  const brands = distinctActive('brand');
  const provinces = distinctActive('province');
  const meta = `<!--__WIDE__-->
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${BASE_URL}${pathUrl}">
${rows.length ? '' : '<meta name="robots" content="noindex,follow">'}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${BASE_URL}${pathUrl}">
<meta property="og:image" content="${BASE_URL}/og.png"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`;
  const crumbs = `<p style="font-size:13px;color:#6b7a89"><a href="/">Inicio</a> › <a href="/coches">Coches</a>${brand ? ` › <a href="/coches/${slugify(brand)}">${esc(brand)}</a>` : ''}${province ? ` › ${esc(province)}` : ''}</p>`;
  const body = `
${crumbs}
<h1>${esc(what)}${esc(where)}</h1>
<p>${rows.length ? `<b>${rows.length}</b> anuncio${rows.length === 1 ? '' : 's'} publicados directamente por sus vendedores. Sin comisiones ni intermediarios: contacta gratis con el vendedor.` : `Todavía no hay anuncios${where || ''} de ${esc(brand || 'esta búsqueda')}. Sé el primero: publicar es gratis.`}</p>
<p><a class="btn" href="/#publish">Publica tu ${esc(brand || 'coche')} gratis →</a></p>
${shown.length ? `<div class="grid-seo">${shown.map(seoCarCard).join('')}</div>` : ''}
${rows.length > shown.length ? `<p><a href="/#results">Ver los ${rows.length} anuncios en el buscador →</a></p>` : ''}
<div class="linkbox"><h2>Buscar por marca</h2>${brands.map(b => `<a href="/coches/${slugify(b)}">${esc(b)}</a>`).join('')}</div>
${provinces.length ? `<div class="linkbox"><h2>Buscar por provincia</h2>${provinces.map(pv => `<a href="/coches${brand ? '/' + slugify(brand) : ''}/${slugify(pv)}">${esc(brand ? brand + ' en ' : '')}${esc(pv)}</a>`).join('')}</div>` : ''}`;
  return sendHtml(res, 200, pageShell(title, body, meta));
}

function ssrSitemap(res) {
  const cars = db.prepare("SELECT id FROM cars WHERE status='active'").all();
  const brands = distinctActive('brand');
  const provinces = distinctActive('province');
  const combos = db.prepare("SELECT DISTINCT brand, province FROM cars WHERE status='active' AND brand<>'' AND province<>''").all();
  const urls = [
    BASE_URL + '/', BASE_URL + '/coches',
    BASE_URL + '/aviso-legal', BASE_URL + '/terminos', BASE_URL + '/privacidad', BASE_URL + '/cookies',
    ...brands.map(b => `${BASE_URL}/coches/${slugify(b)}`),
    ...provinces.map(pv => `${BASE_URL}/coches/${slugify(pv)}`),
    ...combos.map(c => `${BASE_URL}/coches/${slugify(c.brand)}/${slugify(c.province)}`),
    ...cars.map(c => `${BASE_URL}/coche/${c.id}`)
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...new Set(urls)].map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>';
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', ...SEC_HEADERS });
  res.end(xml);
}

/* ---------- Archivos estáticos ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', ...SEC_HEADERS });
    res.end(data);
  });
}

/* ---------- Servidor ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }); return res.end(); }
  if (p.startsWith('/api/')) { api(req, res, url).catch(e => { console.error(e); send(res, 500, { error: 'Error del servidor' }); }); return; }
  if (p.startsWith('/uploads/')) {
    const f = path.join(UPLOAD_DIR, path.basename(p));
    return serveStatic(res, f);
  }
  // SEO
  if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain', ...SEC_HEADERS }); return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${BASE_URL}/sitemap.xml\n`); }
  if (p === '/sitemap.xml') return ssrSitemap(res);
  let m;
  if ((m = p.match(/^\/coche\/(\d+)\/?$/))) return ssrCarPage(+m[1], res);
  // Listados indexables: /coches · /coches/<marca|provincia> · /coches/<marca>/<provincia>
  if (p === '/coches' || p === '/coches/') return ssrListPage(res, {});
  if ((m = p.match(/^\/coches\/([a-z0-9-]+)\/?$/))) {
    const seg = m[1];
    const brand = bySlug(distinctActive('brand'), seg);
    if (brand) return ssrListPage(res, { brand });
    const province = bySlug(distinctActive('province'), seg);
    if (province) return ssrListPage(res, { province });
    return ssrListPage(res, {}); // slug desconocido: listado general (noindex si vacío no aplica; canonical /coches)
  }
  if ((m = p.match(/^\/coches\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/))) {
    const brand = bySlug(distinctActive('brand'), m[1]);
    const province = bySlug(distinctActive('province'), m[2]);
    if (brand || province) return ssrListPage(res, { brand: brand || '', province: province || '' });
    return ssrListPage(res, {});
  }
  if (LEGAL_PAGES[p]) return sendHtml(res, 200, pageShell(LEGAL_PAGES[p][0], LEGAL_PAGES[p][1]));
  if (p === '/og.png' && fs.existsSync(path.join(__dirname, 'og.png'))) return serveStatic(res, path.join(__dirname, 'og.png'));
  // Estructura plana: cualquier otra ruta sirve la SPA (index.html)
  return serveStatic(res, path.join(__dirname, 'index.html'));
});
server.listen(PORT, () => console.log(`\n  MercaCoches en marcha  ->  http://localhost:${PORT}\n`));

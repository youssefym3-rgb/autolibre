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
`);

/* El email indicado en ADMIN_EMAIL se convierte en administrador al arrancar */
function promoteAdmin() {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) return;
  try { db.prepare("UPDATE users SET role='admin' WHERE email=?").run(adminEmail); } catch (e) {}
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

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) { promoteAdmin(); return; }
  const now = Date.now();
  const envFor = (fuel, year) => {
    if (fuel === 'Eléctrico' || fuel === 'Híbrido enchufable') return '0';
    if (fuel === 'Híbrido' || fuel === 'GLP') return 'ECO';
    if (fuel === 'Gasolina') return year >= 2006 ? 'C' : 'B';
    if (fuel === 'Diésel') return year >= 2015 ? 'C' : 'B';
    return 'C';
  };
  const EXTRAS = ['Climatizador','Navegador GPS','Cámara trasera','Sensores de parking','Asientos de cuero','Techo solar/panorámico','Bluetooth','Faros LED/Xenón','Control de crucero','Llantas de aleación','Apple CarPlay/Android Auto','Asientos calefactables','Cámara 360°','Portón eléctrico','Head-Up Display'];
  const insU = db.prepare('INSERT INTO users(name,email,pass_hash,salt,type,plan,phone,city,created) VALUES(?,?,?,?,?,?,?,?,?)');
  const dealers = [
    ['AutoPremium Madrid','ventas@autopremium.es','pro','611 222 333','Madrid'],
    ['Concesionario Norte','info@auto-norte.es','pro','644 555 666','Bilbao'],
    ['Carlos Jiménez','carlos@email.com','private','677 888 999','Valencia']
  ];
  const ids = dealers.map(d => {
    const { salt, hash } = hashPassword('demo');
    return insU.run(d[0], d[1], hash, salt, d[2], 'Free', d[3], d[4], now).lastInsertRowid;
  });
  const sample = [
    ['BMW','Serie 3',2021,'Diésel','Automático','Berlina',38900,45000,190,'Negro','Madrid',0,1],
    ['Audi','A4',2020,'Diésel','Automático','Berlina',31500,62000,163,'Gris','Madrid',0,1],
    ['Mercedes-Benz','Clase C',2022,'Híbrido','Automático','Berlina',44200,28000,204,'Blanco','Bilbao',1,1],
    ['Volkswagen','Golf',2019,'Gasolina','Manual','Compacto',18900,71000,130,'Azul','Valencia',2,0],
    ['Tesla','Model 3',2023,'Eléctrico','Automático','Berlina',39900,19000,283,'Blanco','Madrid',0,1],
    ['Seat','León',2021,'Gasolina','Manual','Compacto',19500,38000,150,'Rojo','Bilbao',1,0],
    ['Toyota','Corolla',2022,'Híbrido','Automático','Compacto',24800,25000,140,'Gris','Valencia',2,0],
    ['Renault','Captur',2020,'Gasolina','Manual','SUV',16500,54000,100,'Blanco','Bilbao',1,0],
    ['Peugeot','3008',2021,'Diésel','Automático','SUV',27900,48000,130,'Negro','Madrid',0,1],
    ['Ford','Puma',2022,'Híbrido','Manual','SUV',22400,21000,125,'Plata','Valencia',2,0],
    ['Kia','Sportage',2023,'Híbrido enchufable','Automático','SUV',34500,12000,265,'Azul','Bilbao',1,1],
    ['Hyundai','Tucson',2021,'Diésel','Automático','SUV',26900,55000,136,'Gris','Madrid',0,0],
    ['Audi','Q5',2020,'Diésel','Automático','SUV',39800,68000,190,'Negro','Madrid',0,1],
    ['BMW','X1',2022,'Gasolina','Automático','SUV',36700,29000,150,'Blanco','Bilbao',1,1],
    ['Volkswagen','Tiguan',2019,'Diésel','Automático','SUV',24900,82000,150,'Marrón','Valencia',2,0],
    ['Mercedes-Benz','Clase A',2021,'Gasolina','Automático','Compacto',28900,33000,163,'Rojo','Madrid',0,0]
  ];
  const insC = db.prepare(`INSERT INTO cars(owner_id,brand,model,year,fuel,gear,body,price,km,power,color,province,doors,seats,env,extras,photos,warranty,certified,no_accidents,seller_type,descr,featured,status,views,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  sample.forEach((s, i) => {
    const ownerId = ids[s[11]];
    const ownerType = dealers[s[11]][2];
    const pool = [...EXTRAS];
    const nEx = 4 + (i % 6);
    const extras = [];
    for (let k = 0; k < nEx; k++) extras.push(pool.splice((i*7 + k*3) % pool.length, 1)[0]);
    insC.run(ownerId, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10],
      s[5]==='Coupé'?2:5, 5, envFor(s[3], s[2]), JSON.stringify(extras), '[]',
      ownerType==='pro'?1:0, (ownerType==='pro'&&i%2===0)?1:0, (i%3!==0)?1:0, ownerType,
      s[0]+' '+s[1]+' en excelente estado. Único propietario, mantenimiento al día en servicio oficial. Libro de revisiones y ITV en regla. Precio al contado.',
      s[12], 'active', Math.floor(Math.random()*400)+40, now - i*86400000*3);
  });
  console.log('Base de datos inicializada con', sample.length, 'coches de ejemplo.');
  promoteAdmin();
}

module.exports = { db, hashPassword, verifyPassword, seedIfEmpty, promoteAdmin };

'use strict';
/* ============================================================================
   connectors.js — ADAPTADORES DE FEED (patrón registro/plugin)
   ----------------------------------------------------------------------------
   Cada conector transforma una fuente (texto o URL) en un ARRAY de objetos
   "planos" (columna -> valor de texto). El motor de sync no sabe de formatos:
   solo pide `connectors.parse(type, payload)`.

   Para añadir un formato nuevo en el futuro (p. ej. un DMS concreto) basta con
   registrar un conector más en el objeto REGISTRY. Nada más cambia.
   ========================================================================== */

/* ---------- Utilidades ---------- */
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    // Array de primitivos -> lo unimos (útil para listas de imágenes)
    if (obj.every(v => typeof v !== 'object' || v === null)) {
      out[prefix || 'value'] = obj.join(' | ');
    } else {
      obj.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    }
    return out;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = String(obj);
  return out;
}

/* ---------- CSV / TSV (detección de separador y comillas) ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');                 // quita BOM
  const firstLine = (text.split(/\r?\n/)[0] || '');
  // separador más frecuente en la cabecera
  const cand = [',', ';', '\t', '|'];
  const sep = cand.sort((a, b) => (firstLine.split(b).length - firstLine.split(a).length))[0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === sep) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* ignora */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {}; headers.forEach((h, i) => o[h] = (r[i] ?? '').trim()); return o;
  });
}

/* ---------- JSON ---------- */
function parseJSON(text, itemPath) {
  const data = JSON.parse(text);
  let arr = locateArray(data, itemPath);
  if (!Array.isArray(arr)) throw new Error('No se encontró un array de vehículos en el JSON. Indica la ruta (item_path).');
  return arr.map(v => flatten(v));
}

/* Localiza el array de registros: por ruta explícita o auto (el mayor). */
function locateArray(data, itemPath) {
  if (itemPath) {
    let cur = data;
    for (const seg of itemPath.split(/[.>\/]/).filter(Boolean)) {
      if (cur == null) return null;
      cur = Array.isArray(cur) ? cur[+seg] : cur[seg];
    }
    return cur;
  }
  if (Array.isArray(data)) return data;
  let best = null;
  (function walk(o) {
    if (Array.isArray(o)) { if (o.length && typeof o[0] === 'object' && (!best || o.length > best.length)) best = o; o.forEach(walk); }
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  })(data);
  return best;
}

/* ---------- XML (parser minimalista sin dependencias) ---------- */
function xmlToObj(xml) {
  xml = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  xml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/[<&>]/g, s => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[s])));
  let i = 0;
  function parseNode() {
    const node = {};
    while (i < xml.length) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) break;
      const text = xml.slice(i, lt).trim();
      if (text) node['#text'] = (node['#text'] || '') + decode(text);
      i = lt;
      if (xml[i + 1] === '/') { i = xml.indexOf('>', i) + 1; return node; } // cierre
      const gt = xml.indexOf('>', i);
      let tag = xml.slice(i + 1, gt).trim();
      const selfClose = tag.endsWith('/');
      if (selfClose) tag = tag.slice(0, -1).trim();
      const name = tag.split(/\s+/)[0];
      i = gt + 1;
      let child = selfClose ? {} : parseNode();
      if (Object.keys(child).length === 1 && '#text' in child) child = child['#text'];
      else if (Object.keys(child).length === 0) child = '';
      if (node[name] === undefined) node[name] = child;
      else { if (!Array.isArray(node[name])) node[name] = [node[name]]; node[name].push(child); }
    }
    return node;
  }
  function decode(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
  return parseNode();
}
function parseXML(text, itemPath) {
  const tree = xmlToObj(text);
  let arr = locateArray(tree, itemPath);
  if (!arr) throw new Error('No se encontró la lista de vehículos en el XML. Indica el elemento repetido (item_path).');
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map(v => flatten(v));
}

/* ---------- Descarga por URL (allowlist de esquema) ---------- */
async function fetchSource(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('La URL debe empezar por http:// o https://');
  const r = await fetch(url, { headers: { 'User-Agent': 'MercaCoches-Feed/1.0' }, redirect: 'follow' });
  if (!r.ok) throw new Error('El servidor del feed respondió ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const body = await r.text();
  return { body, ct };
}
function sniffType(body, ct) {
  const t = body.trimStart();
  if (ct.includes('json') || t.startsWith('{') || t.startsWith('[')) return 'json';
  if (ct.includes('xml') || t.startsWith('<')) return 'xml';
  return 'csv';
}

/* ---------- Registro de conectores ---------- */
const REGISTRY = {
  csv: { parse: (payload) => parseCSV(payload.text) },
  xlsx: { parse: () => { throw new Error('Para .xlsx, guarda la hoja como CSV en Excel (Archivo → Guardar como → CSV) y súbela. El resto es idéntico.'); } },
  json: { parse: (payload) => parseJSON(payload.text, payload.item_path) },
  xml: { parse: (payload) => parseXML(payload.text, payload.item_path) },
  url: {
    parse: async (payload) => {
      const { body, ct } = await fetchSource(payload.source);
      const t = sniffType(body, ct);
      return REGISTRY[t].parse({ text: body, item_path: payload.item_path });
    }
  }
};

/* Punto de entrada único del subsistema. */
async function parse(type, payload) {
  const c = REGISTRY[type];
  if (!c) throw new Error('Tipo de feed no soportado: ' + type);
  return await c.parse(payload);
}

/* Columnas detectadas a partir de una muestra de filas (para el mapeo). */
function detectColumns(rows) {
  const set = new Set();
  rows.slice(0, 50).forEach(r => Object.keys(r).forEach(k => set.add(k)));
  return [...set];
}

module.exports = { parse, detectColumns, flatten, REGISTRY };

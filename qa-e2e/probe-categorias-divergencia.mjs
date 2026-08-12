// MIDE B31 y B32 sobre los datos que YA están guardados. No escribe una sola fila.
//
// B31: `CATEGORIA_MAP` mezcla dos cosas. Los ALIAS ortográficos (`Alimentacion` →
// `Alimentación`) no los discute nadie. Los COLAPSOS CON PÉRDIDA (`Viajes` → `Otros`,
// `Hogar` → `Vivienda`) sí: para esas claves, un gasto por WhatsApp cae en el destino del
// colapso mientras el mismo gasto por la webapp se queda con el nombre que el usuario
// escribió (`webapp/src/app/api/transactions/route.ts` persiste `body.categoria` crudo).
// Es el síntoma de B28 sin arreglar, para seis nombres.
//
// La medición de B26 que sostenía esa decisión asumía que el BACKEND era el único creador de
// raíces. No lo es: `syncCategoriasUsuario` (webapp) y `POST /api/categories` crean la raíz
// con el nombre crudo. Así que la pregunta que hay que responder con un número es:
// **¿cuántos usuarios tienen HOY una raíz activa cuyo nombre es clave de colapso, y cuántas
// filas quedaron del otro lado?**
//
// B32: las filas históricas que quedaron en `'Otros'` se quedan ahí. Desde el deploy de B28
// (`f6a6b8d`, 2026-08-11 23:42 UTC) el mismo concepto se parte en dos. Acá se cuenta el daño
// antes de escribir ninguna migración.
//
// CRITERIO, y es deliberadamente DETERMINÍSTICO y auditable (mismo criterio que
// `probe-categorias-encerradas.mjs`): una fila "menciona" una raíz cuando el nombre de la raíz
// aparece como TOKEN en `descripcion_original` o `comercio`, sin tildes y en minúsculas, con
// tolerancia singular/plural. No hay LLM acá. Es un PISO, no el total: un gasto de viaje que no
// dice "viaje" en el texto no se ve.
//
// EL CONTROL, que es lo que hace válida cualquier lectura (como en B26): las raíces custom que
// NO son clave de colapso pasan hoy por `resolverCategoriaPersistida` y se persisten crudas.
// Si la tasa de "el texto menciona la raíz pero la fila está guardada en otro lado" fuera igual
// en los dos grupos, el colapso no sería la causa y este probe estaría midiendo otra cosa.
//
// Correr:  node qa-e2e/probe-categorias-divergencia.mjs   (desde app/)  → siempre exit 0.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { clienteGuardado } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CATEGORIA_MAP, CATEGORIAS_VALIDAS } = require(path.join(appRoot, 'lib/constants.js'));

// Detrás de la barrera aunque solo lea: las lecturas pasan libres, y el día que alguien le
// agregue un "…y de paso arreglá las filas" la barrera ya está puesta.
const supabase = clienteGuardado(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Deploy de B28 (commit f6a6b8d). Antes de esta fecha el camino de WhatsApp normalizaba TODO.
const DEPLOY_B28 = '2026-08-11';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Singular/plural, la única flexión que se tolera. Sin esto `suscripcion` → `Suscripciones`
// se leería como colapso con pérdida cuando es un alias ortográfico más.
function mismaPalabra(a, b) {
  if (a === b) return true;
  for (const suf of ['s', 'es']) {
    if (a + suf === b || b + suf === a) return true;
  }
  return false;
}

// Las claves del mapa que PIERDEN información, derivadas del mapa y no escritas a mano: si
// alguien agrega una entrada nueva, este probe la clasifica solo.
function clasificarMapa() {
  const colapsos = new Map(); // nombre normalizado → destino canónico
  const alias = [];
  for (const [clave, destino] of Object.entries(CATEGORIA_MAP)) {
    if (mismaPalabra(norm(clave), norm(destino))) { alias.push(`${clave} → ${destino}`); continue; }
    colapsos.set(norm(clave), destino);
  }
  return { colapsos, alias };
}

function tokens(texto) {
  return norm(texto).split(/[^a-z0-9ñ]+/).filter(Boolean);
}

// "El texto menciona este nombre": por TOKEN, no por subcadena. Sin esto, "Auto" matchea
// "automatico" y "Comida" matchea cualquier cosa que la contenga — el conteo se infla solo.
function menciona(texto, nombre) {
  const objetivo = tokens(nombre);
  if (!objetivo.length) return false;
  const tk = tokens(texto);
  if (objetivo.length === 1) return tk.some(t => mismaPalabra(t, objetivo[0]));
  for (let i = 0; i + objetivo.length <= tk.length; i++) {
    if (objetivo.every((o, j) => mismaPalabra(tk[i + j], o))) return true;
  }
  return false;
}

// PostgREST corta en 1000 filas SIN avisar (`error` queda en null). Contar sobre una lista
// truncada daría un número tranquilizador y falso.
async function traerTodo(tabla, columnas, aplicarFiltros = (q) => q) {
  const filas = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await aplicarFiltros(supabase.from(tabla).select(columnas))
      .order('id', { ascending: true }).range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return filas;
}

async function main() {
  const { colapsos, alias } = clasificarMapa();

  const usuarios = await traerTodo('usuarios', 'id, is_test_user');
  const reales = new Set(usuarios.filter(u => !u.is_test_user).map(u => u.id));

  const cats = await traerTodo('categorias_usuario', 'id, usuario_id, nombre, padre_id, activa');
  const tx = await traerTodo('transacciones',
    'id, usuario_id, categoria, descripcion_original, comercio, fecha, created_at',
    (q) => q.eq('tipo', 'gasto'));
  const presupuestos = await traerTodo('presupuestos', 'id, usuario_id, categoria, subcategoria');

  const txPorUsuario = new Map();
  for (const t of tx) {
    if (!reales.has(t.usuario_id)) continue;
    if (!txPorUsuario.has(t.usuario_id)) txPorUsuario.set(t.usuario_id, []);
    txPorUsuario.get(t.usuario_id).push(t);
  }

  // Raíces ACTIVAS de usuarios reales. `activa === false` es un borrado deliberado y una raíz
  // soft-deleted no se reactiva (decisión de Favio, 11-ago), así que no cuenta como afectada.
  const raicesPorUsuario = new Map();
  for (const c of cats) {
    if (c.padre_id || c.activa === false || !reales.has(c.usuario_id)) continue;
    if (!raicesPorUsuario.has(c.usuario_id)) raicesPorUsuario.set(c.usuario_id, []);
    raicesPorUsuario.get(c.usuario_id).push(c);
  }

  const canonicasNorm = new Set([...CATEGORIAS_VALIDAS].map(norm));

  // ───────────────────────── B31 ─────────────────────────
  // Por cada raíz de colapso viva: cuántos usuarios, cuántas filas quedaron con el nombre
  // crudo (webapp) y cuántas en el destino del colapso (WhatsApp) mencionando la raíz.
  const porNombre = new Map();
  const usuariosAfectados = new Set();

  for (const [uid, raices] of raicesPorUsuario) {
    for (const raiz of raices) {
      const destino = colapsos.get(norm(raiz.nombre));
      if (!destino) continue;
      usuariosAfectados.add(uid);
      const k = `${raiz.nombre} → ${destino}`;
      if (!porNombre.has(k)) porNombre.set(k, { usuarios: new Set(), crudas: 0, enDestino: 0, enDestinoMenciona: 0, presupuestos: 0 });
      const acc = porNombre.get(k);
      acc.usuarios.add(uid);
      for (const t of txPorUsuario.get(uid) || []) {
        const cat = norm(t.categoria);
        const texto = [t.descripcion_original, t.comercio].filter(Boolean).join(' ');
        if (mismaPalabra(cat, norm(raiz.nombre))) { acc.crudas++; continue; }
        if (mismaPalabra(cat, norm(destino))) {
          acc.enDestino++;
          if (menciona(texto, raiz.nombre)) acc.enDestinoMenciona++;
        }
      }
      acc.presupuestos += presupuestos.filter(p => p.usuario_id === uid && !p.subcategoria
        && mismaPalabra(norm(p.categoria), norm(raiz.nombre))).length;
    }
  }

  // El control: la MISMA pregunta sobre raíces custom que no son clave de colapso. Esas hoy
  // se persisten crudas por los dos canales, así que su tasa de fuga es la línea base.
  function tasaDeFuga(filtroRaiz) {
    let menciones = 0, fugadas = 0, raicesVistas = 0;
    const porRaiz = new Map();
    for (const [uid, raices] of raicesPorUsuario) {
      for (const raiz of raices) {
        if (!filtroRaiz(raiz)) continue;
        raicesVistas++;
        for (const t of txPorUsuario.get(uid) || []) {
          const texto = [t.descripcion_original, t.comercio].filter(Boolean).join(' ');
          if (!menciona(texto, raiz.nombre)) continue;
          menciones++;
          if (!mismaPalabra(norm(t.categoria), norm(raiz.nombre))) {
            fugadas++;
            porRaiz.set(raiz.nombre, (porRaiz.get(raiz.nombre) || 0) + 1);
          }
        }
      }
    }
    return { raicesVistas, menciones, fugadas, porRaiz };
  }

  const esColapso = (r) => colapsos.has(norm(r.nombre));
  const esCustomLibre = (r) => !colapsos.has(norm(r.nombre)) && !canonicasNorm.has(norm(r.nombre));
  const esCanonica = (r) => canonicasNorm.has(norm(r.nombre));

  const fugaColapso = tasaDeFuga(esColapso);
  const fugaLibre = tasaDeFuga(esCustomLibre);
  const fugaCanonica = tasaDeFuga(esCanonica);

  // ───────────────────────── B32 ─────────────────────────
  // Filas en 'Otros' cuyo texto menciona una raíz PROPIA del usuario que hoy se persistiría
  // con ese nombre (custom libre o clave de colapso, si se decidiera dejarla pasar).
  let otrosTotal = 0, otrosRecuperables = 0, otrosRecuperablesPre = 0;
  const detalleB32 = new Map();
  const usuariosB32 = new Set();
  for (const [uid, lista] of txPorUsuario) {
    const raices = (raicesPorUsuario.get(uid) || []).filter(r => esCustomLibre(r) || esColapso(r));
    for (const t of lista) {
      if (!mismaPalabra(norm(t.categoria), 'otros')) continue;
      otrosTotal++;
      if (!raices.length) continue;
      const hit = raices.find(r => menciona([t.descripcion_original, t.comercio].filter(Boolean).join(' '), r.nombre));
      if (!hit) continue;
      otrosRecuperables++;
      usuariosB32.add(uid);
      if (String(t.fecha || '') < DEPLOY_B28) otrosRecuperablesPre++;
      detalleB32.set(hit.nombre, (detalleB32.get(hit.nombre) || 0) + 1);
    }
  }

  // Criterio ANCHO para B32: filas en 'Otros' cuyo texto menciona una clave de colapso, tenga
  // o no el usuario esa raíz. Es el daño del colapso en sí — el estrecho de arriba pide además
  // que el usuario ya se haya creado la raíz, y eso hoy lo cumple una sola persona.
  const otrosPorClave = new Map();
  for (const [uid, lista] of txPorUsuario) {
    for (const t of lista) {
      if (!mismaPalabra(norm(t.categoria), 'otros')) continue;
      const texto = [t.descripcion_original, t.comercio].filter(Boolean).join(' ');
      for (const claveNorm of colapsos.keys()) {
        if (!menciona(texto, claveNorm)) continue;
        if (!otrosPorClave.has(claveNorm)) otrosPorClave.set(claveNorm, { filas: 0, usuarios: new Set() });
        const a = otrosPorClave.get(claveNorm);
        a.filas++; a.usuarios.add(uid);
      }
    }
  }

  // Las REGLAS POR COMERCIO son la puerta que hoy escribe categorías no canónicas de verdad
  // (hallazgo B30): `catFinal = regla.categoria`, sin pasar por `resolverCategoriaPersistida`.
  // Va acá porque explica los números de B31: sin esto, la lectura culpa a la webapp.
  const reglas = await traerTodo('reglas_comercio', 'id, usuario_id, comercio_pattern, categoria');
  const reglasReales = reglas.filter(r => reales.has(r.usuario_id));
  const reglasColapso = reglasReales.filter(r => colapsos.has(norm(r.categoria)));
  const reglasNoCanon = reglasReales.filter(r => !canonicasNorm.has(norm(r.categoria)) && !colapsos.has(norm(r.categoria)));

  // ───────────────────────── salida ─────────────────────────
  const pct = (a, b) => (b === 0 ? '—' : (100 * a / b).toFixed(1) + '%');

  console.log('\n═══ B31 · claves de COLAPSO CON PÉRDIDA de CATEGORIA_MAP ═══\n');
  console.log(`colapsos derivados del mapa : ${[...new Set([...colapsos].map(([k, v]) => `${k}→${v}`))].join(', ')}`);
  console.log(`alias ortográficos (no cuentan): ${alias.length} entradas`);
  console.log(`\nuniverso: ${reales.size} usuarios reales, ${tx.filter(t => reales.has(t.usuario_id)).length} gastos, ${raicesPorUsuario.size} con árbol propio`);

  console.log(`\nusuarios con una raíz ACTIVA cuyo nombre es clave de colapso: ${usuariosAfectados.size}\n`);
  if (porNombre.size) {
    console.log('  raíz → destino          usuarios   filas crudas   filas en destino   de esas, mencionan la raíz   presupuestos');
    for (const [k, v] of [...porNombre.entries()].sort((a, b) => b[1].usuarios.size - a[1].usuarios.size)) {
      console.log(`  ${k.padEnd(22)} ${String(v.usuarios.size).padStart(8)} ${String(v.crudas).padStart(14)} ${String(v.enDestino).padStart(18)} ${String(v.enDestinoMenciona).padStart(28)} ${String(v.presupuestos).padStart(14)}`);
    }
  } else {
    console.log('  (ninguna)');
  }

  console.log('\n─── control: ¿la fila se va a otra categoría aunque el texto nombre la raíz? ───\n');
  const fila = (nombre, r) => `  ${nombre.padEnd(34)} ${String(r.fugadas).padStart(5)} de ${String(r.menciones).padStart(5)} menciones  (${pct(r.fugadas, r.menciones)})   sobre ${r.raicesVistas} raíces`;
  console.log(fila('raíces de COLAPSO', fugaColapso));
  console.log(fila('raíces custom libres  ← control', fugaLibre));
  console.log(fila('raíces canónicas      ← control', fugaCanonica));
  // El desglose NO es decorativo: una raíz que es NOMBRE PROPIO (un cliente, una marca) aparece
  // en la descripción de gastos que están bien categorizados en otra cosa, e infla la fuga del
  // control sola. Sin ver quién aporta, la tasa del control se lee como divergencia y no lo es.
  const topFuga = [...fugaLibre.porRaiz.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topFuga.length) {
    console.log('\n  quién aporta la fuga del control (ojo con los nombres propios):');
    for (const [n, c] of topFuga) console.log(`    ${String(c).padStart(4)}  ${n}`);
  }

  console.log('\n═══ B32 · lo que quedó encerrado en Otros ═══\n');
  console.log(`gastos en 'Otros' (usuarios reales)                       : ${otrosTotal}`);
  console.log(`de esos, el texto menciona una raíz PROPIA del usuario    : ${otrosRecuperables}  (${pct(otrosRecuperables, otrosTotal)})`);
  console.log(`  · anteriores al deploy de B28 (${DEPLOY_B28})            : ${otrosRecuperablesPre}`);
  console.log(`usuarios afectados                                        : ${usuariosB32.size}`);
  if (detalleB32.size) {
    console.log('\n  a qué raíz irían:');
    for (const [n, c] of [...detalleB32.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${n}`);
    }
  }

  console.log('\n  criterio ANCHO — filas en Otros que mencionan una clave de colapso,');
  console.log('  tenga o no el usuario esa raíz:');
  if (otrosPorClave.size) {
    for (const [n, v] of [...otrosPorClave.entries()].sort((a, b) => b[1].filas - a[1].filas)) {
      console.log(`    ${String(v.filas).padStart(4)}  ${n}  (${v.usuarios.size} usuarios)`);
    }
  } else {
    console.log('    (ninguna)');
  }

  console.log('\n═══ contexto · reglas por comercio (la puerta de B30) ═══\n');
  console.log(`reglas de usuarios reales                    : ${reglasReales.length} (${new Set(reglasReales.map(r => r.usuario_id)).size} usuarios)`);
  console.log(`con categoría = clave de COLAPSO             : ${reglasColapso.length} (${new Set(reglasColapso.map(r => r.usuario_id)).size} usuarios)`);
  console.log(`con categoría no canónica y no colapso       : ${reglasNoCanon.length} (${new Set(reglasNoCanon.map(r => r.usuario_id)).size} usuarios)`);
  console.log('Estas escriben `catFinal = regla.categoria` sin pasar por resolverCategoriaPersistida:');
  console.log('normalizarlas de golpe mandaría esas ' + reglasNoCanon.length + ' a Otros. Es el tradeoff de B30, no de B31.');

  console.log('\nEl criterio es por TOKEN sobre descripcion_original/comercio, sin LLM: es un PISO.');
  console.log('No se escribió ninguna fila.\n');
}

await main();

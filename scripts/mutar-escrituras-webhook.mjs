#!/usr/bin/env node
/**
 * Mutación sobre las guardas del ítem 9B-ter: las 6 escrituras y las 3 lecturas de
 * `handlers/webhook.js`.
 *
 * Hermano de `mutar-escrituras-intents.mjs`, con tres diferencias que importan:
 *
 * 1. **Corre SOLO `tests/handlers/escrituras-del-webhook.test.js`, no `tests/handlers/`.** El
 *    helper es compartido con 9B-bis, así que apuntando al directorio entero una mutación del
 *    helper podría morir por el archivo del ítem anterior y este script diría "muere" sobre
 *    cobertura que no es suya. Lo que se quiere saber acá es si el archivo NUEVO mide el
 *    mecanismo.
 *
 * 2. **Las mutaciones estructurales van una por sitio y a mano.** Una regex sobre `if (!entro(…))`
 *    encontraría tres de cinco: `/silenciar` y `/recordar` lo leen con un ternario. Una lista
 *    implícita habría reportado "3 sitios" y salido verde, que es el perímetro corto que este
 *    repo ya pagó tres veces.
 *
 * 3. **Las tres LECTURAS entran acá**, aunque no sean la misma clase. Cada una tiene su mutación
 *    en las DOS direcciones donde eso significa algo: neutralizar la guarda nueva, y —en el
 *    referrer— borrar la excepción de `PGRST116`, que es lo único que mide si el CONTROL del
 *    caso normal está midiendo algo o pasa por casualidad.
 *
 * **Lo que este script NO cubre, declarado**: el ORDEN del write y el menú en `/categorias` no
 * se muta como orden (moverlo de vuelta es una reescritura, no un reemplazo de cadena). Lo que
 * sí se muta es su guarda, que produce el mismo desenlace observable — el menú impreso sobre un
 * paso que no entró. La diferencia no está medida.
 *
 * Uso:
 *   node scripts/mutar-escrituras-webhook.mjs
 *   node scripts/mutar-escrituras-webhook.mjs --completa   # supervivientes contra la suite entera
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HELPER = 'helpers/escritura-verificada.js';
const W = 'handlers/webhook.js';
const ARCHIVOS = [HELPER, W];
const TESTS = 'tests/handlers/escrituras-del-webhook.test.js';
const COMPLETA = process.argv.includes('--completa');

const MUTACIONES = [
  // ══ El helper: cada una tiene que matar a los seis sitios ══════════════════
  {
    archivo: HELPER,
    id: 'helper · el `error` descartado (el bug original, exacto)',
    de: '  if (error) {\n    log.error({ tag: TAG',
    a: '  if (false && error) {\n    log.error({ tag: TAG',
  },
  {
    archivo: HELPER,
    id: 'helper · las cero filas confirmadas como éxito',
    de: '  if (!tocoAlgo) {',
    a: '  if (false && !tocoAlgo) {',
  },
  {
    archivo: HELPER,
    id: 'helper · `[]` cuenta como "tocó algo" (el RETURNING vacío de postgrest)',
    de: '  const tocoAlgo = Array.isArray(filas) ? filas.length > 0 : filas != null;',
    a: '  const tocoAlgo = filas != null;',
  },
  {
    archivo: HELPER,
    id: 'helper · los dos diagnósticos colapsados en uno',
    de: "    return 'sin_fila';",
    a: "    return 'error';",
  },
  {
    archivo: HELPER,
    id: 'helper · el tag renombrado (la observabilidad sin test se borra sola)',
    de: "const TAG = 'INTENT_ESCRITURA';",
    a: "const TAG = 'OTRA_COSA';",
  },
  {
    archivo: HELPER,
    id: 'helper · el `sitio` fuera del log: no se sabe cuál de los seis falló',
    de: '    log.error({ tag: TAG, sitio, userId, campos, err: error.message },',
    a: '    log.error({ tag: TAG, userId, campos, err: error.message },',
  },
  {
    archivo: HELPER,
    id: 'helper · SIN catch: un rechazo del cliente sube al catch de la cascada',
    reemplazaBloque: {
      desde: '  try {\n    ({ data: filas, error } = await consulta);',
      hasta: "    error = { message: (e && e.message) || String(e) };\n  }",
      por: '  ({ data: filas, error } = await consulta);',
    },
  },
  {
    archivo: HELPER,
    id: 'helper · `ceroFilas` siempre "esperado": los seis pierden su diagnóstico',
    de: "    if (ceroFilas === 'esperado') return 'ok';",
    a: "    return 'ok';",
  },
  {
    archivo: HELPER,
    id: 'helper · `ceroFilas` NUNCA "esperado"',
    // El espejo del anterior. Va igual, aunque se declara EQUIVALENTE abajo: ningún sitio de
    // `webhook.js` pasa `ceroFilas:'esperado'`, así que desde este archivo no es distinguible.
    // Se escribe para que el día que alguien agregue un sitio con cero-filas-esperadas, el
    // superviviente aparezca solo en vez de faltar la mutación.
    de: "    if (ceroFilas === 'esperado') return 'ok';",
    a: "    if (false) return 'ok';",
  },

  // ══ Las cinco guardas de copy, una por sitio ═══════════════════════════════
  // Dos de las cinco NO usan `if (!entro(…))`: `/silenciar` y `/recordar` deciden con un
  // ternario. Por eso la lista es explícita.
  {
    archivo: W,
    id: 'guarda neutralizada · webhook_silenciar (ternario, no `if`)',
    de: 'respuesta = entro(vSilenciar)',
    a: 'respuesta = (true || entro(vSilenciar))',
  },
  {
    archivo: W,
    id: 'guarda neutralizada · webhook_recordar (ternario, no `if`)',
    de: 'respuesta = entro(vRecordar)',
    a: 'respuesta = (true || entro(vRecordar))',
  },
  {
    archivo: W,
    id: 'guarda neutralizada · webhook_manoslibres',
    de: 'respuesta = !entro(vManos)',
    a: 'respuesta = (false && !entro(vManos))',
  },
  {
    archivo: W,
    id: 'guarda neutralizada · webhook_ref_code',
    de: 'if (!entro(vRefCode))',
    a: 'if (false && !entro(vRefCode))',
  },
  {
    archivo: W,
    id: 'guarda neutralizada · webhook_categorias_menu (imprime el menú igual)',
    de: 'if (!entro(vMenuCats))',
    a: 'if (false && !entro(vMenuCats))',
  },

  // ══ Las decisiones que NO son la guarda del copy ═══════════════════════════
  {
    archivo: W,
    id: 'ref_code · la fila EN MEMORIA se ensucia igual con el código que no entró',
    de: '          refCode = null;\n        } else {\n          usuario.ref_code = refCode;\n        }',
    a: '        }\n        usuario.ref_code = refCode;',
  },
  {
    archivo: W,
    id: 'otp · el `sitio` colapsado con otro: el log deja de decir cuál falló',
    de: "{ sitio: 'webhook_otp_verificado', userId,",
    a: "{ sitio: 'webhook_silenciar', userId,",
  },

  // ══ El RETURNING, por sitio ════════════════════════════════════════════════
  // Sin `.select('id')` postgrest devuelve `data: null` SIEMPRE, o sea `sin_fila` en el camino
  // feliz. Lo mata el control de "cero logs" — que es justo el control que 9A no tenía.
  ...[
    ["supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id)", 'webhook_silenciar'],
    ["supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id)", 'webhook_recordar'],
    ["supabase.from('usuarios').update({ manos_libres: nuevoEstado }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ manos_libres: nuevoEstado }).eq('id', usuario.id)", 'webhook_manoslibres'],
    ["supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id)", 'webhook_ref_code'],
    ["supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id)", 'webhook_categorias_menu'],
    ["}).eq('id', otp.id).select('id'),", "}).eq('id', otp.id),", 'webhook_otp_verificado'],
  ].map(([de, a, sitio]) => ({ archivo: W, id: `SIN el RETURNING · ${sitio}`, de, a })),

  // ══ Los WHERE ══════════════════════════════════════════════════════════════
  // `intento(tabla, verbo)` dice que hubo un update, NUNCA sobre qué. Sin mirar el filtro, un
  // UPDATE sin WHERE apaga los recordatorios de TODA la base con la suite en verde.
  ...[
    ["supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ recordatorios_activos: false }).select('id')", 'webhook_silenciar'],
    ["supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ recordatorios_activos: true }).select('id')", 'webhook_recordar'],
    ["supabase.from('usuarios').update({ manos_libres: nuevoEstado }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ manos_libres: nuevoEstado }).select('id')", 'webhook_manoslibres'],
    ["supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ ref_code: refCode }).select('id')", 'webhook_ref_code'],
    ["supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id).select('id')",
      "supabase.from('usuarios').update({ onboarding_paso: 10 }).select('id')", 'webhook_categorias_menu'],
  ].map(([de, a, sitio]) => ({ archivo: W, id: `SIN el WHERE · ${sitio}`, de, a })),

  // ══ Lo que agregó la segunda vuelta (revisión adversarial) ════════════════
  {
    archivo: W,
    id: 'F1 · SIN el RETURNING en el link directo: cero filas se lee como éxito',
    de: "          }).eq('id', usuario.id).select('id');",
    a: "          }).eq('id', usuario.id);",
  },
  {
    archivo: W,
    id: 'F1 · la guarda de cero filas del link directo, neutralizada',
    de: '          if (!linkFilas || linkFilas.length === 0) {',
    a: '          if (false && (!linkFilas || linkFilas.length === 0)) {',
  },
  {
    archivo: W,
    id: 'F2 · el código DUPLICADO tratado como fallo transitorio (callejón sin salida)',
    de: "        if (errOtp && errOtp.code !== 'PGRST116') {",
    a: '        if (errOtp) {',
  },
  // **UNA mutacion por rama, no una por la primera.** La version anterior de este script
  // anclaba solo la llamada del `errOtp`, asi que borrar el refund de las otras cinco pasaba
  // con la SUITE ENTERA en verde (2305 tests): el guard midiendose contra la mitad de lo que
  // declara. Lo encontro la revision DEL ARREGLO.
  ...[
    ["          log.error({ tag: 'WEBAPP_OTP', from, err: errOtp.message }, 'No se pudo leer el código: no se declara inválido');\n          otpDevolverIntento(from);",
      "          log.error({ tag: 'WEBAPP_OTP', from, err: errOtp.message }, 'No se pudo leer el código: no se declara inválido');", 'la lectura del codigo'],
    ["          log.error({ tag: 'WEBAPP_OTP', from, err: errWebRow.message }, 'No se pudo leer la cuenta web: no se elige rama a ciegas');\n          otpDevolverIntento(from);",
      "          log.error({ tag: 'WEBAPP_OTP', from, err: errWebRow.message }, 'No se pudo leer la cuenta web: no se elige rama a ciegas');", 'la lectura de la cuenta web'],
    ["              'El link directo no tocó NINGUNA fila: no se confirma el vínculo ni se quema el código');\n            otpDevolverIntento(from);",
      "              'El link directo no tocó NINGUNA fila: no se confirma el vínculo ni se quema el código');", 'el link directo con cero filas'],
    ["          log.error({ tag: 'WEBAPP_OTP', err: mergeErr.message }, 'Error en merge_and_link');\n          otpDevolverIntento(from);",
      "          log.error({ tag: 'WEBAPP_OTP', err: mergeErr.message }, 'Error en merge_and_link');", 'merge_and_link se cayo'],
    ["          log.error({ tag: 'WEBAPP_OTP', result: mergeResult }, 'merge_and_link resultado inesperado');\n          otpDevolverIntento(from);",
      "          log.error({ tag: 'WEBAPP_OTP', result: mergeResult }, 'merge_and_link resultado inesperado');", 'merge_and_link devolvio otra cosa'],
    ["        log.error({ tag: 'WEBAPP_OTP', err: e.message }, 'Error verificando cuenta web');",
      "        log.error({ tag: 'WEBAPP_OTP', err: e.message }, 'Error verificando cuenta web'); if (false)", 'el catch del bloque'],
  ].map(([de, a, rama]) => ({ archivo: W, id: `F3 · la ficha NO se devuelve · ${rama}`, de, a })),
  {
    archivo: W,
    id: 'F3 · el rate limit deja de contar (el espejo: la defensa contra fuerza bruta apagada)',
    // `e.count += 1;` aparece DOS veces (el throttle del OTP y el del remitente), asi que la
    // mutacion va sobre el `return`, que es unico.
    de: '  return e.count > OTP_MAX_INTENTOS;',
    a: '  return false;',
  },
  {
    archivo: W,
    id: 'F4 · el log del merge nombra al loser, que merge_and_link acaba de borrar',
    de: '        await marcarVerificado(webRow.id);',
    a: '        await marcarVerificado();',
  },
  {
    archivo: W,
    id: 'F5 · SIN el WHERE · webhook_otp_verificado (marca verificados TODOS los OTP pendientes)',
    de: "          }).eq('id', otp.id).select('id'),",
    a: '          }).select(\'id\'),',
  },
  {
    archivo: W,
    id: 'F8 · SIN el `.neq`: uno se puede referir a sí mismo y sembrarse el 50% off',
    de: ".eq('ref_code', refCode).neq('id', usuario.id).single()",
    a: ".eq('ref_code', refCode).single()",
  },
  {
    archivo: W,
    id: 'F9 · el diagnóstico de la lectura del OTP borrado (queda sólo el copy)',
    de: "          log.error({ tag: 'WEBAPP_OTP', from, err: errOtp.message }, 'No se pudo leer el código",
    a: "          log.error({ tag: 'OTRA_COSA', from, err: errOtp.message }, 'No se pudo leer el código",
  },

  // ══ Las tres LECTURAS ══════════════════════════════════════════════════════
  {
    archivo: W,
    id: 'lectura :636 · el error del OTP descartado: "tu código no es válido" sobre uno que sí lo es',
    de: "        if (errOtp && errOtp.code !== 'PGRST116') {",
    a: "        if (false && errOtp && errOtp.code !== 'PGRST116') {",
  },
  {
    archivo: W,
    id: 'lectura :650 · el error de la fila web descartado: elige la rama del link directo a ciegas',
    de: '        if (errWebRow) {',
    a: '        if (false && errWebRow) {',
  },
  {
    archivo: W,
    id: 'lectura :732 · el referrer que no se pudo leer vuelve a ser indiagnosticable',
    de: "      if (errReferrer && errReferrer.code !== 'PGRST116') {",
    a: "      if (false && errReferrer && errReferrer.code !== 'PGRST116') {",
  },
  {
    archivo: W,
    id: 'lectura :732 · SIN la excepción de PGRST116: un código inexistente grita todos los días',
    // El espejo del anterior, y es el que mide si el CONTROL del caso normal está midiendo algo.
    // Un guard que grita sin motivo deja de leerse: esta dirección importa tanto como la otra.
    de: "      if (errReferrer && errReferrer.code !== 'PGRST116') {",
    a: '      if (errReferrer) {',
  },
];

function correr(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
}

const RESCATE = '.mutacion-en-curso.json';
if (existsSync(RESCATE)) {
  const previo = JSON.parse(readFileSync(RESCATE, 'utf-8'));
  for (const [f, s] of Object.entries(previo.archivos || {})) writeFileSync(f, s);
  unlinkSync(RESCATE);
  console.log(`recuperado: una corrida anterior murió mutando "${previo.id}".\n`);
}

const originales = new Map(ARCHIVOS.map((f) => [f, readFileSync(f, 'utf-8')]));
const restaurar = () => {
  for (const [f, s] of originales) writeFileSync(f, s);
  if (existsSync(RESCATE)) unlinkSync(RESCATE);
};
process.on('SIGINT', () => { restaurar(); process.exit(130); });

const cmdTests = `npx vitest run ${TESTS} --reporter=dot`;
process.stdout.write('baseline… ');
if (!correr(cmdTests)) { console.error('ROJO. Una mutación sólo dice algo con baseline verde.'); process.exit(1); }
console.log('verde\n');

const headDe = new Map(ARCHIVOS.map((f) => {
  try { return [f, execSync(`git show HEAD:${f}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })]; } catch { return [f, '']; }
}));

function aplicar(m, src) {
  if (m.reemplazaBloque) {
    const { desde, hasta, por } = m.reemplazaBloque;
    const i = src.indexOf(desde);
    const j = src.indexOf(hasta, i);
    if (i === -1 || j === -1) { console.error(`FATAL: no encontré el bloque de "${m.id}"`); restaurar(); process.exit(1); }
    return src.slice(0, i) + por + src.slice(j + hasta.length);
  }
  const partes = src.split(m.de);
  if (partes.length < 2) { console.error(`FATAL: no encontré "${m.id}"`); restaurar(); process.exit(1); }
  if (partes.length > 2) { console.error(`FATAL: "${m.de}" aparece ${partes.length - 1} veces (${m.id}): la mutación sería ambigua`); restaurar(); process.exit(1); }
  return partes.join(m.a);
}

/**
 * Supervivientes DECLARADOS, cada uno con lo que se midió para declararlo. Un superviviente sin
 * explicación entrena a ignorar la lista entera — y una explicación sin medición es peor,
 * porque se lee igual.
 *
 * Los tres son del HELPER, que es compartido con 9B-bis. Ninguno es un hueco de este archivo:
 * dos son inobservables desde `webhook.js` y el tercero lo mata el archivo hermano, que este
 * script no corre a propósito (ver el docblock de arriba).
 */
const EQUIVALENTES = {
  'helper · `ceroFilas` NUNCA "esperado"':
    'ningún sitio de webhook.js pasa ceroFilas:"esperado" (medido: 0 ocurrencias)',
  'helper · los dos diagnósticos colapsados en uno':
    'ningún sitio de webhook.js compara contra "sin_fila" (medido: 0 ocurrencias); `entro()` da false con los dos, y el log ya salió como warn antes del return',
  'helper · el tag renombrado (la observabilidad sin test se borra sola)':
    'lo mata el pin literal de tests/handlers/escrituras-de-intents.test.js:1070 — medido corriendo la mutación contra tests/handlers/ (1 test rojo). Acá sobrevive porque el spy importa TAG_ESCRITURA del propio helper, o sea que se mide contra su propia declaración',
};
const equivalentesVistos = [];
const supervivientes = [];
let n = 0;

for (const m of MUTACIONES) {
  n++;
  const archivo = m.archivo;
  const src = originales.get(archivo);
  const mutado = aplicar(m, src);
  // La línea que este script existe para tener: una mutación no aplicada y una que el test no
  // atrapa producen el MISMO verde.
  if (mutado === src) { console.error(`FATAL: la mutación "${m.id}" no cambió el archivo`); restaurar(); process.exit(1); }
  writeFileSync(RESCATE, JSON.stringify({ id: m.id, archivos: { [archivo]: src } }));
  writeFileSync(archivo, mutado);

  const verde = correr(cmdTests);
  restaurar();
  const equivalente = EQUIVALENTES[m.id];
  const preexistente = !m.reemplazaBloque && !!(m.de || '') && (headDe.get(archivo) || '').includes(m.de);
  const nota = !verde ? '' : equivalente ? `  [equivalente: ${equivalente}]` : preexistente ? '  [preexistente]' : '';
  console.log(`${String(n).padStart(3)}/${MUTACIONES.length} ${verde ? 'SOBREVIVE' : 'muere    '} ${m.id}${nota}`);
  if (verde && !equivalente) supervivientes.push({ ...m, preexistente });
  if (verde && equivalente) equivalentesVistos.push(m.id);
}

const juzgables = MUTACIONES.length - equivalentesVistos.length;
console.log(`\n${juzgables - supervivientes.length}/${juzgables} mueren (${equivalentesVistos.length} equivalentes excluidas).`);
for (const id of Object.keys(EQUIVALENTES)) {
  if (!equivalentesVistos.includes(id)) console.log(`  ⚠ declarada equivalente pero MURIÓ (o no corrió): ${id}`);
}
if (supervivientes.length) {
  console.log(`Supervivientes: ${supervivientes.length}.`);
  for (const s of supervivientes) console.log('  · ' + s.id + (s.preexistente ? '  [preexistente]' : ''));
}
if (COMPLETA && supervivientes.length) {
  console.log('\n— cada superviviente contra la suite entera —');
  for (const s of supervivientes) {
    const src = originales.get(s.archivo);
    writeFileSync(RESCATE, JSON.stringify({ id: s.id, archivos: { [s.archivo]: src } }));
    writeFileSync(s.archivo, aplicar(s, src));
    const verde = correr('npx vitest run --reporter=dot');
    restaurar();
    console.log(`  ${verde ? 'SOBREVIVE' : 'muere    '} ${s.id}`);
  }
}
process.exit(supervivientes.length ? 1 : 0);

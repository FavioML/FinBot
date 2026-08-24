#!/usr/bin/env node
/**
 * Mutación sobre las guardas del ítem 9A: las escrituras de plata de
 * `handlers/intents/transacciones.js` y el orden del callback Pro de `handlers/admin-commands.js`.
 *
 * Hermano de `scripts/mutar-lecturas-error.mjs`, con dos diferencias que importan:
 *
 * 1. **Hay mutaciones que NO son `if (err)`.** Dos de los tres arreglos de este ítem son
 *    decisiones de ORDEN: reclamar la copia antes de insertar (`restaurar_eliminado`) y resolver
 *    al usuario antes del claim del pago (`procesarCallbackAdmin`). Una guarda neutralizada no
 *    puede expresar "esto pasó en el orden equivocado", así que esas dos van declaradas a mano,
 *    con el par exacto de texto que las invierte. Si el texto de origen no aparece, es error
 *    fatal: una mutación estructural que no se aplica se ve idéntica a una que el test no atrapa.
 *
 * 2. **Reporta si el superviviente es PREEXISTENTE.** Las guardas viejas de estos dos archivos se
 *    mutan igual —es la única forma de medirlas— pero se marcan contra `git show HEAD:` para no
 *    contar como deuda de esta sesión algo que ya estaba.
 *
 * Uso:
 *   node scripts/mutar-escrituras-plata.mjs
 *   node scripts/mutar-escrituras-plata.mjs --completa   # supervivientes contra la suite entera
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ARCHIVOS = ['handlers/intents/transacciones.js', 'handlers/admin-commands.js'];
const TESTS = 'tests/handlers/';
const COMPLETA = process.argv.includes('--completa');

// ─── Mutaciones automáticas: toda guarda cuya condición mira un error ────────
// `if (errX)` → `if (false && errX)`: el error queda destructurado y descartado, que es
// EXACTAMENTE la forma del bug original. No se borra la línea: borrarla cambiaría también el
// destructuring y la mutación probaría otra cosa.
//
// La primera versión de esta regex exigía que el identificador tuviera algo ANTES de `err`
// (`[A-Za-z_$][\w$]*` y después `err`), así que veía `insErr` y no veía `errMoneda`,
// `errEditFecha` ni ninguna de las nueve guardas nuevas: encontró 6 sitios de 20 y la corrida
// salió "5/6 mueren", que se lee como cobertura excelente. **Un mutador con el perímetro corto
// da el mismo verde que uno con el perímetro completo.** Por eso acá el reconocimiento del
// identificador es tonto a propósito y el filtro `err` se aplica DESPUÉS, sobre el nombre.
const RE_GUARDA = /if \((!?[A-Za-z_$][\w$]*(?: (?:&&|\|\|) [^)]+)?)\)/;

// Los comentarios se BLANQUEAN antes de buscar. La primera corrida mutó dos docblocks que
// citan `if (error)` explicándolo, y un comentario mutado no cambia el comportamiento: sale
// SOBREVIVE siempre. O sea que el ruido no era neutro — inflaba el denominador y ponía dos
// falsos "sin cobertura" en la lista que uno se sienta a revisar.
const blanco = (m) => m.replace(/[^\n]/g, ' ');
const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blanco).replace(/\/\/[^\n]*/g, blanco);

function automaticas(rel) {
  const lineas = sinComentarios(readFileSync(rel, 'utf-8')).split('\n');
  const out = [];
  lineas.forEach((l, i) => {
    const m = l.match(RE_GUARDA);
    if (!m) return;
    if (!/err/i.test(m[1].split(' ')[0])) return;
    out.push({
      id: `${rel}:${i + 1} ${m[1]}`,
      archivo: rel,
      de: m[0],
      // **Los paréntesis no son estilo.** `if (false && error || !data)` se agrupa como
      // `(false && error) || !data`, o sea que la guarda sigue decidiendo por `!data` y la
      // mutación es un no-op: `guardarSnabshotEliminacion` salía SOBREVIVE por eso, no por
      // falta de test.
      a: `if (false && (${m[1]}))`,
      linea: i + 1,
    });
  });
  return out;
}

// Guardas que deciden pero no nombran un error. Van explícitas: la regex de arriba no las ve y
// una lista implícita sería justo el agujero que el ítem 7 documentó.
const EXTRAS = [
  { archivo: 'handlers/intents/transacciones.js', de: "if (snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');", a: "if (false && snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');", ocurrencia: 1, id: 'transacciones.js: compensacion de la rama ERROR (eliminar)' },
  { archivo: 'handlers/intents/transacciones.js', de: "if (snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');", a: "if (false && snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');", ocurrencia: 1, id: 'transacciones.js: compensacion de la rama ERROR (deshacer)' },
  { archivo: 'handlers/intents/transacciones.js', de: 'if (!copiaReclamada) {', a: 'if (false && !copiaReclamada) {' },

  // **Las ramas que el reorden INTRODUJO, que la regex de arriba no ve.** La primera versión
  // mutaba 25 sitios y ni uno solo era del reorden del callback Pro: `RE_GUARDA` exige la forma
  // `if (<identificador>)` y ese flujo decide con `resuelto.answer`, `!claimed` y una
  // comparación de estado. Medido por la revisión adversarial: borrar
  // `if (pago.estado !== 'pendiente') return …` dejaba 406 tests en verde mientras el reporte
  // decía "25/25 mueren". **Un mutador que no cubre lo que el commit cambió mide el commit
  // anterior**, y sale igual de verde.
  { archivo: 'handlers/admin-commands.js', de: 'if (resuelto.answer) return { answer: resuelto.answer };', a: 'if (false && resuelto.answer) return { answer: resuelto.answer };', ocurrencia: 0 },
  { archivo: 'handlers/admin-commands.js', de: 'if (resuelto.answer) return { answer: resuelto.answer };', a: 'if (false && resuelto.answer) return { answer: resuelto.answer };', ocurrencia: 1 },
  { archivo: 'handlers/admin-commands.js', de: "if (pago.estado !== 'pendiente')", a: "if (false && pago.estado !== 'pendiente')", ocurrencia: 0 },
  { archivo: 'handlers/admin-commands.js', de: "if (!pago) return { answer: 'Solicitud no encontrada' };", a: "if (false && !pago) return { answer: 'Solicitud no encontrada' };", ocurrencia: 0 },
  { archivo: 'handlers/admin-commands.js', de: "if (!usuario) return { answer: 'Usuario no encontrado' };", a: "if (false && !usuario) return { answer: 'Usuario no encontrado' };", ocurrencia: 0 },
  { archivo: 'handlers/admin-commands.js', de: 'if (!claimed) return { answer: await estadoTrasPerderClaim(pagoId) };', a: 'if (false && !claimed) return { answer: await estadoTrasPerderClaim(pagoId) };', ocurrencia: 0 },

  // **Los PREDICADOS que hacen atómico a cada claim.** Son la mitad del arreglo y ninguna
  // mutación los tocaba. Quitarlos deja el UPDATE incondicional, o sea la duplicación que el
  // reorden dice cerrar — y los dos mocks los trataban como passthrough, así que la suite
  // entera pasaba sin ellos.
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', objetivo.id).is('restored_at', null)", a: ".is('restored_at', null)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', objetivo.id).is('restored_at', null)", a: ".eq('id', objetivo.id)", ocurrencia: 0, id: "transacciones.js · claim de la copia SIN .is('restored_at', null)" },
  { archivo: 'handlers/admin-commands.js', de: ".eq('id', pagoId).eq('estado', 'pendiente')", a: ".eq('id', pagoId)", ocurrencia: 0 },

  // **Lo que la SEGUNDA revisión midió vivo con el reporte diciendo "35/35 mueren".** Cada una
  // de estas sobrevivía, y las tres primeras son sobre escrituras destructivas: el `id` que
  // apunta la compensación, el `id` que apunta la devolución a pendiente, y la rama del catch
  // (que además el mutador viejo no podía tocar — su entrada usaba `ocurrencia: 0` y la cadena
  // aparece dos veces, así que mutaba siempre la rama-error y nunca el catch).
  { archivo: 'handlers/intents/transacciones.js', de: "await supabase.from('transacciones_eliminadas').delete().eq('id', snapshotId)", a: "await supabase.from('transacciones_eliminadas').delete().eq('tag', snapshotId)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".update({ restored_at: null }).eq('id', objetivo.id)", a: ".update({ restored_at: null })", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: "if (snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');", a: "if (false && snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');", ocurrencia: 2, id: 'transacciones.js · compensación del CATCH (eliminar)' },
  { archivo: 'handlers/intents/transacciones.js', de: "if (snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');", a: "if (false && snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');", ocurrencia: 2, id: 'transacciones.js · compensación del CATCH (deshacer)' },
  { archivo: 'handlers/intents/transacciones.js', de: "if (!errBorrar && (!filasBorradas || filasBorradas.length === 0))", a: "if (false && !errBorrar && (!filasBorradas || filasBorradas.length === 0))", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: "if (!errDeshacer && (!filasDeshechas || filasDeshechas.length === 0))", a: "if (false && !errDeshacer && (!filasDeshechas || filasDeshechas.length === 0))", ocurrencia: 0 },
  // sub-condiciones: la mutación de la condición ENTERA muere y tapa que la mitad no se cubre
  // `!data` sin `error` es inalcanzable en postgrest (`.single()` sobre cero filas devuelve
  // PGRST116 en `error`), así que esta mutación es equivalente — declarada abajo con su motivo.
  { archivo: 'handlers/intents/transacciones.js', de: 'if (error || !data) {', a: 'if (error) {', ocurrencia: 0, id: 'transacciones.js · snapshot sin la mitad `!data`' },
  { archivo: 'handlers/admin-commands.js', de: 'if (errTras) {', a: 'if (false && errTras) {', ocurrencia: 0 },
  { archivo: 'handlers/admin-commands.js', de: 'if (!claimed) return { answer: await estadoTrasPerderClaim(pagoId) };', a: 'if (false && !claimed) return { answer: await estadoTrasPerderClaim(pagoId) };', ocurrencia: 1, id: 'admin-commands.js · !claimed del RECHAZO' },
// El `e.id ||` no es cosmético: sin él el id explícito de una entrada se pisaba con el derivado
// del texto, así que DOS mutaciones distintas sobre la misma cadena salían con el mismo nombre y
// la declaración de equivalencia (que se busca por id) no encontraba a la suya.
].map((e) => ({ ...e, id: e.id || `${e.archivo} · ${e.de.slice(0, 46)}${e.ocurrencia ? ' #' + e.ocurrencia : ''}`, ocurrencia: e.ocurrencia || 0 }));

// ─── Mutaciones estructurales: invierten el ORDEN ───────────────────────────
const ESTRUCTURALES = [
  {
    // La primera versión de esta mutación INSERTABA un `if (!insErr) {}` muerto al lado del
    // insert y decía invertir el orden. No invertía nada: el código seguía haciendo lo mismo,
    // los tests pasaban, y se reportó como "SOBREVIVE" — o sea como una guarda sin cobertura,
    // cuando lo que faltaba era la mutación. Ahora restituye literalmente el código de antes
    // del arreglo, que es la única forma de que un superviviente signifique algo.
    id: 'restaurar_eliminado · insertar ANTES de reclamar la copia (orden viejo)',
    archivo: 'handlers/intents/transacciones.js',
    reemplazaBloque: {
      desde: `          const { data: copiaReclamada, error: errReclamoCopia } = await supabase.from('transacciones_eliminadas')`,
      hasta: `            return 'No pude restaurar el gasto. Intenta registrarlo manualmente.';
          }`,
      por: `          const { error: insErr } = await supabase.from('transacciones').insert(payloadRestore);
          if (insErr) {
            return 'No pude restaurar el gasto. Intenta registrarlo manualmente.';
          }
          await supabase.from('transacciones_eliminadas').update({ restored_at: new Date().toISOString() }).eq('id', objetivo.id);`,
    },
  },
  {
    id: 'admin approve · reclamar ANTES de resolver al usuario (orden viejo)',
    archivo: 'handlers/admin-commands.js',
    esEstructural: true,
    de: `      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico: solo un tap gana la fila.`,
    a: `      const claimedPre = await reclamarPagoPendiente({ pagoId, aprobadoPor: 'admin:telegram' });
      if (!claimedPre) return { answer: await estadoTrasPerderClaim(pagoId) };
      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico: solo un tap gana la fila.`,
  },
  {
    // Faltaba: el diff trata el reorden del RECHAZO como la otra mitad del arreglo y no tenía
    // ninguna mutación que lo ejercitara.
    id: 'admin reject · reclamar ANTES de resolver al usuario (orden viejo)',
    archivo: 'handlers/admin-commands.js',
    esEstructural: true,
    de: `      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico también en rechazo`,
    a: `      const preRechazo = await supabase.from('pagos')
        .update({ estado: 'rechazado' }).eq('id', pagoId).eq('estado', 'pendiente').select('usuario_id').maybeSingle();
      if (!preRechazo.data) return { answer: await estadoTrasPerderClaim(pagoId) };
      const resuelto = await resolverSolicitudPro(pagoId);
      if (resuelto.answer) return { answer: resuelto.answer };
      const usuario = resuelto.usuario;
      // Claim atómico también en rechazo`,
  },
];

// ─── Motor ──────────────────────────────────────────────────────────────────

function correr(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
}

const originales = new Map(ARCHIVOS.map((f) => [f, readFileSync(f, 'utf-8')]));
const restaurar = () => { for (const [f, s] of originales) writeFileSync(f, s); };
process.on('SIGINT', () => { restaurar(); process.exit(130); });

const cmdTests = `npx vitest run ${TESTS} --reporter=dot`;
process.stdout.write('baseline… ');
if (!correr(cmdTests)) { console.error('ROJO. Una mutación sólo dice algo con baseline verde.'); process.exit(1); }
console.log('verde\n');

// ¿la guarda ya existía antes de este commit?
const headDe = new Map(ARCHIVOS.map((f) => {
  try { return [f, execSync(`git show HEAD:${f}`, { encoding: 'utf-8' })]; } catch { return [f, '']; }
}));

const mutaciones = [...ARCHIVOS.flatMap(automaticas), ...EXTRAS, ...ESTRUCTURALES];
// **Supervivientes EQUIVALENTES, declarados con su motivo.** Una mutación que no cambia nada
// observable no es una guarda sin test: es una mutación que no prueba nada. Se listan acá con el
// porqué en vez de dejarlas en el reporte como deuda — un superviviente sin explicación entrena
// a ignorar la lista entera, y escribir el motivo obliga a comprobarlo.
const EQUIVALENTES = {
  // `guardarSnapshotEliminacion` devuelve `data.id`. Neutralizada la guarda, con `data` null el
  // acceso tira TypeError, lo agarra su propio catch, y ese catch loguea **el mismo mensaje** y
  // devuelve **el mismo null**. No hay diferencia observable, ni en la respuesta ni en el log.
  'handlers/intents/transacciones.js:163 error || !data': 'el catch interno da el mismo null y el mismo log',
  'transacciones.js · snapshot sin la mitad `!data`': 'idem: sin `!data`, el TypeError cae en el mismo catch',
};
const equivalentesVistos = [];

const supervivientes = [];
let n = 0;

/**
 * Aplicar una mutación es UNA función, usada por el bucle principal Y por `--completa`.
 *
 * Estaban duplicadas, y la copia de `--completa` era `src.replace(s.de, s.a)`: para una
 * mutación de bloque `s.de` es `undefined`, o sea `replace("undefined", …)` — un no-op que
 * imprimía SOBREVIVE sobre un archivo intacto. **Exactamente el defecto que el chequeo
 * `mutado === src` de más abajo existe para atrapar**, reintroducido en el bloque de al lado
 * por copiar en vez de compartir. Lo encontró la revisión adversarial.
 */
function aplicar(m, src) {
  let mutado;
  if (m.reemplazaBloque) {
    const { desde, hasta, por } = m.reemplazaBloque;
    const i = src.indexOf(desde);
    const j = src.indexOf(hasta, i);
    if (i === -1 || j === -1) { console.error(`FATAL: no encontré el bloque de "${m.id}"`); restaurar(); process.exit(1); }
    mutado = src.slice(0, i) + por + src.slice(j + hasta.length);
  } else if (m.inserta) {
    if (!src.includes(m.de)) { console.error(`FATAL: no encontré el origen de "${m.id}"`); restaurar(); process.exit(1); }
    mutado = src.replace(m.de, m.a);
  } else if (m.linea) {
    // Por NÚMERO DE LÍNEA, no por ocurrencia de la cadena: `if (error)` aparece varias veces
    // en el mismo archivo y contar ocurrencias sobre el texto crudo desalinea en cuanto se
    // blanquea un comentario que también la contiene.
    const ls = src.split('\n');
    const antes = ls[m.linea - 1];
    if (!antes || !antes.includes(m.de)) { console.error(`FATAL: la línea ${m.linea} ya no contiene "${m.de}"`); restaurar(); process.exit(1); }
    ls[m.linea - 1] = antes.replace(m.de, m.a);
    mutado = ls.join('\n');
  } else {
    const partes = src.split(m.de);
    if (partes.length < 2 + (m.ocurrencia || 0)) { console.error(`FATAL: no encontré la ocurrencia ${m.ocurrencia} de "${m.id}"`); restaurar(); process.exit(1); }
    // reemplaza sólo la ocurrencia N
    const idx = m.ocurrencia || 0;
    mutado = partes.slice(0, idx + 1).join(m.de) + m.a + partes.slice(idx + 1).join(m.de);
  }
  return mutado;
}

for (const m of mutaciones) {
  n++;
  const src = originales.get(m.archivo);
  const mutado = aplicar(m, src);
  // **La línea que este script existe para tener.** El ítem 1 reportó dos "supervivientes" que
  // eran reemplazos que nunca tocaron el archivo: los tests pasaban porque el código estaba
  // intacto, y eso se leyó como cobertura faltante. Una mutación no aplicada y una que el test
  // no atrapa producen el MISMO verde.
  if (mutado === src) { console.error(`FATAL: la mutación "${m.id}" no cambió el archivo`); restaurar(); process.exit(1); }
  writeFileSync(m.archivo, mutado);

  const verde = correr(cmdTests);
  restaurar();
  // Las estructurales son decisiones de ESTE commit por construcción: preguntarle a HEAD si la
  // línea existía da "sí" (el `insert` de `restaurar` estaba antes también) y etiquetaría como
  // deuda vieja un superviviente que es de acá.
  const equivalente = EQUIVALENTES[m.id];
  const preexistente = !m.reemplazaBloque && !m.esEstructural
    && (headDe.get(m.archivo) || '').includes((m.de || '').split('\n')[0].trim());
  const nota = !verde ? '' : equivalente ? `  [equivalente: ${equivalente}]` : preexistente ? '  [preexistente]' : '';
  console.log(`${String(n).padStart(3)}/${mutaciones.length} ${verde ? 'SOBREVIVE' : 'muere    '} ${m.id}${nota}`);
  if (verde && !equivalente) supervivientes.push({ ...m, preexistente });
  if (verde && equivalente) equivalentesVistos.push(m.id);
}

const juzgables = mutaciones.length - equivalentesVistos.length;
console.log(`\n${juzgables - supervivientes.length}/${juzgables} mueren (${equivalentesVistos.length} equivalentes excluidas).`);
// Si una declarada equivalente MUERE, la declaración era falsa: se avisa en vez de callarlo.
for (const id of Object.keys(EQUIVALENTES)) {
  if (!equivalentesVistos.includes(id)) console.log(`  ⚠ declarada equivalente pero MURIÓ (o no corrió): ${id}`);
}
if (supervivientes.length) {
  const nuevos = supervivientes.filter((s) => !s.preexistente);
  console.log(`Supervivientes: ${supervivientes.length} (${nuevos.length} de este commit, ${supervivientes.length - nuevos.length} preexistentes).`);
  for (const s of supervivientes) console.log('  · ' + s.id + (s.preexistente ? '  [preexistente]' : ''));
}
if (COMPLETA && supervivientes.length) {
  console.log('\n— cada superviviente contra la suite entera —');
  for (const s of supervivientes) {
    const src = originales.get(s.archivo);
    const mut = aplicar(s, src);
    if (mut === src) { console.error(`FATAL: la mutación "${s.id}" no cambió el archivo`); restaurar(); process.exit(1); }
    writeFileSync(s.archivo, mut);
    const verde = correr('npx vitest run --reporter=dot');
    restaurar();
    console.log(`  ${verde ? 'SOBREVIVE' : 'muere    '} ${s.id}`);
  }
}
process.exit(supervivientes.some((s) => !s.preexistente) ? 1 : 0);

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
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

// 9A-bis suma cuatro archivos: la clase "el error descartado" es la misma, pero las dos causas
// (falló / no tocó nada) y los dos canales admin viven en sitios distintos.
const ARCHIVOS = [
  'handlers/intents/transacciones.js', 'handlers/admin-commands.js',
  'lib/pro-payment.js', 'routes/admin.js', 'lib/telegram.js', 'handlers/telegram-webhook.js',
  // Entró en la segunda vuelta: `corregir_categoria` BIFURCA, y cuando el usuario nombra el
  // comercio el UPDATE no está en el handler sino en `recategorizarTransaccion`. Un perímetro
  // definido por la forma del código (los UPDATE de un archivo) no ve una rama que sale por una
  // función, aunque el usuario reciba el mismo mensaje.
  'services/transactions.js',
];
// `tests/lib/` entró con esos archivos. Un mutador que no corre los tests del archivo que muta
// reporta SOBREVIVE sobre todo lo nuevo, que se lee igual que "sin cobertura".
const TESTS = 'tests/handlers/ tests/lib/ tests/services/';
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
    // El filtro mira el PRIMER identificador de la condición. `err` cubre las guardas de 9A;
    // `filas`/`copia` cubren las de 9A-bis, que deciden por el RETURNING de la escritura
    // (`if (!filasMonto || filasMonto.length === 0)`) y no nombran ningún error. Sin esta
    // segunda mitad, las ocho guardas nuevas eran invisibles para el mutador — el mismo
    // perímetro corto que ya hizo salir "5/6 mueren" con 14 sitios sin ver.
    if (!/^!?(err|filas|copia)/i.test(m[1].split(' ')[0])) return;
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

  // ── 9A-bis ────────────────────────────────────────────────────────────────
  //
  // **Quitar el `.select('id')` es la mutación que más importa de este ítem**, y no es una
  // variante de la guarda: es lo único que hace que "0 filas" sea DISTINGUIBLE. Sin él
  // postgrest devuelve `data: null` en toda escritura, así que la guarda dispara SIEMPRE y el
  // backend le contesta "ese gasto ya no está" a todo el mundo. Un mock que no modele el
  // RETURNING deja las siete en verde — pasaba hasta que se modeló.
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txActualizada.id).select('id')", a: ".eq('id', txActualizada.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', ultimaTxM.id).select('id')", a: ".eq('id', ultimaTxM.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txEditM.id).select('id')", a: ".eq('id', txEditM.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txEditF.id).select('id')", a: ".eq('id', txEditF.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txEditC.id).select('id')", a: ".eq('id', txEditC.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txDiv.id).select('id')", a: ".eq('id', txDiv.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".eq('id', txMarcar.id).select('id')", a: ".eq('id', txMarcar.id)", ocurrencia: 0 },
  // el WHERE de los siete: sin el `.eq('id', …)` el update pisa TODAS las transacciones
  { archivo: 'handlers/intents/transacciones.js', de: ".update({ tipo: tipoNuevo }).eq('id', txMarcar.id)", a: ".update({ tipo: tipoNuevo })", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: ".update({ fecha: fechaNueva }).eq('id', txEditF.id)", a: ".update({ fecha: fechaNueva })", ocurrencia: 0 },

  // La compensación de `restaurar_eliminado`: misma clase, arreglo distinto (sólo el log).
  { archivo: 'handlers/intents/transacciones.js', de: ".update({ restored_at: null }).eq('id', objetivo.id).select('id')", a: ".update({ restored_at: null }).eq('id', objetivo.id)", ocurrencia: 0 },
  { archivo: 'handlers/intents/transacciones.js', de: 'else if (!copiaDevuelta || copiaDevuelta.length === 0)', a: 'else if (false && (!copiaDevuelta || copiaDevuelta.length === 0))', ocurrencia: 0 },

  // El claim trabado del rechazo Pro. Las tres mitades del arreglo, por separado: el RETURNING,
  // el aviso al admin (única salida del estado sin salida) y el copy que no manda a un camino
  // cerrado. Mutar sólo la guarda entera taparía que dos de las tres no están cubiertas.
  { archivo: 'lib/pro-payment.js', de: "      .eq('id', usuario.id)\n      .select('id');", a: "      .eq('id', usuario.id);", ocurrencia: 0, id: 'pro-payment.js · el rechazo sin RETURNING: 0 filas indistinguible de error' },
  { archivo: 'lib/pro-payment.js', de: "      claimLimpio = false;\n      log.error({ tag: 'PRO_PAGO', err: errUsr.message", a: "      log.error({ tag: 'PRO_PAGO', err: errUsr.message", ocurrencia: 0, id: 'pro-payment.js · el rechazo NO reporta el claim trabado' },
  { archivo: 'lib/pro-payment.js', de: '  const mensaje = claimLimpio\n    ?', a: '  const mensaje = !claimLimpio\n    ?', ocurrencia: 0, id: 'pro-payment.js · el copy del rechazo, invertido' },

  // Los tres avisos de `registrarPagoAprobado`. Van uno por uno: la mutación de la guarda
  // entera muere con cualquiera de los tres tests y tapa que los otros dos no se ejercitan.
  { archivo: 'lib/pro-payment.js', de: "        await avisarAdminPagos('⚠️ Pro activado, pero el pago `' + pagoId", a: "        await Promise.resolve('⚠️ Pro activado, pero el pago `' + pagoId", ocurrencia: 0, id: 'pro-payment.js · sin aviso: fila reclamada sin plan/monto/periodo' },
  { archivo: 'lib/pro-payment.js', de: "        await avisarAdminPagos('⚠️ Pro activado, pero el pago `' + pendiente.id", a: "        await Promise.resolve('⚠️ Pro activado, pero el pago `' + pendiente.id", ocurrencia: 0, id: 'pro-payment.js · sin aviso: el pendiente sigue pendiente' },
  { archivo: 'lib/pro-payment.js', de: "      await avisarAdminPagos('⚠️ Pro activado para ' + usuarioId + ' pero NO quedó fila", a: "      await Promise.resolve('⚠️ Pro activado para ' + usuarioId + ' pero NO quedó fila", ocurrencia: 0, id: 'pro-payment.js · sin aviso: el insert del pago no entró' },

  // El otro canal admin: el `maybeSingle` es parte del arreglo, no estilo. Con `.single()` un
  // 404 legítimo pasa a 500 (postgrest devuelve PGRST116 en `error` sobre cero filas).
  { archivo: 'routes/admin.js', de: 'await query.maybeSingle();', a: 'await query.single();', ocurrencia: 0, id: 'routes/admin.js · vuelve a .single(): el 404 se disfraza de 500' },

  // Telegram: el `ok:false` con HTTP 200, y el canal de respaldo que lo aprovecha.
  { archivo: 'lib/telegram.js', de: '    if (data && data.ok) return true;', a: '    if (!(data && data.ok)) return true;', ocurrencia: 0, id: 'lib/telegram.js · un rechazo de Telegram cuenta como entregado' },
  { archivo: 'handlers/telegram-webhook.js', de: '      if (!avisado) {', a: '      if (false && !avisado) {', ocurrencia: 0, id: 'telegram-webhook.js · el diagnóstico no sale por el otro canal' },
  { archivo: 'handlers/admin-commands.js', de: '      if (resRechazo && resRechazo.claimLimpio === false) {', a: '      if (false && resRechazo && resRechazo.claimLimpio === false) {', ocurrencia: 0, id: 'admin-commands.js · "Rechazado" a secas sobre un usuario trabado' },

  // ── 9A-bis, segunda vuelta: la rama de `corregir_categoria` que sale por services/ ──
  { archivo: 'services/transactions.js', de: ".update(updates).eq('id', tx.id).select('id')", a: ".update(updates).eq('id', tx.id)", ocurrencia: 0, id: 'services/transactions.js · recategorizar sin RETURNING' },
  { archivo: 'services/transactions.js', de: ".update(updates).eq('id', tx.id).select('id')", a: ".update(updates).eq('id', tx.id)", ocurrencia: 1, id: 'services/transactions.js · corregir sin RETURNING' },
  { archivo: 'services/transactions.js', de: '  if (!filasMovidas || filasMovidas.length === 0) {', a: '  if (false && (!filasMovidas || filasMovidas.length === 0)) {', ocurrencia: 0, id: 'services/transactions.js · recategorizar confirma sobre 0 filas' },
  { archivo: 'services/transactions.js', de: '  if (!filasCorregidas || filasCorregidas.length === 0) {', a: '  if (false && (!filasCorregidas || filasCorregidas.length === 0)) {', ocurrencia: 0, id: 'services/transactions.js · corregir confirma sobre 0 filas' },
  // colapsar los dos desenlaces en uno: el call-site deja de poder distinguirlos
  { archivo: 'services/transactions.js', de: "    return { ok: false, comercio, motivo: 'desaparecido' };", a: "    return { ok: false, comercio, motivo: 'error' };", ocurrencia: 0, id: 'services/transactions.js · "desaparecido" se disfraza de "error"' },
  { archivo: 'handlers/intents/transacciones.js', de: "            } else if (res.motivo === 'desaparecido') {", a: "            } else if (false && res.motivo === 'desaparecido') {", ocurrencia: 0, id: 'transacciones.js · la rama de "ya no está" en corregir_multiple' },
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

/**
 * **Recuperacion ante un corte, y no es teorica: paso DOS VECES el mismo dia.**
 *
 * Entre el `writeFileSync` de la mutacion y el `restaurar()` de esa iteracion hay una corrida
 * entera de vitest. Si el proceso muere ahi —lo mataste, se reinicio la maquina— el archivo
 * queda MUTADO en el working tree. El `SIGINT` no alcanza: no cubre un kill duro ni un corte de
 * energia, que son justo los casos que pasaron.
 *
 * Lo peligroso no es el rojo. Es que la mutacion tiene forma de codigo propio (`if (false && …)`
 * sobre una guarda de plata) y cualquier proceso que copie ese archivo como backup —otro
 * verificador, un `git stash`, vos mismo— la vuelve permanente.
 *
 * El rescate se escribe ANTES de mutar y se borra al restaurar. Si existe al arrancar, se
 * restaura desde ahi y se avisa: la proxima corrida no puede empezar sobre un arbol sucio.
 */
const RESCATE = '.mutacion-en-curso.json';

if (existsSync(RESCATE)) {
  const previo = JSON.parse(readFileSync(RESCATE, 'utf-8'));
  for (const [f, s] of Object.entries(previo.archivos || {})) writeFileSync(f, s);
  unlinkSync(RESCATE);
  console.log(`recuperado: una corrida anterior murio mutando "${previo.id}". Restaurados ${Object.keys(previo.archivos || {}).length} archivo(s).
`);
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
  // El rescate va ANTES del write: si el proceso muere entre las dos líneas, el archivo todavía
  // está intacto y el rescate sobra (restaurarlo es un no-op). Al revés, se pierde.
  writeFileSync(RESCATE, JSON.stringify({ id: m.id, archivos: { [m.archivo]: src } }));
  writeFileSync(m.archivo, mutado);

  const verde = correr(cmdTests);
  restaurar();
  // Las estructurales son decisiones de ESTE commit por construcción: preguntarle a HEAD si la
  // línea existía da "sí" (el `insert` de `restaurar` estaba antes también) y etiquetaría como
  // deuda vieja un superviviente que es de acá.
  const equivalente = EQUIVALENTES[m.id];
  // **Se compara el texto COMPLETO, no su primera línea.** Con `split('\n')[0]` una mutación
  // de varias líneas se declaraba preexistente si su PRIMER renglón existía en HEAD, y eso
  // pasa todo el tiempo con renglones como `.eq('id', usuario.id)` — que está tres veces en
  // `pro-payment.js`. Consecuencia medida: el superviviente de "el rechazo sin RETURNING",
  // que es de este commit, salía etiquetado `[preexistente]` y por lo tanto NO contaba para el
  // exit code. Un mutador que clasifica su propia deuda como deuda vieja es peor que no tener
  // la etiqueta: se lee como cobertura.
  const preexistente = !m.reemplazaBloque && !m.esEstructural
    && !!(m.de || '') && (headDe.get(m.archivo) || '').includes(m.de);
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
    writeFileSync(RESCATE, JSON.stringify({ id: s.id, archivos: { [s.archivo]: src } }));
    writeFileSync(s.archivo, mut);
    const verde = correr('npx vitest run --reporter=dot');
    restaurar();
    console.log(`  ${verde ? 'SOBREVIVE' : 'muere    '} ${s.id}`);
  }
}
process.exit(supervivientes.some((s) => !s.preexistente) ? 1 : 0);

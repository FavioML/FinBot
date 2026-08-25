#!/usr/bin/env node
/**
 * Mutación sobre las guardas del ítem 9D: las 17 escrituras de `handlers/onboarding.js`.
 *
 * Hermano de `scripts/mutar-escrituras-plata.mjs`, con dos diferencias que importan:
 *
 * 1. **Acá NO hay reconocimiento automático de guardas.** Las de 9A tenían la forma
 *    `if (errX)` y una regex las encontraba; las de este ítem son `if (!entro(vX))` y
 *    ternarios `(entro(vX) ? '' : AVISO)`, que esa regex no ve — el paréntesis de la llamada
 *    corta el match. Una lista implícita habría reportado "0 sitios" y salido verde, que es el
 *    perímetro corto que este repo ya pagó dos veces. Van las 17 a mano, una por sitio.
 *
 * 2. **Las mutaciones del helper valen por las 17.** `escribirUsuario` centraliza el WHERE, el
 *    RETURNING y los dos diagnósticos, así que quitarle el `.select('id')` o el
 *    `.eq('id', usuario.id)` es UNA mutación que tiene que matar a toda la tabla de casos. Si
 *    alguna de esas sobrevive, el archivo de tests no está midiendo el mecanismo sino el copy.
 *
 * Uso:
 *   node scripts/mutar-escrituras-onboarding.mjs
 *   node scripts/mutar-escrituras-onboarding.mjs --completa   # supervivientes contra todo
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ARCHIVOS = ['handlers/onboarding.js'];
// `tests/handlers/` cubre los tres archivos que este commit toca: el nuevo y los dos mocks
// viejos que hubo que enseñar a modelar el RETURNING.
const TESTS = 'tests/handlers/';
const COMPLETA = process.argv.includes('--completa');

const F = 'handlers/onboarding.js';

/**
 * Los 12 sitios que LEEN el veredicto con `if (!entro(vX))` y los 4 que lo leen con un
 * ternario. Neutralizar la guarda es la forma exacta del bug original: la escritura se hace,
 * el resultado se descarta, y la confirmación sale igual.
 */
const GUARDAS_IF = [
  'vFree', 'vPaso2', 'vRechazo', 'vMensual', 'vAnual', 'vCats', 'vListo',
  'vPideNombre', 'vPideNombreNuevo',
];
const GUARDAS_TERNARIO = [
  ['vDescUna', "(entro(vDescUna) ? '' : AVISO_MENU_ABIERTO)"],
  ['vDescTodas', "(entro(vDescTodas) ? '' : AVISO_MENU_ABIERTO)"],
  ['vDesc', "(entro(vDesc) ? '' : AVISO_MENU_ABIERTO)"],
  ['vCancel', "(entro(vCancel) ? '' : AVISO_MENU_ABIERTO)"],
];

const MUTACIONES = [
  // ── El helper: una mutación acá tiene que matar a los 17 sitios ────────────
  {
    id: 'escribirUsuario · SIN el RETURNING: "0 filas" deja de ser distinguible',
    // Sin `.select('id')` postgrest devuelve `data: null` en toda escritura, así que la guarda
    // de cero filas dispararía SIEMPRE y el alta le contestaría "se me trabó" a todo el mundo.
    // Es la mutación más importante de este ítem: mide si el doble modela el RETURNING.
    de: ".update(patch).eq('id', usuario.id).select('id'));",
    a: ".update(patch).eq('id', usuario.id));",
  },
  {
    id: 'escribirUsuario · SIN el WHERE: el update pisa toda la tabla `usuarios`',
    de: ".update(patch).eq('id', usuario.id).select('id'));",
    a: ".update(patch).select('id'));",
  },
  {
    id: 'escribirUsuario · el `error` descartado (el bug original, exacto)',
    de: '  if (error) {\n    log.error({ tag: ESCRITURA_TAG',
    a: '  if (false && error) {\n    log.error({ tag: ESCRITURA_TAG',
  },
  {
    id: 'escribirUsuario · las cero filas confirmadas como éxito',
    de: '  if (!filas || filas.length === 0) {',
    a: '  if (false && (!filas || filas.length === 0)) {',
  },
  {
    id: 'escribirUsuario · los dos diagnósticos colapsados en uno',
    // El mensaje al usuario NO distingue las dos causas en producción: el log es lo único que
    // lo hace. Si esta sobrevive, borrar la distinción no cuesta nada y el próximo que lea
    // "la DB rechazó el update" va a mirar el lugar equivocado.
    de: "      'El alta escribió sobre CERO filas: la fila del usuario ya no está');\n    return 'sin_fila';",
    a: "      'El alta escribió sobre CERO filas: la fila del usuario ya no está');\n    return 'error';",
  },
  {
    id: 'escribirUsuario · el tag renombrado (la observabilidad, sin test, se borra sola)',
    de: "const ESCRITURA_TAG = 'ALTA_ESCRITURA';",
    a: "const ESCRITURA_TAG = 'OTRA_COSA';",
  },
  {
    id: 'escribirUsuario · el `paso` fuera del log: no se sabe cuál de los 17 falló',
    de: '    log.error({ tag: ESCRITURA_TAG, paso, userId: usuario.id, campos, err: error.message },',
    a: '    log.error({ tag: ESCRITURA_TAG, userId: usuario.id, campos, err: error.message },',
  },
  {
    id: 'escribirUsuario · SIN catch: un rechazo del cliente deja a la persona muda',
    // Restituye literalmente la forma de antes del arreglo. `manejarOnboarding` corre dentro
    // del try de `webhook.js:744`, cuyo catch loguea y avisa al admin sin responderle nada al
    // usuario: sin este catch, un rechazo es silencio absoluto.
    reemplazaBloque: {
      desde: '  try {\n    ({ data: filas, error } = await supabase.from(\'usuarios\')',
      hasta: "    error = { message: msgErr(e) };\n  }",
      por: "  ({ data: filas, error } = await supabase.from('usuarios')\n    .update(patch).eq('id', usuario.id).select('id'));",
    },
  },

  // ── completarAlta: el chokepoint del cierre ────────────────────────────────
  {
    id: 'completarAlta · la telemetría vuelve a afirmar un cierre que no ocurrió',
    reemplazaBloque: {
      desde: '  if (!entro(veredicto)) {',
      hasta: "    stepFailed(usuario, 100, veredicto === 'sin_fila' ? 'cierre_sin_fila' : 'cierre_no_entro');\n    return;\n  }",
      por: '  if (false) {\n    return;\n  }',
    },
  },
  {
    id: 'completarAlta · los dos motivos colapsados: no se sabe si la fila existe',
    de: "veredicto === 'sin_fila' ? 'cierre_sin_fila' : 'cierre_no_entro'",
    a: "'cierre_no_entro'",
  },

  // ── Los sitios que NO comparten arreglo, uno por uno ───────────────────────
  {
    id: 'paso 100 · el saludo afirma un nombre que no se guardó',
    de: 'return mensajePrimerGasto(entro(vNombre) ? nombreLimpio : null);',
    a: 'return mensajePrimerGasto(nombreLimpio);',
  },
  {
    id: 'paso 100 · el alta deja de cerrarse cuando el nombre falla (de más, no de menos)',
    // El gemelo del anterior en la otra dirección: frenar el alta por un nombre perdido es
    // exactamente la decisión que este paso rechaza desde que se rediseñó el alta.
    de: "    const vNombre = await escribirUsuario(usuario, { nombre: nombreLimpio }, 'nombre');",
    a: "    const vNombre = await escribirUsuario(usuario, { nombre: nombreLimpio }, 'nombre');\n    if (!entro(vNombre)) return 'No pude guardar tu nombre.';",
  },
  {
    id: 'nombre_intentos · sin el helper: el único rastro del sitio que sólo loguea',
    // Este sitio no cambia el copy, así que su ÚNICA observabilidad es el log. Volver al
    // update crudo se ve idéntico desde la respuesta del usuario.
    de: "      await escribirUsuario(usuario, { nombre_intentos: (usuario.nombre_intentos || 0) + 1 }, 'nombre_intentos');",
    a: "      await supabase.from('usuarios').update({ nombre_intentos: (usuario.nombre_intentos || 0) + 1 }).eq('id', usuario.id);",
  },
  {
    id: '/manual · la escritura del plan desaparece',
    de: "    await escribirUsuario(usuario, { plan: 'free' }, 'manual_plan_free');",
    a: '    await Promise.resolve();',
  },
  {
    id: 'elige_pro · el copy de fallo entrega igual los datos de Yape',
    // La mitad del arreglo que no es la guarda: `esperaComprobante()` lee `onboarding_paso===2`,
    // así que dar el número sin ese 2 escrito registra el pago como un gasto.
    de: "        return 'Se me trabó ahora mismo. 😅\\n\\nEscríbeme *pro* otra vez en un ratito y te paso los datos de pago.\\n\\n_Mejor no yapees todavía: así no me pierdo tu comprobante._';",
    a: "        return 'Se me trabó ahora mismo. 😅\\n\\n📲 *Yapea al:* 970398192 y mándame la captura.';",
  },
  {
    id: 'tipo_plan · el copy de fallo vuelve a pedir un monto',
    de: "const MENSAJE_TIPO_PLAN_TRABADO = 'Se me trabó guardando tu elección. 😅\\n\\n' +\n  'No yapees todavía: escríbeme *1* (mensual) o *2* (anual) otra vez en un ratito y te paso el monto.';",
    a: "const MENSAJE_TIPO_PLAN_TRABADO = 'Se me trabó. 📲 Yapea S/10 al *970398192* igual y mándame la captura.';",
  },
  {
    id: 'menú -1 · el aviso vacío: el menú queda abierto sin decirlo',
    de: "const AVISO_MENU_ABIERTO = '\\n\\n⚠️ *Ojo:* se me trabó cerrando el menú, así que sigo esperando ' +\n  'una opción. *No me escribas nada que empiece con un número* —una de las opciones borra tu ' +\n  'cuenta—; cualquier otra cosa lo cierra.';",
    a: "const AVISO_MENU_ABIERTO = '';",
  },
  {
    // La primera versión mandaba a `/ayuda`, que escapa la máquina de estados sólo para ESE
    // mensaje y no toca `onboarding_paso`: el siguiente vuelve al menú y la trampa queda igual.
    id: 'menú -1 · el aviso vuelve a mandar a /ayuda, que no cierra el menú',
    de: "  'una opción. *No me escribas nada que empiece con un número* —una de las opciones borra tu ' +\n  'cuenta—; cualquier otra cosa lo cierra.';",
    a: "  'una opción. Mándame */ayuda* y lo cierro.';",
  },
  {
    id: 'categorias · el fallo vuelve a invitar al presupuesto que no va a funcionar',
    de: "          + 'Se me trabó guardando el resto, así que para poner un límite escríbeme */presupuesto* en un ratito.';",
    a: "          + '*¿Quieres configurar un presupuesto mensual?* 💰\\n\\nEj: _\"limite de 500 soles en Comida\"_';",
  },
  {
    id: 'rechaza_plan · el fallo vuelve a mandar a *hola*, que desde el paso 1 no funciona',
    de: "        return '👍 Sin problema.\\n\\nSe me trabó cerrando esto, así que si te vuelvo a preguntar por el plan, escribe *free* y seguimos gratis.';",
    a: "        return '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';",
  },
  {
    id: 'arranque · el fallo vuelve a preguntar el nombre (el bucle)',
    de: "const MENSAJE_ARRANQUE_TRABADO = '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\\n\\n' +\n  'Se me trabó justo al arrancar. 😅 Escríbeme *hola* en un ratito y empezamos.';",
    a: "const MENSAJE_ARRANQUE_TRABADO = '👋 ¡Hola! Soy *NETO*.\\n\\n¿Cómo te llamas?';",
  },

  // ── Los tres `step_failed` nuevos del paso 1 ──────────────────────────────
  // Alimentan el embudo del alta y distinguen "el usuario rechazó" de "no pudimos escribir".
  // Sin mutación propia, borrarlos o colapsarlos sale verde: es el hueco que la revisión de
  // 9B encontró con los `LECTURA_CAIDA`.
  {
    id: 'paso 1 · el fallo de free se cuenta como un rechazo del usuario',
    de: "        stepFailed(usuario, 1, 'plan_free_no_entro');",
    a: "        stepFailed(usuario, 1, 'rechaza_plan');",
  },
  {
    id: 'paso 1 · el fallo de pro no deja evento',
    de: "        stepFailed(usuario, 1, 'paso_pro_no_entro');",
    a: '        void 0;',
  },
  {
    id: 'paso 1 · el rechazo y su fallo colapsan en un motivo',
    de: "        stepFailed(usuario, 1, 'rechaza_plan_no_entro');",
    a: "        stepFailed(usuario, 1, 'rechaza_plan');",
  },
  {
    id: 'paso 1 · free deja de emitir wa_onboarding_completed en el camino feliz',
    de: "      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'free' });",
    a: '      void 0;',
  },
  {
    id: 'paso 10 · categorías deja de emitir wa_onboarding_completed en el camino feliz',
    de: "      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'categorias' });",
    a: '      void 0;',
  },

  // ── Las 13 guardas que leen el veredicto ───────────────────────────────────
  ...GUARDAS_IF.map((v) => ({
    id: `guarda neutralizada · ${v}`,
    de: `if (!entro(${v}))`,
    a: `if (false && !entro(${v}))`,
  })),
  ...GUARDAS_TERNARIO.map(([v, txt]) => ({
    id: `guarda neutralizada · ${v} (ternario del menú)`,
    de: txt,
    a: "('')",
  })),
].map((e) => ({ ...e, ocurrencia: e.ocurrencia || 0 }));

// ─── Motor (mismo que `mutar-escrituras-plata.mjs`) ─────────────────────────

function correr(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
}

// El rescate se escribe ANTES de mutar. Una mutación que queda en el árbol tiene forma de
// código propio y cualquier proceso que lo copie la vuelve permanente.
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
  try { return [f, execSync(`git show HEAD:${f}`, { encoding: 'utf-8' })]; } catch { return [f, '']; }
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
  if (partes.length < 2 + m.ocurrencia) { console.error(`FATAL: no encontré la ocurrencia ${m.ocurrencia} de "${m.id}"`); restaurar(); process.exit(1); }
  const idx = m.ocurrencia;
  return partes.slice(0, idx + 1).join(m.de) + m.a + partes.slice(idx + 1).join(m.de);
}

// Supervivientes EQUIVALENTES, declarados con su motivo. Un superviviente sin explicación
// entrena a ignorar la lista entera.
const EQUIVALENTES = {};
const equivalentesVistos = [];
const supervivientes = [];
let n = 0;

for (const m of MUTACIONES) {
  n++;
  const src = originales.get(m.archivo || F);
  const archivo = m.archivo || F;
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
  if (verde && !equivalente) supervivientes.push({ ...m, archivo, preexistente });
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

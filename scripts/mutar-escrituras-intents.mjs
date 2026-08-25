#!/usr/bin/env node
/**
 * Mutación sobre las guardas del ítem 9B-bis: las 15 escrituras de `handlers/intents/`.
 *
 * Hermano de `mutar-escrituras-onboarding.mjs`, con dos diferencias que importan:
 *
 * 1. **El perímetro son OCHO archivos, no uno.** La clase es la misma, pero cada handler
 *    resuelve el fallo distinto —uno compensa, uno sigue de largo, tres separan "ya no está" de
 *    "se cayó"— así que las mutaciones estructurales van una por sitio y a mano. Una regex sobre
 *    `if (!entro(…))` encontraría trece de quince: `configurar_presupuesto` lo lee con un
 *    ternario y `dividir_gasto_grupal` con `entro(vLimpieza) ? … : …`. Una lista implícita
 *    habría reportado "13 sitios" y salido verde, que es el perímetro corto que este repo ya
 *    pagó tres veces.
 *
 * 2. **Las mutaciones del helper valen por los quince.** `verificarEscritura` centraliza el
 *    `{error}`, la cuenta de filas y los dos diagnósticos: neutralizar cualquiera de esos tiene
 *    que matar la tabla entera de casos. Si una sobrevive, el archivo de tests está midiendo el
 *    copy y no el mecanismo.
 *
 * **Lo que este script NO cubre, declarado**: el `.select('id')` se muta en el helper (donde su
 * ausencia es indistinguible de la de cualquier sitio) y en los cuatro sitios cuyo `sin_fila`
 * tiene copy propio. En los otros once, borrarlo sale como `sin_fila` y lo mata el control de
 * "cero logs en el camino feliz" — pero eso es una inferencia, no una corrida.
 *
 * Uso:
 *   node scripts/mutar-escrituras-intents.mjs
 *   node scripts/mutar-escrituras-intents.mjs --completa   # supervivientes contra la suite entera
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HELPER = 'helpers/escritura-verificada.js';
const D = 'handlers/intents/';
const BUDGET = 'services/budget.js';
const ARCHIVOS = [
  HELPER,
  D + 'consultas.js', D + 'deudas.js', D + 'metas.js', D + 'moderacion.js',
  D + 'premium.js', D + 'presupuestos.js', D + 'social.js', D + 'utilidades.js',
  // Entra en la segunda vuelta: `configurar_presupuesto` toma una dependencia dura del `id`
  // que devuelve `guardarPresupuesto`, y esa proyeccion vive aca.
  BUDGET,
];
// `tests/handlers/` cubre el archivo nuevo y los dos viejos que tocan estos mismos handlers. Un
// mutador que no corre los tests del archivo que muta reporta SOBREVIVE sobre todo lo nuevo,
// que se lee igual que "sin cobertura".
const TESTS = 'tests/handlers/ tests/services/budget.test.js';
const COMPLETA = process.argv.includes('--completa');

const MUTACIONES = [
  // ══ El helper: cada una tiene que matar a los quince sitios ════════════════
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
    // La sutil: con RETURNING y cero coincidencias postgrest devuelve `[]`, no `null`. Un
    // `filas != null` a secas lo lee como éxito, y el bug de 9A-bis vuelve entero sin que
    // ninguna guarda desaparezca del código.
    de: '  const tocoAlgo = Array.isArray(filas) ? filas.length > 0 : filas != null;',
    a: '  const tocoAlgo = filas != null;',
  },
  {
    archivo: HELPER,
    id: 'helper · los dos diagnósticos colapsados en uno',
    // El mensaje al usuario no siempre distingue las dos causas: el log es lo único que lo hace
    // en once de los quince sitios. Si esto sobrevive, borrar la distinción no cuesta nada y el
    // próximo que lea "la DB rechazó" va a mirar el lugar equivocado.
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
    id: 'helper · el `sitio` fuera del log: no se sabe cuál de los quince falló',
    de: '    log.error({ tag: TAG, sitio, userId, campos, err: error.message },',
    a: '    log.error({ tag: TAG, userId, campos, err: error.message },',
  },
  {
    archivo: HELPER,
    id: 'helper · SIN catch: un rechazo del cliente sube y contesta "Tuve un problema"',
    reemplazaBloque: {
      desde: '  try {\n    ({ data: filas, error } = await consulta);',
      hasta: "    error = { message: (e && e.message) || String(e) };\n  }",
      por: '  ({ data: filas, error } = await consulta);',
    },
  },
  {
    archivo: HELPER,
    id: 'helper · `ceroFilas` siempre "esperado": los catorce pierden su diagnóstico',
    de: "    if (ceroFilas === 'esperado') return 'ok';",
    a: "    return 'ok';",
  },
  {
    archivo: HELPER,
    id: 'helper · `ceroFilas` NUNCA "esperado": el DELETE de la deuda opuesta grita todos los días',
    // El espejo del anterior. Sin él, un default cambiado en cualquiera de las dos direcciones
    // no está medido, y la dirección "grita de más" es la que enseña a ignorar el log.
    de: "    if (ceroFilas === 'esperado') return 'ok';",
    a: "    if (false) return 'ok';",
  },

  // ══ Las quince guardas, una por sitio ══════════════════════════════════════
  ...[
    ['consultas.js', 'vModo', 'preferencia_reporte_gmail'],
    ['moderacion.js', 'vSilencio', 'silenciar'],
    ['moderacion.js', 'vReactivar', 'reactivar_recordatorios'],
    ['moderacion.js', 'vMenu', 'desconectar_cuenta'],
    ['premium.js', 'vRef', 'ver_referidos'],
    ['utilidades.js', 'vNombre', 'cambiar_nombre'],
    ['social.js', 'vFeedback', 'feedback'],
    ['metas.js', 'vCrear', 'crear_meta'],
    ['metas.js', 'vEdit', 'editar_meta'],
    ['metas.js', 'vDel', 'eliminar_meta'],
    ['presupuestos.js', 'vDelPres', 'eliminar_presupuesto'],
    ['deudas.js', 'vDup', 'registrar_deuda_corrige_opuesta'],
    ['deudas.js', 'vPart', 'dividir_gasto_grupal'],
  ].map(([f, v, sitio]) => ({
    archivo: D + f,
    id: `guarda neutralizada · ${sitio} (${v})`,
    de: `if (!entro(${v}))`,
    a: `if (false && !entro(${v}))`,
  })),
  {
    archivo: D + 'presupuestos.js',
    id: 'guarda neutralizada · configurar_presupuesto_alerta (ternario, no `if`)',
    de: 'const lineaAlerta = entro(vAlerta)',
    a: 'const lineaAlerta = true',
  },
  {
    archivo: D + 'deudas.js',
    id: 'guarda neutralizada · dividir_gasto_grupal_limpieza (ternario del copy a medias)',
    de: 'return entro(vLimpieza)',
    a: 'return true',
  },

  // ══ Los tres `sin_fila` con copy propio ════════════════════════════════════
  // Sin mutación propia, colapsarlos contra el copy del rechazo sale verde: es el hueco que la
  // revisión de 9B encontró con los `LECTURA_CAIDA`.
  ...[
    ['metas.js', 'vEdit', 'editar_meta'],
    ['metas.js', 'vDel', 'eliminar_meta'],
    ['presupuestos.js', 'vDelPres', 'eliminar_presupuesto'],
  ].map(([f, v, sitio]) => ({
    archivo: D + f,
    id: `sin_fila colapsado contra el rechazo · ${sitio}`,
    de: `if (${v} === 'sin_fila')`,
    a: `if (false && ${v} === 'sin_fila')`,
  })),

  // ══ El RETURNING, por sitio, donde su ausencia decide un copy ══════════════
  ...[
    ['metas.js', "supabase.from('metas_ahorro').update(updates).eq('id', metaTarget.id).select('id')", "supabase.from('metas_ahorro').update(updates).eq('id', metaTarget.id)", 'editar_meta'],
    ['metas.js', "supabase.from('metas_ahorro').delete().eq('id', metaDel.id).select('id')", "supabase.from('metas_ahorro').delete().eq('id', metaDel.id)", 'eliminar_meta'],
    ['presupuestos.js', "supabase.from('presupuestos').delete().eq('id', presElim[0].id).select('id')", "supabase.from('presupuestos').delete().eq('id', presElim[0].id)", 'eliminar_presupuesto'],
    ['presupuestos.js', "supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('id', filaPres.id).select('id')", "supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('id', filaPres.id)", 'configurar_presupuesto_alerta'],
  ].map(([f, de, a, sitio]) => ({ archivo: D + f, id: `SIN el RETURNING · ${sitio}`, de, a })),

  // ══ Los WHERE ══════════════════════════════════════════════════════════════
  {
    archivo: D + 'presupuestos.js',
    id: 'configurar_presupuesto · el WHERE vuelve a (usuario_id, categoria): pisa todos los meses',
    // El arreglo de este commit. Sin `mes`/`anio`, "aviso al 60%" reescribe el umbral de la
    // historia entera de esa categoría — y "cero filas" deja de significar nada.
    de: "supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('id', filaPres.id)",
    a: "supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('usuario_id', usuario.id).eq('categoria', datos.categoria)",
  },
  {
    archivo: D + 'metas.js',
    id: 'eliminar_meta · SIN el WHERE: el delete se lleva las metas de todos',
    // `intento(tabla, verbo)` dice que hubo un delete, NUNCA sobre qué. Es la mutación con la
    // que 9A descubrió un DELETE destructivo sostenido por un comentario.
    de: "supabase.from('metas_ahorro').delete().eq('id', metaDel.id).select('id')",
    a: "supabase.from('metas_ahorro').delete().select('id')",
  },
  {
    archivo: D + 'moderacion.js',
    id: 'silenciar · SIN el WHERE: el update apaga los recordatorios de TODA la base',
    de: "supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id).select('id')",
    a: "supabase.from('usuarios').update({ recordatorios_activos: false }).select('id')",
  },
  {
    archivo: D + 'deudas.js',
    id: 'dividir_gasto_grupal_limpieza · SIN el WHERE: la compensación borra los splits de todos',
    de: "supabase.from('gastos_compartidos').delete().eq('id', gastoComp.id).eq('creador_id', usuario.id).select('id')",
    a: "supabase.from('gastos_compartidos').delete().select('id')",
  },

  // ══ Las decisiones que NO son una guarda ═══════════════════════════════════
  {
    archivo: D + 'deudas.js',
    id: 'dividir_gasto_grupal · SIN compensar: el reintento crea un segundo gasto compartido',
    reemplazaBloque: {
      desde: '            const vLimpieza = await verificarEscritura(',
      hasta: "para no anotarlo dos veces.';",
      por: "            return 'No pude anotar el reparto. Vuelve a dictármelo.';",
    },
  },
  {
    archivo: D + 'deudas.js',
    id: 'registrar_deuda · la corrección fallida ABORTA el registro de la deuda',
    // La dirección opuesta del arreglo: cortar acá pierde la deuda que la persona acaba de
    // dictar por una corrección accesoria. Es de más, no de menos.
    de: "              avisoOpuesta = '\\n\\n⚠️ Ojo: te quedó también la anotación opuesta de hace un rato. Revísala con _\"mis deudas\"_.';",
    a: "              return 'Ups, algo falló al registrar la deuda. Inténtalo de nuevo.';",
  },
  {
    archivo: D + 'deudas.js',
    id: 'registrar_deuda · el DELETE deja de declarar `ceroFilas: esperado`',
    de: "campos: ['id'], ceroFilas: 'esperado' });",
    a: "campos: ['id'] });",
  },
  {
    archivo: D + 'moderacion.js',
    id: 'desconectar_cuenta · el menú destructivo se imprime igual',
    // El daño de 9D desde el otro lado: sin `onboarding_paso = -1` escrito, cada opción del
    // menú es una promesa vacía y el "1" cae al NLP.
    reemplazaBloque: {
      desde: "        if (!entro(vMenu)) {\n          return '⚠️ Se me trabó abriendo el menú",
      hasta: "*desconectar cuenta* de nuevo en un momento.';\n        }",
      por: '',
    },
  },
  {
    archivo: D + 'social.js',
    id: 'feedback · vuelve a ser fire-and-forget con el `.catch(() => {})`',
    reemplazaBloque: {
      desde: '        const vFeedback = await verificarEscritura(',
      hasta: "          }).select('id'),\n          { sitio: 'feedback', userId: usuario.id, campos: ['mensaje'] });",
      por: `        supabase.from('nlp_errors').insert({
          usuario_id: usuario.id, whatsapp: from,
          mensaje: msg.substring(0, 500), intencion: 'feedback',
          error_tipo: 'feedback', error_detalle: 'Sugerencia del usuario'
        }).then(() => {}).catch(() => {});
        const vFeedback = 'ok';`,
    },
  },
  {
    archivo: D + 'moderacion.js',
    id: 'silenciar · el opt-out se marca aunque el silencio no haya entrado',
    // Ensucia la única serie que mide fatiga: un opt-out sobre alguien que sigue recibiendo.
    de: "          if (!entro(vSilencio)) {\n            return 'No pude desactivar los recordatorios. Intenta de nuevo.';\n          }",
    a: '',
  },
  {
    archivo: D + 'presupuestos.js',
    id: 'configurar_presupuesto · el update se dispara aunque guardarPresupuesto no devuelva fila',
    de: "          const vAlerta = filaPres && filaPres.id\n            ? await verificarEscritura(",
    a: "          const vAlerta = true\n            ? await verificarEscritura(",
  },
  // ══ Los tres arreglos de la SEGUNDA VUELTA (hallazgos de la revisión adversarial) ═══
  {
    archivo: HELPER,
    id: 'helper · `PGRST116` vuelve a salir como rechazo de la DB en vez de sin_fila',
    // Una escritura terminada en `.select(…).single()` devuelve `PGRST116` sobre cero filas.
    // Sin la rama, los tres sitios con copy propio mandan a "Intenta de nuevo" sobre una fila
    // que no existe — justo lo que este ítem decidió no hacer.
    de: "  if (error && error.code === 'PGRST116') {",
    a: '  if (false) {',
  },
  {
    archivo: HELPER,
    id: 'helper · TODO error sale como sin_fila (la dirección opuesta de PGRST116)',
    // El espejo. Sin este, ensanchar la rama hasta tragarse cualquier error no está medido, y
    // esa dirección convierte un rechazo real en "esa fila ya no está".
    de: "  if (error && error.code === 'PGRST116') {",
    a: '  if (error) {',
  },
  {
    archivo: D + 'deudas.js',
    id: 'dividir_gasto_grupal_limpieza · SIN el `creador_id`: la compensación deja de ser un invariante',
    de: ".delete().eq('id', gastoComp.id).eq('creador_id', usuario.id).select('id')",
    a: ".delete().eq('id', gastoComp.id).select('id')",
  },
  {
    archivo: BUDGET,
    id: 'guardarPresupuesto · el RETURNING proyecta sin `id`: el call-site pierde su objetivo',
    // La mutacion que la revision adversarial midio dejando la suite ENTERA en verde: con
    // `.select('monto_limite')`, `configurar_presupuesto` manda a TODOS los usuarios al copy
    // "El aviso quedo como estaba", que ademas los invita a repetir el comando en bucle.
    de: "  }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' }).select().single();",
    a: "  }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' }).select('monto_limite').single();",
  },
  {
    archivo: D + 'metas.js',
    id: 'crear_meta · el fallo sigue armando el mensaje del plan que no existe',
    de: "          if (!entro(vCrear)) {\n            return 'No pude crear el plan. Intenta de nuevo.';\n          }",
    a: '',
  },
].map((e) => ({ ...e, ocurrencia: e.ocurrencia || 0 }));

// ─── Motor (mismo que `mutar-escrituras-onboarding.mjs`) ─────────────────────

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

// El `stdio` silencia el `fatal:` de git para los archivos que todavía no están en HEAD (el
// helper es nuevo). Sin eso, una línea de error real de git se mezcla con una condición normal.
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

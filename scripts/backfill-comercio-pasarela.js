/**
 * Backfill one-time: saca el prefijo de pasarela de los comercios ya guardados.
 *
 * Por qué existe: hasta el 02-sep-2026 el campo `comercio` de un correo bancario lo decidía
 * entero un LLM, y para el mismo "IZI*BARBANEGRA" devolvía cualquiera de tres cosas
 * ("IZI*BARBANEGRA", "IZI BARBANEGRA", "IZI"). Como `buscarReglaComercio` compara por IGUALDAD
 * exacta en minúsculas y el detector de recurrentes agrupa por `comercio.toLowerCase()`, esas
 * grafías conviven sin reconocerse: la regla que el usuario corrigió a mano no se vuelve a
 * aplicar, y un mismo local se parte en varios grupos de recurrentes.
 *
 * El código ya no las produce (`canonizarComercio` en services/parsers.js). Este script arregla
 * lo que quedó escrito antes, y **usa esa misma función** en vez de reimplementar el regex en
 * SQL: dos implementaciones de la misma regla divergen solas, y acá una divergencia agregaría
 * una cuarta grafía en lugar de eliminar tres.
 *
 * Uso:
 *   railway run -- node scripts/backfill-comercio-pasarela.js            # dry-run (default)
 *   DRY_RUN=0 railway run -- node scripts/backfill-comercio-pasarela.js  # ejecuta
 *
 * Idempotente: `canonizarComercio` es idempotente, así que una segunda corrida no toca nada.
 *
 * NO recalcula `dedup_hash`, y es deliberado. El hash se compara sólo contra inserts NUEVOS
 * dentro de una ventana de 10 segundos (`DEDUP_WINDOW_MS`), así que un hash viejo que ya no
 * corresponde a su propio `comercio` no puede hacer que nada se descarte de más: como mucho
 * deja de reconocer un duplicado, que es el lado seguro. Recalcularlo obligaría a duplicar acá
 * la fórmula de `guardarTransaccion`, y una fórmula con dos dueños diverge sola.
 */
require('dotenv').config();
const { supabase } = require('../lib/db');
const { canonizarComercio } = require('../services/parsers');

const DRY_RUN = process.env.DRY_RUN !== '0';

// El backfill SÍ pela por espacio ("IZI CARPPONE BARBERIA"), que el runtime no hace por
// default. La evidencia acá no es el asterisco sino la revisión a mano: las 39 filas que
// toca se listaron una por una en el dry-run del 02-sep y ninguna era una pasarela
// cobrándose a sí misma (el caso "NIUBIZ PERU", que pelar por espacio arruinaría).
// Si esta corrida devuelve filas nuevas, hay que volver a mirar la lista antes de aplicar.
const CON_EVIDENCIA = { separadorEspacio: true };
const canonizar = (x) => canonizarComercio(x, CON_EVIDENCIA);

// `canonizarComercio` hace DOS cosas: pela el prefijo y colapsa espacios. Para el runtime las
// dos están bien, pero el backfill sólo reescribe historia por la PRIMERA. El dry-run del
// 02-sep mostró por qué: sin este filtro arrastraba ~60 filas cuyo único cambio era un espacio
// al final ("Taxi  " → "Taxi"), que ensancha el blast radius sin comprar nada — los dos sitios
// que comparan nombres (`buscarReglaComercio` y el detector de recurrentes) ya hacen `.trim()`.
const soloCambiaronEspacios = (antes, despues) => despues === antes.replace(/\s+/g, ' ').trim();

function fatal(msg, err) {
  console.error('ABORTA:', msg, err ? '→ ' + err.message : '');
  process.exit(1);
}

// ── transacciones ─────────────────────────────────────────────────────────────
// Se leen TODAS las filas con comercio y se filtra en JS con la función real. Filtrar en el
// servidor pediría traducir el patrón a SQL, que es justo la segunda implementación que este
// script evita. El volumen lo permite (miles de filas, no millones).
async function backfillTransacciones() {
  const cambios = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from('transacciones').select('id, comercio')
      .not('comercio', 'is', null)
      .order('id').range(desde, desde + PAGINA - 1);
    // supabase-js no lanza: sin leer `error`, una página fallida se vería igual que "no hay más
    // filas" y el backfill reportaría éxito habiendo saltado la mitad de la tabla.
    if (error) fatal('no se pudo leer transacciones', error);
    if (!data || data.length === 0) break;
    for (const t of data) {
      const nuevo = canonizar(t.comercio);
      if (nuevo !== t.comercio && !soloCambiaronEspacios(t.comercio, nuevo)) {
        cambios.push({ id: t.id, antes: t.comercio, despues: nuevo });
      }
    }
    if (data.length < PAGINA) break;
  }

  console.log('\ntransacciones: ' + cambios.length + ' filas a cambiar');
  const porNombre = new Map();
  for (const c of cambios) porNombre.set(c.antes + ' → ' + c.despues, (porNombre.get(c.antes + ' → ' + c.despues) || 0) + 1);
  for (const [par, n] of [...porNombre.entries()].sort()) console.log('  ' + par + (n > 1 ? '  (x' + n + ')' : ''));

  if (DRY_RUN || cambios.length === 0) return cambios.length;
  let ok = 0;
  for (const c of cambios) {
    // `.select('id')` no es decoración: un update que no afecta NINGUNA fila (RLS, id que ya
    // no existe) tampoco devuelve error en supabase-js, así que sin esto el script imprimía
    // "actualizadas: N" sin haber probado que se movió una sola fila.
    const { data, error } = await supabase.from('transacciones')
      .update({ comercio: c.despues }).eq('id', c.id).select('id');
    if (error) fatal('falló el update de la transacción ' + c.id, error);
    if (!data || data.length === 0) fatal('el update de la transacción ' + c.id + ' no tocó ninguna fila');
    ok++;
  }
  console.log('  actualizadas: ' + ok + ' de ' + cambios.length);
  return ok;
}

// ── reglas_comercio ───────────────────────────────────────────────────────────
// El patrón se guarda ya en minúsculas. Ojo con el índice único (usuario_id, comercio_pattern):
// canonizar puede chocar contra una regla que el usuario ya tenga con la grafía limpia. En ese
// caso gana la existente y se borra la prefijada — son la misma regla escrita dos veces, y
// dejar la prefijada viva la deja sin poder matchear nunca más.
async function backfillReglas() {
  // Pagina igual que transacciones. PostgREST corta en 1000 filas SIN error, y acá el truncado
  // hace doble daño: se saltan filas, y además el Set de existentes queda incompleto, así que
  // un rename puede chocar contra una regla que nunca vio y matar la corrida a mitad de las
  // escrituras con el 23505 del índice único. Hoy son 774 reglas, o sea a un tirón del corte.
  const filas = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from('reglas_comercio').select('id, usuario_id, comercio_pattern, categoria, subcategoria')
      .order('id').range(desde, desde + PAGINA - 1);
    if (error) fatal('no se pudo leer reglas_comercio', error);
    if (!data || data.length === 0) break;
    filas.push(...data);
    if (data.length < PAGINA) break;
  }

  // La clave va en MINUSCULAS aunque el patron se guarde asi por convencion: el objetivo se
  // calcula con `.toLowerCase()`, y con el mapa armado sobre el crudo un patron legacy en
  // mayusculas no colisionaba con su version prefijada. Quedaban dos reglas del mismo comercio
  // ("Barbanegra" y "barbanegra"), el indice unico no se queja porque como texto son distintas,
  // solo la minuscula es alcanzable por `buscarReglaComercio`, y si sus categorias difieren el
  // conflicto no se reportaba nunca — que es justo lo que la rama de conflicto existe para evitar.
  const clavePorUsuario = (r, patron) => r.usuario_id + '|' + String(patron).toLowerCase();
  const porClave = new Map(filas.map(r => [clavePorUsuario(r, r.comercio_pattern), r]));
  const aActualizar = [];
  const aBorrar = [];
  const enConflicto = [];
  for (const r of filas) {
    const nuevo = canonizar(r.comercio_pattern).toLowerCase();
    // El `.toLowerCase()` de arriba es de la CONVENCION del patron, no de este arreglo: si
    // quedara alguna regla legacy con mayusculas, sin esta linea el backfill la renombraria a
    // minusculas y esa escritura saldria en la lista sin explicacion, fuera del alcance que el
    // script declara. Un cambio de solo-case no es pelar un prefijo.
    if (nuevo === r.comercio_pattern
      || soloCambiaronEspacios(r.comercio_pattern.toLowerCase(), nuevo)) continue;
    const choca = porClave.get(clavePorUsuario(r, nuevo));
    if (!choca) {
      aActualizar.push({ ...r, nuevo });
      porClave.set(clavePorUsuario(r, nuevo), { ...r, comercio_pattern: nuevo });
      continue;
    }
    // Chocan contra el índice único (usuario_id, comercio_pattern). Si las dos clasifican
    // IGUAL son la misma regla escrita dos veces y la prefijada se borra: dejarla viva la
    // condena a no matchear nunca más. Si clasifican DISTINTO, borrar una es tirar una
    // corrección del usuario, que es justo el daño que este trabajo viene a evitar: se
    // reporta y no se toca. La categoría se imprime siempre, para que quien revisa la
    // corrida pueda ver el conflicto en vez de tener que confiar.
    const mismaClase = (choca.categoria || null) === (r.categoria || null)
      && (choca.subcategoria || null) === (r.subcategoria || null);
    (mismaClase ? aBorrar : enConflicto).push({ ...r, nuevo, choca });
  }

  const clase = (x) => (x.categoria || '-') + (x.subcategoria ? ' > ' + x.subcategoria : '');
  console.log('\nreglas_comercio: ' + aActualizar.length + ' a renombrar, ' + aBorrar.length
    + ' duplicadas a borrar, ' + enConflicto.length + ' en conflicto (NO se tocan)');
  for (const r of aActualizar) console.log('  ' + r.comercio_pattern + ' → ' + r.nuevo + '   [' + clase(r) + ']');
  for (const r of aBorrar) console.log('  BORRAR ' + r.comercio_pattern + ' [' + clase(r) + '] — ya existe ' + r.nuevo + ' [' + clase(r.choca) + ']');
  for (const r of enConflicto) console.log('  CONFLICTO ' + r.comercio_pattern + ' [' + clase(r) + '] vs ' + r.nuevo + ' [' + clase(r.choca) + '] — resolver a mano');

  if (DRY_RUN) return 0;
  for (const r of aActualizar) {
    const { data, error: e } = await supabase.from('reglas_comercio')
      .update({ comercio_pattern: r.nuevo }).eq('id', r.id).select('id');
    if (e) fatal('falló el update de la regla ' + r.id, e);
    if (!data || data.length === 0) fatal('el update de la regla ' + r.id + ' no tocó ninguna fila');
  }
  for (const r of aBorrar) {
    const { data, error: e } = await supabase.from('reglas_comercio').delete().eq('id', r.id).select('id');
    if (e) fatal('falló el borrado de la regla ' + r.id, e);
    if (!data || data.length === 0) fatal('el borrado de la regla ' + r.id + ' no tocó ninguna fila');
  }
  return aActualizar.length + aBorrar.length;
}

(async () => {
  console.log(DRY_RUN ? '=== DRY-RUN (no escribe nada) ===' : '=== EJECUTANDO ===');
  await backfillTransacciones();
  await backfillReglas();
  if (DRY_RUN) console.log('\nNada escrito. Para aplicar: DRY_RUN=0 railway run -- node scripts/backfill-comercio-pasarela.js');
})().catch(e => fatal('excepción no controlada', e));

// Harness E2E de los códigos de invitación de DEUDAS y GASTOS COMPARTIDOS (S′10).
//
// ── Qué mide, y por qué hacía falta ────────────────────────────────────────────
//
// `POST /api/debts/invite` y `POST /api/split/invite` emitían
// `crypto.randomBytes(4).toString('hex')`: 8 chars hex = **32 bits**. La fuente es
// criptográfica —o sea que el ataque de PREDICCIÓN que motivó `codigos-seguros` no
// aplica acá— pero el espacio es chico, y las dos superficies hermanas ya emiten más
// (espacios 31^8 = 39.6 bits, metas 55^8 = 46.3).
//
// Lo que hay detrás del código NO es un preview: medido por este harness, quien confirma
// una invitación de deuda queda con una fila espejo `deuda_vinculada_id`, y
// `PUT /api/debts?action=marcar_pagada` sobre ESA fila propaga `monto_pendiente: 0,
// estado: 'pagada'` a la deuda del ACREEDOR. El código es la única credencial de esa
// puerta: el preview es público (sin sesión) y el join solo pide estar logueado.
//
// ── La corrida de CONTROL ──────────────────────────────────────────────────────
// Contra el código anterior al fix, `entropia_*` sale ROJO (8 chars, 32 bits) y
// `deuda_segundo_confirmante` sale ROJO (el chequeo de "ya confirmada" filtraba por
// `usuario_id`, así que N usuarios distintos podían confirmar la MISMA deuda y cada uno
// se llevaba una fila espejo con poder de escritura sobre la original). Si el harness no
// falla contra el código viejo, no está midiendo el hallazgo.
//
// ── Lo que NO asegura ──────────────────────────────────────────────────────────
// `obs_marcar_pagada` es una OBSERVACIÓN, no una aserción. Que el deudor legítimo pueda
// declarar pagada la deuda del acreedor es simetría deliberada del sync (los dos lados
// ven lo mismo), y decidir si eso está bien es otra conversación. Acá se mide para que el
// número esté escrito, no para romper el build.
//
// ── Por qué el ACREEDOR es el usuario Free y el que confirma es el Pro ─────────
// Al revés (Pro acreedor, Free confirmando) la observación de arriba NO se puede medir:
// `PUT /api/debts` pasa por `requireLectura`, así que el confirmante Free choca con el
// muro (402) y la propagación nunca se ejercita. Esa es además la cota real del hallazgo
// y conviene tenerla escrita: **la escritura sobre la deuda ajena exige que el atacante
// tenga lectura** (Pro o trial). El join y el preview, no.
// Emitir el invite sí funciona desde el muro —ninguna de las dos rutas `/invite` gatea—
// y esta disposición lo ejercita de paso.
//
// Uso: node qa-invite-codes.mjs           (contra https://app.neto.pe)
//      NETO_APP_URL=http://localhost:3000 node qa-invite-codes.mjs
// Creds: ~/.config/neto/qa.env (NETO_QA_FREE_* = acreedor/creador, NETO_QA_* = el que confirma,
//        NETO_QA_M3_USUARIO_ID = tercero, solo como fila sembrada — no tiene sesión web).
// Las escrituras van por `clienteGuardado` (qa-guard): este harness borra filas de `deudas`,
// que es exactamente la tabla del incidente del 01-ago-2026.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clienteGuardado, resumenGuard } from './lib/qa-guard.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-INVITE';

// El piso de 64 bits que este harness defiende NO se comprueba estimando entropía de una
// muestra (ver el bloque de `evaluarCodigos`): se comprueba exigiendo la FORMA que el
// contrato produce. Importa porque acá no hay rate limit que ayude: el preview es público
// y el único limitador de la webapp (`lib/rate-limit.ts`) es un Map en memoria, o sea POR
// LAMBDA — no acota a un atacante distribuido. Ver el ledger.

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional */ }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
// ACREEDOR / CREADOR del gasto = el usuario Free. CONFIRMANTE = el Pro. Ver el encabezado.
const ACREEDOR = { email: env.NETO_QA_FREE_EMAIL, password: env.NETO_QA_FREE_PASSWORD, uid: env.NETO_QA_FREE_USUARIO_ID };
const CONFIRMA = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD, uid: env.NETO_QA_USUARIO_ID };
const TERCERO = env.NETO_QA_M3_USUARIO_ID;
const SERVICE =
  env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !ACREEDOR.email || !ACREEDOR.password || !ACREEDOR.uid || !CONFIRMA.email || !CONFIRMA.password || !CONFIRMA.uid || !TERCERO) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_*, NETO_QA_FREE_*, NETO_QA_M3_USUARIO_ID).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (qa.env, entorno o webapp/.env.local).');
  process.exit(2);
}

const svc = clienteGuardado(SUPA, SERVICE);
const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

async function login(user) {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!grant.ok) throw new Error(`Password grant falló para ${user.email}: ${grant.status}`);
  const session = await grant.json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  const pairs = [];
  if (value.length <= MAX) pairs.push(`${cookieName}=${value}`);
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${cookieName}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

// `cookie` null = petición ANÓNIMA. No es un detalle: los dos GET de preview son
// públicos a propósito y eso es la mitad de por qué el código tiene que ser largo.
async function api(cookie, method, path, body) {
  const r = await fetch(`${APP}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json, text: text.slice(0, 300) };
}

const checks = {};
let fallos = 0;
function check(nombre, ok, detalle) {
  checks[nombre] = { ok: ok ? 'OK' : 'FALLA', ...(detalle ? { detalle } : {}) };
  if (!ok) fallos++;
}
function observar(nombre, detalle) {
  checks[nombre] = { ok: 'OBS', detalle };
}

/**
 * Qué se le exige al código que emite PRODUCCIÓN.
 *
 * ── Dos intentos fallidos antes de éste, y los dos enseñan lo mismo ────────────
 *
 * Este check quiso, dos veces, MEDIR la entropía a partir de 3 muestras:
 *
 *   1. Contar el alfabeto observado. Con 36 tiradas sobre 55 símbolos se ven ~27, así que
 *      declaraba **57.7 bits** de unos reales 69.4 → rojo falso en la primera corrida
 *      contra el código nuevo.
 *   2. Inferir la clase (mayús + minús + dígitos = 62) y acotarla por el alfabeto que
 *      implican los distintos vistos, invirtiendo el problema del coleccionista de cupones.
 *      Medido sobre 200 corridas sintéticas: aprobaba un generador de 11 chars (63.6 bits
 *      reales, justo debajo del piso) **78 veces**, y hacía flakear el caso REAL **10 de
 *      200**. O sea que cambió un error por otro y encima agregó ruido.
 *
 * La lección: **3 muestras no alcanzan para estimar un alfabeto**, y forzarlo produce una
 * regla que falla por la razón equivocada. El contrato de entropía no se mide acá — lo fija
 * `webapp/src/lib/codigos-seguros.test.ts`, que cubre los 55 símbolos sobre 2000 muestras.
 * Lo que este harness sí puede responder, y el test unitario no, es **qué emite prod**.
 *
 * ── Las cuatro reglas, y por qué ninguna flakea ────────────────────────────────
 *
 * | regla | qué mata | margen |
 * |---|---|---|
 * | largo ≥ 12 | el código viejo (8) y cualquier acortamiento, incluido el de 11 que el estimador anterior aprobaba | determinista |
 * | todo char ∈ alfabeto declarado | un cambio de alfabeto que meta símbolos ajenos | determinista |
 * | ≥ 18 símbolos distintos | un colapso a un alfabeto chico (`aA1`, hex, 8 símbolos) | medido sobre 20.000 corridas sintéticas: el caso real nunca bajó de **19**, y un adversario de ≤16 símbolos no puede pasar de 16 |
 * | las 3 clases presentes | un alfabeto de solo mayúsculas+dígitos (los 31 de espacios = 59.4 bits), que la regla de distintos NO ve porque llega a 28 | con 5 muestras, P(falte una clase) ≈ 1e-4; con 3 el dígito faltaba 1 de cada 285 |
 *
 * Los bits que se imprimen salen del alfabeto DECLARADO: son el contrato, no una medición,
 * y así están rotulados.
 *
 * **Lo que estas reglas NO pueden separar, y conviene decirlo en vez de fingir que sí:**
 * un alfabeto mixto de ~39 símbolos (63.4 bits, justo debajo del piso) deja ver ~31
 * distintos sobre 60 tiradas contra los ~37 del real, y las dos distribuciones se pisan.
 * Subir el piso de distintos hasta separarlas hace flakear el caso real. O sea que la
 * frontera fina la fija el test unitario, no esto; acá se atrapan los cambios GRUESOS,
 * que son los que pasan de verdad: volver a hex, acortar el largo, o cambiar al alfabeto
 * de espacios. Las siete mutaciones de la autoprueba salen 0/50.000 y el caso real
 * 50.000/50.000.
 */
const ALFABETO_DECLARADO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const LARGO_MINIMO = 12;
const DISTINTOS_MINIMO = 18;
// 5 y no 3: con 3 muestras (36 tiradas) la regla de las tres clases falla sola 1 de cada
// 285 corridas porque no sale ningun digito (8 de 55). Con 5 baja a ~1e-4.
const MUESTRAS = 5;

function evaluarCodigos(codigos) {
  const juntos = codigos.join('');
  const chars = [...new Set(juntos)];
  const problemas = [];

  const largo = Math.min(...codigos.map((c) => c.length));
  if (largo < LARGO_MINIMO) problemas.push(`largo ${largo} < ${LARGO_MINIMO}`);

  const ajenos = chars.filter((c) => !ALFABETO_DECLARADO.includes(c));
  if (ajenos.length) problemas.push(`chars fuera del alfabeto declarado: ${ajenos.join('')}`);

  if (chars.length < DISTINTOS_MINIMO) {
    problemas.push(`solo ${chars.length} simbolos distintos (piso ${DISTINTOS_MINIMO}): el alfabeto se achico`);
  }

  // Mayúscula Y minúscula, y NO el dígito. Medido sobre 20.000 corridas: exigir las tres
  // hace flakear el caso real 1 vez, porque solo 8 de los 55 símbolos son dígitos y
  // P(ninguno en 60 tiradas) ≈ 8e-5. Con las dos que quedan, P ≈ 1e-15 y no se pierde
  // nada: los dos casos que la regla existe para matar son alfabetos que se quedan de un
  // solo lado — los 31 de espacios (mayús + dígitos, 59.4 bits) y un lowercase-only
  // (23 chars, 54.3 bits). Un alfabeto mixto SIN dígitos son 47 chars = 66.6 bits, que
  // está por encima del piso y no hay motivo para rechazarlo.
  const faltan = [
    [/[A-Z]/, 'mayuscula'], [/[a-z]/, 'minuscula'],
  ].filter(([re]) => !chars.some((c) => re.test(c))).map(([, n]) => n);
  if (faltan.length) problemas.push(`no aparece ninguna ${faltan.join(' ni ')}: el alfabeto no es el declarado`);

  return {
    largo,
    distintosVistos: chars.length,
    bitsContrato: +(largo * Math.log2(ALFABETO_DECLARADO.length)).toFixed(1),
    problemas,
  };
}

/**
 * El estimador corre contra fixtures ANTES de juzgar a producción: es un detector, y un
 * detector que solo se ejercita sobre el caso real es ciego por construcción — la lección
 * que este mismo trabajo ya pagó dos veces en los guards estáticos.
 *
 * Si alguno de estos falla, el harness aborta: prefiero no medir a medir con una regla rota.
 */
function autoprueba() {
  const muestrear = (alfabeto, n, largo) => {
    // Determinístico a propósito: un fixture con `Math.random` hace flakear al detector.
    //
    // Se toman los bits ALTOS (`s / 65536`) y no `s % len`: los bajos de un LCG son
    // notoriamente pobres, y con `% 8` la primera versión sacaba 3 símbolos distintos de
    // los 8 del alfabeto. El fixture seguía discriminando —por eso el mutante moría igual—
    // pero afirmaba "alfabeto de 8" ejercitando uno de 3, que es la clase
    // `guard-que-afirma-mas-de-lo-que-ejercita` con otra ropa.
    const out = [];
    let s = 7;
    for (let i = 0; i < n; i++) {
      let c = '';
      for (let j = 0; j < largo; j++) {
        s = (s * 1103515245 + 12345) % 2147483648;
        c += alfabeto[Math.floor(s / 65536) % alfabeto.length];
      }
      out.push(c);
    }
    return out;
  };
  const REAL = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const casos = [
    // [alfabeto, largo, ¿debería PASAR?, qué mutación representa]
    ['0123456789abcdef', 8, false, 'el código VIEJO: 8 hex, 32 bits'],
    [REAL, 11, false, 'acortar el largo a 11 (63.6 bits, justo debajo del piso)'],
    ['aA1bB2cC', 12, false, 'alfabeto de 8 con las tres clases (36 bits)'],
    ['aA1', 12, false, 'alfabeto de 3 (19 bits)'],
    ['ABCDEFGHJKMNPQRSTUVWXYZ23456789', 12, false, 'el alfabeto de ESPACIOS: 31 chars sin minúsculas (59.4 bits)'],
    ['NetoDe0123456789', 12, false, 'alfabeto de 16 (48 bits)'],
    ['abcdefghjkmnpqrstuvwxyz', 12, false, 'lowercase-only: 23 chars, 54.3 bits — pasa el piso de distintos, lo mata la regla de clases'],
    [REAL, 12, true, 'el real: 69.4 bits'],
  ];
  for (const [alfabeto, largo, deberiaPasar, queEs] of casos) {
    const muestras = muestrear(alfabeto, MUESTRAS, largo);
    const e = evaluarCodigos(muestras);
    // El fixture tiene que EJERCITAR el alfabeto que dice: si el muestreador degenera, el
    // caso pasa por el motivo equivocado y el día que alguien lo toque no se entera.
    const cobertura = e.distintosVistos / Math.min(alfabeto.length, largo * MUESTRAS);
    if (cobertura < 0.5) {
      throw new Error(
        `autoprueba: el fixture de ${alfabeto.length} símbolos solo sacó ${e.distintosVistos} ` +
        'distintos — el muestreador degeneró y el caso no ejercita lo que dice');
    }
    if ((e.problemas.length === 0) !== deberiaPasar) {
      throw new Error(
        `autoprueba de las reglas: ${queEs} → ` +
        (e.problemas.length ? `rechazado por [${e.problemas.join('; ')}]` : 'aceptado') +
        `, y se esperaba lo contrario`);
    }
  }
}

const creadas = { deudas: [], gastos: [] };

async function limpiar() {
  // Espejos y sembrados primero (FK deuda_vinculada_id → deudas.id).
  // Se filtra SIEMPRE por `usuario_id` con un id de la allowlist: es lo que le da a
  // qa-guard el sujeto de la operación. Un DELETE por `deuda_vinculada_id` a secas no
  // fija a nadie y la barrera lo aborta, con razón.
  const errores = [];
  const borrar = async (q) => { const { error } = await q; if (error) errores.push(error.message); };

  for (const uid of [CONFIRMA.uid, TERCERO, ACREEDOR.uid]) {
    await borrar(svc.from('deudas').delete().eq('usuario_id', uid).eq('descripcion', TAG));
  }
  // `gasto_participantes` NO se borra a mano: su FK a `gastos_compartidos` es
  // `ON DELETE CASCADE` (medido en `pg_constraint`), asi que el padre se las lleva.
  await borrar(svc.from('gastos_compartidos').delete().eq('creador_id', ACREEDOR.uid).eq('descripcion', TAG));
  // Los titulos son los que escriben las rutas reales (`debts/join` y `split/join`), NO el
  // TAG del harness: filtrar por TAG era un no-op silencioso que dejaba filas cada corrida.
  for (const uid of [ACREEDOR.uid, CONFIRMA.uid]) {
    await borrar(svc.from('notificaciones').delete().eq('usuario_id', uid)
      .in('titulo', ['Deuda confirmada', 'Gasto compartido confirmado']));
  }
  creadas.deudas = [];
  creadas.gastos = [];
  return errores;
}

async function sembrarDeuda() {
  const { data, error } = await svc.from('deudas').insert({
    usuario_id: ACREEDOR.uid,
    tipo: 'me_deben',
    contraparte: 'QA Contraparte',
    monto_original: 120,
    monto_pendiente: 120,
    moneda: 'PEN',
    descripcion: TAG,
    estado: 'activa',
  }).select('id').single();
  if (error) throw new Error('No pude sembrar la deuda: ' + error.message);
  creadas.deudas.push(data.id);
  return data.id;
}

async function sembrarGasto() {
  const { data: gasto, error } = await svc.from('gastos_compartidos').insert({
    creador_id: ACREEDOR.uid,
    descripcion: TAG,
    monto_total: 90,
    moneda: 'PEN',
  }).select('id').single();
  if (error) throw new Error('No pude sembrar el gasto compartido: ' + error.message);
  creadas.gastos.push(gasto.id);
  const { data: parte, error: e2 } = await svc.from('gasto_participantes').insert({
    gasto_id: gasto.id,
    nombre: 'QA Participante',
    monto_debe: 45,
    monto_pagado: 0,
  }).select('id').single();
  if (e2) throw new Error('No pude sembrar el participante: ' + e2.message);
  return { gastoId: gasto.id, participanteId: parte.id };
}

let cookieAcreedor, cookieConfirma;

try {
  autoprueba();
  await limpiar();
  cookieAcreedor = await login(ACREEDOR);
  cookieConfirma = await login(CONFIRMA);

  // ── 1. Entropía: DEUDAS ──────────────────────────────────────────────────────
  const codigosDeuda = [];
  const deudasParaCodigo = [];
  for (let i = 0; i < MUESTRAS; i++) {
    const id = await sembrarDeuda();
    deudasParaCodigo.push(id);
    const r = await api(cookieAcreedor, 'POST', '/api/debts/invite', { deuda_id: id });
    if (r.status !== 200 || !r.json?.invite_code) throw new Error(`invite deuda -> ${r.status} ${r.text}`);
    codigosDeuda.push(r.json.invite_code);
  }
  const eD = evaluarCodigos(codigosDeuda);
  check('forma_codigo_deuda', eD.problemas.length === 0,
    `largo=${eD.largo} distintos=${eD.distintosVistos} contrato≈${eD.bitsContrato} bits ej=${codigosDeuda[0]}` +
    (eD.problemas.length ? ` — ${eD.problemas.join('; ')}` : ''));
  check('deuda_codigos_distintos', new Set(codigosDeuda).size === codigosDeuda.length,
    `${new Set(codigosDeuda).size}/${codigosDeuda.length} distintos`);

  // El código que devuelve la API tiene que ser el que quedó EN LA FILA.
  //
  // Este check existe por un defecto que casi se despliega: subir el largo a 32 chars
  // contra una columna `character varying(12)` hace fallar el UPDATE, y como ninguna de
  // las dos rutas leía el `error`, devolvían 200 con un código que la fila nunca guardó
  // — link roto para siempre, en silencio. Ni la suite unitaria (que afirma sobre la
  // función pura) ni el resto de este harness (que solo miraba la respuesta HTTP) podían
  // verlo. **La aserción no conoce el ancho de la columna a propósito**: escribir el 12
  // acá lo dejaría envejecer. Pregunta por el efecto, no por el esquema.
  //
  // Se filtra por los IDs que sembró ESTA corrida y no por el TAG: si un cleanup anterior
  // falló, las filas viejas engordan el conjunto y la comparación pasa sin haber
  // comprobado lo de hoy. El caso que importa (código NO guardado → columna null) lo
  // detectaba igual, pero un check que puede dar verde por basura acumulada es un check
  // que envejece hacia el lado cómodo.
  const { data: filasDeuda } = await svc.from('deudas').select('id, invite_code')
    .eq('usuario_id', ACREEDOR.uid).in('id', deudasParaCodigo);
  const enDb = new Set((filasDeuda || []).map((f) => f.invite_code));
  const noPersistidos = codigosDeuda.filter((c) => !enDb.has(c));
  check('deuda_codigo_persiste', noPersistidos.length === 0,
    `${codigosDeuda.length - noPersistidos.length}/${codigosDeuda.length} guardados en la fila` +
    (noPersistidos.length ? ` — la API devolvio 200 con ${noPersistidos[0]} y la columna no lo tiene` : ''));

  const deudaId = deudasParaCodigo[0];
  const codigo = codigosDeuda[0];

  // ── 2. El preview es PÚBLICO (sin sesión). Documenta el modelo de posesión ────
  const prev = await api(null, 'GET', `/api/debts/invite?code=${encodeURIComponent(codigo)}`);
  check('deuda_preview_anonimo', prev.status === 200 && prev.json?.acreedor != null,
    `status=${prev.status} acreedor=${prev.json?.acreedor ?? '—'} monto=${prev.json?.monto_original ?? '—'}`);

  // ── 3. Segundo confirmante ───────────────────────────────────────────────────
  // Se siembra un espejo del TERCERO (no tiene sesión web: solo hace falta la FILA) y se
  // pide al CONFIRMANTE que confirme la MISMA deuda. Con el chequeo filtrado por usuario_id, entra igual:
  // dos espejos para una sola deuda, y cada uno puede marcarla pagada.
  const { data: espejoTercero, error: eT } = await svc.from('deudas').insert({
    usuario_id: TERCERO,
    tipo: 'debo',
    contraparte: 'QA Acreedor',
    monto_original: 120,
    monto_pendiente: 120,
    moneda: 'PEN',
    descripcion: TAG,
    estado: 'activa',
    deuda_vinculada_id: deudaId,
  }).select('id').single();
  if (eT) throw new Error('No pude sembrar el espejo del tercero: ' + eT.message);

  const joinSegundo = await api(cookieConfirma, 'POST', '/api/debts/join', { code: codigo });
  check('deuda_segundo_confirmante', joinSegundo.status === 409,
    `status=${joinSegundo.status} (esperado 409: ya hay un espejo de esta deuda) ${joinSegundo.text}`);

  // Deja el terreno limpio para el join legítimo, gane o pierda el check de arriba.
  await svc.from('deudas').delete().eq('usuario_id', TERCERO).eq('id', espejoTercero.id);
  await svc.from('deudas').delete().eq('usuario_id', CONFIRMA.uid).eq('deuda_vinculada_id', deudaId);

  // ── 4. Join legítimo ─────────────────────────────────────────────────────────
  const joinOk = await api(cookieConfirma, 'POST', '/api/debts/join', { code: codigo });
  const espejoConfirmante = joinOk.json?.id;
  check('deuda_join_legitimo', joinOk.status === 200 && joinOk.json?.deuda_vinculada_id === deudaId,
    `status=${joinOk.status} vinculada=${joinOk.json?.deuda_vinculada_id ?? '—'}`);

  // ── 5. OBSERVACIÓN: qué poder da confirmar ───────────────────────────────────
  if (espejoConfirmante) {
    // `id` y `action` van en el BODY, no en el query string: con query devuelve 400
    // ("Missing id") y la observación se leería como "no se pudo".
    const pagar = await api(cookieConfirma, 'PUT', '/api/debts', { id: espejoConfirmante, action: 'marcar_pagada' });
    const { data: original } = await svc.from('deudas').select('estado, monto_pendiente').eq('usuario_id', ACREEDOR.uid).eq('id', deudaId).single();
    observar('obs_marcar_pagada',
      `el confirmante marcó pagada su fila espejo (status=${pagar.status}) → la deuda del ACREEDOR quedó ` +
      `estado=${original?.estado} pendiente=${original?.monto_pendiente}. Esto es lo que hay ` +
      `detrás de un invite code de deuda.`);
  } else {
    observar('obs_marcar_pagada', 'no se pudo medir: el join legítimo no devolvió id');
  }

  // ── 6. Entropía y preview: SPLITS ────────────────────────────────────────────
  const codigosSplit = [];
  let primerParticipante = null;
  for (let i = 0; i < MUESTRAS; i++) {
    const { gastoId, participanteId } = await sembrarGasto();
    if (!primerParticipante) primerParticipante = { gastoId, participanteId };
    const r = await api(cookieAcreedor, 'POST', '/api/split/invite', { gasto_id: gastoId, participante_id: participanteId });
    if (r.status !== 200 || !r.json?.invite_code) throw new Error(`invite split -> ${r.status} ${r.text}`);
    codigosSplit.push(r.json.invite_code);
  }
  const eS = evaluarCodigos(codigosSplit);
  check('forma_codigo_split', eS.problemas.length === 0,
    `largo=${eS.largo} distintos=${eS.distintosVistos} contrato≈${eS.bitsContrato} bits ej=${codigosSplit[0]}` +
    (eS.problemas.length ? ` — ${eS.problemas.join('; ')}` : ''));
  check('split_codigos_distintos', new Set(codigosSplit).size === codigosSplit.length,
    `${new Set(codigosSplit).size}/${codigosSplit.length} distintos`);

  // La misma pregunta que en deudas: ¿el código llegó a la fila? Se hace por SEPARADO
  // porque las dos rutas escriben en tablas distintas y con largos de columna propios.
  const { data: filasParte } = await svc.from('gasto_participantes').select('invite_code')
    .in('gasto_id', creadas.gastos);
  const enDbS = new Set((filasParte || []).map((f) => f.invite_code));
  const noPersistidosS = codigosSplit.filter((c) => !enDbS.has(c));
  check('split_codigo_persiste', noPersistidosS.length === 0,
    `${codigosSplit.length - noPersistidosS.length}/${codigosSplit.length} guardados en la fila`);

  const prevS = await api(null, 'GET', `/api/split/invite?code=${encodeURIComponent(codigosSplit[0])}`);
  check('split_preview_anonimo', prevS.status === 200 && prevS.json?.creador != null,
    `status=${prevS.status} creador=${prevS.json?.creador ?? '—'}`);

  const joinS = await api(cookieConfirma, 'POST', '/api/split/join', { code: codigosSplit[0] });
  check('split_join_legitimo', joinS.status === 200 && joinS.json?.id != null, `status=${joinS.status} ${joinS.text}`);

  // El EFECTO, no el 200. `gasto_participantes.usuario_id` es el único token de
  // idempotencia de esa ruta, y el UPDATE que lo escribe iba DESPUÉS del insert de la
  // deuda y sin leer su `error`: un fallo devolvía 200 con la deuda ya creada y el
  // participante sin reclamar, así que el mismo link acuñaba otra deuda en cada canje.
  //
  // `split_segundo_confirmante` NO ve eso —en el camino feliz el UPDATE anda y el 409
  // sale igual—, que es justo por qué hace falta este check: pregunta por la fila.
  const { data: parteReclamada } = await svc.from('gasto_participantes')
    .select('usuario_id').eq('id', primerParticipante.participanteId).single();
  check('split_reclamo_persiste', parteReclamada?.usuario_id === CONFIRMA.uid,
    `usuario_id en la fila = ${parteReclamada?.usuario_id ?? 'null'} (esperado ${CONFIRMA.uid})`);

  // El segundo confirmante de un split YA estaba cerrado: `gasto_participantes.usuario_id`
  // es la marca, y es por participante. Se verifica igual para que no sea una creencia.
  const joinS2 = await api(cookieConfirma, 'POST', '/api/split/join', { code: codigosSplit[0] });
  check('split_segundo_confirmante', joinS2.status === 409, `status=${joinS2.status}`);
} catch (e) {
  check('harness', false, 'excepción: ' + e.message);
} finally {
  // El cleanup FALLA el harness. Un `.catch(console.error)` acá dejaba exit 0 con filas
  // de prueba abandonadas en produccion — que es el mismo patron que este harness denuncia
  // en el codigo que audita: tragarse el error de una escritura.
  const errores = await limpiar().catch((e) => [e.message]);
  check('cleanup', errores.length === 0, errores.join(' | '));
}

const anchoMax = Math.max(...Object.keys(checks).map((k) => k.length));
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v.ok === 'OK' ? '✅' : v.ok === 'OBS' ? '📏' : '❌'} ${k.padEnd(anchoMax)}  ${v.detalle || ''}`);
}
console.log('\n' + resumenGuard());
console.log(fallos === 0 ? '\nqa-invite-codes: OK' : `\nqa-invite-codes: ${fallos} FALLA(S)`);
process.exit(fallos === 0 ? 0 : 1);

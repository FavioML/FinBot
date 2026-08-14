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

// Piso de entropía exigido. 64 bits deja el barrido completo fuera de alcance por varios
// órdenes de magnitud incluso sin rate limit, que es la situación real: el preview es
// público y el único limitador disponible en la webapp (`lib/rate-limit.ts`) es un Map en
// memoria, o sea POR LAMBDA — no acota a un atacante distribuido. Ver el ledger.
const BITS_MINIMOS = 64;

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
 * Bits de entropía del código EMITIDO, con el modelo del ATACANTE: no cuenta los
 * caracteres distintos que salieron, infiere la CLASE a la que pertenecen.
 *
 * La primera versión contaba el alfabeto observado y lo presentaba como "cota inferior
 * honesta… puede sub-reportar y hacer fallar de más, nunca aprobar un código corto".
 * Sub-reportar no es gratis, y se vio en la primera corrida contra el código nuevo:
 * 3 códigos × 12 chars son 36 tiradas sobre un alfabeto de 55, así que se observan ~28 y
 * el estimador decía **57.7 bits** de unos reales 69.4 → **rojo falso**. Un harness que
 * falla por la razón equivocada es peor que uno que no existe: la reacción natural es
 * bajarle el piso, y ahí se pierde de verdad.
 *
 * Saturar el alfabeto pedía ~30 códigos por corrida, o sea 60 filas sembradas y borradas
 * en producción para medir algo que ya afirma el test unitario (`codigos-seguros.test.ts`
 * cubre los 55 chars sobre 2000 muestras). Acá la pregunta es otra: **qué emite PROD**.
 * Y para eso la clase alcanza — es además lo que ve quien ataca, que no conoce el
 * alfabeto interno, ve códigos y deduce el charset.
 *
 * Sobre-reporta un poco (62 supuestos contra 55 reales, +2 bits) porque el alfabeto
 * excluye los ambiguos. Contra el código viejo sigue dando el veredicto correcto: puro
 * `[0-9a-f]` cae en la rama hex → 16 → 8 × 4 = **32 bits**, rojo.
 */
function claseDe(chars) {
  const todos = [...new Set(chars)];
  if (todos.every((c) => /[0-9]/.test(c))) return { nombre: 'digitos', n: 10 };
  if (todos.every((c) => /[0-9a-f]/.test(c))) return { nombre: 'hex', n: 16 };
  return {
    nombre: 'alfanumerico',
    n: (todos.some((c) => /[A-Z]/.test(c)) ? 26 : 0)
     + (todos.some((c) => /[a-z]/.test(c)) ? 26 : 0)
     + (todos.some((c) => /[0-9]/.test(c)) ? 10 : 0),
  };
}

/**
 * La clase SOLA sobre-reporta, y en la dirección insegura. Lo encontró la segunda revisión
 * adversarial con un contraejemplo construible: un generador sobre el alfabeto `aA1bB2cC`
 * (8 símbolos) tiene mayúscula, minúscula y dígito, así que `claseDe` declara 62 y 12 chars
 * se leen como 71.5 bits cuando son 36. El estimador anterior sobre-reportaba hacia el lado
 * SEGURO; éste lo hacía hacia el peligroso, que es peor que cualquiera de los dos.
 *
 * La corrección no es un piso arbitrario sobre los distintos vistos: es INVERTIR el problema
 * del coleccionista de cupones. Con N tiradas de un alfabeto de n símbolos se esperan
 * `n · (1 − (1 − 1/n)^N)` distintos, que es monótona en n; así que del número de distintos
 * observados sale una estimación del alfabeto real, y se toma el MENOR entre ésa y la clase.
 * Un alfabeto de 8 deja ver 8 → estima 8 → 36 bits → rojo. Uno de 31 deja ver ~21 → estima
 * ~31 → 59.4 bits → rojo, aunque su clase diga 62.
 */
function alfabetoImplicado(distintos, tiradas) {
  const esperado = (n) => n * (1 - Math.pow(1 - 1 / n, tiradas));
  let n = 2;
  while (n < 200 && esperado(n) < distintos) n++;
  return n;
}

function bitsDe(codigos) {
  const largos = new Set(codigos.map((c) => c.length));
  const largo = Math.min(...largos);
  const juntos = codigos.join('');
  const clase = claseDe(juntos);
  const distintos = new Set(juntos).size;
  const implicado = alfabetoImplicado(distintos, juntos.length);
  const alfabeto = Math.min(clase.n, implicado);
  return {
    largo,
    largosDistintos: [...largos],
    clase: clase.nombre,
    claseN: clase.n,
    distintosVistos: distintos,
    implicado,
    alfabeto,
    bits: +(largo * Math.log2(alfabeto)).toFixed(1),
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
  const casos = [
    // [alfabeto, largo, ¿debería pasar el piso?]
    ['0123456789abcdef', 8, false],                                          // el código VIEJO: 32 bits
    ['aA1bB2cC', 12, false],                                                 // el contraejemplo del revisor
    ['ABCDEFGHJKMNPQRSTUVWXYZ23456789', 12, false],                          // 31 chars: 59.4 bits, clase diría 62
    ['ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 12, true],   // el real: 69.4 bits
  ];
  for (const [alfabeto, largo, deberiaPasar] of casos) {
    const muestras = muestrear(alfabeto, 3, largo);
    const e = bitsDe(muestras);
    // El fixture tiene que EJERCITAR el alfabeto que dice: si el muestreador degenera, el
    // caso pasa por el motivo equivocado y el día que alguien lo toque no se entera.
    const cobertura = e.distintosVistos / Math.min(alfabeto.length, largo * 3);
    if (cobertura < 0.5) {
      throw new Error(
        `autoprueba: el fixture de ${alfabeto.length} símbolos solo sacó ${e.distintosVistos} ` +
        'distintos — el muestreador degeneró y el caso no ejercita lo que dice');
    }
    if ((e.bits >= BITS_MINIMOS) !== deberiaPasar) {
      throw new Error(
        `autoprueba del estimador: alfabeto de ${alfabeto.length} × ${largo} dio ${e.bits} bits ` +
        `(clase ${e.claseN}, implicado ${e.implicado}) y se esperaba ${deberiaPasar ? '≥' : '<'} ${BITS_MINIMOS}`);
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
  for (let i = 0; i < 3; i++) {
    const id = await sembrarDeuda();
    deudasParaCodigo.push(id);
    const r = await api(cookieAcreedor, 'POST', '/api/debts/invite', { deuda_id: id });
    if (r.status !== 200 || !r.json?.invite_code) throw new Error(`invite deuda -> ${r.status} ${r.text}`);
    codigosDeuda.push(r.json.invite_code);
  }
  const eD = bitsDe(codigosDeuda);
  check('entropia_deuda', eD.bits >= BITS_MINIMOS,
    `largo=${eD.largo} clase=${eD.clase}(${eD.claseN}) vistos=${eD.distintosVistos} alfabeto=${eD.alfabeto} bits≈${eD.bits} (piso ${BITS_MINIMOS}) ej=${codigosDeuda[0]}`);
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
  for (let i = 0; i < 3; i++) {
    const { gastoId, participanteId } = await sembrarGasto();
    if (!primerParticipante) primerParticipante = { gastoId, participanteId };
    const r = await api(cookieAcreedor, 'POST', '/api/split/invite', { gasto_id: gastoId, participante_id: participanteId });
    if (r.status !== 200 || !r.json?.invite_code) throw new Error(`invite split -> ${r.status} ${r.text}`);
    codigosSplit.push(r.json.invite_code);
  }
  const eS = bitsDe(codigosSplit);
  check('entropia_split', eS.bits >= BITS_MINIMOS,
    `largo=${eS.largo} clase=${eS.clase}(${eS.claseN}) vistos=${eS.distintosVistos} alfabeto=${eS.alfabeto} bits≈${eS.bits} (piso ${BITS_MINIMOS}) ej=${codigosSplit[0]}`);
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

// Harness E2E del panel admin (/admin y /api/admin/*).
//
// Existe porque la auditoría del panel (2026-07-30) encontró métricas MAL, no solo lentas:
// las rutas traían filas crudas de `transacciones` y agregaban en JS, y PostgREST corta la
// respuesta en 1000 filas. Con 2123 filas el embudo reportaba 21 de 44 usuarios activados
// (25% vs 52% real) sin un solo error visible. Un bug así no lo ve un smoke test de status
// 200: hay que comparar contra la base.
//
// Por eso el ORÁCULO de este harness pagina a propósito (Range headers) para contar lo que
// las rutas contaban mal. Si alguien vuelve a introducir una agregación sin paginar ni
// agregar en SQL, la comparación falla.
//
// Mismo patrón de auth que el resto de qa-e2e: password grant → cookie SSR forjada.
// Usa la cuenta admin DEDICADA (admin-qa@neto.pe), no la cuenta personal ni el usuario QA
// normal: así el caso "un usuario común NO entra al panel" sigue siendo comprobable.
//
// Es READ-ONLY: solo GET. No aprueba pagos, no borra usuarios, no escribe nada.
//
// Uso: node qa-admin-panel.mjs            (contra https://app.neto.pe)
//      NETO_APP_URL=http://localhost:3000 node qa-admin-panel.mjs   (dev local)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

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
const ADMIN = { email: env.NETO_QA_ADMIN_EMAIL, password: env.NETO_QA_ADMIN_PASSWORD };
// Usuario QA normal: sirve para probar que NO puede entrar al panel.
const PLAIN = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD };
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !ADMIN.email || !ADMIN.password) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_URL, NETO_QA_ANON, NETO_QA_ADMIN_*).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local).');
  process.exit(2);
}

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

// GET con medición de latencia end-to-end (la que sufre el navegador, no la de la función).
async function get(cookie, path) {
  const t0 = performance.now();
  const r = await fetch(`${APP}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
  const text = await r.text().catch(() => '');
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json, ms, len: text.length };
}

// --- ORÁCULO: lee la base directo, paginando, sin pasar por las RPC del panel ---
// Deliberadamente NO usa admin_user_tx_stats: si el oráculo usara la misma función que la
// ruta, un bug en la función pasaría inadvertido por los dos lados.
async function sbPaginado(tabla, select) {
  const filas = [];
  const PASO = 1000;
  for (let desde = 0; ; desde += PASO) {
    const r = await fetch(`${SUPA}/rest/v1/${tabla}?select=${select}`, {
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        Range: `${desde}-${desde + PASO - 1}`,
      },
    });
    if (!r.ok) throw new Error(`oráculo ${tabla} -> ${r.status}`);
    const lote = await r.json();
    filas.push(...lote);
    if (lote.length < PASO) break;
  }
  return filas;
}

const results = [];
function ok(name, cond, note) { results.push({ name, pass: !!cond, note }); }

(async () => {
  console.log(`Panel admin contra ${APP}\n`);

  // ---------- 1. Guard: sin sesión y con sesión de usuario común ----------
  // /api/admin/check va aparte a propósito: NO es una ruta de datos, es la que el cliente
  // consulta para decidir si muestra el link al panel. Responder 200 con {isAdmin:false} es
  // su contrato correcto, no una fuga: no devuelve nada más que ese booleano.
  const RUTAS = [
    '/api/admin/stats',
    '/api/admin/users',
    '/api/admin/economics',
    '/api/admin/costs',
    '/api/admin/pnl',
    '/api/admin/surveys',
    '/api/admin/producto',
    '/api/admin/tickets?limit=50',
    '/api/admin/nlp-errors?limit=100',
  ];

  for (const ruta of RUTAS) {
    const r = await get(null, ruta);
    ok(`guard sin sesión: ${ruta}`, r.status === 401 || r.status === 403, `-> ${r.status}`);
  }
  const checkAnon = await get(null, '/api/admin/check');
  ok('check sin sesión dice isAdmin:false', checkAnon.json?.isAdmin === false, `-> ${JSON.stringify(checkAnon.json)}`);

  if (PLAIN.email && PLAIN.password) {
    const cookiePlain = await login(PLAIN);
    for (const ruta of RUTAS) {
      const r = await get(cookiePlain, ruta);
      ok(`guard usuario común: ${ruta}`, r.status === 401 || r.status === 403, `-> ${r.status}`);
    }
    const checkPlain = await get(cookiePlain, '/api/admin/check');
    ok('check usuario común dice isAdmin:false', checkPlain.json?.isAdmin === false, `-> ${JSON.stringify(checkPlain.json)}`);
  } else {
    console.log('(sin NETO_QA_EMAIL/PASSWORD: me salto el chequeo de usuario común)\n');
  }

  // ---------- 2. Todas las rutas responden 200 con sesión admin ----------
  const cookie = await login(ADMIN);
  const checkAdmin = await get(cookie, '/api/admin/check');
  ok(
    'check admin dice isAdmin:true',
    checkAdmin.json?.isAdmin === true,
    checkAdmin.json?.isAdmin === false
      ? 'la cuenta admin QA no está en ADMIN_USER_IDS de Vercel'
      : `-> ${JSON.stringify(checkAdmin.json)}`,
  );

  const resp = {};
  const latencias = [];

  for (const ruta of RUTAS) {
    const r = await get(cookie, ruta);
    resp[ruta] = r.json;
    latencias.push({ ruta, ms: r.ms, kb: Math.round(r.len / 102.4) / 10 });
    ok(`200 admin: ${ruta}`, r.status === 200, `-> ${r.status} en ${r.ms}ms`);
  }

  // ---------- 3. Truncado: ninguna colección debe medir exactamente 1000 ----------
  // 1000 clavado es la firma del techo de PostgREST, no una casualidad estadística.
  for (const [ruta, json] of Object.entries(resp)) {
    if (!json) continue;
    for (const [clave, valor] of Object.entries(json)) {
      if (Array.isArray(valor) && valor.length === 1000) {
        ok(`sin truncado: ${ruta} .${clave}`, false, 'exactamente 1000 filas: huele a techo de PostgREST');
      }
    }
  }
  ok('sin truncado: ninguna colección clavada en 1000', !results.some(r => r.name.startsWith('sin truncado:') && !r.pass));

  // ---------- 3b. surveys: el listado tampoco puede truncarse en silencio ----------
  // La ruta antes leía survey_events entera DOS veces sin .limit() (bug latente: mismo techo de
  // 1000 filas que la Ola 1, esperando volumen). Ahora la ventana es acotada y CONTADA: `total`
  // y `hasMore` deben venir, y la ventana devuelta no puede exceder el techo ni mentir sobre si
  // cubre todo. Los stats vienen de SQL (migración 040), así que deben venir aunque el listado
  // esté acotado.
  const surveys = resp['/api/admin/surveys'];
  if (surveys) {
    const evs = surveys.events;
    ok('surveys: listado es array', Array.isArray(evs), `-> ${typeof evs}`);
    ok('surveys: expone total (número)', typeof surveys.total === 'number', `-> ${surveys.total}`);
    ok('surveys: expone hasMore (bool)', typeof surveys.hasMore === 'boolean', `-> ${surveys.hasMore}`);
    ok('surveys: ventana <= 1000 (techo PostgREST)', Array.isArray(evs) && evs.length <= 1000, `-> ${evs?.length}`);
    // hasMore es la única fuente de verdad de "hay más": si es false, la ventana DEBE cubrir el
    // total; si dice cubrir todo pero clava exactamente el techo, es el bug de vuelta.
    if (surveys.hasMore === false) {
      ok('surveys: hasMore=false ⇒ ventana == total', Array.isArray(evs) && evs.length === surveys.total, `${evs?.length} vs ${surveys.total}`);
      ok('surveys: ventana completa no clava el techo de 1000', evs?.length !== 1000, `-> ${evs?.length}`);
    }
    ok('surveys: stats vienen de SQL (by_event_type presente)', !!surveys.stats?.by_event_type, `-> ${JSON.stringify(Object.keys(surveys.stats || {}))}`);
    // El payload ya no arrastra message_sent (73% de los bytes, solo alimentaba un hover).
    ok('surveys: message_sent fuera del listado', !Array.isArray(evs) || evs.every(e => !('message_sent' in e)), 'alguna fila aún trae message_sent');
  } else {
    ok('surveys: la ruta respondió', false, 'no hubo respuesta JSON de /api/admin/surveys');
  }

  // ---------- 4. Invariantes de actividad ----------
  const k = resp['/api/admin/stats']?.kpis || {};
  ok('DAU <= WAU', k.dau <= k.wau, `${k.dau} <= ${k.wau}`);
  ok('WAU <= MAU', k.wau <= k.mau, `${k.wau} <= ${k.mau}`);

  // ---------- 5. Embudo contra el oráculo ----------
  // "No es negocio real" = cuenta de prueba O interna (el fundador no lleva is_test_user). Es la
  // definición de isRevenueUser y de los RPC (migr 057), y se declara acá arriba porque la usan
  // el embudo, el MRR y las métricas de producto. Si el oráculo contara todo, validaría
  // exactamente el sesgo que el panel acaba de dejar de tener.
  const INTERNAL_WHATSAPP = new Set(['51970398192', '51999999997']);
  const esInterno = (u) => !!u.is_test_user || INTERNAL_WHATSAPP.has(u.whatsapp);
  const usuariosPlan = await sbPaginado('usuarios', 'id,whatsapp,is_test_user,plan,trial_estado,cuenta_borrada_at');
  const idsReales = new Set(usuariosPlan.filter((u) => !esInterno(u)).map((u) => u.id));

  const txs = await sbPaginado('transacciones', 'usuario_id');
  const usuariosConTx = new Set(txs.map(t => t.usuario_id)).size;
  const conTxReales = new Set(txs.filter(t => idsReales.has(t.usuario_id)).map(t => t.usuario_id)).size;
  const usuarios = await sbPaginado('usuarios', 'id');

  const funnel = resp['/api/admin/stats']?.funnel || {};
  ok(
    'embudo: primera transacción == usuarios reales con transacciones',
    funnel.firstTransaction === conTxReales,
    `panel dice ${funnel.firstTransaction}, la base dice ${conTxReales} (${usuariosConTx} contando pruebas)`,
  );
  ok(
    'embudo: registrados == usuarios reales (sin pruebas ni internos)',
    funnel.registered === idsReales.size,
    `panel dice ${funnel.registered}, la base dice ${idsReales.size} (${usuarios.length} en total)`,
  );
  ok('embudo: registrados >= onboarding completo', funnel.registered >= funnel.onboardingComplete);
  ok('embudo: registrados >= primera transacción', funnel.registered >= funnel.firstTransaction);

  // ---------- 6. /users: los counts por usuario deben sumar el total real ----------
  const lista = resp['/api/admin/users']?.usuarios || [];
  const sumaTx = lista.reduce((acc, u) => acc + (u.transacciones || 0), 0);
  ok('users: total == usuarios reales', lista.length === usuarios.length, `${lista.length} vs ${usuarios.length}`);
  ok(
    'users: suma de transacciones por usuario == total real',
    sumaTx === txs.length,
    `suma ${sumaTx} vs ${txs.length} en la base`,
  );

  // ---------- 6b. economics: mismos agregados, misma verdad ----------
  // stats y economics calculan actividad por caminos distintos. Si divergen, uno miente.
  const eco = resp['/api/admin/economics'] || {};
  ok(
    'economics: transacciones totales == verdad de la base',
    eco.transactions_total === txs.length,
    `panel dice ${eco.transactions_total}, la base dice ${txs.length}`,
  );
  ok(
    'economics: total de usuarios == verdad de la base',
    eco.total_users === usuarios.length,
    `panel dice ${eco.total_users}, la base dice ${usuarios.length}`,
  );
  ok(
    'economics.active_users_30d == stats.mau (no pueden divergir)',
    eco.active_users_30d === k.mau,
    `economics ${eco.active_users_30d} vs stats ${k.mau}`,
  );
  // Margen operativo = MRR − costos mensuales (aritmética interna de la ruta).
  ok(
    'economics: margen operativo == mrr − costos mensuales',
    Math.abs(Number(eco.operating_margin_monthly_pen) - (Math.round((Number(eco.mrr) - Number(eco.total_monthly_costs_pen)) * 100) / 100)) < 0.01,
    `margen ${eco.operating_margin_monthly_pen} vs ${eco.mrr} − ${eco.total_monthly_costs_pen}`,
  );

  // "Pro sin pago registrado" == cuánto del MRR no es plata. Un comp (Pro regalado por
  // /admin/activar) ya NO entra al MRR: desde el 2026-09-01 se descuenta, y el panel lo reporta
  // aparte como `cortesias` para que el descuento tenga explicación en la misma pantalla.
  // El oráculo lo recalcula desde `usuarios` + `pagos` con la misma definición de la ruta:
  // Pro pagado (premium y trial_estado <> 'activo'), no interno, sin ninguna fila aprobada
  // con monto > 0. Si el panel y la base divergen, el MRR está contando plata que no entró.
  // Las mismas cuentas que EXCLUDED_REVENUE_WHATSAPP en admin-revenue.ts (fundador + QA Pro).
  const pagosOk = await sbPaginado('pagos', 'usuario_id,estado,monto,aprobado_at,created_at');
  const proPagadosReales = usuariosPlan.filter(
    (u) => u.plan === 'premium' && u.trial_estado !== 'activo' && !esInterno(u),
  );

  // BAJA DECLARADA: pidió borrar su cuenta y no volvió a pagar después. Se reimplementa acá
  // en vez de importar `admin-revenue.ts` a propósito — el valor del oráculo es ser una
  // segunda implementación, no un espejo. El testigo es una fila de `pagos` aprobada con
  // monto > 0 POSTERIOR a la baja, y no `fecha_pago`/`premium_desde`, que se escriben en los
  // comps y en el premio de referidos sin que entre un sol.
  const cobrosPorUsuario = new Map();
  for (const p of pagosOk) {
    if (p.estado !== 'aprobado' || !(Number(p.monto) > 0) || !p.usuario_id) continue;
    const t = new Date(p.aprobado_at || p.created_at).getTime();
    if (Number.isNaN(t)) continue;
    (cobrosPorUsuario.get(p.usuario_id) || cobrosPorUsuario.set(p.usuario_id, []).get(p.usuario_id)).push(t);
  }
  const ahora = Date.now();
  const esBajaDeclarada = (u) => {
    if (!u.cuenta_borrada_at) return false;
    const baja = new Date(u.cuenta_borrada_at).getTime();
    if (Number.isNaN(baja) || baja > ahora) return false;
    return !(cobrosPorUsuario.get(u.id) || []).some((t) => t > baja && t <= ahora);
  };
  const bajasOraculo = proPagadosReales.filter(esBajaDeclarada);
  // Pro de CORTESIA: tiene el plan y nunca le entro un sol. Desde el 2026-09-01 sale del MRR,
  // igual que la baja, y por el mismo motivo — no es plata. El oraculo tiene que descontarlo
  // tambien, o este harness afirma que el panel esta mal justo cuando esta bien.
  //
  // La baja gana sobre la cortesia cuando las dos aplican: el panel cuenta a esa persona una
  // sola vez, en `bajas_declaradas`.
  const esCortesia = (u) => !(cobrosPorUsuario.get(u.id) || []).some((t) => t <= ahora);
  const cortesiasOraculo = proPagadosReales.filter((u) => !esBajaDeclarada(u) && esCortesia(u));
  const proActivosReales = proPagadosReales.filter(
    (u) => !esBajaDeclarada(u) && !esCortesia(u),
  );

  ok(
    'economics: el MRR no cuenta cuentas de prueba, bajas declaradas ni cortesias',
    eco.pro_users === proActivosReales.length,
    `panel dice ${eco.pro_users} Pro, la base dice ${proActivosReales.length}` +
      (bajasOraculo.length ? ` (${bajasOraculo.length} de ${proPagadosReales.length} pagados pidieron borrar su cuenta)` : '') +
      (cortesiasOraculo.length ? ` (${cortesiasOraculo.length} de cortesia, sin ningun pago)` : ''),
  );
  // Y que la caída del MRR tenga explicación EN LA MISMA respuesta: un número que baja sin
  // motivo visible se lee como un bug del panel.
  ok(
    'economics: bajas_declaradas == verdad de la base',
    eco.bajas_declaradas === bajasOraculo.length,
    `panel dice ${eco.bajas_declaradas}, la base dice ${bajasOraculo.length}`,
  );
  // Y el otro descuento del MRR, por el mismo motivo que el de arriba: si baja sin explicacion
  // en la misma respuesta, se lee como un bug del panel.
  //
  // **Este check cambio de nombre el 2026-09-01 y el harness NO se actualizo solo.** Se llamaba
  // `pro_sin_pago_registrado` y afirmaba lo contrario que hoy: esos Pro SI estaban en el MRR y
  // el campo solo los reportaba. Al renombrarse a `cortesias`, la comparacion quedo
  // `undefined === N`, o sea roja siempre. Es el recordatorio de que un harness del canary es
  // consumidor del contrato de la API: renombrar un campo lo rompe igual que a una pantalla.
  ok(
    'economics: cortesias == verdad de la base',
    eco.cortesias === cortesiasOraculo.length,
    `panel dice ${eco.cortesias}, la base dice ${cortesiasOraculo.length}` +
      (cortesiasOraculo.length > 0
        ? ` (${cortesiasOraculo.length} Pro regalado, S/${cortesiasOraculo.length * 10} que no se cobran)`
        : ''),
  );

  // ---------- 7. MAU contra el oráculo ----------
  const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const txMes = await sbPaginado('transacciones', `usuario_id&created_at=gte.${hace30}`);
  ok(
    'MAU == verdad de la base',
    k.mau === new Set(txMes.map(t => t.usuario_id)).size,
    `panel dice ${k.mau}, la base dice ${new Set(txMes.map(t => t.usuario_id)).size}`,
  );

  // ---------- 7b. /users: campos de actividad (migración 042) + flag interno (Ola 4) ----------
  // La página admin/users segmenta la base con estas ventanas. Validamos la DATA de la ruta;
  // la clasificación en segmentos tiene sus propios unit tests (admin-user-segments.test.ts).
  const conActividad = lista.every(
    (u) => 'tx_14d' in u && 'tx_30d' in u && 'last_tx_at' in u && 'is_internal' in u,
  );
  ok('users: cada fila trae los campos de actividad (042)', conActividad, 'falta tx_14d/tx_30d/last_tx_at/is_internal');
  // Monotonía por usuario, no depende del reloj: 14d ⊆ 30d ⊆ total.
  const monotono = lista.every(
    (u) => (u.tx_14d || 0) <= (u.tx_30d || 0) && (u.tx_30d || 0) <= (u.transacciones || 0),
  );
  ok('users: tx_14d <= tx_30d <= transacciones (por usuario)', monotono, 'alguna fila viola la monotonía');
  // Suma de tx_30d == tx del mes según el oráculo (±2 por el borde de 30d entre now() de la DB
  // y Date.now() de JS; con cientos de tx la coincidencia es exacta salvo una justo en el borde).
  const sumaTx30 = lista.reduce((a, u) => a + (u.tx_30d || 0), 0);
  ok('users: suma tx_30d == tx del mes (oráculo, ±2)', Math.abs(sumaTx30 - txMes.length) <= 2, `suma ${sumaTx30} vs oráculo ${txMes.length}`);
  // is_internal marca exactamente lo que el MRR excluye: cuenta de prueba (is_test_user) O la
  // lista de internas (el fundador, que no es cuenta de prueba). Este check miraba SOLO la lista
  // y por eso se puso rojo al arreglar el MRR el 2026-08-02: la definición se movió y el guard
  // seguía comprobando la vieja. Va contra el mismo `esInterno` que usa el oráculo del MRR,
  // así que "la lista y el MRR marcan distinto al mismo usuario" no puede volver a pasar.
  const internosBase = new Map(usuariosPlan.map((u) => [u.id, esInterno(u)]));
  const flagOk = lista.every((u) => u.is_internal === (internosBase.get(u.id) ?? false));
  ok('users: is_internal == la misma definición que excluye el MRR', flagOk,
    'is_internal no coincide con is_test_user + lista de internas');

  // ---------- 7c. /users/[id]: ficha individual (Ola 4 Fase 2) ----------
  // Endpoint dinámico (un usuario) → no entra en el loop de RUTAS estáticas. Guardado por el mismo
  // requireAdminUser que las demás (la protección a usuario común ya la prueba el loop de arriba),
  // así que acá basta el guard sin sesión + los invariantes de datos. El cruce fuerte:
  // features.transacciones lo cuenta admin_user_features (043) y el count de /users viene de
  // admin_user_tx_stats (039) — dos RPC distintas contando lo mismo, deben coincidir.
  const target =
    lista.find((u) => u.plan === 'premium' && (u.transacciones || 0) > 0) ||
    lista.find((u) => (u.transacciones || 0) > 0) ||
    lista[0];
  if (target) {
    const rutaFicha = `/api/admin/users/${target.id}`;
    const fichaAnon = await get(null, rutaFicha);
    ok('guard sin sesión: users/[id]', fichaAnon.status === 401 || fichaAnon.status === 403, `-> ${fichaAnon.status}`);

    const ficha = await get(cookie, rutaFicha);
    ok('users/[id]: 200 admin', ficha.status === 200, `-> ${ficha.status} en ${ficha.ms}ms`);
    const f = ficha.json?.features;
    ok('users/[id]: expone features (objeto)', !!f && typeof f === 'object', `-> ${JSON.stringify(ficha.json)?.slice(0, 80)}`);
    if (f) {
      ok(
        'users/[id]: features.transacciones == count de /users (043 vs 039)',
        Number(f.transacciones) === (target.transacciones || 0),
        `ficha ${f.transacciones} vs users ${target.transacciones}`,
      );
      // LTV nunca negativo, y sin pagos aprobados el LTV tiene que ser 0 (no puede haber valor sin cobro).
      ok(
        'users/[id]: ltv_pen coherente con pagos_aprobados',
        Number(f.ltv_pen) >= 0 && (Number(f.pagos_aprobados) > 0 || Number(f.ltv_pen) === 0),
        `ltv ${f.ltv_pen} / pagos ${f.pagos_aprobados}`,
      );
    }
  } else {
    ok('users/[id]: hay un usuario para probar la ficha', false, 'la lista vino vacía');
  }

  // ---------- 8. Producto: invariantes entre los tres RPC (Ola 3) ----------
  // Todo agrega en SQL, así que ninguna colección trae filas para contarlas. Las invariantes
  // cruzan los tres RPC: si alguno truncara o contara mal, dejan de cuadrar. La más fuerte:
  // adopción.transacciones == total - dormidos (usuarios con tx == total menos los de 0 tx).
  const prod = resp['/api/admin/producto'];
  if (prod) {
    const eng = prod.engagement || {};
    const total = Number(eng.total);
    const bucketsSum = (eng.buckets || []).reduce((a, b) => a + Number(b.usuarios), 0);
    ok('producto: total es número', Number.isFinite(total) && total > 0, `-> ${eng.total}`);
    ok('producto: buckets suman el total', bucketsSum === total, `${bucketsSum} vs ${total}`);

    const cohortes = prod.retention?.cohorts || [];
    const sumaCohortes = cohortes.reduce((a, c) => a + Number(c.size), 0);
    ok('producto: cohortes suman el total (= usuarios reales)', sumaCohortes === total, `${sumaCohortes} vs ${total}`);

    const adoptMap = Object.fromEntries((prod.adoption || []).map(a => [a.feature, Number(a.users)]));
    ok(
      'producto: adopción.transacciones == total - dormidos',
      adoptMap.transacciones === total - Number(eng.dormant),
      `${adoptMap.transacciones} vs ${total - Number(eng.dormant)}`,
    );
    ok(
      'producto: ninguna adopción excede el total',
      (prod.adoption || []).every(a => Number(a.users) <= total),
      'alguna feature reporta más usuarios que el total',
    );
    // El total real == universo menos lo que no es negocio real (cuentas de prueba + internas).
    // Antes era una banda floja (`usuarios-3`) sobre la lista de internas; al empezar a excluir
    // is_test_user (migración 057) se puso roja, porque 7 cuentas de prueba salieron de golpe.
    // Ahora es una igualdad exacta contra el mismo `esInterno` que usa el oráculo del MRR: una
    // banda tolera justo el tipo de error que este check existe para ver.
    const universoReal = usuariosPlan.filter((u) => !esInterno(u)).length;
    ok(
      'producto: total real == usuarios que no son prueba ni internos',
      total === universoReal,
      `real ${total} vs universo real ${universoReal} (de ${usuarios.length} en total)`,
    );
    // Ninguna celda de retención madura puede tener más activos que el tamaño de su cohorte.
    const celdaMala = cohortes.some(c => (c.cells || []).some(cell => Number(cell.active) > Number(c.size)));
    ok('producto: retención activos <= tamaño de cohorte', !celdaMala, 'una cohorte reporta más activos que su tamaño');
  } else {
    ok('producto: la ruta respondió', false, 'no hubo respuesta JSON de /api/admin/producto');
  }

  // ---------- 9. P&L mensual contra el oráculo (Rework Costos, RPC admin_pnl_monthly 044) ----------
  // Filosofía de siempre: el oráculo recomputa el P&L leyendo pagos + admin_costs directo (paginando),
  // NO usa el RPC. Si el RPC truncara o agregara mal, deja de cuadrar. Base caja: ingreso = pagos
  // aprobados no-internos por mes Lima (coalesce(aprobado_at, created_at)); costo = paid_history por
  // mes Lima. NO se cruza contra economics.revenue_this_month a propósito: economics filtra por
  // created_at del mes y el P&L bucketea por fecha de aprobación, así que en el borde de mes (pago
  // creado un mes, aprobado el siguiente) pueden divergir legítimamente. El oráculo es el juez.
  const pnl = resp['/api/admin/pnl'];
  const limaMonth = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }).slice(0, 7) : null);
  if (pnl && Array.isArray(pnl.months)) {
    ok('pnl: expone months (array)', pnl.months.length > 0, `-> ${pnl.months.length}`);
    // result == income - cost, por mes (aritmética interna del RPC).
    const aritmeticaOk = pnl.months.every(
      (m) => Math.abs(Number(m.result_pen) - (Number(m.income_pen) - Number(m.cost_pen))) < 0.01,
    );
    ok('pnl: result == income - cost (cada mes)', aritmeticaOk, 'alguna fila no cuadra income-cost');

    // Oráculo independiente: usuarios (id+whatsapp) para excluir internos, pagos y admin_costs.
    // "No es negocio real" = cuenta de prueba O interna, la misma definición del RPC (migr 057) y
    // de isRevenueUser. Con la lista sola, un pago que un harness deje sin limpiar entraría al
    // oráculo, saldría del RPC, y el FAIL apuntaría al lugar equivocado.
    const usuariosWa = await sbPaginado('usuarios', 'id,whatsapp,is_test_user');
    const internalIds = new Set(usuariosWa.filter(esInterno).map((u) => u.id));
    const pagos = await sbPaginado('pagos', 'monto,estado,aprobado_at,created_at,usuario_id');
    const costsRows = await sbPaginado('admin_costs', 'paid_history');

    const incomeByMonth = {};
    for (const p of pagos) {
      if (p.estado !== 'aprobado' || p.monto == null) continue;
      if (internalIds.has(p.usuario_id)) continue;
      const mm = limaMonth(p.aprobado_at || p.created_at);
      if (!mm) continue;
      incomeByMonth[mm] = (incomeByMonth[mm] || 0) + Number(p.monto);
    }
    const costByMonth = {};
    for (const c of costsRows) {
      for (const e of Array.isArray(c.paid_history) ? c.paid_history : []) {
        const mm = e && e.paid_at ? String(e.paid_at).slice(0, 7) : null;
        if (!mm) continue;
        costByMonth[mm] = (costByMonth[mm] || 0) + Number(e.amount_pen);
      }
    }

    let ingresoCuadra = true, costoCuadra = true;
    for (const m of pnl.months) {
      const mm = String(m.month).slice(0, 7);
      if (Math.abs(Number(m.income_pen) - (incomeByMonth[mm] || 0)) >= 0.01) ingresoCuadra = false;
      if (Math.abs(Number(m.cost_pen) - (costByMonth[mm] || 0)) >= 0.01) costoCuadra = false;
    }
    ok('pnl: ingreso por mes == oráculo (pagos aprobados no-internos)', ingresoCuadra, 'algún mes no cuadra vs oráculo de pagos');
    ok('pnl: costo por mes == oráculo (paid_history)', costoCuadra, 'algún mes no cuadra vs oráculo de paid_history');

    // Caja generada acumulada (economics, RPC admin_pnl_totals 045): total histórico neto == oráculo.
    // Suma TODO el income y TODO el cost (no solo la ventana de 6 meses del /pnl).
    const incomeTotal = Object.values(incomeByMonth).reduce((a, b) => a + b, 0);
    const costTotal = Object.values(costByMonth).reduce((a, b) => a + b, 0);
    const netTotal = Math.round((incomeTotal - costTotal) * 100) / 100;
    ok(
      'economics: caja generada == oráculo histórico (ingresos − costos)',
      Math.abs(Number(eco.cash_generated_pen) - netTotal) < 0.01,
      `economics ${eco.cash_generated_pen} vs oráculo ${netTotal}`,
    );
  } else {
    ok('pnl: la ruta respondió con months', false, 'no hubo months en /api/admin/pnl');
  }

  // ---------- 10. Guard del endpoint de corrección de historial (mutación) ----------
  // PUT /costs/[id]/paid-history sin sesión debe rechazar ANTES de tocar la DB. Se manda body {} (sin
  // paid_history): aunque el guard se rompiera, cae en 400 de validación, nunca escribe (read-only safe).
  const algunCosto = (resp['/api/admin/costs']?.costs || [])[0];
  if (algunCosto) {
    const r = await fetch(`${APP}/api/admin/costs/${algunCosto.id}/paid-history`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      redirect: 'manual',
    });
    ok('guard sin sesión: PUT paid-history', r.status === 401 || r.status === 403, `-> ${r.status}`);
  }

  // ---------- Reporte ----------
  console.log('Latencias (end-to-end, incluye red desde esta máquina):');
  for (const l of latencias.sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${String(l.ms).padStart(5)}ms  ${String(l.kb).padStart(6)}kb  ${l.ruta}`);
  }
  const total = latencias.reduce((a, b) => a + b.ms, 0);
  console.log(`  ${String(total).padStart(5)}ms  TOTAL secuencial\n`);

  const fallos = results.filter(r => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  (${r.note})` : ''}`);
  }
  console.log(`\n${results.length - fallos.length}/${results.length} checks OK`);
  process.exit(fallos.length ? 1 : 0);
})().catch(e => {
  // exit 2 = NO HUBO VEREDICTO, no "todo mal". Acá solo caen excepciones: login, red, Supabase
  // o la service-role key. Ningún check de verdad lanza (todos pasan por `ok()` y se acumulan),
  // así que confundir esto con exit 1 haría que el canary gritara "el panel miente" cada vez que
  // se cae el wifi. A la tercera falsa alarma nadie vuelve a leer el reporte, y ahí se pierde el
  // canary entero. Misma convención que deploy-fresh y gating-score.
  console.error('ERROR (infra, sin veredicto):', e.message);
  process.exit(2);
});

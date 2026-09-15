#!/usr/bin/env node
/**
 * RETENCIÓN DEL DÍA 0 → 1, solo lectura (plan día 0→1, 14-sep-2026). Imprime la línea base y, con
 * `--desde`, la cohorte posterior al deploy, con las MISMAS definiciones. Es un instrumento de
 * medición: no da PASS/FAIL, salvo el freno del cierre del día (ver abajo).
 *
 * DEFINICIONES (las que reprodujeron la base del 14-sep; cambiarlas rompe la comparación):
 *
 *   movimiento manual  `transacciones` con `gmail_msg_id` null y cuya `descripcion_original` no es
 *                      un id de Gmail (16 hex, filas anteriores a la migración 031) ni empieza con
 *                      `Excel:`, `Import webapp:` o `duplicado:`. De usuarios sin `is_test_user` ni
 *                      `cuenta_borrada_at`.
 *   cohorte            personas cuyo PRIMER movimiento manual (gasto O ingreso — así se midió la
 *                      base; con solo gastos salen 38 en vez de 41) cae desde `--desde` (Lima) y
 *                      tiene 48h o más.
 *   franja             hora Lima de ese primer movimiento: 0-14 "mañana", 15-23 "tarde". Siempre
 *                      separada: es el confusor más grande que tiene la medición.
 *   anota 4-36h        otro movimiento manual entre 4h y 36h después del primero. MANDA.
 *   día siguiente      un movimiento manual con fecha Lima = la del primero + 1.
 *   días 0-2           fechas Lima distintas con movimiento en los días 0, 1 y 2.
 *   terminadas         `trial_estado` vencido o convertido, inicio Lima POSTERIOR al 01-ago (el
 *                      01-ago es el backfill de la migración 052) y `trial_vence` antes de hoy.
 *                      Días de uso = fechas Lima con un GASTO manual dentro de la prueba.
 *
 * TRAMPA QUE YA MORDIÓ: `transacciones.created_at` es `timestamp WITHOUT time zone` y guarda la hora
 * UTC. PostgREST lo devuelve sin offset, así que acá se le pega la `Z` antes de convertir a Lima.
 * En SQL es `(created_at at time zone 'UTC') at time zone 'America/Lima'`; con un solo `at time
 * zone` la hora se corre 10h y la franja sale INVERTIDA (pasó armando este mismo probe).
 *
 * Base del 14-sep (n chico: la cifra va con su n, nunca un porcentaje suelto):
 *   anota 4-36h 16/41 (mañana 4/21 · tarde 12/20) · día siguiente 13/41 (la base decía 13/42; mañana
 *   1/21 igual) · pruebas activas sin correo ni web 5/22 · terminadas ≤1 día / 5+ días / pagos
 *   14/24 · 5/24 · 2/24.
 *
 * CANAL (cierre del día, `tipo='cierre_dia_prueba'`): entregados, `131047` (un 131047 significa que
 * el filtro "escribió hoy" está mal), respondidos en 2h, bajas y el `quality_rating` del número.
 * FRENO: si más de 1 de cada 5 destinatarios queda con `recordatorios_activos=false`, o el
 * `quality_rating` no es GREEN, se pone `CIERRE_DIA_PRUEBA=off` en Railway. Ese caso sale exit 1.
 *
 *   node qa-e2e/probe-retencion-dia0.mjs                      # base: desde el 01-ago
 *   node qa-e2e/probe-retencion-dia0.mjs --desde 2026-09-15   # cohorte post-deploy
 *
 * Lecturas: salud del canal ~23-sep · retención ~6-oct · pagos ~28-oct.
 * exit 0 = medido · 1 = el freno salta · 2 = no pudo medir.
 */
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DESDE = arg('--desde') || '2026-08-01';
const HORA = 3600 * 1000;

function envLocal(clave) {
  if (process.env[clave]) return process.env[clave];
  const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  return txt.split('\n').find((l) => l.startsWith(clave + '='))?.split('=').slice(1).join('=').trim();
}

async function credenciales() {
  const token = envLocal('RAILWAY_API_TOKEN');
  if (!token) throw new Error('Falta RAILWAY_API_TOKEN en app/.env');
  const q = `query{variables(projectId:"${RAILWAY.P}",environmentId:"${RAILWAY.E}",serviceId:"${RAILWAY.S}")}`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('Railway API: ' + JSON.stringify(j.errors).slice(0, 200));
  const v = j.data.variables;
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY']) if (!v[k]) throw new Error('Falta ' + k + ' en Railway');
  return v;
}

/** Solo GET. Pagina de a 1000: PostgREST corta ahí sin avisar, y un total sobre una lista capada satura en el límite. */
function db(vars) {
  const base = vars.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const h = { apikey: vars.SUPABASE_KEY, Authorization: 'Bearer ' + vars.SUPABASE_KEY };
  return {
    async todas(tabla, query) {
      const out = [];
      for (let off = 0; ; off += 1000) {
        const r = await fetch(`${base}${tabla}?${query}&order=id.asc&limit=1000&offset=${off}`, { headers: h });
        if (!r.ok) throw new Error(`select ${tabla}: ${r.status} ${(await r.text()).slice(0, 200)}`);
        const j = await r.json();
        out.push(...j);
        if (j.length < 1000) return out;
      }
    },
  };
}

const utc = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
const fechaLima = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const horaLima = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', hour: 'numeric', hourCycle: 'h23' }).format(d));
const masDias = (f, n) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const esManual = (t) => {
  const d = t.descripcion_original || '';
  return !/^[0-9a-f]{16}$/.test(d) && !d.startsWith('Excel:') && !d.startsWith('Import webapp:') && !d.startsWith('duplicado:');
};
const frac = (a, b) => `${a}/${b}`;

let vars, sb;
try {
  vars = await credenciales();
  sb = db(vars);
} catch (e) {
  console.error('No se pudo medir: ' + e.message);
  process.exit(2);
}

try {
  const ahora = new Date();
  const hoy = fechaLima(ahora);
  const usuarios = await sb.todas('usuarios',
    'select=id,is_test_user,cuenta_borrada_at,plan,trial_estado,trial_inicio,trial_vence,email,supabase_auth_id,recordatorios_activos');
  const vivos = new Map(usuarios.filter((u) => u.is_test_user !== true && !u.cuenta_borrada_at).map((u) => [u.id, u]));

  const txs = (await sb.todas('transacciones', 'select=id,usuario_id,tipo,created_at,descripcion_original&gmail_msg_id=is.null&created_at=gte.2026-07-01'))
    .filter((t) => vivos.has(t.usuario_id) && esManual(t))
    .map((t) => ({ ...t, ts: utc(t.created_at) }));
  const porUsuario = new Map();
  for (const t of txs) {
    if (!porUsuario.has(t.usuario_id)) porUsuario.set(t.usuario_id, []);
    porUsuario.get(t.usuario_id).push(t);
  }

  // ─── Cohorte y retención, por franja ─────────────────────────────────────────
  const inicio = new Date(DESDE + 'T00:00:00-05:00');
  const filas = { manana: [], tarde: [] };
  for (const [uid, lista] of porUsuario) {
    // El primero de TODA la historia: alguien que anotó en julio no entra a una cohorte de agosto.
    const primero = lista.reduce((a, b) => (a.ts <= b.ts ? a : b));
    if (primero.ts < inicio || ahora - primero.ts < 48 * HORA) continue;
    const d0 = fechaLima(primero.ts);
    const franja = horaLima(primero.ts) < 15 ? 'manana' : 'tarde';
    const a436 = lista.some((t) => t.ts - primero.ts >= 4 * HORA && t.ts - primero.ts <= 36 * HORA);
    const diaSig = lista.some((t) => fechaLima(t.ts) === masDias(d0, 1));
    const dias02 = new Set(lista.map((t) => fechaLima(t.ts)).filter((f) => f >= d0 && f <= masDias(d0, 2))).size;
    filas[franja].push({ a436, diaSig, dias02, web: !!vivos.get(uid).supabase_auth_id });
  }
  const resumen = (xs) => ({
    n: xs.length,
    a436: xs.filter((x) => x.a436).length,
    diaSig: xs.filter((x) => x.diaSig).length,
    prom: xs.length ? (xs.reduce((s, x) => s + x.dias02, 0) / xs.length).toFixed(2) : '—',
    dos: xs.filter((x) => x.dias02 >= 2).length,
    web: xs.filter((x) => x.web).length,
  });
  console.log(`Retención día 0→1 · cohorte: primer movimiento manual desde ${DESDE} (Lima), 48h o más · medido ${ahora.toLocaleString('es-PE', { timeZone: 'America/Lima' })}`);
  console.log('\nfranja   n   anota 4-36h   día siguiente   días 0-2 (prom · 2+)   con web hoy');
  for (const [nombre, xs] of [['mañana', filas.manana], ['tarde', filas.tarde], ['total', [...filas.manana, ...filas.tarde]]]) {
    const r = resumen(xs);
    console.log(`${nombre.padEnd(7)} ${String(r.n).padStart(3)}   ${frac(r.a436, r.n).padEnd(12)}  ${frac(r.diaSig, r.n).padEnd(14)}  ${r.prom} · ${frac(r.dos, r.n).padEnd(12)}  ${frac(r.web, r.n)}`);
  }

  // ─── Pruebas ─────────────────────────────────────────────────────────────────
  const conDesde = (u) => !arg('--desde') || fechaLima(new Date(u.trial_inicio)) >= DESDE;
  const activas = [...vivos.values()].filter((u) => u.plan === 'premium' && u.trial_estado === 'activo');
  const sinCorreoNiWeb = activas.filter((u) => !u.supabase_auth_id && !(u.email || '').trim());
  const terminadas = [...vivos.values()].filter((u) => ['vencido', 'convertido'].includes(u.trial_estado) && u.trial_inicio &&
    fechaLima(new Date(u.trial_inicio)) > '2026-08-01' && String(u.trial_vence) < hoy && conDesde(u));
  const diasDePrueba = (u) => {
    const ini = fechaLima(new Date(u.trial_inicio));
    const fin = String(u.trial_vence).slice(0, 10);
    return new Set((porUsuario.get(u.id) || []).filter((t) => t.tipo === 'gasto')
      .map((t) => fechaLima(t.ts)).filter((f) => f >= ini && f <= fin)).size;
  };
  const dias = terminadas.map(diasDePrueba);
  console.log(`\npruebas activas sin correo ni web: ${frac(sinCorreoNiWeb.length, activas.length)}`);
  console.log(`pruebas terminadas${arg('--desde') ? ' (inicio desde ' + DESDE + ')' : ''}: ≤1 día ${frac(dias.filter((d) => d <= 1).length, terminadas.length)} · 5+ días ${frac(dias.filter((d) => d >= 5).length, terminadas.length)} · pagos ${frac(terminadas.filter((u) => u.trial_estado === 'convertido').length, terminadas.length)}`);

  // ─── Canal: el cierre del día ────────────────────────────────────────────────
  const entregas = (await sb.todas('notification_deliveries', 'select=id,usuario_id,canal,estado,created_at,delivered_at,failed_at,fail_code,code&tipo=eq.cierre_dia_prueba'))
    .filter((d) => (d.canal || 'whatsapp') === 'whatsapp');
  let freno = false;
  if (entregas.length === 0) {
    console.log('\ncierre del día: sin envíos todavía');
  } else {
    const destinatarios = [...new Set(entregas.map((d) => d.usuario_id))];
    const turnos = [];
    for (let i = 0; i < destinatarios.length; i += 50) {
      const lote = destinatarios.slice(i, i + 50).join(',');
      turnos.push(...await sb.todas('conversaciones', `select=id,usuario_id,created_at&rol=eq.usuario&usuario_id=in.(${lote})`));
    }
    const respondio = (d) => turnos.some((t) => t.usuario_id === d.usuario_id &&
      utc(t.created_at) > utc(d.created_at) && utc(t.created_at) - utc(d.created_at) <= 2 * HORA);
    const c131047 = entregas.filter((d) => d.fail_code === 131047 || d.code === 131047).length;
    const bajas = destinatarios.filter((id) => usuarios.find((u) => u.id === id)?.recordatorios_activos === false).length;
    console.log(`\ncierre del día: ${entregas.length} envíos a ${destinatarios.length} personas`);
    console.log(`  entregados ${frac(entregas.filter((d) => d.delivered_at).length, entregas.length)} · 131047 ${c131047}${c131047 ? '  <-- el filtro "escribió hoy" está mal' : ''} · respondidos en 2h ${frac(entregas.filter(respondio).length, entregas.length)}`);
    console.log(`  bajas (se silenciaron después): ${frac(bajas, destinatarios.length)}`);
    if (bajas * 5 > destinatarios.length) { freno = true; console.log('  FRENO: más de 1 de cada 5 se silenció → CIERRE_DIA_PRUEBA=off'); }
  }
  if (vars.META_ACCESS_TOKEN && vars.META_PHONE_NUMBER_ID) {
    const r = await fetch(`https://graph.facebook.com/v19.0/${vars.META_PHONE_NUMBER_ID}?fields=quality_rating`, {
      headers: { Authorization: 'Bearer ' + vars.META_ACCESS_TOKEN },
    });
    const j = await r.json().catch(() => ({}));
    const q = j.quality_rating || ('ilegible: ' + JSON.stringify(j).slice(0, 120));
    console.log(`quality_rating del número: ${q}`);
    if (j.quality_rating && j.quality_rating !== 'GREEN') { freno = true; console.log('  FRENO: el quality_rating bajó → CIERRE_DIA_PRUEBA=off'); }
  } else {
    console.log('quality_rating del número: sin credenciales de Meta en Railway');
  }
  process.exit(freno ? 1 : 0);
} catch (e) {
  console.error('No se pudo medir: ' + e.message);
  process.exit(2);
}

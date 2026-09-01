import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresión de services/referrals.js — modelo de referidos DOS LADOS (rediseño 2026-07-31).
//
// Invariantes cubiertas:
// 1. El premio al referrer se dispara por CONVERSIÓN Pro pagada del referido, no por uso.
//    procesarConversionProReferido premia 1 mes por conversión, idempotente por-referido
//    (claim atómico convertido_pro false->true).
// 2. ANTI-DOBLE-OTORGAMIENTO. El otorgamiento del mes usa un CAS sobre
//    referidos_meses_otorgados: dos conversiones concurrentes del mismo referrer no pisan
//    su premium_vence (last-write-wins daría 1 mes en vez de 2).
// 3. ESCRITURA SOBRE LECTURA FALLIDA. Un SELECT que falla no se interpreta como "no existe".
// 4. Lado del referido: sembrarDescuentoReferido pone 50% off (7 días) solo a un free sin
//    descuento vigente.

let router;
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in', 'is']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  // .update().select('id') sigue siendo escritura: no pisar q.op.
  chain.select = (cols, opts) => { if (!q.op) q.op = 'select'; if (opts && opts.head) q.head = true; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    return Promise.resolve({ data: null, error: null, count: null, ...(router(q) || {}) }).then(resolve, reject);
  };
  return { chain, q };
}

let ops = [];
const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t).chain.select(...a),
      insert: (p) => { const { chain, q } = makeChain(t, 'insert'); q.payload = p; return chain; },
      update: (p) => { const { chain, q } = makeChain(t, 'update'); q.payload = p; return chain; },
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = {
  // Replica la red de seguridad web-first del helper real: sin numero no hay envio, pero
  // tampoco excepcion (lib/whatsapp.js).
  enviarWhatsapp: vi.fn(async (numero) => (
    numero ? { ok: true, msgId: 'wamid.1' } : { ok: false, skipped: 'no_whatsapp' }
  )),
};
const notifMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };
const adminMock = { notificarAdmin: vi.fn().mockResolvedValue(undefined), notificarErrorAdmin: vi.fn(), ADMIN_NUMBER: '51999' };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', notifMock],
  ['lib/admin-notify.js', adminMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  registrarReferido,
  sembrarDescuentoReferido,
  procesarConversionProReferido,
  obtenerEstadisticasReferidos,
  resumenReferidoParaAdmin,
  mensajeMisReferidos,
} = require('../../services/referrals');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
// Lo que PostgREST devuelve cuando NO HAY FILA, y desde el 01-sep-2026 es `{ data: null,
// error: null }` y no un PGRST116: este archivo dejó de usar `.single()`. La diferencia es la
// razón entera del cambio — con `.single()` la ausencia llega disfrazada de error, así que un
// `if (error)` a secas la convierte en "no pude leer", y el arreglo obliga a comparar códigos
// en cada call-site. Con `maybeSingle` las dos preguntas se separan solas.
//
// **Cambiar esta constante puso dos casos existentes en rojo, y eso es correcto**: describían
// el protocolo viejo, no una regresión.
const SIN_FILA = { data: null, error: null };
/** El PGRST116, para el caso que verifica que ya nadie lo produzca ni lo espere. */
const SIN_FILA_SINGLE = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
const HOY = new Date().toISOString().slice(0, 10);
const escrituras = (tabla) => ops.filter(o => (o.op === 'insert' || o.op === 'update') && (!tabla || o.table === tabla));

beforeEach(() => {
  ops = [];
  logMock.error.mockClear();
  logMock.warn.mockClear();
  waMock.enviarWhatsapp.mockClear();
  notifMock.crearNotificacion.mockClear();
  adminMock.notificarAdmin.mockClear();
});

describe('registrarReferido', () => {
  // Router base: dedup sin fila, referrer con ref_code, referido free sin descuento.
  function routerAlta(extra) {
    return (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA;
      if (q.table === 'usuarios' && q.op === 'select') return { data: { ref_code: 'ABCD1234', plan: 'free', referido_dscto_vence: null } };
      return (extra && extra(q)) || {};
    };
  }

  it('no inserta cuando el SELECT de dedup falla (no puede saber si ya existe)', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return FALLO;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    expect(escrituras()).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('inserta el vínculo y siembra el descuento cuando el referido es nuevo', async () => {
    router = routerAlta();
    await registrarReferido('r1', 'u1');
    const ins = escrituras('referidos');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toEqual({ ref_code: 'ABCD1234', referrer_id: 'r1', referido_id: 'u1' });
    // Y siembra el 50% off al referido.
    const updDscto = escrituras('usuarios').find(o => o.payload.referido_dscto_pct);
    expect(updDscto).toBeTruthy();
    expect(updDscto.payload.referido_dscto_pct).toBe(50);
  });

  it('no loguea error cuando el insert choca con el unique index (ya existía)', async () => {
    router = routerAlta((q) => (q.op === 'insert' ? { data: null, error: { code: '23505', message: 'duplicate key' } } : null));
    await registrarReferido('r1', 'u1');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('loguea y no siembra cuando el insert falla por otro motivo', async () => {
    router = routerAlta((q) => (q.op === 'insert' ? { data: null, error: { code: '23502', message: 'null value' } } : null));
    await registrarReferido('r1', 'u1');
    expect(logMock.error).toHaveBeenCalled();
    expect(escrituras('usuarios')).toHaveLength(0); // no llegó a sembrar el descuento
  });

  /**
   * Las dos causas cortan igual —el referido no queda vinculado— así que lo único observable
   * es el LOG, y por eso es lo que se afirma. Hasta el 01-sep-2026 este archivo resolvía con
   * un TERCER idioma (`.single()` + `error.code !== 'PGRST116'`) y las dos ramas compartían
   * una sola línea: `if (errRef || !referrer)` decía "no se pudo leer el ref_code" también
   * cuando la lectura había ido perfecta y el referrer sencillamente no existe.
   *
   * La diferencia no es cosmética: un referrer ausente es un `ref:` inventado o una cuenta
   * borrada, y no hay nada que arreglar; una lectura caída es infraestructura, y ese referido
   * SÍ debería haberse vinculado. Confundirlas manda a mirar el lugar equivocado.
   */
  it('distingue "el referrer no existe" de "no pude leer al referrer"', async () => {
    const registrar = (respuestaUsuarios) => {
      router = (q) => {
        if (q.table === 'referidos' && q.op === 'select') return { data: null, error: null };
        if (q.table === 'usuarios' && q.op === 'select') return respuestaUsuarios;
        return {};
      };
      return registrarReferido('r1', 'u1');
    };

    // No existe: `maybeSingle` devuelve `{ data: null, error: null }`, que es un hecho, no un
    // fallo. No va como `error` porque no hay nada que reintentar ni que arreglar.
    await registrar({ data: null, error: null });
    expect(escrituras(), 'se vinculó a un referrer inexistente').toHaveLength(0);
    expect(logMock.error, 'una ausencia legítima se reportó como fallo de lectura').not.toHaveBeenCalled();
    expect(JSON.stringify(logMock.warn.mock.calls)).toMatch(/no existe/);

    logMock.error.mockClear();
    logMock.warn.mockClear();
    ops = [];

    // No se pudo leer: sí es un fallo, y el mensaje tiene que decir qué se perdió.
    await registrar(FALLO);
    expect(escrituras()).toHaveLength(0);
    expect(logMock.error, 'una lectura caída se fue muda o como advertencia').toHaveBeenCalled();
    expect(JSON.stringify(logMock.error.mock.calls)).toMatch(/no queda vinculado/);
  });
});

describe('el idioma de las lecturas: maybeSingle, no single', () => {
  /**
   * El guard del ítem 21(c). No es de estilo: los dos idiomas son correctos por separado y el
   * problema es tener los dos, porque el lector tiene que averiguar cuál está viendo antes de
   * poder juzgarlo — y el modo de falla del viejo es silencioso.
   *
   * Se mide sobre el fuente SIN comentarios, porque el docblock de `referrals.js` cita
   * `.single()` y `SIN_FILAS` para explicar por qué se fueron: sin quitarlos, el guard se
   * pondría rojo por su propia documentación (`guard-que-se-mide-contra-su-documentacion`,
   * que en este repo ya lleva cinco).
   */
  const sinComentarios = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const FUENTE = sinComentarios(readFileSync(path.join(projectRoot, 'services/referrals.js'), 'utf8'));

  it('no queda ningun .single() ni ninguna comparacion contra PGRST116', () => {
    // Antivacuidad: si el borrador de comentarios se comiera el archivo entero, las dos
    // aserciones de abajo pasarían sin mirar nada.
    expect(FUENTE).toMatch(/async function registrarReferido/);
    expect((FUENTE.match(/\.maybeSingle\(\)/g) || []).length).toBeGreaterThanOrEqual(4);

    expect(FUENTE, 'volvio un .single(): la ausencia queda disfrazada de error').not.toMatch(/\.single\(\)/);
    expect(FUENTE, 'volvio la comparacion contra PGRST116').not.toMatch(/PGRST116/);
  });

  it('el detector reconoce las dos formas (contraprueba)', () => {
    expect(sinComentarios('await q.single();')).toMatch(/\.single\(\)/);
    // Y uno que vive SOLO en un comentario no se marca: es la evasión al revés, la que ponía
    // el guard rojo por documentar el cambio.
    expect(sinComentarios('// esto usaba .single() antes')).not.toMatch(/\.single\(\)/);
    expect(sinComentarios('/** el .single() viejo */')).not.toMatch(/\.single\(\)/);
    // Y no se come el código de al lado: un comentario de línea no arrastra la línea siguiente.
    expect(sinComentarios('// nota\nawait q.single();')).toMatch(/\.single\(\)/);
  });

  it('PGRST116 ya no aparece porque nadie lo produce (no porque nadie lo mire)', async () => {
    // El control que separa las dos explicaciones: si una lectura devolviera el código viejo,
    // el módulo lo trata como el fallo que es, no como "no existe". Con el idioma anterior
    // este mismo fixture entraba por la puerta de "todavía no está vinculado" y seguía.
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA_SINGLE;
      return { data: { ref_code: 'ABCD1234' } };
    };
    await registrarReferido('r1', 'u1');
    expect(escrituras(), 'un PGRST116 se leyo como "no existe" y se inserto igual').toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('sembrarDescuentoReferido', () => {
  it('siembra 50% off por 7 días a un referido free sin descuento', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'free', referido_dscto_vence: null } } : {};
    await sembrarDescuentoReferido('u1');
    const upd = escrituras('usuarios')[0];
    expect(upd.payload.referido_dscto_pct).toBe(50);
    expect(upd.payload.referido_dscto_vence > HOY).toBe(true);
  });

  it('no siembra si el referido ya es premium (no tiene primer mes)', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'premium' } } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
  });

  it('no reinicia la ventana si el descuento sigue vigente', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'free', referido_dscto_vence: '2099-12-31' } } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
  });

  /**
   * **La única de las cuatro lecturas del archivo que se iba MUDA.** Con `if (error || !u)
   * return;` una caída de Supabase se leía exactamente igual que "este usuario no califica
   * para el descuento", y el síntoma no es un error visible: es un referido que estrena Pro a
   * S/10 en vez de a S/5, sin una línea que explique por qué.
   *
   * El `return` sigue siendo el correcto —sembrar sobre una fila que no se pudo leer pisaría
   * un descuento vigente— así que lo único que cambia es el rastro, y por eso es lo que se
   * afirma. El CONTROL de abajo separa "no calificaba" de "no se pudo preguntar", que es la
   * confusión entera.
   */
  it('una lectura caída deja rastro (no se confunde con "no califica")', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? FALLO : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios'), 'sembró un descuento sobre una fila que no pudo leer').toHaveLength(0);
    expect(logMock.error, 'la caída se fue muda: el referido pierde su 50% sin dejar rastro').toHaveBeenCalled();
    expect(JSON.stringify(logMock.error.mock.calls)).toMatch(/50% off/);
  });

  it('CONTROL: un referido que NO califica no ensucia el log', async () => {
    // Sin esta mitad, un módulo que logueara siempre pasaría el caso de arriba, y el log se
    // llenaría de líneas por el camino normal — que es como se deja de leer un log.
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'premium' } } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('CONTROL: un referido que no existe tampoco (ausencia no es fallo)', async () => {
    // `maybeSingle` devuelve `{ data: null, error: null }`. Es la distinción que el `.single()`
    // de antes escondía detrás de un PGRST116.
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: null, error: null } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('procesarConversionProReferido', () => {
  // DB simulada: fila del referido (claim) + fila del referrer con CAS atómico.
  function montar({ refRow, claim, referrer, updateReferrer } = {}) {
    const estado = {
      referrer: { whatsapp: '51999', nombre: 'Ana Perez', premium_desde: null, premium_vence: null, referidos_meses_otorgados: 0, ...referrer },
    };
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select' && q.head) return { count: 3 }; // conteo de convertidos (para el aviso)
      if (q.table === 'referidos' && q.op === 'select') return { data: refRow === undefined ? { referrer_id: 'r1', convertido_pro: false } : refRow };
      if (q.table === 'referidos' && q.op === 'update') return { data: claim === undefined ? { referrer_id: 'r1' } : claim }; // claim atómico
      if (q.table === 'usuarios' && q.op === 'select') return { data: { ...estado.referrer } };
      if (q.table === 'usuarios' && q.op === 'update') {
        if (updateReferrer) return updateReferrer;
        const c = q.methods.find(m => m[0] === 'eq' && m[1] === 'referidos_meses_otorgados');
        if (c && c[2] !== estado.referrer.referidos_meses_otorgados) return { data: [] }; // CAS perdió
        estado.referrer = { ...estado.referrer, ...q.payload };
        return { data: [{ id: 'r1' }] };
      }
      return {};
    };
    return estado;
  }

  it('premia al referrer con 1 mes cuando el referido convierte a Pro', async () => {
    const db = montar();
    await procesarConversionProReferido('u1');
    expect(db.referrer.plan).toBe('premium');
    expect(db.referrer.referidos_meses_otorgados).toBe(1);
    expect(db.referrer.premium_vence > HOY).toBe(true);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('no premia si el referido ya estaba convertido (fast path, sin UPDATE)', async () => {
    montar({ refRow: { referrer_id: 'r1', convertido_pro: true } });
    await procesarConversionProReferido('u1');
    expect(escrituras()).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('no premia si otra ejecución ya se llevó el claim (convertido_pro)', async () => {
    montar({ claim: null });
    await procesarConversionProReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('no hace nada si el usuario no fue referido por nadie', async () => {
    montar({ refRow: null });
    await procesarConversionProReferido('u1');
    expect(escrituras()).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('con el Pro del referrer vencido la base es hoy, no la fecha vieja', async () => {
    const db = montar({ referrer: { premium_vence: '2020-01-15' } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence > HOY).toBe(true);
  });

  // Un referrer EN TRIAL tiene plan='premium' + premium_vence NULL: sin mirar el trial,
  // el mes se calculaba desde hoy (solapado con la prueba que ya tenía gratis) y —peor—
  // checkTrialExpiry no mira premium_vence, así que el día 15 lo bajaba al muro igual y
  // el mes anunciado por WhatsApp ("Tu Pro ahora vence: X") se evaporaba en silencio.
  it('el referrer EN TRIAL apila el mes sobre trial_vence y queda sellado convertido', async () => {
    const db = montar({ referrer: { plan: 'premium', trial_estado: 'activo', trial_vence: '2099-03-10', premium_vence: null } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence).toBe('2099-04-10'); // trial_vence + 1 mes, no hoy + 1 mes
    expect(db.referrer.trial_estado).toBe('convertido');  // fuera del alcance del downgrade d15
  });

  it('el referrer fuera de trial recibe su mes sin que se le toque trial_estado', async () => {
    const db = montar({ referrer: { plan: 'free', trial_estado: 'vencido', trial_vence: '2020-01-01' } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence > HOY).toBe(true);   // base hoy: el trial vencido no manda
    const upd = escrituras('usuarios')[0];
    expect('trial_estado' in upd.payload).toBe(false);    // 'vencido' se queda como historia
  });

  // El vencimiento se calcula con sumarMeses (no setMonth): un 31 avanza al último día del
  // mes destino, no desborda al siguiente.
  it('apila sobre el vencimiento vigente respetando fin de mes', async () => {
    const db = montar({ referrer: { premium_vence: '2099-01-31' } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence).toBe('2099-02-28');
  });

  it('el UPDATE del otorgamiento lleva el claim sobre el contador leído', async () => {
    montar();
    await procesarConversionProReferido('u1');
    const upd = escrituras('usuarios')[0];
    expect(upd.methods).toContainEqual(['eq', 'referidos_meses_otorgados', 0]);
    expect(upd.payload.referidos_meses_otorgados).toBe(1);
  });

  it('dos referidos distintos que convierten dan 2 meses (CAS serializa)', async () => {
    const db = montar();
    await Promise.all([procesarConversionProReferido('u1'), procesarConversionProReferido('u2')]);
    expect(db.referrer.referidos_meses_otorgados).toBe(2);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(2);
  });

  it('no avisa por WhatsApp si no puede leer al referrer', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: false } };
      if (q.table === 'referidos' && q.op === 'update') return { data: { referrer_id: 'r1' } };
      if (q.table === 'usuarios' && q.op === 'select') return FALLO;
      return {};
    };
    await procesarConversionProReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('no avisa por ningún canal si el UPDATE del otorgamiento falla', async () => {
    montar({ updateReferrer: FALLO });
    await procesarConversionProReferido('u1');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(notifMock.crearNotificacion).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el referrer web-only (sin whatsapp) recibe el mes Y SE ENTERA por la campana', async () => {
    const db = montar({ referrer: { whatsapp: null } });
    await procesarConversionProReferido('u1');

    expect(db.referrer.plan).toBe('premium');
    // Antes esto cortaba con `if (!referrer.whatsapp) return` y el comentario prometía que
    // "verá el mes reflejado en la webapp" — pero eso era un premium_vence que cambiaba
    // solo, sin una línea que dijera por qué. Es un beneficio ya otorgado e irreversible:
    // el peor candidato para depender de la ventana de 24h de Meta.
    expect(notifMock.crearNotificacion).toHaveBeenCalledTimes(1);
    const [usuarioId, , titulo] = notifMock.crearNotificacion.mock.calls[0];
    expect(usuarioId).toBe('r1');
    expect(titulo).toBe('Ganaste 1 mes de Neto Pro gratis');
  });

  it('el referrer con whatsapp recibe los dos canales', async () => {
    montar({});
    await procesarConversionProReferido('u1');

    const premio = waMock.enviarWhatsapp.mock.calls.find((c) => c[2]?.tipo === 'referido_premio');
    expect(premio).toBeDefined();
    expect(notifMock.crearNotificacion.mock.calls.map((c) => c[0])).toContain('r1');
  });
});

// El claim (`convertido_pro`) se consume ANTES de otorgar el mes, y son dos tablas
// sin transacción entre medio. Si algo falla en el hueco, el premio se perdía para
// siempre: el reintento salía por el fast path `if (convertido_pro) return`, y el
// aviso al referrer también estaba después del grant, así que nadie se enteraba.
//
// `premio_otorgado_at` (migración 062) separa "el referido pagó" de "al referrer se
// le acreditó". Estos tests fijan las tres salidas.
describe('procesarConversionProReferido: el premio no se pierde en silencio', () => {
  function montarBase(overrides) {
    const estado = { referrer: { whatsapp: '51999', nombre: 'Ana', premium_desde: null, premium_vence: null, referidos_meses_otorgados: 0 } };
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select' && q.head) return { count: 1 };
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: false } };
      if (q.table === 'referidos' && q.op === 'update') {
        const forzado = overrides && overrides.updReferidos && overrides.updReferidos(q);
        if (forzado) return forzado;
        // El rollback usa `.select()` sin maybeSingle: supabase devuelve un ARRAY,
        // y de ahí sale si tocó alguna fila. El claim usa maybeSingle (objeto).
        if (q.payload.convertido_pro === false) return { data: [{ referido_id: 'u1' }] };
        return { data: { referrer_id: 'r1' } };
      }
      if (q.table === 'usuarios' && q.op === 'select') return (overrides && overrides.selUsuario) || { data: { ...estado.referrer } };
      if (q.table === 'usuarios' && q.op === 'update') {
        if (overrides && overrides.updUsuario) return overrides.updUsuario;
        estado.referrer = { ...estado.referrer, ...q.payload };
        return { data: [{ id: 'r1' }] };
      }
      return {};
    };
    return estado;
  }
  /** Los UPDATE sobre `referidos` posteriores al claim. */
  const updsReferidos = () => escrituras('referidos').filter((o) => o.op === 'update');

  it('al otorgar el mes SELLA premio_otorgado_at (sin sello, un premio pagado parece pendiente)', async () => {
    montarBase();
    await procesarConversionProReferido('u1');
    const sello = updsReferidos().find((o) => o.payload.premio_otorgado_at);
    expect(sello, 'no se selló premio_otorgado_at tras acreditar el mes').toBeTruthy();
    expect(sello.methods).toContainEqual(['eq', 'referido_id', 'u1']);
    expect(adminMock.notificarAdmin).not.toHaveBeenCalled();   // camino feliz: nada que gritar
  });

  it('si NO se puede leer al referrer, devuelve el claim y avisa (todavía no se escribió nada)', async () => {
    montarBase({ selUsuario: FALLO });
    await procesarConversionProReferido('u1');

    // El claim vuelve a false: sin esto, un reintento sale por el fast path y el mes
    // se pierde para siempre.
    const rollback = updsReferidos().find((o) => o.payload.convertido_pro === false);
    expect(rollback, 'el claim quedó consumido: el premio ya no se puede reintentar').toBeTruthy();
    expect(rollback.payload.convertido_pro_at).toBeNull();
    // Y no desarma un premio ya otorgado.
    expect(rollback.methods).toContainEqual(['is', 'premio_otorgado_at', null]);
    // Devolver el claim no alcanza: nadie re-dispara una aprobación de pago sola.
    expect(adminMock.notificarAdmin).toHaveBeenCalledTimes(1);
    const aviso = adminMock.notificarAdmin.mock.calls[0][0];
    expect(aviso).toContain('El claim se devolvió');
    // Y el aviso trae el SQL, no una instrucción que no funciona: re-aprobar el pago
    // NO vuelve a entrar acá (reclamarPagoPendiente exige estado='pendiente') y el
    // botón de activar Pro marcaría al referrer como pagador.
    expect(aviso).toContain('update usuarios set');
    expect(aviso).toContain('referidos_meses_otorgados');
    expect(escrituras('usuarios')).toHaveLength(0);
  });

  it('no afirma que devolvió el claim cuando el UPDATE no tocó ninguna fila', async () => {
    // supabase-js devuelve `{data:null,error:null}` tanto si actualizó 1 fila como
    // si actualizó 0. Sin `.select()`, el aviso decía "el claim se devolvió" sobre
    // un rollback que nunca ocurrió, y el admin seguía una instrucción falsa.
    montarBase({ selUsuario: FALLO, updReferidos: (q) => (q.payload.convertido_pro === false ? { data: [] } : null) });
    await procesarConversionProReferido('u1');
    expect(adminMock.notificarAdmin).toHaveBeenCalledTimes(1);
    expect(adminMock.notificarAdmin.mock.calls[0][0]).toContain('NO se pudo devolver el claim');
  });

  it('si falla el UPDATE del referrer NO devuelve el claim (podría pagar dos meses) pero avisa', async () => {
    montarBase({ updUsuario: FALLO });
    await procesarConversionProReferido('u1');

    // Acá no se sabe si el UPDATE entró. Revertir arriesga otorgar dos veces.
    expect(updsReferidos().some((o) => o.payload.convertido_pro === false)).toBe(false);
    expect(adminMock.notificarAdmin).toHaveBeenCalledTimes(1);
    const texto = adminMock.notificarAdmin.mock.calls[0][0];
    expect(texto).toContain('r1');   // referrer
    expect(texto).toContain('u1');   // referido
    expect(texto).toContain('premio_otorgado_at is null');   // la consulta para encontrarlo
  });

  it('si el mes se acredita pero falla el sello, avisa y NO reintenta el grant', async () => {
    // El referrer ya tiene su mes: reintentar sería pagarle dos.
    let visto = 0;
    const db = montarBase({
      updReferidos: (q) => (q.payload.premio_otorgado_at ? (visto++, FALLO) : { data: { referrer_id: 'r1' } }),
    });
    await procesarConversionProReferido('u1');

    expect(db.referrer.referidos_meses_otorgados).toBe(1);   // el mes entró
    expect(visto).toBe(1);                                   // el sello se intentó una vez
    expect(adminMock.notificarAdmin).toHaveBeenCalledTimes(1);
    expect(adminMock.notificarAdmin.mock.calls[0][0]).toContain('SÍ se acreditó');
    expect(waMock.enviarWhatsapp).toHaveBeenCalled();        // al referrer igual se le avisa su mes
  });

  it('si el CAS se agota tras 6 vueltas, tampoco se pierde en silencio', async () => {
    // Rama que ninguna prueba tocaba: 6 conversiones concurrentes del mismo referrer
    // ganándole al CAS. Se sale del loop sin premiar y antes esto era un log.warn.
    montarBase({ updUsuario: { data: [] } });
    await procesarConversionProReferido('u1');
    expect(adminMock.notificarAdmin).toHaveBeenCalledTimes(1);
    expect(adminMock.notificarAdmin.mock.calls[0][0]).toContain('CAS');
    // No se devuelve el claim: seis intentos de UPDATE salieron, no se sabe si alguno entró.
    expect(updsReferidos().some((o) => o.payload.convertido_pro === false)).toBe(false);
  });

  it('si el propio aviso al admin revienta, no se lleva puesta la conversión', async () => {
    // `notificarAdmin` pega a Telegram y a Meta. Que falle no puede propagar hacia
    // arriba: quien llama es `activarPro`, o sea la aprobación de un pago.
    adminMock.notificarAdmin.mockRejectedValueOnce(new Error('telegram caído'));
    montarBase({ updUsuario: FALLO });
    await expect(procesarConversionProReferido('u1')).resolves.toBeUndefined();
    // El rastro que sí queda cuando el aviso no llega.
    expect(logMock.error.mock.calls.some((c) => c[0] && c[0].tag === 'REFERIDO_PENDIENTE')).toBe(true);
  });

  it('el aviso al admin no depende del cooldown compartido de notificarErrorAdmin', async () => {
    // notificarErrorAdmin tiene 5 min de cooldown COMPARTIDO con todos los errores
    // del backend: un pico de errores no relacionados se comería justo este aviso.
    montarBase({ updUsuario: FALLO });
    await procesarConversionProReferido('u1');
    expect(adminMock.notificarErrorAdmin).not.toHaveBeenCalled();
    expect(adminMock.notificarAdmin).toHaveBeenCalled();
  });
});

describe('obtenerEstadisticasReferidos', () => {
  it('cuenta invitados (aún no Pro), referidos Pro y meses', async () => {
    router = (q) => (q.table === 'referidos' && q.op === 'select')
      ? { data: [
          { convertido_pro: true, premio_otorgado_at: '2026-08-01T00:00:00Z' },
          { convertido_pro: false, premio_otorgado_at: null },
          { convertido_pro: true, premio_otorgado_at: '2026-08-02T00:00:00Z' },
        ] }
      : {};
    const s = await obtenerEstadisticasReferidos('r1');
    expect(s).toEqual({ invitados: 1, referidosPro: 2, meses: 2 });
  });

  it('los meses cuentan lo ACREDITADO, no lo convertido (no le promete un mes que no tiene)', async () => {
    // El hueco de B2: convertido_pro=true con premio_otorgado_at=null es un premio
    // debido y no pagado. Contarlo como mes le muestra al referrer un beneficio que
    // su fila de `usuarios` no tiene.
    router = (q) => (q.table === 'referidos' && q.op === 'select')
      ? { data: [
          { convertido_pro: true, premio_otorgado_at: '2026-08-01T00:00:00Z' },
          { convertido_pro: true, premio_otorgado_at: null },
        ] }
      : {};
    const s = await obtenerEstadisticasReferidos('r1');
    expect(s).toEqual({ invitados: 0, referidosPro: 2, meses: 1 });
  });

  it('devuelve ceros si la lectura falla (no inventa)', async () => {
    router = (q) => (q.table === 'referidos' && q.op === 'select') ? FALLO : {};
    const s = await obtenerEstadisticasReferidos('r1');
    expect(s).toEqual({ invitados: 0, referidosPro: 0, meses: 0 });
  });
});

describe('resumenReferidoParaAdmin', () => {
  it('reporta el descuento vigente y el nombre del referrer', async () => {
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') {
        const idEq = q.methods.find(m => m[0] === 'eq' && m[1] === 'id');
        if (idEq && idEq[2] === 'u1') return { data: { referido_dscto_pct: 50, referido_dscto_vence: '2099-01-01' } };
        return { data: { nombre: 'Ana Perez' } };
      }
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: false, premio_otorgado_at: null } };
      return {};
    };
    const r = await resumenReferidoParaAdmin('u1');
    expect(r.descuentoPct).toBe(50);
    expect(r.referrerNombre).toBe('Ana Perez');
    expect(r.yaPremiado).toBe(false);
  });

  it('un premio DEBIDO y no otorgado no se reporta como "ya premiado"', async () => {
    // La pantalla donde el admin decide es justo donde no puede mentir: con
    // convertido_pro=true y premio_otorgado_at=null, el mes NO se acreditó.
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') return { data: { nombre: 'Ana Perez' } };
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: true, premio_otorgado_at: null } };
      return {};
    };
    expect((await resumenReferidoParaAdmin('u1')).yaPremiado).toBe(false);

    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') return { data: { nombre: 'Ana Perez' } };
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: true, premio_otorgado_at: '2026-08-01T00:00:00Z' } };
      return {};
    };
    expect((await resumenReferidoParaAdmin('u1')).yaPremiado).toBe(true);
  });

  it('ignora un descuento ya vencido', async () => {
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') return { data: { referido_dscto_pct: 50, referido_dscto_vence: '2000-01-01' } };
      if (q.table === 'referidos' && q.op === 'select') return { data: null };
      return {};
    };
    const r = await resumenReferidoParaAdmin('u1');
    expect(r.descuentoPct).toBe(0);
    expect(r.referrerNombre).toBe(null);
  });
});

describe('mensajeMisReferidos', () => {
  it('arma el mensaje con el link a la mini-landing y el progreso dos-lados', () => {
    const m = mensajeMisReferidos('ABC123', { invitados: 2, referidosPro: 1, meses: 1 });
    expect(m).toContain('neto.pe/r/ABC123');
    expect(m).toContain('1 mes gratis');
    expect(m).toContain('Invitados: 2');
    expect(m).toContain('Referidos Pro: 1');
    expect(m).toContain('Meses ganados: 1');
  });
});

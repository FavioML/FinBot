import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import path from 'path';

/**
 * LA OTRA MITAD DEL ÍTEM 20: el COMPORTAMIENTO de cada sitio de `lib/support-tickets.js`
 * cuando la lectura se cae.
 *
 * `tests/lib/lecturas-de-lib.test.js` mira la FORMA —que el `{ error }` se destructure— y eso
 * no alcanza, medido: el parser compartido **no exige que el error se CONSULTE**. Un
 * `const { data, error } = await supabase…` que nunca mira `error` sale limpio del guard. La
 * mutación que lo demuestra acá es la misma que el ítem 19 usó en `/panel`: **quitarle a
 * `listarTicketsPendientes` su `if (error)` dejando el destructuring deja el guard de forma
 * VERDE y mata este archivo.**
 *
 * Cada caso viene con su CONTROL, porque el modo de fallo que este ítem persigue no es "no
 * contesta" sino "contesta lo mismo que cuando de verdad no hay nada". Un test que sólo
 * afirmara el mensaje de error pasaría igual si los dos mensajes fueran idénticos, que es
 * exactamente el bug.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE ARCHIVO EXISTE Y NO ES CEREMONIA
 *
 * Tres de los sitios tenían una política de fallo ESCRITA que era inalcanzable, porque
 * supabase-js no lanza y el `catch` que la implementaba nunca corría:
 *
 *   · `estadoVentana` declaraba *"ante la duda, se ASUME ABIERTA"* (o sea: no mandar correo).
 *     Con la lectura muda, una caída de `conversaciones` daba `abierta: FALSE` y **mandaba** el
 *     correo. La política y el efecto real estaban al revés, a dos líneas de distancia.
 *   · `abrirSesion` estaba envuelta en `moderacion.js` por un `catch` que contesta *"se me trabó
 *     abriendo la conversación"*. Un insert rechazado lo esquivaba y se anunciaba el modo
 *     soporte igual.
 *   · `cerrarSesion` le mandaba al usuario un WhatsApp diciéndole que su conversación estaba
 *     cerrada mientras el UPDATE había sido rechazado.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn(), META_ERR_FUERA_VENTANA: 131047 };
const notifyMock = {
  notificarUsuario: vi.fn(async () => ({ ok: true })),
  CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_whatsapp', SOLO_IN_APP: 'solo_in_app' },
};

/**
 * El doble de supabase, con las respuestas indexadas por **(tabla, operación)**.
 *
 * La cola posicional del harness vecino (`support-hilo`) alcanza cuando el flujo tiene tres
 * queries; acá `responderTicket` encadena hasta seis sobre tres tablas, y una cola por posición
 * convierte cualquier cambio de orden en un test que mide otra cosa sin ponerse rojo. Con la
 * clave `tabla:op`, cada caso siembra exactamente el sitio que quiere tirar y los demás
 * responden vacío.
 */
const db = { resp: {}, inserts: [], updates: [] };

function cadena(tabla) {
  const c = {};
  let op = 'select';
  const resultado = () => {
    const k = tabla + ':' + op;
    const v = db.resp[k];
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    if (v) return v;
    return { data: null, error: null };
  };
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
  c.insert = (fila) => { op = 'insert'; db.inserts.push({ tabla, fila }); return c; };
  c.update = (patch) => { op = 'update'; db.updates.push({ tabla, patch }); return c; };
  c.maybeSingle = async () => resultado();
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notify-user.js', notifyMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  responderTicket, listarTicketsPendientes, obtenerSesionAbierta, abrirSesion, cerrarSesion,
} = require('../../lib/support-tickets');

/** El error que devuelve supabase-js cuando la consulta no se pudo hacer. NO se lanza. */
const CAIDA = { data: null, error: { message: 'connection terminated unexpectedly' } };
/** Y el otro estado, el que hoy es indistinguible del anterior: la consulta salió y no hay filas. */
const VACIO = { data: null, error: null };
const VACIO_LISTA = { data: [], error: null };

beforeEach(() => {
  db.resp = {};
  db.inserts = [];
  db.updates = [];
  for (const f of Object.values(logMock)) f.mockReset();
  waMock.enviarWhatsapp.mockReset();
  waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
  notifyMock.notificarUsuario.mockReset();
  notifyMock.notificarUsuario.mockResolvedValue({ ok: true });
});

/** El destinatario de correo que `responderTicket` le pasó al chokepoint, o null. */
const correoQueSalio = () => {
  const args = notifyMock.notificarUsuario.mock.calls[0]?.[0];
  return args?.email?.to ?? null;
};

describe('estadoVentana · la política declarada era inalcanzable, y el efecto era el opuesto', () => {
  // La forma de sembrar: el ticket se lee bien, el WhatsApp sale bien, y lo único que se tira
  // es una de las dos lecturas de la ventana.
  const responderConVentana = ({ usuarios, conversaciones }) => {
    db.resp['tickets_soporte:select'] = [{ data: { whatsapp: '51999', usuario_id: 'u1' }, error: null }];
    db.resp['usuarios:select'] = usuarios;
    db.resp['conversaciones:select'] = conversaciones;
    return responderTicket({ ticketId: 't1', mensaje: 'ya lo revisamos' });
  };

  it('CONTROL: con la ventana de Meta cerrada de verdad, el correo SÍ sale', async () => {
    // Sin este control, el caso de abajo pasaría igual si el correo no saliera nunca.
    const r = await responderConVentana({
      usuarios: { data: { email: 'ana@example.com', recordatorios_activos: true }, error: null },
      // Cero mensajes entrantes → la ventana está cerrada → el correo es el canal que queda.
      conversaciones: VACIO_LISTA,
    });

    expect(r.ok).toBe(true);
    expect(correoQueSalio()).toBe('ana@example.com');
  });

  it('con `conversaciones` caída NO manda correo: la duda ya no decide por el lado caro', async () => {
    // El bug: `conv` llegaba null, `ultimo` quedaba en 0 y `abierta` salía FALSE, o sea que una
    // caída de la base se leía como "la ventana está cerrada, mandale el correo" — mientras el
    // comentario de dos líneas más abajo prometía asumir lo contrario.
    await responderConVentana({
      usuarios: { data: { email: 'ana@example.com', recordatorios_activos: true }, error: null },
      conversaciones: CAIDA,
    });

    expect(correoQueSalio(), 'una lectura caída volvió a disparar el correo').toBe(null);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('con `usuarios` caída tampoco manda correo, y AHORA queda registrado', async () => {
    // **Ojo con este caso: la mitad del correo no discrimina, y va dicho.** Contra el código
    // anterior también salía `null` — pero por otro motivo (con `usuarios` caída no había
    // dirección que usar, así que el correo era imposible, no evitado). Es la clase
    // `negativo-que-rechaza-por-otra-condicion`: un verde que no prueba lo que parece.
    //
    // Lo que SÍ separa las dos versiones es el `warn`: antes, una lectura caída acá no dejaba
    // rastro de ninguna clase. La aserción del correo se queda igual, como control de que el
    // arreglo no apagó de más.
    const r = await responderConVentana({ usuarios: CAIDA, conversaciones: VACIO_LISTA });

    expect(logMock.warn, 'la lectura caída volvió a no dejar rastro').toHaveBeenCalled();
    expect(correoQueSalio()).toBe(null);
    // El aviso in-app NO depende de la ventana: si la respuesta se entregó, el cartel sale.
    // Lo que se apaga es únicamente el canal excepcional.
    expect(notifyMock.notificarUsuario, 'la campana no salió: se apagó de más').toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });
});

describe('responderTicket · "no existe" y "no pude leer" dejaron de ser el mismo mensaje', () => {
  it('CONTROL: el ticket no existe → "No encontré el número del ticket"', async () => {
    db.resp['tickets_soporte:select'] = [VACIO];

    const r = await responderTicket({ ticketId: 't-fantasma', mensaje: 'hola' });

    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No encontré el número del ticket/);
    expect(waMock.enviarWhatsapp, 'se intentó enviar sin número').not.toHaveBeenCalled();
  });

  it('la lectura del ticket se cae → lo DICE, y no manda a buscar una fila que sí está', async () => {
    db.resp['tickets_soporte:select'] = [CAIDA];

    const r = await responderTicket({ ticketId: 't1', mensaje: 'hola' });

    expect(r.ok).toBe(false);
    expect(r.msg, 'sigue contestando lo mismo que cuando el ticket no existe').not.toMatch(/No encontré el número del ticket/);
    expect(r.msg).toMatch(/no pude leer el ticket/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('CONTROL: sin ticket pendiente que marcar, el ✅ sale limpio', async () => {
    db.resp['tickets_soporte:select'] = [VACIO_LISTA];

    const r = await responderTicket({ numDestino: '51999', mensaje: 'listo' });

    expect(r.ok).toBe(true);
    expect(r.msg).toBe('✅ Respuesta enviada a 51999.');
  });

  it('la búsqueda del pendiente se cae → el ✅ ya no significa "quedó registrada"', async () => {
    // El mensaje YA salió y cortar no lo desenvía; lo que estaba mal era el retorno. Sin el
    // aviso, el ticket sigue visible como pendiente y el admin contesta dos veces.
    //
    // **El sufijo dice que no pudo VERIFICAR, y no que quedó pendiente.** Lo segundo es falso
    // justo en el camino de `contactarUsuario`, que entra SIEMPRE por acá —nunca pasa
    // `ticketId`— porque su destinatario no tiene ticket: viene de `nlp_errors`, y la
    // conversación la abre y la registra esa misma función unas líneas después. Afirmando de
    // más, el sufijo provocaba la segunda respuesta que venía a evitar.
    db.resp['tickets_soporte:select'] = [CAIDA];

    const r = await responderTicket({ numDestino: '51999', mensaje: 'listo' });

    expect(r.ok, 'la respuesta se entregó: el retorno tiene que seguir diciendo que salió').toBe(true);
    expect(r.msg, 'afirma un ticket pendiente que en el camino de contactarUsuario no existe').not.toMatch(/sigue como pendiente/);
    expect(r.msg).toMatch(/no pude verificar/i);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('listarTicketsPendientes · "todo tranquilo" era también la cara de una caída', () => {
  it('CONTROL: sin tickets pendientes, el mensaje de calma', async () => {
    db.resp['tickets_soporte:select'] = VACIO_LISTA;
    expect(await listarTicketsPendientes()).toMatch(/No hay tickets pendientes/);
  });

  it('con la tabla caída dice que no pudo leer, no que no hay nada', async () => {
    // **Ésta es la mutación que separa los dos guards.** Quitarle a esta función su
    // `if (error)` y dejar el destructuring: `lecturas-de-lib.test.js` sigue VERDE y este caso
    // muere. El guard de forma no puede ver esto, y por eso los dos archivos hacen falta.
    db.resp['tickets_soporte:select'] = CAIDA;

    const msg = await listarTicketsPendientes();

    expect(msg).not.toMatch(/No hay tickets pendientes/);
    expect(msg).toMatch(/no pude leer los tickets/i);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('obtenerSesionAbierta · falla ABIERTO, pero deja de fallar en silencio', () => {
  it('CONTROL: sin sesión abierta devuelve null y no grita', async () => {
    db.resp['tickets_soporte:select'] = VACIO_LISTA;

    expect(await obtenerSesionAbierta('u1')).toBe(null);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('con la tabla caída devuelve null (para no romperle el bot a todos) pero LOGUEA', async () => {
    // El retorno es a propósito el mismo: esta lectura corre en el arranque de cada mensaje
    // entrante dentro de un `Promise.all`, y propagar el error le rompería el registro de
    // gastos a todo el mundo. Lo que cambió es que ahora se sabe que pasó — sin el log, un
    // usuario en modo soporte al que el bot le contesta sobre gastos no deja ningún rastro.
    db.resp['tickets_soporte:select'] = CAIDA;

    expect(await obtenerSesionAbierta('u1')).toBe(null);
    expect(logMock.error).toHaveBeenCalledOnce();
  });
});

describe('abrirSesion · el modo soporte no se anuncia si no se abrió', () => {
  it('CONTROL: el insert entra → viene el ticket con su id', async () => {
    db.resp['tickets_soporte:select'] = VACIO_LISTA;          // no hay sesión previa
    db.resp['tickets_soporte:insert'] = { data: { id: 't-nuevo' }, error: null };

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r).toEqual({ yaAbierta: false, ticket: { id: 't-nuevo' } });
  });

  it('el insert es rechazado → ticket null y queda registrado', async () => {
    // Sin esto, `/soporte` contestaba "*Modo soporte activado*" sobre una sesión que no
    // existe: lo que la persona escribiera después no encontraría sesión y se lo llevaría el
    // bot. Lo que esos call-sites ANUNCIAN se mide aparte, porque es otro perímetro:
    // `tests/handlers/anuncio-de-soporte.test.js` (/soporte y /salir) y el caso
    // `hablar_con_humano` de `tests/handlers/escrituras-de-intents.test.js` (la ruta NLP).
    db.resp['tickets_soporte:select'] = VACIO_LISTA;
    db.resp['tickets_soporte:insert'] = CAIDA;

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r.ticket).toBe(null);
    expect(r.yaAbierta).toBe(false);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('cerrarSesion · las dos mentiras, la del admin y la del usuario', () => {
  it('CONTROL: no hay conversación abierta → lo dice, y no avisa a nadie', async () => {
    db.resp['tickets_soporte:select'] = VACIO_LISTA;

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true });

    expect(r.closed).toBe(0);
    expect(r.msg).toMatch(/No hay conversación de soporte abierta/);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('la lectura se cae → no lo confunde con "no había ninguna"', async () => {
    db.resp['tickets_soporte:select'] = CAIDA;

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true });

    expect(r.ok).toBe(false);
    expect(r.msg).not.toMatch(/No hay conversación de soporte abierta/);
    expect(r.msg).toMatch(/no pude leer/i);
  });

  it('CONTROL: el cierre entra → ✅ y el usuario recibe su aviso', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999' }], error: null };
    db.resp['tickets_soporte:update'] = { data: null, error: null };

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true });

    expect(r.closed).toBe(1);
    expect(r.msg).toMatch(/cerrada/);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
  });

  it('el UPDATE es rechazado en /cerrar → NO se le dice al usuario que su conversación se cerró', async () => {
    // La peor de las dos: el admin leía "✅ cerrada" y a la persona le llegaba un WhatsApp
    // afirmándolo, mientras sus mensajes siguientes seguían yendo al admin.
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999' }], error: null };
    db.resp['tickets_soporte:update'] = CAIDA;

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true });

    expect(r.ok).toBe(false);
    expect(r.closed).toBe(0);
    expect(r.msg).toMatch(/no pude cerrar/i);
    expect(waMock.enviarWhatsapp, 'se le prometió al usuario un cierre que no ocurrió').not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el UPDATE es rechazado en el AUTOCIERRE → el aviso SÍ sale, porque el ruteo ya cambió', async () => {
    // **El caso que la primera versión del arreglo rompió, y no lo veía ningún test del repo**
    // (`grep -rn "porInactividad" tests/` daba cero antes de éste).
    //
    // Los dos llamadores deciden en momentos distintos: `/cerrar` puede reintentar, pero
    // `obtenerSesionAbierta` devuelve `null` pase lo que pase con el UPDATE, así que el mensaje
    // que disparó el vencimiento YA se lo lleva el bot. Callar acá deja a la persona
    // preguntándole algo al equipo y recibiendo a Neto hablándole de gastos, que es el
    // desenlace que su propio comentario llama "peor que el silencio".
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999' }], error: null };
    db.resp['tickets_soporte:update'] = CAIDA;

    const r = await cerrarSesion({ usuarioId: 'u1', avisarUsuario: true, porInactividad: true });

    expect(waMock.enviarWhatsapp, 'el usuario quedó sin aviso con el bot ya contestándole').toHaveBeenCalledOnce();
    expect(String(waMock.enviarWhatsapp.mock.calls[0][1])).toMatch(/sin actividad|asistente/i);
    // Y el retorno sigue diciendo la verdad: NO se cerró.
    expect(r.ok).toBe(false);
    expect(r.closed).toBe(0);
  });

  it('CONTROL: el autocierre que SÍ entra avisa una sola vez y reporta el cierre', async () => {
    // Separa "avisa siempre" de "avisa cuando corresponde": sin esto, la aserción de arriba
    // pasaría igual con la guarda borrada del todo.
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999' }], error: null };
    db.resp['tickets_soporte:update'] = { data: null, error: null };

    const r = await cerrarSesion({ usuarioId: 'u1', avisarUsuario: true, porInactividad: true });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
    expect(r.closed).toBe(1);
    expect(r.ok, '`ok` va en las seis salidas: si falta en el éxito, `if (r.ok)` es falso ahí').toBe(true);
  });

  it('el aviso al usuario deja fila en el ledger: sin `tipo`, `registrarEntrega` no escribe nada', () => {
    // No es telemetría de adorno. El comentario del arreglo acepta que el aviso del autocierre
    // se repita mientras el UPDATE falle; sin fila, "se repitió una vez" y "se repitió
    // cuatrocientas" se ven igual, y ningún dedup futuro tiene qué leer. El repo ya pagó esa
    // forma con 12 avisos de onboarding idénticos a la misma persona.
    //
    // Se afirma sobre la FUENTE porque el doble de `enviarWhatsapp` de este archivo no ejecuta
    // `registrarEntrega`: mockearlo para "verificar" que se llama sería comprobar el mock.
    const src = readFileSync(path.join(projectRoot, 'lib/support-tickets.js'), 'utf-8');
    const llamada = src.slice(src.indexOf('const aviso = porInactividad'));
    const envio = llamada.slice(0, llamada.indexOf('return {'));
    expect(envio, 'el aviso de cierre volvió a salir sin `tipo`: no deja fila en notification_deliveries')
      .toMatch(/enviarWhatsapp\([^)]*\{[^}]*tipo:/s);
  });
});


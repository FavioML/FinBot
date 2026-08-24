import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import Module from 'module';

/**
 * 9A · `handlers/admin-commands.js` — un pago aprobado que no activaba Pro.
 *
 * El claim de `reclamarPagoPendiente` es atómico y **no repetible**: cuando la fila pasa a
 * `aprobado`, el reintento del botón contesta "Ya procesado (aprobado)" y no vuelve a activar
 * nada. La lectura del usuario venía DESPUÉS del claim y descartaba su `error`, así que una
 * lectura caída se leía como "Usuario no encontrado" con el pago ya aprobado y `activarPro` sin
 * correr: la persona pagaba y se quedaba en Free, sin ningún log que lo delatara.
 *
 * **Lo que estos tests fijan no es "se lee el error", es el ORDEN.** Leer el error donde estaba
 * habría cambiado la mentira por un error honesto y el pago quedaba trabado igual. Por eso la
 * aserción central de cada caso de fallo es que el CLAIM NO OCURRIÓ — o sea que la solicitud
 * sigue pendiente y el botón se puede volver a tocar.
 *
 * El fake de `admin-callback.test.js` contesta la misma fila para cualquier tabla, así que no
 * puede distinguir "falla la lectura de pagos" de "falla la de usuarios". Este es consciente
 * de la tabla, que es justamente lo que hay que discriminar acá.
 */

const require = createRequire(import.meta.url);

const state = {
  filas: {},      // tabla -> fila que devuelve un select
  fallos: {},     // 'tabla:verbo' -> mensaje de error
  llamadas: [],   // { tabla, verbo }
};

// `fallos['tabla:verbo']` acepta un string o un ARRAY indexado por llamada. Hace falta para el
// caso de perder el claim: `pagos` se lee DOS veces (la resolucion previa y la relectura), y sin
// separarlas la guarda de la segunda es inalcanzable desde un test.
const nth = {};
function fallo(clave) {
  const f = state.fallos[clave];
  if (f === undefined) return null;
  if (!Array.isArray(f)) return f;
  const i = (nth[clave] = (nth[clave] || 0) + 1) - 1;
  return f[i] || null;
}

function builder(tabla) {
  let verbo = 'select';
  const filtros = [];
  const b = new Proxy({}, {
    get(_t, p) {
      if (p === 'update' || p === 'insert' || p === 'delete' || p === 'upsert') {
        return () => { if (verbo === 'select') verbo = p; return b; };
      }
      // Los filtros se REGISTRAN. Antes la semántica condicional estaba HARDCODEADA acá
      // (`fila.estado === 'pendiente'` para cualquier verbo mutante), o sea que el fake modelaba
      // el resultado de un claim atómico sin mirar la query que lo hace atómico: quitarle el
      // `.eq('estado', 'pendiente')` al claim del rechazo dejaba la suite entera en verde.
      if (p === 'eq' || p === 'is') return (col, val) => { filtros.push([col, val]); return b; };
      if (p === 'single' || p === 'maybeSingle') {
        return async () => {
          state.llamadas.push({ tabla, verbo });
          const err = fallo(tabla + ':' + verbo);
          if (err) return { data: null, error: { message: err } };
          if (verbo === 'select') {
            const fila = state.filas[tabla] || null;
            if (tabla === 'usuarios' && state.trasLeerUsuario) { const f = state.trasLeerUsuario; state.trasLeerUsuario = null; f(); }
            return { data: fila, error: null };
          }
          // Escritura condicional: la fila sale sólo si satisface TODOS los filtros de la
          // cadena, como Postgres. Derivado, no hardcodeado.
          const fila = state.filas[tabla];
          const pasa = fila && filtros.every(([c, v]) => fila[c] === v);
          return { data: pasa ? fila : null, error: null };
        };
      }
      // `then` NO puede caer en el passthrough: el Proxy devolvía `b` para toda propiedad
      // desconocida, así que un `await` sobre una cadena que no termina en single/maybeSingle
      // llamaba `b.then(resolve, reject)`, recibía `b` y no resolvía nunca — timeout en vez de
      // diagnóstico. Es la misma clase que el `maybeSingle` faltante de `transacciones.test.js`:
      // un método sin modelar que no se ve como método sin modelar.
      if (p === 'then') return undefined;
      return () => b;
    },
  });
  return b;
}

const fakeDb = {
  supabase: {
    from: (tabla) => builder(tabla),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null }) }) },
  },
};

const pro = {
  activarPro: vi.fn(async () => ({ venceStr: '30/09/2026' })),
  rechazarSolicitudPro: vi.fn(async () => {}),
  reclamarPagoPendiente: vi.fn(async () => {
    const fila = state.filas.pagos;
    state.llamadas.push({ tabla: 'pagos', verbo: 'claim' });
    return fila && fila.estado === 'pendiente' ? fila : null;
  }),
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const norm = String(id).replace(/\\/g, '/');
  if (norm === './db' || norm === '../lib/db' || norm.endsWith('/lib/db')) return fakeDb;
  if (norm === '../lib/pro-payment' || norm.endsWith('/lib/pro-payment')) return pro;
  return origRequire.apply(this, arguments);
};
const { procesarCallbackAdmin } = require('../../handlers/admin-commands');
Module.prototype.require = origRequire;

const PAGO = { id: 'pago-1', estado: 'pendiente', usuario_id: 'u-1' };
const USUARIO = { id: 'u-1', nombre: 'Ana', whatsapp: '51999888777' };

const reclamó = () => state.llamadas.some((c) => c.verbo === 'claim');
const reclamóRechazo = () => state.llamadas.some((c) => c.tabla === 'pagos' && c.verbo === 'update');

beforeEach(() => {
  state.filas = { pagos: { ...PAGO }, usuarios: { ...USUARIO } };
  state.fallos = {};
  state.llamadas = [];
  state.trasLeerUsuario = null;
  for (const k of Object.keys(nth)) delete nth[k];
  vi.clearAllMocks();
});

describe('approve · nada irreversible pasa antes de tener al usuario', () => {
  it('camino feliz: activa Pro y confirma', async () => {
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/Aprobado/);
    expect(pro.activarPro).toHaveBeenCalledOnce();
    expect(r.edit).toMatch(/Ana/);
  });

  it('si falla la lectura de USUARIOS: lo dice y NO reclama el pago', async () => {
    state.fallos['usuarios:select'] = 'db caída';
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/No pude leer el usuario/i);
    // el corazón del ítem: la solicitud sigue pendiente y el botón se puede volver a tocar
    expect(reclamó()).toBe(false);
    expect(pro.activarPro).not.toHaveBeenCalled();
    // y NO puede decir "Usuario no encontrado", que era la mentira original
    expect(r.answer).not.toMatch(/no encontrado/i);
  });

  it('si falla la lectura de PAGOS: lo dice, distinto de "no encontrada", y NO reclama', async () => {
    state.fallos['pagos:select'] = 'db caída';
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/No pude leer la solicitud/i);
    expect(r.answer).not.toMatch(/no encontrada/i);
    expect(reclamó()).toBe(false);
  });

  it('una solicitud ya procesada se reporta como tal aunque el usuario no se pueda leer', async () => {
    // Cubre el corto-circuito por `estado` de `resolverSolicitudPro`. Sin él, un doble-tap sobre
    // una solicitud ya aprobada con la DB a medias contesta "No pude leer el usuario" —o sea un
    // fallo de infraestructura— sobre algo que ya está resuelto y no hay que reintentar.
    state.filas.pagos = { ...PAGO, estado: 'aprobado' };
    state.fallos['usuarios:select'] = 'db caída';
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/ya procesado \(aprobado\)/i);
    expect(r.answer).not.toMatch(/no pude leer/i);
  });

  it('un usuario que de verdad no existe sigue diciendo "Usuario no encontrado"', async () => {
    // El negativo del caso anterior: si los dos fallos comparten copy, el test de arriba pasa
    // sin distinguir nada.
    state.filas.usuarios = null;
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/Usuario no encontrado/i);
    expect(reclamó()).toBe(false);
  });

  it('solicitud inexistente → "no encontrada", sin reclamar', async () => {
    state.filas.pagos = null;
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/no encontrada/i);
    expect(reclamó()).toBe(false);
  });

  it('sigue siendo idempotente: un pago ya aprobado no re-activa', async () => {
    state.filas.pagos = { ...PAGO, estado: 'aprobado' };
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/ya procesado \(aprobado\)/i);
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('carrera: si otro tap gana el claim entre la lectura y el claim, no activa dos veces', async () => {
    // Sin este caso, el reordenamiento podría haber cambiado un bug por el que el claim atómico
    // existe para evitar (apilar un mes + fila duplicada).
    //
    // La primera versión de este caso dejaba el pago en `aprobado` DESDE EL PRINCIPIO, así que
    // salía por el chequeo de estado y nunca llegaba al claim: el `mockResolvedValueOnce(null)`
    // quedaba sin consumir y se filtraba al test siguiente, que fallaba por una causa que no era
    // la suya. La carrera de verdad es: la lectura ve `pendiente` y el otro tap gana DESPUÉS.
    pro.reclamarPagoPendiente.mockImplementationOnce(async () => {
      state.llamadas.push({ tabla: 'pagos', verbo: 'claim' });
      state.filas.pagos = { ...PAGO, estado: 'aprobado' }; // el tap ganador ya la marcó
      return null;
    });
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(reclamó()).toBe(true);
    expect(pro.activarPro).not.toHaveBeenCalled();
    expect(r.answer).toMatch(/ya procesado/i);
  });

  it('si pierde el claim y la relectura falla, no puede decir "no encontrada"', async () => {
    // La fila estaba viva y pendiente dos lineas antes. Devolver "Solicitud no encontrada" ahi
    // manda al admin a buscar una solicitud que existe.
    state.fallos['pagos:select'] = [null, 'db caida'];
    pro.reclamarPagoPendiente.mockImplementationOnce(async () => {
      state.llamadas.push({ tabla: 'pagos', verbo: 'claim' });
      return null;
    });
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/no pude leer el estado final/i);
    expect(r.answer).not.toMatch(/no encontrada/i);
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('si activarPro revienta y devolvió el pago a pendiente, manda a reintentar el botón', async () => {
    // `activarPro` revierte el claim a `pendiente` cuando falla su escritura crítica
    // (`lib/pro-payment.js`). Ese es el caso frecuente y la recuperación correcta es el botón.
    pro.activarPro.mockImplementationOnce(async () => {
      state.filas.pagos = { ...PAGO, estado: 'pendiente' };
      throw new Error('timeout');
    });
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/volvi[oó] a pendiente/i);
    expect(r.answer).toMatch(/Aprobar otra vez/i);
    // **La versión anterior de este test exigía `/activar` y fijaba una instrucción DAÑINA:**
    // ese comando registra el pago en S/0 y no le paga el mes al referrer. Un test puede
    // blindar una decisión equivocada tan bien como una correcta.
    expect(r.answer).not.toMatch(/\/activar/);
  });

  it('si no se puede leer cómo quedó el pago, NO afirma que quedó aprobado', async () => {
    // **Tercera rama.** La primera versión mandaba el fallo de LECTURA al mensaje que asegura
    // "NO volvió a pendiente" — o sea afirmaba un estado que no pudo leer, la misma falacia que
    // `estadoTrasPerderClaim` evita cincuenta líneas más arriba en este mismo commit. Y muerde
    // justo cuando más importa: un hipo de red tumba la escritura de `activarPro` (que sí
    // revierte) y la relectura a la vez, y el admin termina metiendo SQL a mano.
    state.fallos['pagos:select'] = [null, 'db caida'];
    pro.activarPro.mockRejectedValueOnce(new Error('timeout'));
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/no pude leer c[oó]mo qued[oó]/i);
    expect(r.answer).not.toMatch(/NO volvi[oó] a pendiente/i);
    expect(r.answer).toMatch(/NO uses \/activar/);
  });

  it('si el claim LANZA, manda a reintentar el botón y no a "Error procesando"', async () => {
    // `reclamarPagoPendiente` lanza a propósito cuando no puede distinguir "otro tap ganó" de un
    // fallo de infraestructura. Ese throw caía en el catch genérico y el admin leía "Error
    // procesando", sin ninguna de las dos indicaciones. Acá no se reclamó nada: el botón sirve.
    pro.reclamarPagoPendiente.mockRejectedValueOnce(new Error('timeout'));
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/Reintenta el bot[oó]n/i);
    expect(r.answer).not.toMatch(/Error procesando/i);
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('si el pago NO volvió a pendiente, lo dice y desaconseja /activar', async () => {
    // El caso residual: falló también el rollback. `activarPro` ya avisa al admin por su
    // cuenta; acá lo que importa es no mandarlo al camino de cortesía.
    pro.activarPro.mockImplementationOnce(async () => {
      state.filas.pagos = { ...PAGO, estado: 'aprobado' };
      throw new Error('timeout');
    });
    const r = await procesarCallbackAdmin('pro:approve:mensual:pago-1');
    expect(r.answer).toMatch(/NO volvi[oó] a pendiente/i);
    expect(r.answer).toMatch(/NO uses \/activar/);
  });
});

describe('reject · el mismo orden, por el mismo motivo', () => {
  it('camino feliz: rechaza y avisa', async () => {
    const r = await procesarCallbackAdmin('pro:reject:pago-1');
    expect(r.answer).toMatch(/Rechazado/);
    expect(pro.rechazarSolicitudPro).toHaveBeenCalledOnce();
  });

  it('si falla la lectura de usuarios: NO marca la solicitud rechazada', async () => {
    state.fallos['usuarios:select'] = 'db caída';
    const r = await procesarCallbackAdmin('pro:reject:pago-1');
    expect(r.answer).toMatch(/No pude leer el usuario/i);
    // sin esto, la solicitud quedaba `rechazado` y nadie le avisaba nunca a quien pagó
    expect(reclamóRechazo()).toBe(false);
    expect(pro.rechazarSolicitudPro).not.toHaveBeenCalled();
  });

  it('si el claim del rechazo falla, no lo confunde con "ya procesado"', async () => {
    // El agujero de al lado: el UPDATE del rechazo descartaba su `error`, así que un rechazo
    // de la DB era indistinguible de "otro tap ganó la fila".
    state.fallos['pagos:update'] = 'db caída';
    const r = await procesarCallbackAdmin('pro:reject:pago-1');
    expect(r.answer).toMatch(/No pude rechazarlo/i);
    expect(r.answer).not.toMatch(/ya procesado/i);
    expect(pro.rechazarSolicitudPro).not.toHaveBeenCalled();
  });

  it('si la solicitud cambia entre la lectura y el claim, el claim la frena', async () => {
    // **Este caso prueba el PREDICADO del claim**, no el manejo de su resultado: el pre-chequeo
    // ve `pendiente` y otro tap la marca justo después. Lo único que evita el segundo aviso
    // "no pudimos validar tu comprobante" es el `.eq('estado', 'pendiente')` del UPDATE.
    state.trasLeerUsuario = () => { state.filas.pagos = { ...PAGO, estado: 'aprobado' }; };
    const r = await procesarCallbackAdmin('pro:reject:pago-1');
    expect(pro.rechazarSolicitudPro).not.toHaveBeenCalled();
    expect(r.answer).toMatch(/ya procesado/i);
  });

  it('sigue siendo idempotente', async () => {
    state.filas.pagos = { ...PAGO, estado: 'rechazado' };
    const r = await procesarCallbackAdmin('pro:reject:pago-1');
    expect(r.answer).toMatch(/ya procesado/i);
    expect(pro.rechazarSolicitudPro).not.toHaveBeenCalled();
  });
});

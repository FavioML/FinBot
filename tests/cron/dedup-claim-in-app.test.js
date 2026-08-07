import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

/**
 * B6 — el dedup de los crons no puede colgar de una escritura POSTERIOR al envío.
 *
 * Los cuatro avisos con dedup por fecha (vencimiento de Pro a 3 días y el mismo día, fin de
 * trial d11/d14, y el cobro próximo de una suscripción) preguntan "¿ya avisé?" contra la
 * tabla `notificaciones`. Esa fila la escribía `notificarUsuario` DESPUÉS de mandar el
 * WhatsApp, así que un insert fallido dejaba al dedup ciego: el cron horario volvía a mandar
 * el mismo mensaje en cada corrida a partir de las 8am — hasta 16 veces el mismo día, a una
 * persona real. Es exactamente el bug de las 24 notificaciones que el dedup existía para
 * matar, reintroducido por el orden de dos escrituras.
 *
 * El contrato que se fija acá tiene DOS mitades, y las dos hacen falta:
 *   1. `claimInApp` invierte el orden y falla del lado seguro (unit, abajo).
 *   2. Los cuatro call-sites lo piden (guard estático, más abajo). Sin la segunda, el flag
 *      existe y nadie lo usa: verde por vacuidad.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const orden = [];
const waMock = {
  enviarWhatsapp: vi.fn(async () => { orden.push('whatsapp'); return { ok: true, msgId: 'wamid.1' }; }),
};
const notifMock = {
  crearNotificacion: vi.fn(async () => { orden.push('in_app'); return true; }),
};

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', notifMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { notificarUsuario, CANALES } = require('../../lib/notify-user');
// A nivel de módulo, como en `resumen-destinatarios` y `trial-premium-collision`, y NO dentro
// del `it`. Cargar `cron/checks` arrastra medio backend, y hecho perezoso dentro del test ese
// costo se cobra contra el `testTimeout` de 10s: con la máquina cargada el require tardó 36s
// y el test se cayó por timeout, ~1 de cada 10 corridas. El único flaky de la suite, y no era
// una condición de carrera sino contabilidad de dónde se paga el import. (07-ago-2026)
const { llegoElAviso } = require('../../cron/checks');

const BASE = {
  usuarioId: 'u1',
  whatsapp: '51999888777',
  tipo: 'premium_expiry_3d',
  mensaje: 'Tu plan vence',
  titulo: 'Plan Pro vence en 3 días',
};

beforeEach(() => {
  vi.clearAllMocks();
  orden.length = 0;
  waMock.enviarWhatsapp.mockImplementation(async () => { orden.push('whatsapp'); return { ok: true, msgId: 'wamid.1' }; });
  notifMock.crearNotificacion.mockImplementation(async () => { orden.push('in_app'); return true; });
});

describe('claimInApp: la fila in-app es el claim, no un efecto colateral', () => {
  it('escribe la in-app ANTES del WhatsApp', async () => {
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, claimInApp: true });

    expect(orden).toEqual(['in_app', 'whatsapp']);
    expect(res).toEqual({ wa: { ok: true, msgId: 'wamid.1' }, inApp: true });
  });

  it('sin el flag el orden sigue siendo el de siempre (WhatsApp primero)', async () => {
    await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(orden).toEqual(['whatsapp', 'in_app']);
  });

  // El corazón del hallazgo: ESTE es el caso que mandaba 16 WhatsApps al día.
  it('si el claim no se pudo escribir, NO manda WhatsApp', async () => {
    notifMock.crearNotificacion.mockResolvedValue(false);

    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, claimInApp: true });

    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(res).toEqual({ wa: { ok: false, skipped: 'claim_in_app_fallo' }, inApp: false });
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('si crearNotificacion LANZA, tampoco manda WhatsApp (y no propaga)', async () => {
    notifMock.crearNotificacion.mockRejectedValue(new Error('supabase caído'));

    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, claimInApp: true });

    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(res.wa.skipped).toBe('claim_in_app_fallo');
  });

  // Un fallo de WhatsApp NO puede borrar el claim: el aviso ya quedó reclamado y reintentarlo
  // en la corrida siguiente sería justo el re-envío que esto viene a matar. Fuera de la
  // ventana de 24h de Meta (131047) esto pasa TODOS los días con el usuario inactivo, que es
  // el destinatario típico de estos cuatro avisos.
  it('un WhatsApp bloqueado deja el claim escrito igual', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047 });

    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, claimInApp: true });

    expect(res.inApp).toBe(true);
    expect(res.wa.code).toBe(131047);
  });

  /**
   * `llegoElAviso` es el permiso para hacer lo que solo tiene sentido si la persona se
   * enteró (hoy: abrir la ventana de comprobante de 48h). Se prueba acá porque la primera
   * versión preguntaba por una CAUSA de fallo y no por entrega, y así dejaba pasar el modo
   * frecuente: Meta bloquea el texto libre fuera de la ventana de 24h con `{ok:false,
   * code:131047}` y SIN `skipped`.
   */
  it('llegoElAviso distingue entrega de "lo intenté"', () => {
    expect(llegoElAviso({ wa: { ok: true }, inApp: true })).toBe(true);
    expect(llegoElAviso({ wa: { ok: true }, inApp: false })).toBe(true);       // solo WhatsApp
    expect(llegoElAviso({ wa: { ok: false, code: 131047 }, inApp: true })).toBe(true); // solo in-app

    // Los que NO llegaron. El 131047 es el que la primera versión dejaba pasar.
    expect(llegoElAviso({ wa: { ok: false, code: 131047 }, inApp: false })).toBe(false);
    expect(llegoElAviso({ wa: { ok: false, skipped: 'no_whatsapp' }, inApp: false })).toBe(false);
    expect(llegoElAviso({ wa: { ok: false, skipped: 'claim_in_app_fallo' }, inApp: false })).toBe(false);
    expect(llegoElAviso({ wa: { ok: true, skipped: 'test_user' }, inApp: false })).toBe(false);
    expect(llegoElAviso({ wa: { ok: false, error: 'boom' }, inApp: false })).toBe(false);
    expect(llegoElAviso(null)).toBe(false);
    expect(llegoElAviso({})).toBe(false);
  });

  it('sin canal in-app declarado no hay claim: se degrada y avisa por log', async () => {
    const res = await notificarUsuario({
      canales: CANALES.SOLO_WHATSAPP, motivo: 'prueba', ...BASE, claimInApp: true,
    });

    expect(logMock.error).toHaveBeenCalled();
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1); // best-effort: no se traga el aviso
    expect(res.wa.ok).toBe(true);
  });
});

/**
 * Guard estático. El unit de arriba prueba que el flag FUNCIONA; esto prueba que se USA.
 *
 * La lista es cerrada a propósito: si mañana aparece un quinto aviso con dedup contra
 * `notificaciones`, este test no lo detecta solo — pero sí impide que alguien saque el flag
 * de los cuatro que ya lo tienen, que es el modo de falla real (un refactor del cron que
 * "limpia" un parámetro que parece decorativo).
 */
describe('los cuatro crons con dedup por fecha piden el claim', () => {
  const CHECKS = fs.readFileSync(path.join(projectRoot, 'cron/checks.js'), 'utf8');

  const bloques = () => [...CHECKS.matchAll(/notificarUsuario\(\{[\s\S]*?\n\s*\}\);/g)].map(m => m[0]);

  // El ancla NO puede ser el `tipo` en todos los casos: los avisos de fin de trial pasan
  // `tipo: aviso.tipo` y los literales 'trial_d11'/'trial_d14' viven arriba, en el array que
  // recorre el bucle. Se ancla por lo que de verdad está dentro de cada llamada.
  const AVISOS = [
    ['vencimiento de Pro a 3 días', "tipo: 'premium_expiry_3d'"],
    ['vencimiento de Pro hoy', "tipo: 'premium_expiry_hoy'"],
    ['fin de trial (d11 y d14)', 'tipo: aviso.tipo'],
  ];

  it.each(AVISOS)('%s pasa claimInApp en su llamada a notificarUsuario', (_nombre, ancla) => {
    // Acotar al bloque de SU llamada importa: un `claimInApp` de otra llamada del mismo
    // archivo haría pasar el test sin cubrir a este aviso.
    const suyo = bloques().filter(b => b.includes(ancla));
    expect(suyo.length, `no encontré la llamada anclada en «${ancla}»`).toBe(1);
    expect(suyo[0]).toMatch(/claimInApp:\s*true/);
  });

  // Antivacuidad + contraprueba: el regex tiene que estar partiendo el archivo de verdad
  // (varias llamadas) y tiene que DISTINGUIR — la mayoría de los avisos no dedupean por fecha
  // y no llevan el flag. Un regex que colapsara todo en un solo bloque gigante pasaría los
  // it.each de arriba y fallaría acá.
  it('el guard distingue: hay llamadas con y sin claim en el mismo archivo', () => {
    const bs = bloques();
    expect(bs.length).toBeGreaterThan(6);
    expect(bs.filter(b => /claimInApp:\s*true/.test(b)).length).toBe(3);
    expect(bs.filter(b => !/claimInApp/.test(b)).length).toBeGreaterThan(0);
  });

  // El recordatorio de suscripción es la EXCEPCIÓN, y tiene que seguir siéndolo: solo sale
  // si faltan exactamente 3 días para el cobro, así que fallar cerrado no lo posterga —
  // lo pierde, y el ciclo siguiente es 25 días después. Poner el claim ahí cambia un
  // duplicado ocasional por un aviso que nunca sale.
  it('el cobro de suscripción NO lleva claim (fallar cerrado ahí pierde el aviso)', () => {
    const suyo = bloques().filter(b => b.includes("tipo: 'suscripcion_cobro'"));
    expect(suyo.length).toBe(1);
    expect(suyo[0]).not.toMatch(/claimInApp:\s*true/);
  });

  // El claim aborta el envío. Todo lo que el call-site haga DESPUÉS asumiendo que el aviso
  // salió tiene que mirar el resultado. `solicitarComprobante` es el caso que duele: abre 48h
  // donde toda foto se lee como captura de pago, así que correrlo sin haber avisado le rompe
  // el registro por foto al usuario sin decirle por qué (la trampa de B12).
  //
  // Se recorre desde el BLOQUE hacia adelante, no desde `solicitarComprobante` hacia atrás.
  // La primera versión hacía lo segundo, con una ventana de 1600 chars, y tenía un FALSO
  // NEGATIVO: el mensaje del aviso de 3 días más sus comentarios empujan el
  // `notificarUsuario({` fuera de la ventana, así que esa llamada quedaba sin revisar y la
  // mutación (quitarle la guarda) pasaba VERDE. Mismo modo de falla que el primer guard de
  // Q5 y el de `maxGmailAccounts`: el barrido se saltaba justo el sitio que debía mirar.
  it('solicitarComprobante nunca corre tras un claim fallido', () => {
    const conClaim = [...CHECKS.matchAll(/notificarUsuario\(\{[\s\S]*?\n\s*\}\);/g)]
      .filter(m => /claimInApp:\s*true/.test(m[0]));
    expect(conClaim.length, 'antivacuidad: no hay bloques con claim que revisar').toBe(3);

    let revisadas = 0;
    for (const m of conClaim) {
      // Lo que viene inmediatamente después del bloque, hasta cerrar el try del bucle.
      // La ventana la CIERRA el `} catch`, no el número: 800 dejaba 92 chars de margen y
      // un comentario más lo habría partido (lo midió la segunda revisión). 4000 es holgura
      // sobre un corte que ya es estructural.
      const despues = CHECKS.slice(m.index + m[0].length, m.index + m[0].length + 4000);
      const corte = despues.indexOf('} catch');
      const cuerpo = corte >= 0 ? despues.slice(0, corte) : despues;
      const usos = [...cuerpo.matchAll(/solicitarComprobante\(/g)];
      for (const u of usos) {
        revisadas++;
        const linea = cuerpo.slice(cuerpo.lastIndexOf('\n', u.index) + 1, cuerpo.indexOf('\n', u.index));
        // La guarda tiene que preguntar por ENTREGA, no por una causa puntual de fallo:
        // `skipped !== 'claim_in_app_fallo'` cubría el modo raro y dejaba pasar el frecuente
        // (Meta 131047 devuelve ok:false SIN skipped).
        expect(linea, 'solicitarComprobante sin guarda tras un claim: ' + linea.trim())
          .toMatch(/llegoElAviso\(/);
      }
    }
    // Antivacuidad de la segunda mitad: si el recorte dejara de encontrar los usos, el
    // for de arriba no correría y el test pasaría sin haber mirado nada.
    expect(revisadas, 'el barrido no encontró ningún solicitarComprobante tras un claim').toBe(2);
  });
});

/**
 * `claimInApp` solo tiene sentido con el canal in-app declarado: sin fila que reclamar, el
 * módulo se degrada y loguea. El docstring prometía que el castigo vivía en el build, y no
 * era cierto — lo señaló el revisor del diff. Acá está.
 */
describe('claimInApp nunca se combina con un canal único', () => {
  const RUNTIME = ['handlers', 'services', 'lib', 'routes', 'cron'];

  function archivosJs(dir) {
    const out = [];
    const abs = path.join(projectRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...archivosJs(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }

  const conClaim = [];
  for (const rel of RUNTIME.flatMap(archivosJs)) {
    if (rel.replace(/\\/g, '/') === 'lib/notify-user.js') continue; // es la definición
    const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    for (const m of src.matchAll(/notificarUsuario\(\{[\s\S]*?\n\s*\}\);/g)) {
      // `claimInApp:\s*true` y no `claimInApp` a secas: el bloque del cobro de suscripción
      // NOMBRA el flag en el comentario que explica por qué NO lo lleva.
      if (/claimInApp:\s*true/.test(m[0])) conClaim.push({ rel, bloque: m[0] });
    }
  }

  it('el barrido encuentra las llamadas con claim (antivacuidad)', () => {
    expect(conClaim.length).toBe(3);
  });

  it('ninguna declara SOLO_WHATSAPP', () => {
    const malas = conClaim.filter(c => /CANALES\.SOLO_/.test(c.bloque)).map(c => c.rel);
    expect(malas).toEqual([]);
  });
});

/**
 * El dedup de los dos avisos de vencimiento de Pro sigue leyendo `notificaciones` POR
 * TÍTULO, o sea contra una cadena de copy: cambiar el título del aviso sin tocar la query
 * lo deja sin matchear y vuelve el re-envío. El claim no salva de eso, así que se fija el par.
 */
describe('la clave del dedup y el copy del aviso no pueden divergir', () => {
  const CHECKS = fs.readFileSync(path.join(projectRoot, 'cron/checks.js'), 'utf8');

  it.each([
    ['Plan Pro vence en 3 días'],
    ['Plan Pro vence hoy'],
  ])('«%s» aparece en su query de dedup Y en el aviso', (titulo) => {
    const ocurrencias = CHECKS.split(titulo).length - 1;
    expect(ocurrencias).toBeGreaterThanOrEqual(2);
  });

  // El de fin de trial no repite el literal (título y query salen del mismo `aviso.titulo`),
  // que es más robusto. Se fija que siga siendo así y no vuelva a duplicarse a mano.
  it('el fin de trial deriva título y dedup de la misma variable', () => {
    expect(CHECKS).toMatch(/\.eq\('titulo',\s*aviso\.titulo\)/);
    expect(CHECKS).toMatch(/titulo:\s*aviso\.titulo/);
  });
});

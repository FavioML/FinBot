import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * La poda de la campana: que corra, que pase los números que dice pasar, y que su silencio
 * signifique una sola cosa.
 *
 * `notificaciones` no se podaba NUNCA. Medido el 2026-08-27: la fila viva más vieja era del 3
 * de abril (146 días), un usuario acumulaba **786** filas y otro 364. El daño no es de espacio
 * (1848 filas en total) sino de medición: `total` sin techo vuelve incontestable la pregunta
 * "¿la campana es ruidosa?", que es justamente la que el ítem 2 del backlog vino a contestar.
 *
 * **El caso que más importa acá es el del cero.** A partir del segundo día lo normal es podar
 * cero filas, así que "corrió y no había nada" y "dejó de correr" producen exactamente el mismo
 * silencio. Por eso el log sale SIEMPRE, y hay un caso que lo fija: sin él, la poda puede morir
 * y nadie se entera hasta que alguien vuelva a contar filas dentro de un año.
 *
 * Los frenos (`p_dias` mínimo 7, `p_tope` mínimo 20) viven en la función de Postgres, no acá:
 * un borrado con el filtro caído no falla, pasa en silencio. Están verificados contra la base
 * en `migrations/077` y se comprobaron a mano el día que se aplicó (los dos `raise` cortan
 * ANTES de cualquier DELETE, con la tabla intacta en 1848 filas).
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/** Lo que devuelve la función de Postgres, y con qué argumentos se la llamó. */
let respuesta = { data: { por_edad: 0, por_tope: 0 }, error: null };
let lanza = null;
let llamada = null;

const supabaseMock = {
  from: () => ({ select: () => ({ eq: () => ({}) }) }),
  rpc: (nombre, params) => {
    llamada = { nombre, params };
    return { maybeSingle: async () => { if (lanza) throw lanza; return respuesta; } };
  },
};

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/db.js', { supabase: supabaseMock }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { checkRetencionNotificaciones } = require('../cron/checks');

/** 4:05am Lima = 09:05 UTC. El gate horario es parte de lo que se ejercita. */
function enLaFranja() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:05:00Z'));
}

beforeEach(() => {
  respuesta = { data: { por_edad: 0, por_tope: 0 }, error: null };
  lanza = null;
  llamada = null;
  logMock.info.mockClear();
  logMock.error.mockClear();
  enLaFranja();
});
afterEach(() => vi.useRealTimers());

describe('poda de notificaciones', () => {
  it('llama a la función con los dos cortes declarados', async () => {
    await checkRetencionNotificaciones();
    // Mirar solo "se llamó" no alcanza: los números son la decisión de producto, y pasarlos
    // cambiados es el error que nadie ve hasta que faltan filas.
    expect(llamada).toEqual({
      nombre: 'notificaciones_podar',
      params: { p_dias: 90, p_tope: 100 },
    });
  });

  it('reporta cuántas borró cada cláusula', async () => {
    respuesta = { data: { por_edad: 352, por_tope: 703 }, error: null };
    await checkRetencionNotificaciones();
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'RETENCION', porEdad: 352, porTope: 703 }),
      expect.any(String),
    );
  });

  it('loguea TAMBIÉN cuando no borró nada', async () => {
    // El caso normal a partir del segundo día. Sin esta línea, una poda muerta y una poda sin
    // trabajo son el mismo silencio, y la muerta no se descubre nunca.
    await checkRetencionNotificaciones();
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'RETENCION', porEdad: 0, porTope: 0 }),
      expect.any(String),
    );
  });

  it('un error de la base se lee y se reporta, no se confunde con cero', async () => {
    respuesta = { data: null, error: { message: 'deadlock detected' } };
    await checkRetencionNotificaciones();
    expect(logMock.error).toHaveBeenCalled();
    // Y NO el log de éxito: si saliera, un fallo se leería como una poda limpia de 0 filas.
    expect(logMock.info).not.toHaveBeenCalled();
  });

  it('si la llamada lanza, no tumba el tick del cron', async () => {
    lanza = new Error('ECONNRESET');
    await expect(checkRetencionNotificaciones()).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('fuera de la franja de las 4am no toca nada', async () => {
    vi.setSystemTime(new Date('2026-08-27T20:05:00Z')); // 3:05pm Lima
    await checkRetencionNotificaciones();
    expect(llamada).toBeNull();
  });
});

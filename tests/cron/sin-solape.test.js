import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { correrSinSolape, _resetSinSolape } = require('../../cron/sin-solape.js');

/**
 * El invariante de P′10 que no se ve leyendo `cron/index.js`: un tick nuevo NO arranca si el
 * anterior de la misma tarea sigue corriendo.
 *
 * El caso que esto previene no se puede reproducir hoy en producción (a ~106 usuarios ningún
 * check pasa de segundos), así que la prueba es sobre la primitiva, con una promesa que
 * controlo yo. Eso también es lo que la hace mutable: sacar la guarda de `enVuelo` la mata.
 */
describe('correrSinSolape', () => {
  beforeEach(() => _resetSinSolape());

  it('saltea el tick si la corrida anterior no terminó', () => {
    let resolver;
    const tarea = vi.fn(() => new Promise((r) => { resolver = r; }));

    expect(correrSinSolape('t', tarea)).toBe(true);
    expect(correrSinSolape('t', tarea)).toBe(false);
    expect(correrSinSolape('t', tarea)).toBe(false);
    expect(tarea).toHaveBeenCalledTimes(1);

    resolver();
  });

  it('vuelve a correr una vez que la anterior terminó', async () => {
    let resolver;
    const tarea = vi.fn(() => new Promise((r) => { resolver = r; }));

    correrSinSolape('t', tarea);
    resolver();
    await new Promise((r) => setTimeout(r, 0));

    expect(correrSinSolape('t', tarea)).toBe(true);
    expect(tarea).toHaveBeenCalledTimes(2);
    resolver();
  });

  it('una excepción SÍNCRONA libera el registro y sube tal cual', () => {
    // Hoy una función que revienta antes del primer await termina en `uncaughtException`.
    // El wrapper no puede convertir eso en una promesa rechazada sin cambiar qué handler la
    // atiende, y los dos avisan al admin por caminos distintos.
    const rota = vi.fn(() => { throw new Error('sync'); });
    expect(() => correrSinSolape('sync', rota)).toThrow('sync');
    expect(correrSinSolape('sync', vi.fn(async () => {}))).toBe(true);
  });

  it('el atasco se mide en TIEMPO colgada, no en ticks salteados', async () => {
    // Un umbral en ticks significa 45 min para una tarea de 15 y **72 horas** para
    // `checkGmailHuerfanos`, que corre cada 24 — tres días de silencio en una de las dos tareas
    // que llaman a Google sin timeout. Y el reloj arranca de cero cada vez que la tarea corre
    // bien, o si no un salteo de hace semanas dispararía el aviso con el primero de hoy.
    vi.useFakeTimers();
    try {
      const avisos = [];
      const opts = { alAtascarse: (n, ms) => avisos.push(ms), umbralAtascoMs: 10 * 60 * 1000 };
      const colgada = () => new Promise(() => {});

      correrSinSolape('t', colgada, opts);
      vi.advanceTimersByTime(5 * 60 * 1000);
      correrSinSolape('t', colgada, opts);
      expect(avisos, 'cinco minutos colgada todavía no es atasco').toEqual([]);

      vi.advanceTimersByTime(6 * 60 * 1000);
      correrSinSolape('t', colgada, opts);
      expect(avisos.length, 'a los once sí').toBe(1);
      expect(avisos[0]).toBeGreaterThanOrEqual(10 * 60 * 1000);

      // El reaviso NO es en el tick siguiente: espera 4× lo que llevaba.
      vi.advanceTimersByTime(60 * 1000);
      correrSinSolape('t', colgada, opts);
      expect(avisos.length, 'un minuto después no reavisa').toBe(1);

      vi.advanceTimersByTime(60 * 60 * 1000);
      correrSinSolape('t', colgada, opts);
      expect(avisos.length, 'pero el rastro no se pierde: reavisa con backoff').toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('el bloqueo es POR TAREA, no global', () => {
    // Si el registro fuera un booleano en vez de un Set, una tarea lenta congelaría a las
    // otras 22 — un fallo mucho peor que el que esto viene a arreglar.
    const lenta = vi.fn(() => new Promise(() => {}));
    const otra = vi.fn(() => new Promise(() => {}));

    expect(correrSinSolape('lenta', lenta)).toBe(true);
    expect(correrSinSolape('otra', otra)).toBe(true);
    expect(correrSinSolape('lenta', lenta)).toBe(false);
    expect(otra).toHaveBeenCalledTimes(1);
  });

  it('una tarea que REVIENTA libera el registro (y no se traga el error)', async () => {
    // Sin el `finally`, el primer fallo dejaría esa tarea marcada como en vuelo para siempre:
    // dejaría de correr en silencio hasta el próximo deploy.
    const rota = vi.fn(async () => { throw new Error('boom'); });
    const capturadas = [];
    const previo = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (r) => capturadas.push(r));

    correrSinSolape('rota', rota);
    await new Promise((r) => setTimeout(r, 20));

    // Vuelve a poder correr…
    expect(correrSinSolape('rota', rota)).toBe(true);
    expect(rota).toHaveBeenCalledTimes(2);
    // …y el error no se perdió: llegó al handler de proceso, que es quien avisa al admin.
    await new Promise((r) => setTimeout(r, 20));
    expect(capturadas.map((e) => e.message)).toContain('boom');

    process.removeAllListeners('unhandledRejection');
    previo.forEach((l) => process.on('unhandledRejection', l));
  });
});

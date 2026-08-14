import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { programar, calcularOffsets } = require('../../cron/programar.js');
const { _resetSinSolape } = require('../../cron/sin-solape.js');

/**
 * Este archivo existe porque los dos guards que escribí primero **no ejercitaban el cableado**:
 * uno leía `cron/index.js` como TEXTO con regex y el otro probaba la primitiva de no-solape
 * AISLADA. Una revisión adversarial midió el precio — cuatro mutaciones de producción pasaban
 * en verde con 66/66:
 *
 *   · borrar `if (t.alBoot) ...`      → `escaneoAutomatico`, `limpiarOTPVencidos`,
 *                                       `checkGmailHuerfanos` y `keepWarmWebapp` dejan de
 *                                       correr al levantar el proceso
 *   · `const offsetMs = 0`            → vuelve el hallazgo P′10 entero
 *   · borrar el `setTimeout` de afuera → ídem
 *   · `setInterval(fn, ...)` en vez de `setInterval(() => correrSinSolape(...))`
 *                                     → el anti-solape queda desconectado, y su propio test
 *                                       sigue verde porque prueba la primitiva sola
 *
 * Las cuatro son sobre el COMPORTAMIENTO del scheduler, así que la única forma de matarlas es
 * correrlo con relojes falsos. Es la lección de `feedback_mutar_lo_cubierto_no_encuentra_lo_no_cubierto`
 * aplicada a mi propio diff: mutar lo que el guard dice cubrir no encuentra lo que no cubre.
 */

const MIN = 60 * 1000;
const tarea = (nombre, cadaMs, extra = {}) => ({ nombre, cadaMs, tag: 'TEST', mensaje: nombre, ...extra });

describe('programar', () => {
  beforeEach(() => {
    _resetSinSolape();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('las tareas `alBoot` corren de inmediato, y solo esas', () => {
    const conBoot = vi.fn(async () => {});
    const sinBoot = vi.fn(async () => {});
    programar([tarea('conBoot', 15 * MIN, { alBoot: true }), tarea('sinBoot', 15 * MIN)], { conBoot, sinBoot });

    expect(conBoot).toHaveBeenCalledTimes(1);
    expect(sinBoot).toHaveBeenCalledTimes(0);
  });

  it('dos tareas del mismo período NO arrancan en el mismo instante', async () => {
    // Muere con `offsetMs = 0` y con quitar el `setTimeout` que envuelve al `setInterval`:
    // las dos mutaciones hacen que `b` dispare junto con `a`.
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    const P = 60 * 1000;
    programar([tarea('a', P), tarea('b', P)], { a, b });

    await vi.advanceTimersByTimeAsync(P + 1);
    expect(a, 'la primera del grupo arranca sin desfase').toHaveBeenCalledTimes(1);
    expect(b, 'la segunda todavía no: tiene desfase').toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(20 * 1000);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('el anti-solape está CABLEADO, no solo disponible', async () => {
    // Muere con `setInterval(fn, ...)` en vez de `setInterval(() => correrSinSolape(...))`.
    // La tarea nunca resuelve: sin el wrapper, cada tick la vuelve a llamar.
    const colgada = vi.fn(() => new Promise(() => {}));
    programar([tarea('colgada', 1000)], { colgada });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(colgada).toHaveBeenCalledTimes(1);
  });

  it('una tarea que termina vuelve a correr en cada tick', async () => {
    // El control del caso anterior: sin esto, un anti-solape que nunca libere pasaría igual.
    const sana = vi.fn(async () => {});
    programar([tarea('sana', 1000)], { sana });

    await vi.advanceTimersByTimeAsync(5000);
    expect(sana).toHaveBeenCalledTimes(5);
  });

  it('TODOS los nombres que no resuelven se reportan, y no frenan a las demás', () => {
    // Antes esto tiraba en medio del `forEach`, y como `startCronJobs` corre dentro de un
    // `setTimeout` y `uncaughtException` no hace `process.exit`, el proceso quedaba a medias
    // y VIVO: las tareas posteriores al typo sin programar y Railway viéndolo sano.
    //
    // Van DOS fantasmas y no uno: con uno solo, mutar el `forEach` a `alFaltarFuncion(rotas[0])`
    // pasaba en verde, y un rename de varios exports a la vez avisaría de uno — que además,
    // con el cooldown global de 5 min de `notificarErrorAdmin`, es UN WhatsApp para todos.
    const rotas = [];
    const buena = vi.fn(async () => {});
    const r = programar(
      [tarea('fantasma1', 15 * MIN), tarea('buena', 15 * MIN, { alBoot: true }), tarea('fantasma2', 15 * MIN)],
      { buena },
      { alFaltarFuncion: (n) => rotas.push(n) },
    );

    expect(rotas).toEqual(['fantasma1', 'fantasma2']);
    expect(r.programadas).toEqual(['buena']);
    expect(buena, 'la tarea sana quedó programada igual').toHaveBeenCalledTimes(1);
  });

  it('el atasco escala al aviso, no se queda en un log', async () => {
    // El guard de no-solape convierte "lento" en "muerto hasta el próximo deploy". `log.warn`
    // no escribe en `errores` ni avisa al admin, así que sin esto la señal solo existiría si
    // alguien abriera los logs de Railway.
    const avisos = [];
    const colgada = vi.fn(() => new Promise(() => {}));
    programar([tarea('colgada', 1000)], { colgada }, { alAtascarse: (n, ms) => avisos.push(ms), umbralAtascoMs: 10_000 });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(avisos.length, 'avisa al cruzar el umbral y después con backoff, no en cada tick').toBeGreaterThanOrEqual(1);
    expect(avisos.length, '120 ticks salteados, un puñado de avisos').toBeLessThan(10);
    expect(avisos[0], 'el aviso lleva cuánto tiempo lleva colgada, no cuántos ticks').toBeGreaterThanOrEqual(10_000);
  });
});

describe('calcularOffsets', () => {
  it('una tarea sola en su período no lleva desfase', () => {
    // `keepWarmWebapp` (4 min) es el caso real: con un desfase calculado sobre el índice global
    // del array le tocaban 200s, o sea que su primer tick pasaba de +4 a +7min20s — justo la
    // tarea que existe para que no haya ventana fría en Vercel después de cada deploy.
    const offsets = calcularOffsets([tarea('sola', 4 * MIN), tarea('a', 15 * MIN), tarea('b', 15 * MIN)]);
    expect(offsets.get('sola')).toBe(0);
    expect(offsets.get('b')).toBeGreaterThan(0);
  });

  it('con DOS tareas el desfase se queda por debajo de medio período', () => {
    // El `+1` de `período / (grupo.length + 1)` es el margen que hace que el último del grupo no
    // quede a medio período del primero. Sin él, un grupo de 2 da exactamente `0` y `p/2`.
    //
    // **El período tiene que ser chico para que se vea**: la primera versión de este test usaba
    // 60s, donde el tope de `PASO_OFFSET_MS` (20s) aplasta la diferencia y las dos variantes dan
    // lo mismo. La mutación sobrevivió. Con 30s el paso lo decide la división y no el tope.
    const P = 30 * 1000;
    const offsets = calcularOffsets([tarea('a', P), tarea('b', P)]);
    expect(offsets.get('b'), 'sin el +1 da exactamente medio período').toBeLessThan(P / 2);
    expect(offsets.get('b')).toBeGreaterThan(0);
  });

  it('el desfase nunca llega a medio período, ni con un grupo grande', () => {
    const grupo = Array.from({ length: 18 }, (_, i) => tarea('t' + i, 15 * MIN));
    const offsets = calcularOffsets(grupo);
    const max = Math.max(...offsets.values());
    expect(max).toBeLessThan((15 * MIN) / 2);
    expect(new Set(offsets.values()).size, 'todos distintos').toBe(18);
  });

  it('con muchas tareas en un período corto el paso se achica en vez de desbordar', () => {
    const grupo = Array.from({ length: 10 }, (_, i) => tarea('t' + i, 60 * 1000));
    const offsets = calcularOffsets(grupo);
    expect(Math.max(...offsets.values())).toBeLessThan(60 * 1000);
    expect(new Set(offsets.values()).size).toBe(10);
  });
});

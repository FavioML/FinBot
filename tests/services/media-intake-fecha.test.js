import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptVision, extraerPagoDeImagen } from '../../services/media-intake.js';
import { anclarAnioDeCaptura } from '../../lib/dates.js';

/**
 * El AÑO de una captura no es un dato leído: cuando la imagen muestra "23 Ago" sin año —el
 * formato de los avisos del BCP— el modelo lo INVENTA. Medido en prod el 24-ago-2026: nueve
 * capturas de un mismo usuario, las nueve guardadas como 2025-08-23 en vez de 2026-08-23.
 *
 * El modo de falla es el peor que tiene este camino, porque no se parece a una falla: la fila
 * se guarda, la confirmación de WhatsApp dice "Nuevo gasto" y el gasto desaparece de toda
 * consulta del mes. El usuario ve "No hay gastos entre 2026-08-23 y 2026-08-23" sobre plata que
 * sí anotó, y la única pista —un "📅 2025-08-23" en la confirmación— pasa desapercibida cuando
 * llegan nueve seguidas. Nadie más lo mira: `guardarTransaccion` valida el monto y la moneda,
 * la fecha entraba cruda.
 *
 * La defensa tiene dos mitades y este archivo exige LAS DOS, porque cada una sola falla:
 *   · la regla del prompt PIDE el año correcto, pero pedirle algo a un modelo no es garantía
 *     (el 24-ago desobedeció nueve de nueve veces);
 *   · `anclarAnioDeCaptura` DECIDE, pero solo protege si alguien la llama en el camino real.
 *
 * Por eso el tercer bloque no prueba la función suelta: prueba que `extraerPagoDeImagen` la
 * aplique. Es el que muere si alguien borra esa llamada y deja la función intacta.
 */

const RAIZ = join(import.meta.dirname, '..', '..');
const HOY = '2026-08-25';
const PROMPT = promptVision(HOY);

describe('promptVision: el año se le dice, no se le adivina', () => {
  it('trae la regla de fecha con el año en curso', () => {
    expect(PROMPT).toContain('REGLA CRÍTICA DE FECHA');
    expect(PROMPT).toContain('el año en curso es 2026');
  });

  it('nombra el caso que rompe: día y mes visibles, año ausente', () => {
    // La regla vieja ("Fecha de hoy si no se ve en la imagen") solo cubría la imagen SIN fecha.
    // El caso real es el intermedio, y es el que hay que dejar escrito.
    expect(PROMPT).toMatch(/d[íi]a y mes pero NO el a[ñn]o/);
    expect(PROMPT).toMatch(/23 Ago/);
  });

  it('el año sale de `hoy`, no está clavado en el código', () => {
    // Un año hardcodeado funciona hasta el 31 de diciembre y después miente todo el año
    // siguiente, en silencio y en la dirección exacta de este bug. Se mide con OTRA fecha:
    // si el prompt fuera fijo, este segundo render seguiría diciendo 2026.
    const otro = promptVision('2031-03-04');
    expect(otro).toContain('el año en curso es 2031');
    expect(otro).not.toContain('2026');

    const src = readFileSync(join(RAIZ, 'services/media-intake.js'), 'utf8');
    const fn = src.slice(src.indexOf('function promptVision'), src.indexOf('async function extraerPagoDeImagen'));
    expect(fn, 'promptVision no puede traer un año literal').not.toMatch(/\b20[2-9]\d\b/);
  });
});

describe('anclarAnioDeCaptura: corrige el año y respeta el resto', () => {
  it('el caso medido: 2025-08-23 visto el 24-ago-2026', () => {
    expect(anclarAnioDeCaptura('2025-08-23', '2026-08-24')).toBe('2026-08-23');
  });

  it('no toca una fecha que ya cae en ventana', () => {
    expect(anclarAnioDeCaptura('2026-08-23', '2026-08-24')).toBe('2026-08-23');
  });

  it('diciembre visto en enero es del año ANTERIOR y se deja quieto', () => {
    // El error que introduciría un "corregir siempre al año en curso": adelantaría un año
    // los gastos de fin de año de todo el que registre en los primeros días de enero.
    expect(anclarAnioDeCaptura('2025-12-20', '2026-01-05')).toBe('2025-12-20');
  });

  it('un año futuro alucinado también se ancla', () => {
    expect(anclarAnioDeCaptura('2027-08-23', '2026-08-25')).toBe('2026-08-23');
  });

  it('devuelve null cuando no hay ancla, en vez de inventar una', () => {
    // Sin ancla el llamador deja la fecha original. Es lo que hace que este saneo no pueda
    // empeorar el caso de quien manda a propósito el comprobante de un gasto viejo.
    expect(anclarAnioDeCaptura('2026-06-01', '2026-08-25')).toBeNull();
    expect(anclarAnioDeCaptura('2024-02-29', '2026-03-01')).toBeNull();
    expect(anclarAnioDeCaptura('mañana', '2026-08-25')).toBeNull();
    expect(anclarAnioDeCaptura(null, '2026-08-25')).toBeNull();
  });
});

describe('extraerPagoDeImagen aplica el saneo (no basta con que la función exista)', () => {
  const visionCreate = globalThis.__mockOpenAICreate;

  const responder = (obj) => visionCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(obj) } }]
  });
  const IMG = Buffer.from('x');

  beforeEach(() => { visionCreate.mockReset(); });

  it('reancla el año que devuelve Vision antes de entregar el objeto', async () => {
    responder({ tipo: 'gasto', monto: 259, moneda: 'PEN', comercio: 'RENZO COSTA', fecha: '2025-08-23' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-08-24');
    expect(parsed.fecha).toBe('2026-08-23');
    // El resto del objeto pasa intacto: esto corrige el año, no reescribe la transacción.
    expect(parsed.monto).toBe(259);
    expect(parsed.comercio).toBe('RENZO COSTA');
  });

  it('deja intacta la fecha que ya está bien', async () => {
    responder({ tipo: 'gasto', monto: 8, fecha: '2026-08-25' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-08-25');
    expect(parsed.fecha).toBe('2026-08-25');
  });

  it('no rompe cuando Vision no devuelve fecha ni cuando dice no_pago', async () => {
    responder({ tipo: 'gasto', monto: 20 });
    const sinFecha = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-08-25');
    expect(sinFecha.fecha).toBeUndefined();

    responder({ tipo: 'no_pago' });
    const noPago = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-08-25');
    expect(noPago.tipo).toBe('no_pago');
  });

  it('sigue lanzando si el modelo no devuelve JSON', async () => {
    // El saneo se metió entre el parseo y el return. Si de paso se tragó el throw, un modelo
    // que responde prosa dejaría de fallar y empezaría a registrar nada en silencio.
    visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'no puedo leer esto' } }] });
    await expect(extraerPagoDeImagen(IMG, 'image/jpeg', '2026-08-25')).rejects.toThrow(/JSON/);
  });
});

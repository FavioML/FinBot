import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectarMultiGasto } = require('../../services/multi-gasto-detector');

/**
 * B27, y es un caso REAL, no inventado: un usuario mandó
 *
 *   Gasté S/.10.2 alimentos
 *   Gasté S/. 1.50 transporte
 *
 * y recibió *"No pude procesar eso"* DOS veces antes de rendirse y mandarlos de a uno. No lo
 * agarraba ninguno de los dos detectores: el separador era un salto de línea (y `detectarMultiGasto`
 * solo miraba `,` y ` y `) y no había `en/de/por` entre el monto y el sustantivo, que `RE_PAR`
 * exige.
 *
 * La mitad de este archivo son los NEGATIVOS, y pesan más que los positivos: relajar la
 * preposición es exactamente el tipo de cambio que empieza a comerse mensajes que no son
 * listas de gastos. El ancla que lo hace seguro es que CADA línea empiece con verbo de gasto.
 */

describe('B27 — lista de gastos separada por saltos de línea', () => {
  it('detecta el caso real que se perdió', () => {
    const items = detectarMultiGasto('Gasté S/.10.2 alimentos\nGasté S/. 1.50 transporte');
    expect(items).toEqual([
      { monto: 10.2, comercio: 'alimentos' },
      { monto: 1.5, comercio: 'transporte' },
    ]);
  });

  it('tolera CRLF, líneas en blanco y espacios de más', () => {
    const items = detectarMultiGasto('  Gasté 20 pan\r\n\r\n  Pagué 30 luz  \r\n');
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ monto: 30, comercio: 'luz' });
  });

  it('sigue funcionando con la preposición puesta', () => {
    expect(detectarMultiGasto('Gasté 20 en pan\nGasté 30 en luz')).toHaveLength(2);
  });

  // ── Negativos: lo que NO puede empezar a agarrar ────────────────────────────
  it('una sola línea no es una lista', () => {
    expect(detectarMultiGasto('gasté 50 taxi')).toBeNull();
  });

  it('si UNA línea no es un gasto, no detecta nada', () => {
    // Media lista registrada y media perdida es peor que no detectar: el usuario ve una
    // confirmación y se queda creyendo que entró todo.
    expect(detectarMultiGasto('Gasté 20 en pan\nhola como estás')).toBeNull();
    expect(detectarMultiGasto('Gasté 20 en pan\n¿cuánto llevo este mes?')).toBeNull();
  });

  it('la línea intrusa TAMBIÉN aborta cuando quedan 2 gastos válidos', () => {
    // ⚠️ Los dos casos de arriba pasan igual si el bucle `continue`a en vez de abortar:
    // queda 1 solo ítem y el `>= 2` los devuelve a null de todas formas. O sea que no
    // prueban la regla, la rozan. Éste sí: con `continue` salen 2 ítems y la pregunta del
    // usuario se pierde en silencio. Lo destapó la mutación, no la corrida en verde.
    expect(detectarMultiGasto('Gasté 20 pan\n¿cuánto llevo este mes?\nGasté 30 luz')).toBeNull();
  });

  it('una línea sin verbo de gasto no cuenta, aunque tenga monto y sustantivo', () => {
    expect(detectarMultiGasto('20 pan\n30 luz')).toBeNull();
  });

  it('rechaza montos imposibles en vez de registrar basura', () => {
    expect(detectarMultiGasto('Gasté 0 pan\nGasté 30 luz')).toBeNull();
    expect(detectarMultiGasto('Gasté 9999999 pan\nGasté 30 luz')).toBeNull();
  });

  // ── Los caminos viejos no se movieron ───────────────────────────────────────
  it('los dos casos que el detector ya cubría dan lo mismo', () => {
    expect(detectarMultiGasto('gasté 50 en taxi y 30 en almuerzo')).toEqual([
      { monto: 50, comercio: 'taxi' },
      { monto: 30, comercio: 'almuerzo' },
    ]);
    expect(detectarMultiGasto('hoy 80 de luz, 50 de agua y 200 de internet')).toHaveLength(3);
  });

  it('lo que no era multi-gasto sigue sin serlo', () => {
    expect(detectarMultiGasto('gasté 50 en taxi')).toBeNull();
    expect(detectarMultiGasto('hola, cuánto llevo este mes')).toBeNull();
    expect(detectarMultiGasto('')).toBeNull();
    expect(detectarMultiGasto(null)).toBeNull();
  });
});

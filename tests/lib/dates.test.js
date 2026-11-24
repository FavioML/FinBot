import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolverFechaRelativa, resolverDiaSemanaPasado, resolverFechaDiaMes, anclarAnioDeEdicion, mensajeDiceAnio, ddmmTraeSuAnio, fechaDeLaOrden } = require('../../lib/dates');

// Helper: dado fechaHoy YYYY-MM-DD, devuelve YYYY-MM-DD restando N días.
function diasAtras(fechaHoy, n) {
  const [y, m, d] = fechaHoy.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

describe('resolverFechaRelativa', () => {
  const HOY = '2026-05-09';
  const AYER = diasAtras(HOY, 1);
  const ANTEAYER = diasAtras(HOY, 2);
  const HACE_3 = diasAtras(HOY, 3);

  it('"ayer" → corrige fecha del parser', () => {
    expect(resolverFechaRelativa('ayer gasté 30 en almuerzo', HOY, HOY)).toBe(AYER);
  });

  it('"ayer" → no-op si parser ya tiene la fecha correcta', () => {
    expect(resolverFechaRelativa('ayer gasté 30 en almuerzo', AYER, HOY)).toBeNull();
  });

  it('"anteayer" → 2 días atrás', () => {
    expect(resolverFechaRelativa('anteayer pagué 40 de gas', HOY, HOY)).toBe(ANTEAYER);
  });

  it('"antier" → 2 días atrás', () => {
    expect(resolverFechaRelativa('antier compré 20 en pan', HOY, HOY)).toBe(ANTEAYER);
  });

  it('"hace 3 días" → 3 días atrás', () => {
    expect(resolverFechaRelativa('hace 3 días pagué 80 de luz', HOY, HOY)).toBe(HACE_3);
  });

  it('"hace tres días" (palabra) → 3 días atrás', () => {
    expect(resolverFechaRelativa('hace tres días pagué 80 de luz', HOY, HOY)).toBe(HACE_3);
  });

  it('"hace un día" → 1 día atrás', () => {
    expect(resolverFechaRelativa('hace un día gasté 50', HOY, HOY)).toBe(AYER);
  });

  it('"el lunes pasado" NO activa este guard (delegado a resolverDiaSemanaPasado)', () => {
    expect(resolverFechaRelativa('el lunes pasado gasté 50 en taxi', HOY, HOY)).toBeNull();
  });

  it('msg sin marcador relativo → null', () => {
    expect(resolverFechaRelativa('gasté 50 en farmacia', HOY, HOY)).toBeNull();
  });

  it('"ayer" dentro de "anteayer" no produce falso positivo', () => {
    // anteayer detecta primero; el resultado debe ser 2 días, no 1.
    expect(resolverFechaRelativa('anteayer gasté 30', HOY, HOY)).toBe(ANTEAYER);
  });
});

// 24-nov-2026: con el día en 12 o menos y otro mes, el parser devolvía HOY para "03/10".
describe('resolverFechaDiaMes', () => {
  const HOY = '2026-11-24';
  it('lee día/mes y corrige la fecha de hoy que puso el parser', () => {
    expect(resolverFechaDiaMes('gasté 20 en taxi 03/10', HOY, HOY)).toBe('2026-10-03');
    expect(resolverFechaDiaMes('150.00 ingreso de cita en estilista 03/10', HOY, HOY)).toBe('2026-10-03');
    expect(resolverFechaDiaMes('Me pagaron 150.00 de arreglo de cabello el 03/10', HOY, HOY)).toBe('2026-10-03');
    expect(resolverFechaDiaMes('gasté 20 en taxi el 3/10', HOY, HOY)).toBe('2026-10-03');
    // Mes/día leído por el modelo ("10 de marzo") también se corrige.
    expect(resolverFechaDiaMes('gasté 20 en taxi 03/10', '2026-03-10', HOY)).toBe('2026-10-03');
  });
  it('con año escrito, de dos o cuatro cifras', () => {
    expect(resolverFechaDiaMes('S/16.80 - Taxi 12/11/2026 ida', HOY, HOY)).toBe('2026-11-12');
    expect(resolverFechaDiaMes('El 26/10/26 compra comida de mascota 20 soles', HOY, HOY)).toBe('2026-10-26');
    expect(resolverFechaDiaMes('cena 80 el 03/12/2025', HOY, HOY)).toBe('2025-12-03');
  });
  it('null si la del parser ya es esa', () => {
    expect(resolverFechaDiaMes('18.50 empanada 19/10', '2026-10-19', HOY)).toBeNull();
  });
  it('no decide: futuro, imposible, dos fechas, fracción o marcador relativo', () => {
    expect(resolverFechaDiaMes('gasté 20 el 15/12', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('gasté 20 el 31/02', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('gasté 20 el 13/13', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('taxi 20 el 03/10 y cine 30 el 04/10', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('1/2 kilo de pollo 12', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('3/4 de queso 9', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('ayer 03/10 taxi 20', HOY, HOY)).toBeNull();
  });
  it('no confunde montos ni fechas ISO con día/mes', () => {
    expect(resolverFechaDiaMes('S/16.80 taxi', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('taxi 2026/11/03 20 soles', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('pagué 1.5/2', HOY, HOY)).toBeNull();
    expect(resolverFechaDiaMes('gasté 20 en taxi', HOY, HOY)).toBeNull();
  });
  it('un día de la semana no frena: la fecha dice más', () => {
    expect(resolverFechaDiaMes('taxi 20 el sábado 03/10', HOY, HOY)).toBe('2026-10-03');
  });
  it('el año en letras cuenta ("03/10 de 2025")', () => {
    expect(resolverFechaDiaMes('taxi 20 03/10 de 2025', HOY, HOY)).toBe('2025-10-03');
  });
  // Revisión adversarial del 24-nov: sin señal de fecha, estos "n/m" quedaban como fechas pasadas.
  for (const msg of ['cuota 2/6 del celular 200', 'pagué la cuota 4/10 del préstamo 300', 'gasté 100 en 1/8 de pollo',
    'gasté 20 en 1/5 de libra', 'compré 6/8 tornillos 15', 'farmacia 24/7 gasté 30', 'taxi 20 24/7', 'pedido 5/10 llegó 80 soles',
    'compré 30 en entradas fila 4/10', 'gasté 20 a las 8/9 en taxi', 'pizza 40 entre 4, 10/4', '$20/3', 'usd 20/3',
    // Segunda revisión: sin año ni "el", una cifra de un lado no alcanza; día = mes tampoco.
    'netflix 45 plan 2/4', 'pasaje 6/6', '2/5 de la cuenta 60', 'pagué 500 matrícula 1/10', 'examen 10/10 pagué 20 de copias',
    'pagué 45 en 10/10 estrellas', 'gasté 40 en 04/04 cuotas', 'gasté 20 en taxi 3/10']) {
    it(`un n/m que no es fecha no se lee como fecha: ${JSON.stringify(msg)}`, () => {
      expect(resolverFechaDiaMes(msg, HOY, HOY)).toBeNull();
    });
  }
  it('las cuotas y tallas de diciembre tampoco, aunque ya no caigan en el futuro', () => {
    expect(resolverFechaDiaMes('cuota 3/12 de la laptop 150', '2026-12-20', '2026-12-20')).toBeNull();
    expect(resolverFechaDiaMes('polo talla 10/12 gasté 50', '2026-12-20', '2026-12-20')).toBeNull();
  });
  it('en enero, "28/12" es el diciembre que pasó; lejos del año anterior no decide', () => {
    expect(resolverFechaDiaMes('taxi 20 28/12', '2027-01-05', '2027-01-05')).toBe('2026-12-28');
    for (const msg of ['pagué 300 en 12/12 cuotas', 'pasaje 12/12 sol 3', 'gasolina 50 km 10/12']) {
      expect(resolverFechaDiaMes(msg, '2027-01-05', '2027-01-05'), msg).toBeNull();
    }
    expect(resolverFechaDiaMes('taxi 20 15/12', HOY, HOY)).toBeNull();
  });
  it('las 29 formas reales de producción siguen leyéndose', () => {
    for (const [msg, f] of [['el 16/09 gasté 68.6 en combustible (GLP)', '2026-09-16'], ['Gaste S/235.7 en comida para la casa en Tottus el 20/09.', '2026-09-20'],
      ['14 jugo en el Enano 04/10', '2026-10-04'], ['18.50 empanada y alfajor 19/10', '2026-10-19'], ['150.00 entró a mi cuenta 03/10 de cita estilista', '2026-10-03']]) {
      expect(resolverFechaDiaMes(msg, HOY, HOY), msg).toBe(f);
    }
  });
  it('la misma fecha escrita dos veces cuenta como una', () => {
    expect(resolverFechaDiaMes('03/10 taxi 20, era el 03/10', HOY, HOY)).toBe('2026-10-03');
  });
});

// 24-nov-2026: sin historial, el clasificador mandaba "cámbialo al 15/10" como 2023-10-15
// (qa-e2e/probe-editar-fecha.mjs) y `editar_fecha` lo escribía.
describe('mensajeDiceAnio / ddmmTraeSuAnio', () => {
  it.each([
    'fue el 3/10 del año pasado', 'fue el 15/10 de hace 2 años', 'cámbialo al 15/10 en 2025', 'fue el 15/10 del 25',
    "fue el 15 de octubre del '25", 'cámbialo al 15-10-25', 'cámbialo al 15.10.2025', 'cámbialo al 15/10/25', 'ano pasado',
    // Segunda revisión: con puntuación pegada el año no contaba.
    'cámbialo al 15 de octubre 2025.', 'cámbialo al 15 de octubre 2025, gracias', 'fue el 15/10 2025.', 'fue el 15 de octubre del 25',
  ])('dice año: %s', (m) => expect(mensajeDiceAnio(m)).toBe(true));
  it.each([
    'cámbialo al 15/10', 'cámbialo al 15 de octubre, eran 1500 soles', 'eran 2000 soles', 'a las 1430', 'del 25 soles',
    'cumpleaños', 'cambia la fecha al 3/10',
    // "del 15" es un DÍA (segunda revisión: apagaba el ancla y dejaba pasar el 2023).
    'cambia la fecha del 15 de octubre', 'cámbialo del 15 de octubre', 'fue del 15 de octubre', 'cambia la fecha del 15-10',
  ])('no dice año: %s', (m) => expect(mensajeDiceAnio(m)).toBe(false));
  it('el año dentro del dd/mm', () => {
    expect(ddmmTraeSuAnio('cámbialo al 15/10/2025')).toBe(true);
    expect(ddmmTraeSuAnio('cámbialo al 15/10 de 2025')).toBe(true);
    expect(ddmmTraeSuAnio('fue el 3/10 del año pasado')).toBe(false);
  });
});

describe('anclarAnioDeEdicion', () => {
  const HOY = '2026-11-24';
  it('el año inventado por el modelo vuelve al de la última vez que pasó esa fecha', () => {
    expect(anclarAnioDeEdicion('cámbialo al 15/10', '2023-10-15', HOY)).toBe('2026-10-15');
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre', '2023-10-15', HOY)).toBe('2026-10-15');
    // Un año anterior tampoco: "15 de octubre" dicho en noviembre es el de hace un mes.
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre', '2025-10-15', HOY)).toBe('2026-10-15');
  });
  it('deja la del modelo cuando ya es esa', () => {
    expect(anclarAnioDeEdicion('cámbialo al 03/10', '2026-10-03', HOY)).toBe('2026-10-03');
    expect(anclarAnioDeEdicion('cambia la fecha a hoy', HOY, HOY)).toBe(HOY);
  });
  it('en enero, un diciembre sin año es el que pasó', () => {
    expect(anclarAnioDeEdicion('cámbialo al 28/12', '2027-12-28', '2027-01-05')).toBe('2026-12-28');
    expect(anclarAnioDeEdicion('fue el lunes', '2024-12-28', '2027-01-05')).toBe('2026-12-28');
  });
  it('con año escrito manda el del mensaje, no se toca', () => {
    expect(anclarAnioDeEdicion('cámbialo al 15/10/2023', '2023-10-15', HOY)).toBe('2023-10-15');
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre de 2024', '2024-10-15', HOY)).toBe('2024-10-15');
    expect(anclarAnioDeEdicion('cámbialo al 15/10/25', '2025-10-15', HOY)).toBe('2025-10-15');
    expect(anclarAnioDeEdicion('fue el 15 de octubre del año pasado', '2025-10-15', HOY)).toBe('2025-10-15');
  });
  it('un monto de cuatro cifras no es un año dicho: el año inventado se corrige igual', () => {
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre, eran 1500 soles', '2023-10-15', HOY)).toBe('2026-10-15');
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre, eran 2000 soles', '2023-10-15', HOY)).toBe('2026-10-15');
  });
  it('una relativa manda la del modelo: el año sale del texto, no del calendario', () => {
    expect(anclarAnioDeEdicion('fue hace 13 meses', '2025-12-02', '2027-01-02')).toBe('2025-12-02');
    expect(anclarAnioDeEdicion('cámbialo a mañana', '2027-01-01', '2026-12-31')).toBe('2027-01-01');
  });
  it('"ayer" u "hoy" en el mensaje no apagan el ancla (segunda revisión)', () => {
    expect(anclarAnioDeEdicion('fue el 15/10 no hoy', '2023-10-15', HOY)).toBe('2026-10-15');
    expect(anclarAnioDeEdicion('fue el 15/10, no ayer', '2023-10-15', HOY)).toBe('2026-10-15');
  });
  it('el borde de los 120 días hacia el año anterior', () => {
    expect(anclarAnioDeEdicion('cámbialo al 06/12', '2023-12-06', '2026-04-05')).toBe('2025-12-06');
    expect(anclarAnioDeEdicion('cámbialo al 05/12', '2023-12-05', '2026-04-05')).toBeNull();
  });
  it('una fecha futura de este año pasa como antes (precio declarado); con un año lejano, null', () => {
    expect(anclarAnioDeEdicion('cámbialo al 30/11', '2026-11-30', HOY)).toBe('2026-11-30');
    expect(anclarAnioDeEdicion('cámbialo al 30/11', '2023-11-30', HOY)).toBeNull();
  });
  it('null si la del modelo no es una fecha real', () => {
    expect(anclarAnioDeEdicion('cámbialo al 31/02', '2026-02-31', HOY)).toBeNull();
    expect(anclarAnioDeEdicion('cámbialo al 15 de octubre', '15 de octubre', HOY)).toBeNull();
    expect(anclarAnioDeEdicion('cámbialo al 15/10', undefined, HOY)).toBeNull();
  });
  it('un 29 de febrero sin año que este año no existe', () => {
    // 2028 es bisiesto; en 2027 el 29-feb no existe y el de 2026 tampoco: no hay lectura, y el año
    // del modelo (2028) es futuro → null, se pregunta.
    expect(anclarAnioDeEdicion('cámbialo al 29/02', '2028-02-29', '2027-05-01')).toBeNull();
  });
});

describe('fechaDeLaOrden', () => {
  const HOY = '2026-11-24';
  it('completa una fecha sin ceros ("2026-11-2"), que antes Postgres aceptaba', () => {
    expect(fechaDeLaOrden('fue el viernes', '2026-11-2', HOY)).toEqual({ fecha: '2026-11-02', ddmm: false, anclada: false });
  });
  it('dd/mm del texto y después el ancla', () => {
    expect(fechaDeLaOrden('cámbialo al 03/10', HOY, HOY)).toEqual({ fecha: '2026-10-03', ddmm: true, anclada: false });
    expect(fechaDeLaOrden('cámbialo al 15 de octubre', '2023-10-15', HOY)).toEqual({ fecha: '2026-10-15', ddmm: false, anclada: true });
  });
  it('con el año dicho fuera del dd/mm, el dd/mm no pone el de hoy', () => {
    expect(fechaDeLaOrden('fue el 15/10 2025.', '2025-10-15', HOY).fecha).toBe('2025-10-15');
  });
  it('null si no hay fecha creíble', () => {
    expect(fechaDeLaOrden('cámbialo al 15 de octubre', 'antier', HOY)).toBeNull();
  });
});

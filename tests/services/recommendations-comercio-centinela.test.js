import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

// Desde el 01-oct el parser guarda 'Sin comercio' cuando no puede nombrar un gasto (antes ''), y
// `construirDatosUsuario` contaba esa etiqueta como un comercio: salía entre los comercios top y,
// con gastos sin nombre en dos meses, como "gasto recurrente". Las dos listas van al prompt de
// recomendaciones, así que el modelo terminaba aconsejando sobre "Sin comercio".

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');
const hoy = new Date();
const fecha = (diasAtras) => new Date(hoy.getTime() - diasAtras * 86400000).toISOString().split('T')[0];

// Los mismos gastos para todas las lecturas de gastos: así cada comercio aparece en este mes Y en el
// anterior, que es la condición de "recurrente".
const GASTOS = [
  ...[1, 2, 3].map((d) => ({ monto: 15, monto_pen: 15, categoria: 'Otros', fecha: fecha(d), tipo: 'gasto', comercio: 'Sin comercio' })),
  ...[1, 2].map((d) => ({ monto: 15, monto_pen: 15, categoria: 'Otros', fecha: fecha(d), tipo: 'gasto', comercio: 'sin_descripcion' })),
  { monto: 40, monto_pen: 40, categoria: 'Alimentación', fecha: fecha(1), tipo: 'gasto', comercio: 'Wong' },
];

function stubSupabase() {
  return {
    from(tabla) {
      const q = {
        _tipo: null,
        select() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, order() { return q; }, range() { return q; },
        eq(col, val) { if (col === 'tipo') q._tipo = val; return q; },
        then(resolve) {
          if (tabla !== 'transacciones') return resolve({ data: [], error: null });
          return resolve({ data: q._tipo === 'ingreso' ? [{ monto: 3000, monto_pen: 3000 }] : GASTOS, error: null });
        },
      };
      return q;
    },
  };
}

function cargar() {
  const dbPath = require.resolve(path.join(APP, 'lib', 'db.js'));
  const recomPath = require.resolve(path.join(APP, 'services', 'recommendations.js'));
  const subsPath = require.resolve(path.join(APP, 'services', 'subscriptions'));
  delete require.cache[recomPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: stubSupabase() } };
  require.cache[subsPath] = { id: subsPath, filename: subsPath, loaded: true,
    exports: { detectarSuscripciones: async () => ({ suscripciones_detectadas: [], total_mensual_pen: 0, total_mensual_usd: 0 }) } };
  return require(recomPath);
}

describe('construirDatosUsuario: una etiqueta de "sin nombre" no es un comercio', () => {
  it('no está entre los comercios top ni entre los gastos recurrentes; Wong sí (control)', async () => {
    const datos = await cargar().construirDatosUsuario('u-1');
    const nombres = (xs) => JSON.stringify(xs || []).toLowerCase();
    expect(nombres(datos.comercios_top)).toContain('wong');
    expect(nombres(datos.comercios_top)).not.toMatch(/sin comercio|sin_descripcion/);
    expect(nombres(datos.gastos_recurrentes)).toContain('wong');
    expect(nombres(datos.gastos_recurrentes)).not.toMatch(/sin comercio|sin_descripcion/);
  });
});

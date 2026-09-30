import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cajaDelMes, filtroPagosDelMes, type PagoRow } from './admin-revenue';

/**
 * "Caja del mes" (stats), `revenue_this_month` (economics), el P&L y /admin/pagos son el MISMO
 * número, y /admin/pagos lo enlaza así. Hasta el 30-sep-2026 las dos rutas prefiltraban `pagos`
 * por `created_at >= inicio de mes`, y el comprobante enviado el último día y aprobado el
 * primero se caía de la tarjeta.
 *
 * El harness (`qa-admin-panel.mjs`) cruza los cuatro números contra producción, pero solo lo
 * puede ver el mes en que exista un pago que cruce de mes (0 al 30-sep). Este test es la parte
 * determinista: evalúa el filtro con el caso del borde puesto a mano.
 */

/**
 * Evalúa un árbol `or` de PostgREST hecho solo de `col.gte."valor"`, que es la única forma que
 * produce `filtroPagosDelMes`. Si la forma cambia, el parser lanza en vez de aprobar a ciegas.
 */
function aplicarOr(filtro: string, filas: PagoRow[]): PagoRow[] {
  const ramas = filtro.split(/,(?=[a-z_]+\.)/).map((r) => {
    const m = r.match(/^([a-z_]+)\.gte\."([^"]+)"$/);
    if (!m) throw new Error(`forma de filtro no soportada por el test: ${r}`);
    return { col: m[1] as 'aprobado_at' | 'created_at', desde: new Date(m[2]).getTime() };
  });
  return filas.filter((f) =>
    ramas.some(({ col, desde }) => f[col] != null && new Date(f[col] as string).getTime() >= desde),
  );
}

const INICIO_OCT = '2026-10-01T05:00:00.000Z'; // 1-oct 00:00 Lima

const filas: PagoRow[] = [
  // Enviado el 30-sep a las 20:00 Lima, aprobado el 1-oct a las 09:00 Lima: es caja de OCTUBRE.
  { usuario_id: 'u1', estado: 'aprobado', monto: '10.00', created_at: '2026-10-01T01:00:00Z', aprobado_at: '2026-10-01T14:00:00Z' },
  // Enviado y aprobado en setiembre: no es de octubre.
  { usuario_id: 'u2', estado: 'aprobado', monto: '99.00', created_at: '2026-09-20T15:00:00Z', aprobado_at: '2026-09-20T16:00:00Z' },
  // Enviado en octubre y todavía pendiente: no suma.
  { usuario_id: 'u3', estado: 'pendiente', monto: '10.00', created_at: '2026-10-02T15:00:00Z', aprobado_at: null },
];

describe('filtroPagosDelMes + cajaDelMes', () => {
  it('el pago enviado el 30 y aprobado el 1 entra a la caja del mes nuevo', () => {
    const traidas = aplicarOr(filtroPagosDelMes(INICIO_OCT), filas);
    expect(cajaDelMes(traidas, new Set(), INICIO_OCT)).toBe(10);
  });

  it('CONTROL: con el prefiltro viejo (solo created_at) ese pago se perdía', () => {
    const viejo = filas.filter((f) => new Date(f.created_at as string).getTime() >= new Date(INICIO_OCT).getTime());
    expect(cajaDelMes(viejo, new Set(), INICIO_OCT)).toBe(0);
  });

  it('las comillas protegen los `.` y `:` del timestamp', () => {
    expect(filtroPagosDelMes(INICIO_OCT)).toBe(
      `aprobado_at.gte."${INICIO_OCT}",created_at.gte."${INICIO_OCT}"`,
    );
  });
});

describe('las dos rutas que calculan la caja del mes usan el filtro', () => {
  const RUTAS = ['stats', 'economics'].map((r) => join(process.cwd(), 'src', 'app', 'api', 'admin', r, 'route.ts'));

  it.each(RUTAS)('%s', (ruta) => {
    const src = readFileSync(ruta, 'utf8');
    expect(src).toContain('.or(filtroPagosDelMes(startMonthIso))');
    // La forma vieja, en cualquier columna de fecha de `pagos`, vuelve a perder el borde.
    expect(src).not.toMatch(/\.gte\(\s*['"](created_at|aprobado_at)['"]\s*,\s*startMonthIso\s*\)/);
    expect(src).toContain('cajaDelMes(');
  });
});

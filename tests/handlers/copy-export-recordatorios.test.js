import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);

/**
 * Copy de dos intents que prometían cosas que la webapp no tiene (11-oct-2026):
 *
 * - `exportar_datos` vendía un export a Excel (Excel sólo se IMPORTA) y mandaba todo a
 *   Movimientos diciendo "ahí puedes exportar en CSV, JSON o PDF", cuando ahí sólo hay CSV.
 * - `recordatorio_pago` contestaba "ponme un recordatorio de pagar luz el 15" explicando los
 *   avisos automáticos sin decir que ESE recordatorio no se crea, y el pitch prometía un
 *   resumen diario "a la hora que elijas" que no tiene preferencia de hora.
 *
 * Los guards de claims (webapp, landing, content/) no alcanzan los handlers, así que esto es
 * la red del canal donde Neto habla. Además de fijar el copy, mira que cada pantalla que el
 * copy nombra siga teniendo el formato: si el CSV se muda de Movimientos, esto se pone rojo.
 */

const { PLAN_CONFIG } = require('../../lib/constants');
const reportes = require('../../handlers/intents/reportes');
const utilidades = require('../../handlers/intents/utilidades');

const ctx = { getUserPlanConfig: (u) => PLAN_CONFIG[u.plan] };
const FREE = { id: 'u1', plan: 'free' };
const PRO = { id: 'u1', plan: 'premium' };

const responder = (handler, intencion, usuario, msg) =>
  handler.handle({ intencion, msg, datos: {}, usuario, from: '+51999', ctx });

const webapp = (rel) => readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../webapp/src/app', rel), 'utf8');

describe('exportar_datos: cada formato apunta a donde vive', () => {
  it('Pro: CSV en Movimientos, PDF en Reporte, JSON en Configuración, cada uno con su link', async () => {
    const r = await responder(reportes, 'exportar_datos', PRO, 'quiero exportar mis datos');
    const lineas = r.split('\n\n');
    const bloque = (fmt) => lineas.find((l) => l.includes('*' + fmt + '*'));
    expect(bloque('CSV')).toContain('Movimientos');
    expect(bloque('CSV')).toContain('https://app.neto.pe/dashboard/transacciones');
    expect(bloque('PDF')).toContain('Reporte');
    expect(bloque('PDF')).toContain('https://app.neto.pe/dashboard/reportes');
    expect(bloque('JSON')).toContain('Configuración');
    expect(bloque('JSON')).toContain('https://app.neto.pe/dashboard/configuracion');
  });

  it('Pro: ya no dice que en Movimientos hay JSON o PDF', async () => {
    const r = await responder(reportes, 'exportar_datos', PRO, 'exportar');
    expect(r).not.toMatch(/CSV, JSON o PDF/);
  });

  it('Free: el pitch nombra cada formato con su sección', async () => {
    const r = await responder(reportes, 'exportar_datos', FREE, 'exportar');
    expect(r).toContain('función Pro');
    expect(r).toMatch(/CSV desde Movimientos/);
    expect(r).toMatch(/PDF desde Reporte/);
    expect(r).toMatch(/JSON desde Configuración/);
  });

  it.each([['free', FREE], ['pro', PRO]])('%s: no promete exportar a Excel', async (_n, usuario) => {
    const r = await responder(reportes, 'exportar_datos', usuario, 'exportar a excel');
    expect(r).not.toMatch(/excel/i);
  });

  // El copy nombra tres pantallas: si una deja de tener su formato, el copy vuelve a mentir.
  it('la webapp sigue teniendo cada formato en la pantalla que nombra el copy', () => {
    expect(webapp('dashboard/transacciones/page.tsx')).toMatch(/text\/csv/);
    expect(webapp('dashboard/reportes/page.tsx')).toMatch(/pdf\.save\(/);
    const config = webapp('dashboard/configuracion/page.tsx');
    expect(config).toContain("fetch('/api/export')");
    expect(config).toContain('title="Exportar datos"');
    expect(webapp('api/export/route.ts')).toContain("'Content-Type': 'application/json'");
  });
});

describe('recordatorio_pago: dice que el recordatorio a medida no se crea', () => {
  const PEDIDO = 'ponme un recordatorio de pagar luz el 15';

  it.each([['free', FREE], ['pro', PRO]])('%s: lo dice primero, antes de cualquier pitch', async (_n, usuario) => {
    const r = await responder(utilidades, 'recordatorio_pago', usuario, PEDIDO);
    const primerParrafo = r.split('\n\n')[0];
    expect(primerParrafo).toMatch(/no puedo crear recordatorios/i);
    expect(primerParrafo).toMatch(/no va a llegar/);
  });

  it.each([['free', FREE], ['pro', PRO]])('%s: no promete una hora elegida ni un recordatorio creado', async (_n, usuario) => {
    const r = await responder(utilidades, 'recordatorio_pago', usuario, PEDIDO);
    expect(r).not.toMatch(/hora que elijas/);
    expect(r).not.toMatch(/te (lo )?recordar[ée]\b|listo,? te aviso|recordatorio creado|program[ée]/i);
  });

  it('Pro: lista sólo los avisos automáticos que existen', async () => {
    const r = await responder(utilidades, 'recordatorio_pago', PRO, PEDIDO);
    expect(r).toMatch(/3 días antes\*? de que se cobre una suscripción/);
    expect(r).toMatch(/deudas que tienen fecha de vencimiento/);
    expect(r).toContain('https://app.neto.pe/dashboard/configuracion');
  });

  it('Free: el pitch nombra el resumen de las 9pm de Manos Libres, no una hora a elegir', async () => {
    const r = await responder(utilidades, 'recordatorio_pago', FREE, PEDIDO);
    expect(r).toContain('función Pro');
    expect(r).toMatch(/Modo Manos Libres.*9pm/);
  });

  // Los dos números del copy salen de los crons: si cambian allá, el copy tiene que moverse.
  it('el "3 días antes" y las "9pm" siguen siendo lo que hacen los crons', () => {
    const checks = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../cron/checks.js'), 'utf8');
    expect(checks).toMatch(/const SUB_LEAD_DIAS = 3;/);
    const manosLibres = checks.slice(checks.indexOf('async function checkResumenDiarioManosLibres'));
    expect(manosLibres).toMatch(/^[\s\S]{0,300}getHours\(\) !== 21/);
  });
});

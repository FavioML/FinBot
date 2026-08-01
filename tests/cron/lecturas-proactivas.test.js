import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';

/**
 * Guard de los crons, hermano de `webapp/src/lib/supabase/lectura-callsites.test.ts`.
 *
 * El muro tiene dos caras y solo una estaba cubierta. Los chokepoints de
 * `handlers/message-processor.js` y `handlers/webhook.js` cortan lo que el usuario PIDE, y
 * `intents-acceso.test.js` obliga a clasificar cada intent nuevo. Pero un cron no pide
 * nada: empuja. Y tres de ellos empujaban por WhatsApp exactamente lo que el muro cobra.
 *
 *   · checkAlertasProactivas mandaba el estado de los presupuestos y la caída del score.
 *     `ver_presupuesto` y `ver_neto_score` están los dos en INTENTS_LECTURA. Sin filtro de
 *     plan: 6 usuarios en el muro lo recibían cada miércoles.
 *   · checkRecordatorioDeudas mandaba el ledger ("le debes S/X a Y"). `ver_deudas` también.
 *   · checkRecordatorioEspacios mandaba balances de espacios saltándose el modelo
 *     "host paga" entero.
 *
 * Eso no se detecta mirando producción: el cron corre, no falla, y se ve como un usuario
 * contento que nunca paga. Por eso el guard es estático: cualquier cron que mande WhatsApp
 * tiene que demostrar que mira el plan, o estar declarado abajo con su motivo.
 */

const FUENTE = readFileSync(path.join(process.cwd(), 'cron', 'checks.js'), 'utf-8');

/**
 * Crons que mandan WhatsApp sin mirar el plan, a propósito:
 *
 * · ONBOARDING / ACTIVACIÓN — le hablan a quien todavía no tiene nada que leer. Gatearlos
 *   por plan sería no hablarle nunca a un usuario nuevo.
 * · EL MURO MISMO — checkTrialExpiry ES quien avisa que la prueba terminó.
 * · ADMIN — le escriben a Favio, no a usuarios.
 * · ESCRITURA / SERVICIO — no entregan data acumulada.
 */
const SIN_GATE_DE_PLAN = new Set([
  'checkRecordatorioOnboarding',   // "anótame un gasto": el usuario aún no registró nada
  'checkActivacionDia2',           // empujón a activar la cuenta web
  'checkTrialExpiry',              // el aviso de fin de prueba y el mensaje del muro
  'checkRecordatoriosCostos',      // costos operativos → canal admin
  'checkSurveyConversions',        // no manda nada, solo marca conversiones
  'checkCalcularNetoScore',        // calcula, no envía
  'checkSurveyTriggers',           // vive en services/survey-triggers.js, tiene su propio gate
  'limpiarOTPVencidos',
]);

/**
 * Señales válidas de que un cron mira el plan antes de mandar.
 *
 * `getUserPlanConfig` entra porque su única razón de existir es gatear: devuelve las
 * capabilities del plan. Que alguien la llame e ignore el resultado sería un bug distinto
 * (y mucho menos probable) que el que este archivo persigue.
 */
const SENALES_DE_GATE = [
  /\.eq\(\s*['"]plan['"]\s*,\s*['"]premium['"]\s*\)/,   // filtra en la query
  /estaEnMuro\s*\(/,                                     // predicado del muro
  /getUserPlanConfig\s*\(/,                              // capability por plan
  /ownerEsPro\s*\(/,                                     // modelo "host paga"
];

/** Corta `cron/checks.js` en funciones para poder mirarlas de a una. */
function funciones(src) {
  const nombres = [...src.matchAll(/^async function (check\w+|limpiar\w+)\s*\(/gm)]
    .map((m) => ({ nombre: m[1], desde: m.index }));
  return nombres.map((f, i) => ({
    nombre: f.nombre,
    cuerpo: src.slice(f.desde, i + 1 < nombres.length ? nombres[i + 1].desde : src.length),
  }));
}

const CRONS = funciones(FUENTE);

describe('crons que empujan lecturas por WhatsApp', () => {
  it('encuentra los crons (si el parseo se rompe, el resto del archivo miente)', () => {
    expect(CRONS.length).toBeGreaterThan(10);
    expect(CRONS.map((c) => c.nombre)).toContain('checkAlertasProactivas');
  });

  it('todo cron que manda WhatsApp mira el plan, o está declarado exento', () => {
    const sinGate = CRONS
      .filter((c) => /enviarWhatsapp\s*\(/.test(c.cuerpo))
      .filter((c) => !SENALES_DE_GATE.some((re) => re.test(c.cuerpo)))
      .map((c) => c.nombre)
      .filter((n) => !SIN_GATE_DE_PLAN.has(n));

    expect(sinGate).toEqual([]);
  });

  it('no hay exenciones fantasma (nombres que ya no existen)', () => {
    const vivos = new Set(CRONS.map((c) => c.nombre));
    // checkSurveyTriggers se re-exporta desde services/, no se define acá.
    const fantasma = [...SIN_GATE_DE_PLAN].filter((n) => !vivos.has(n) && n !== 'checkSurveyTriggers');
    expect(fantasma).toEqual([]);
  });

  // Los tres del incidente, nombrados uno por uno. Si alguien saca el gate, este test dice
  // exactamente cuál y por qué importaba.
  it.each([
    ['checkAlertasProactivas', 'presupuestos y score son ver_presupuesto / ver_neto_score'],
    ['checkRecordatorioDeudas', 'el ledger de deudas es ver_deudas'],
    ['checkRecordatorioEspacios', 'el balance de un espacio es ver_balance_espacio'],
    // Este lo encontró el propio guard cuando se escribió: leía el plan, pero solo para
    // elegir la CADENCIA (free = el día 1 de cada mes), no para cortar. Que un cron
    // mencione `plan` no prueba que gatee.
    ['checkDetectorFugas', 'el detector de fugas es ver_fugas'],
  ])('%s tiene gate de plan (%s)', (nombre) => {
    const cron = CRONS.find((c) => c.nombre === nombre);
    expect(cron, nombre + ' ya no existe: actualiza este test').toBeDefined();
    expect(SENALES_DE_GATE.some((re) => re.test(cron.cuerpo))).toBe(true);
  });
});

describe('checkPremiumExpiry no puede tocar un trial vivo', () => {
  it('sus queries llevan el guard, y el guard es NULL-safe', () => {
    const cron = CRONS.find((c) => c.nombre === 'checkPremiumExpiry');
    expect(cron).toBeDefined();
    // Tres queries: aviso 3d, aviso hoy, expirados.
    const usos = cron.cuerpo.match(/SIN_TRIAL_ACTIVO/g) || [];
    expect(usos.length).toBe(3);
    expect(FUENTE).toMatch(/SIN_TRIAL_ACTIVO\s*=\s*['"]trial_estado\.is\.null/);
  });
});

import { describe, it, expect } from 'vitest';
import { enTrial, esProPagado, estaEnMuro, diasRestantesTrial, pantallaPro } from './plan';

/**
 * El modelo tiene DOS columnas y tres preguntas distintas, y colapsarlas es lo que
 * produjo los bugs que este archivo previene:
 *
 *   plan === 'premium'            → ¿tiene Pro AHORA? (entitlement)
 *   plan + trial_estado='activo'  → ¿está PROBANDO?   (enTrial)
 *   plan + trial_estado≠'activo'  → ¿PAGA?            (esProPagado)
 *
 * Mirar una sola columna daba pantallas que se contradicen entre sí: el banner de prueba
 * arriba del paywall (un usuario real quedó así 30 días), y `/dashboard/pro` diciéndole
 * "Eres Neto Pro ⭐" a quien estaba probando, sin fecha ni precio ni el descuento que le
 * correspondía.
 *
 * Estos predicados son el espejo exacto de `lib/trial.js` en el backend. Si divergen, la
 * webapp y WhatsApp le responden distinto a la misma persona.
 */

const PROBANDO = { plan: 'premium', trial_estado: 'activo' } as const;
const PAGADO = { plan: 'premium', trial_estado: 'convertido' } as const;
const MURO = { plan: 'free', trial_estado: 'vencido' } as const;
/** El estado roto que produjo el incidente: el reloj corre pero el plan ya cayó. */
const DESINCRONIZADO = { plan: 'free', trial_estado: 'activo' } as const;

describe('enTrial exige las dos columnas', () => {
  it('reconoce al que está probando', () => {
    expect(enTrial(PROBANDO.plan, PROBANDO.trial_estado)).toBe(true);
  });

  it('el estado desincronizado NO es un trial', () => {
    // Si esto vuelve a dar true, el TrialStatusBanner reaparece encima del Paywall.
    expect(enTrial(DESINCRONIZADO.plan, DESINCRONIZADO.trial_estado)).toBe(false);
  });

  it('Pro pagado no está probando', () => {
    expect(enTrial(PAGADO.plan, PAGADO.trial_estado)).toBe(false);
    expect(enTrial('premium', null)).toBe(false);
  });

  it('sin plan no está probando', () => {
    expect(enTrial(undefined, 'activo')).toBe(false);
  });
});

describe('esProPagado separa al que paga del que prueba', () => {
  it('durante el trial NO es Pro pagado', () => {
    // Ese es el bug que escondía el descuento de referido justo a quien se le ancló al
    // fin del trial: `plan === 'premium'` respondía "ya paga" y el 50% no se mostraba.
    expect(esProPagado(PROBANDO.plan, PROBANDO.trial_estado)).toBe(false);
  });

  it('el que convirtió sí lo es', () => {
    expect(esProPagado(PAGADO.plan, PAGADO.trial_estado)).toBe(true);
  });

  it('el que está en el muro no lo es', () => {
    expect(esProPagado(MURO.plan, MURO.trial_estado)).toBe(false);
  });
});

describe('enTrial y esProPagado nunca son verdaderos a la vez', () => {
  const estados = [PROBANDO, PAGADO, MURO, DESINCRONIZADO,
    { plan: 'premium', trial_estado: null }, { plan: 'free', trial_estado: null }];

  it.each(estados)('%o', (u) => {
    expect(enTrial(u.plan, u.trial_estado) && esProPagado(u.plan, u.trial_estado)).toBe(false);
  });

  it('y el que está en el muro nunca está en trial', () => {
    // Ojo con la forma de esta aserción: es una IMPLICACIÓN, así que se cumple por
    // vacuidad si `estaEnMuro` devuelve false para todos. Se descubrió el 2026-08-05
    // rompiendo `estaEnMuro` a propósito para probar el gate del deploy: devolvía
    // `false` siempre y los 159 tests seguían verdes. Por eso abajo va el describe que
    // la mide de frente, y por eso acá se afirma primero que el barrido no es vacío.
    const enMuro = estados.filter((u) => estaEnMuro(u.plan));
    expect(enMuro.length, 'ningún fixture cae en el muro: la implicación sería vacía')
      .toBeGreaterThan(0);
    for (const u of enMuro) expect(enTrial(u.plan, u.trial_estado)).toBe(false);
  });
});

/**
 * `estaEnMuro` de frente, y no dentro de una implicación.
 *
 * Es el predicado más caro de la webapp: su único consumidor es el `estado` de
 * `ContenidoOMuro` (`dashboard-shell.tsx`), que es lo que elige entre <Paywall /> y la
 * página. Si miente, el dashboard entero —historial, reportes, todo lo que se cobra—
 * queda abierto para el que no paga. (Acá se citaba el número de línea y el `if` literal;
 * los dos quedaron viejos con el refactor del 26-ago, que es lo que pasa siempre con una
 * cita de línea.) Hasta hoy no tenía un solo test directo: `tsc` no lo
 * ve (la firma no cambia) y la única aserción que lo mencionaba pasaba por vacuidad.
 */
describe('estaEnMuro: el paywall del dashboard cuelga de esto', () => {
  it('el del muro está en el muro', () => {
    expect(estaEnMuro('free')).toBe(true);
  });

  it('el Pro pagado NO', () => {
    expect(estaEnMuro('premium')).toBe(false);
  });

  it('el que está en trial tampoco: el trial entrega Pro completo', () => {
    expect(estaEnMuro(PROBANDO.plan)).toBe(false);
  });

  /**
   * Fail-closed. `undefined` llega cuando el fetch del usuario todavía no resolvió o la
   * fila vino incompleta; ante la duda se cobra, no se regala. Es el complemento exacto
   * del entitlement (`plan === 'premium'`), que es lo que lo hace imposible de
   * desincronizar con el backend.
   */
  it('sin plan, se asume muro (fail-closed)', () => {
    expect(estaEnMuro(undefined)).toBe(true);
    expect(estaEnMuro('')).toBe(true);
    expect(estaEnMuro('cualquier-cosa')).toBe(true);
  });

  it('es el complemento exacto del entitlement Pro, para los dos valores del tipo', () => {
    for (const plan of ['free', 'premium'] as const) {
      expect(estaEnMuro(plan)).toBe(plan !== 'premium');
    }
  });
});

describe('pantallaPro — a dónde aterriza cada uno en /dashboard/pro', () => {
  it('el que está probando ve SU pantalla, no la de "ya eres Pro"', () => {
    // La regresión que costaba plata: acá aterrizan el banner del dashboard y los avisos
    // de WhatsApp del día 11 y 14. Si esto vuelve a dar 'pagado', el trial manda a la
    // gente a decidir a una pantalla que le dice que no hay nada que decidir.
    expect(pantallaPro({ plan: 'premium', trialEstado: 'activo' })).toBe('trial');
  });

  it('el Pro pagado ve la gestión de su cuenta', () => {
    expect(pantallaPro({ plan: 'premium', trialEstado: 'convertido' })).toBe('pagado');
  });

  it('el del muro ve el formulario de pago', () => {
    expect(pantallaPro({ plan: 'free', trialEstado: 'vencido' })).toBe('pago');
  });

  it('el que nunca tuvo nada ve el formulario de pago', () => {
    expect(pantallaPro({ plan: 'free', trialEstado: null })).toBe('pago');
  });

  it('un pago en verificación gana sobre cualquier plan', () => {
    for (const trialEstado of ['activo', 'convertido', 'vencido', null]) {
      expect(pantallaPro({ plan: 'premium', trialEstado, pagoPendiente: true })).toBe('pendiente');
    }
  });

  it('el estado desincronizado cae del lado seguro (el formulario), no del lado Pro', () => {
    expect(pantallaPro({ plan: 'free', trialEstado: 'activo' })).toBe('pago');
  });

  it('sin status cargado nunca dice que ya es Pro', () => {
    expect(pantallaPro({})).toBe('pago');
  });
});

describe('diasRestantesTrial', () => {
  it('devuelve null si el plan ya cayó, aunque el estado siga en activo', () => {
    expect(diasRestantesTrial('free', 'activo', '2099-12-31')).toBeNull();
  });

  it('devuelve null sin fecha de fin', () => {
    expect(diasRestantesTrial('premium', 'activo', null)).toBeNull();
  });

  it('nunca es negativo, aunque la fecha ya pasó', () => {
    expect(diasRestantesTrial('premium', 'activo', '2020-01-01')).toBe(0);
  });

  it('cuenta en días completos hacia adelante', () => {
    const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const en5 = new Date(new Date(hoyLima + 'T12:00:00-05:00').getTime() + 5 * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    expect(diasRestantesTrial('premium', 'activo', en5)).toBe(5);
  });
});

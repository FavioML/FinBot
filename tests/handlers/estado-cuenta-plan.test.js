import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Hallazgo M10 de la auditoría CTO (2026-08-04). "Plan: Free" es el nombre de un plan que
// dejó de existir: con el modelo de trial + muro, `plan='free'` ES el muro (registro
// abierto, lectura cerrada). Al usuario que terminó su prueba se le respondía el nombre de
// un producto derogado, justo en la pantalla a la que uno entra a ver QUÉ TIENE.
//
// Y colapsaba dos situaciones que no se parecen: el que gastó sus 14 días y el que todavía
// no registró nada (a ese le esperan los 14 completos con su primer gasto). `trial_estado`
// es lo que las distingue.
//
// La otra mitad del hallazgo —el "no solo 1 mes" del freemium muerto— ya no existe: se lo
// llevó el rework de /premium de la ola 1 (ver premium-comando-sin-comprobante.test.js).

// **`premium.js` usa el `obtenerCuentasGmail` que IMPORTA, no el del `ctx`.** El `ctx` de abajo
// lo declaraba desde siempre y nadie lo leía, así que este archivo le pegaba a Supabase de
// PRODUCCIÓN en cada corrida y pasaba en verde porque la función se tragaba el `{ error }` y
// devolvía `[]` — indistinguible de "este usuario no tiene Gmail". Se destapó el 2026-09-02, al
// hacer que esa lectura fallara cerrado. El `ctx` se deja porque la firma del handler lo pide.
const gmailPath = require.resolve('../../gmail.js');
require.cache[gmailPath] = {
  id: gmailPath, filename: gmailPath, loaded: true,
  exports: {
    obtenerCuentasGmail: async () => [],
    tieneGmailConectado: async () => false,
    revocarAccesoGmail: async () => {},
    oauth2Client: {}, BANCOS_CATALOGO: {},
  },
};

const premium = require('../../handlers/intents/premium');

const ctx = { obtenerCuentasGmail: async () => [], supabase: null };
const estadoCuenta = (usuario) =>
  premium.handle({ intencion: 'estado_cuenta', msg: 'mi cuenta', datos: {}, usuario, from: '51999', ctx });

const EN_MURO = { id: 'u1', nombre: 'Ana', plan: 'free', trial_estado: 'vencido' };
const EX_PAGADOR = { id: 'u2', nombre: 'Beto', plan: 'free', trial_estado: 'convertido' };
const NUNCA_EMPEZO = { id: 'u3', nombre: 'Cami', plan: 'free', trial_estado: null };
const EN_TRIAL = { id: 'u4', nombre: 'Dani', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-17' };
const PAGADO = { id: 'u5', nombre: 'Eva', plan: 'premium', trial_estado: 'convertido', premium_vence: '2026-09-01' };

describe('estado_cuenta nombra el plan que el usuario realmente tiene', () => {
  it('el del muro no ve "Free": ve lo que conserva', async () => {
    const r = await estadoCuenta(EN_MURO);
    expect(r, 'sigue nombrando un plan derogado').not.toMatch(/Plan: \*Free\*/);
    expect(r).toContain('Plan: *Gratis (solo registro)*');
  });

  it('el ex pagador está en el mismo muro y lee lo mismo', async () => {
    expect(await estadoCuenta(EX_PAGADOR)).toContain('Plan: *Gratis (solo registro)*');
  });

  // No es cosmético: a este todavía no le cortaron nada, y decirle "solo registro" le
  // anuncia un muro que no tocó — y le esconde que su primer gasto abre 14 días de Pro.
  it('el que nunca registró nada NO recibe el mensaje del muro, y sí el de su prueba', async () => {
    const r = await estadoCuenta(NUNCA_EMPEZO);
    expect(r).toContain('Plan: *Gratis*');
    expect(r).not.toContain('solo registro');
    expect(r, 'no le dice que su primer gasto abre los 14 días').toMatch(/14 días.*primer gasto/s);
  });

  // La prueba ya no le espera a nadie más: ofrecérsela al del muro (que no puede volver a
  // tenerla) o al pagador es prometer algo que el sistema va a negar.
  it('nadie más recibe la promesa de los 14 días', async () => {
    for (const u of [EN_MURO, EX_PAGADOR, EN_TRIAL, PAGADO]) {
      expect(await estadoCuenta(u), `le ofrece la prueba a ${u.nombre}`).not.toMatch(/se activa con tu primer gasto/);
    }
  });

  it('el del trial sigue viéndose como prueba, no como pagador', async () => {
    const r = await estadoCuenta(EN_TRIAL);
    expect(r).toContain('Plan: *Pro (prueba)*');
    expect(r).toContain('Termina:');
  });

  it('el pagador ve su plan con vencimiento', async () => {
    const r = await estadoCuenta(PAGADO);
    expect(r).toContain('Plan: *Pro ⭐*');
    expect(r).toContain('Vence:');
  });

  /**
   * Una fila SIN la columna (`undefined`) no es lo mismo que una con `null`, y el repo ya
   * pagó esa confusión: `mensajeMuro` las separa porque el cron del día 15 le prometía
   * otros 14 días gratis a quien acababa de gastarlos. Acá el daño sería menor, pero la
   * regla es la misma — `undefined` es un bug del llamador, no un estado del usuario:
   * se loguea y se responde el texto neutro, verdadero en cualquier caso.
   *
   * Hoy es inalcanzable (`obtenerOCrearUsuario` hace `select('*')` o lanza). Este test
   * existe para que el día que alguien acote ese select, no quede bendecido.
   */
  it('una fila parcial no afirma nada y se loguea como bug del llamador', async () => {
    const errores = [];
    const log = require('../../lib/logger');
    const orig = log.error;
    log.error = (...a) => { errores.push(a); };
    try {
      const r = await estadoCuenta({ id: 'u6', nombre: 'Fer', plan: 'free' });
      expect(r).toContain('Plan: *Gratis*');
      expect(r).not.toContain('solo registro');
      expect(r, 'a una fila parcial le ofrece una prueba que quizá ya gastó').not.toMatch(/se activa con tu primer gasto/);
    } finally {
      log.error = orig;
    }
    expect(errores.length, 'la fila parcial pasó en silencio').toBeGreaterThan(0);
    expect(JSON.stringify(errores)).toMatch(/trial_estado/);
  });
});

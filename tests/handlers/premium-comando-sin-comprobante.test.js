import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresión de la auditoría 2026-08-04. Al delegar el comando `/premium` al intent
// `ver_premium` (fix M2: el comando le decía "Tu plan NETO Pro" a cualquiera, incluido
// el del muro) se arrastró sin querer su EFECTO LATERAL: `solicitarComprobante`, que abre
// 48h en las que toda foto se interpreta como comprobante de pago.
//
// Por qué eso importa tanto: en la rama `esperaComprobante` de webhook.js, una captura que
// NO parece el pago a Neto se responde con "esa captura no parece el pago" y **retorna sin
// registrar el gasto**. O sea que un usuario en el muro que tipea /premium por curiosidad
// pierde el registro por foto durante 48h — y registrar es la única cosa que el muro le
// deja hacer ("escribir nunca se corta" es la promesa que no se negocia).
//
// El texto y el efecto lateral quedaron separados: `mensajeVerPremium` es puro, y solo el
// intent NLP (donde "quiero pro" SÍ es intención de pago) llama a solicitarComprobante.

const { mensajeVerPremium, pideComprobante } = require('../../handlers/intents/premium');

const EN_TRIAL = { id: 'u1', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-17' };
const PAGADO = { id: 'u2', plan: 'premium', trial_estado: 'convertido', tipo_plan: 'mensual', premium_vence: '2026-09-01' };
const EN_MURO = { id: 'u3', plan: 'free', trial_estado: 'vencido' };

describe('mensajeVerPremium: tres ramas, cero efectos', () => {
  it('al del trial le dice que está PROBANDO, con fecha y precio (no "ya eres Pro")', () => {
    const m = mensajeVerPremium(EN_TRIAL);
    expect(m).toContain('Estás probando');
    expect(m).toContain('S/10');
    expect(m).not.toContain('Tu plan NETO Pro');
  });

  it('al pagador le confirma su plan con vencimiento', () => {
    const m = mensajeVerPremium(PAGADO);
    expect(m).toContain('Tu plan NETO Pro');
    expect(m).toContain('Mensual');
  });

  // El bug original de M2: el comando inline respondía esto mismo al del muro.
  it('al del muro le da el PITCH con precio y forma de pago, no un "ya eres Pro"', () => {
    const m = mensajeVerPremium(EN_MURO);
    expect(m).not.toContain('Tu plan NETO Pro');
    expect(m).toContain('S/10');
    expect(m).toContain('Yapea');
  });

  // Contraprueba de que el copy no se quedó pegado al freemium muerto ("no solo 1 mes"
  // era el límite del plan Free que ya no existe).
  it('el pitch no promete límites del freemium derogado', () => {
    expect(mensajeVerPremium(EN_MURO)).not.toContain('no solo 1 mes');
  });
});

describe('pideComprobante: solo la rama de pitch arma la espera de 48h', () => {
  it('el del muro sí (es a quien el intent NLP le pide la captura)', () => {
    expect(pideComprobante(EN_MURO)).toBe(true);
  });

  it('el del trial NO — está mandando fotos de Yapes para REGISTRAR', () => {
    expect(pideComprobante(EN_TRIAL)).toBe(false);
  });

  it('el pagador NO — ya pagó', () => {
    expect(pideComprobante(PAGADO)).toBe(false);
  });
});

describe('guard: el comando /premium no puede arrastrar el efecto lateral', () => {
  const webhook = fs.readFileSync(path.join(projectRoot, 'handlers/webhook.js'), 'utf8');

  // Antivacuidad: si el comando desaparece o se renombra, este test debe romperse en vez
  // de pasar por no encontrar nada.
  it('la rama del comando existe y usa el builder puro', () => {
    expect(webhook).toContain("cmd === '/premium'");
    expect(webhook).toContain('premiumIntents.mensajeVerPremium(usuario)');
  });

  it('el comando NO llama al handler del intent (que sí tiene el efecto lateral)', () => {
    const rama = webhook.slice(webhook.indexOf("cmd === '/premium'"));
    const hastaElSiguiente = rama.slice(0, rama.indexOf('} else if'));
    expect(hastaElSiguiente).not.toContain('premiumIntents.handle');
    expect(hastaElSiguiente).not.toContain('solicitarComprobante');
  });

  // webhook.js no debe poder setear la espera por su cuenta en la cascada de comandos.
  it('webhook.js no importa solicitarComprobante', () => {
    expect(webhook).not.toContain('solicitarComprobante');
  });
});

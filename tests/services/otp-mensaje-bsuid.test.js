import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mensajeOtpBsuid } = require('../../services/otp-sin-numero');

/**
 * Lo que recibe por WhatsApp quien manda su código sin número visible (12-sep-2026).
 *
 * Las dos reglas que deciden todo: un fallo NUESTRO dice "reenvíamelo, sigue siendo válido" (el
 * código quedó vivo a propósito) y un código malo manda a generar otro. Invertirlas manda a
 * repetir el trámite a quien no hizo nada mal, o a reintentar para siempre a quien sí.
 */
const REENVIA = /sigue siendo válido/;
const GENERA_OTRO = /genera uno nuevo/;

describe('mensajeOtpBsuid', () => {
  it.each(['vinculada', 'fusionada', 'adoptada'])('%s: confirma el vínculo, con el primer nombre', (estado) => {
    const m = mensajeOtpBsuid({ estado, nombre: 'Julio Mejia' });
    expect(m).toMatch(/^✅ Julio, tu cuenta web quedó verificada y vinculada/);
  });

  it('sin nombre no deja una coma colgando', () => {
    expect(mensajeOtpBsuid({ estado: 'vinculada' })).toMatch(/^✅ Tu cuenta web/);
  });

  it('ya_vinculada: dice que ya lo estaba', () => {
    expect(mensajeOtpBsuid({ estado: 'ya_vinculada', nombre: 'Ana' })).toMatch(/ya está verificada/);
  });

  it.each(['invalido', 'sin_cuenta_web'])('%s: manda a generar otro, no a reenviar', (estado) => {
    const m = mensajeOtpBsuid({ estado });
    expect(m).toMatch(GENERA_OTRO);
    expect(m).not.toMatch(REENVIA);
  });

  it.each(['lectura_fallida', 'error', 'vinculada_sin_destrabar'])('%s: el fallo es nuestro, que reenvíe', (estado) => {
    const m = mensajeOtpBsuid({ estado });
    expect(m).toMatch(REENVIA);
    expect(m).not.toMatch(GENERA_OTRO);
  });

  it('un estado nuevo cae del lado de "reenvíamelo": el código se trata como vivo', () => {
    expect(mensajeOtpBsuid({ estado: 'algo_que_no_existe_hoy' })).toMatch(REENVIA);
  });

  it('conflicto: a soporte', () => {
    expect(mensajeOtpBsuid({ estado: 'conflicto' })).toMatch(/soporte/);
  });
});

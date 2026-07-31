import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// El token de activación es la única puerta entre "alguien abrió un link" y
// "vinculamos una cuenta de Neto a una cuenta de Google". Si se puede forjar o
// si acepta uno vencido, cualquiera se queda con la cuenta de otro. Estos tests
// son el espejo de tests/gmail-oauth-state.test.js, que cubre el mismo patrón.

const SECRETO = 'secreto-de-prueba-para-activacion';

function cargarModulo(secreto) {
  process.env.ACTIVATION_TOKEN_SECRET = secreto;
  const ruta = require.resolve('../../lib/activacion');
  delete require.cache[ruta];
  return require('../../lib/activacion');
}

let activacion;

beforeEach(() => {
  activacion = cargarModulo(SECRETO);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ACTIVATION_TOKEN_SECRET;
});

describe('token de activación — round-trip', () => {
  it('un token recién firmado se verifica y devuelve el uid', () => {
    const token = activacion.construirTokenActivacion('u-123');
    expect(activacion.verificarTokenActivacion(token)).toMatchObject({ uid: 'u-123' });
  });

  it('el link apunta a la webapp con el token en `t`', () => {
    const link = activacion.construirLinkActivacion('u-123');
    expect(link).toMatch(/^https:\/\/app\.neto\.pe\/activar\?t=/);
    const token = link.split('t=')[1];
    expect(activacion.verificarTokenActivacion(token).uid).toBe('u-123');
  });

  it('el payload NO lleva número ni email (el link puede terminar en un screenshot)', () => {
    const token = activacion.construirTokenActivacion('u-123');
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['ts', 'uid']);
  });
});

describe('token de activación — rechazos', () => {
  it('rechaza una firma alterada', () => {
    const token = activacion.construirTokenActivacion('u-123');
    const [payload, firma] = token.split('.');
    const alterada = firma.slice(0, -1) + (firma.slice(-1) === 'A' ? 'B' : 'A');
    expect(activacion.verificarTokenActivacion(payload + '.' + alterada)).toBeNull();
  });

  it('rechaza un payload alterado (cambiar el uid invalida la firma)', () => {
    const token = activacion.construirTokenActivacion('u-123');
    const firma = token.split('.')[1];
    const otroPayload = Buffer.from(JSON.stringify({ uid: 'u-999', ts: Date.now() })).toString('base64url');
    expect(activacion.verificarTokenActivacion(otroPayload + '.' + firma)).toBeNull();
  });

  it('rechaza un token firmado con otro secreto', () => {
    const ajeno = cargarModulo('otro-secreto-distinto').construirTokenActivacion('u-123');
    activacion = cargarModulo(SECRETO);
    expect(activacion.verificarTokenActivacion(ajeno)).toBeNull();
  });

  it('rechaza un token vencido', () => {
    const token = activacion.construirTokenActivacion('u-123');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + activacion.TOKEN_TTL_MS + 1000);
    expect(activacion.verificarTokenActivacion(token)).toBeNull();
  });

  it('rechaza basura, vacío y formatos raros sin reventar', () => {
    for (const malo of [null, undefined, '', 'sin-punto', '.', 'a.b', {}, 123]) {
      expect(activacion.verificarTokenActivacion(malo)).toBeNull();
    }
  });

  it('sin secreto configurado no firma NI verifica (falla cerrada)', () => {
    const sinSecreto = cargarModulo('');
    expect(sinSecreto.construirTokenActivacion('u-123')).toBeNull();
    expect(sinSecreto.construirLinkActivacion('u-123')).toBeNull();
    // Y no acepta un token que sí fue firmado con un secreto real.
    const valido = cargarModulo(SECRETO).construirTokenActivacion('u-123');
    expect(cargarModulo('').verificarTokenActivacion(valido)).toBeNull();
  });
});

describe('cadencia del empujón (nudgeActivacion)', () => {
  const sinActivar = { id: 'u-123', nombre: 'Ana Prueba' };

  it('no empuja a quien ya activó su cuenta', () => {
    expect(activacion.nudgeActivacion({ ...sinActivar, supabase_auth_id: 'auth-1' }, 5)).toBeNull();
  });

  it('no empuja a quien todavía no registró nada (el link no tendría qué mostrar)', () => {
    expect(activacion.nudgeActivacion(sinActivar, 0)).toBeNull();
    expect(activacion.nudgeActivacion(sinActivar, undefined)).toBeNull();
  });

  it('primer gasto → saluda y manda el link', () => {
    const texto = activacion.nudgeActivacion(sinActivar, 1);
    expect(texto).toMatch(/primer gasto/i);
    expect(texto).toContain('/activar?t=');
  });

  it('antes del corte → una línea al pie, no un bloque', () => {
    const texto = activacion.nudgeActivacion(sinActivar, 2);
    expect(texto).toContain('/activar?t=');
    expect(texto.split('\n').filter(Boolean).length).toBeLessThan(4);
  });

  it('en el corte (3er gasto) → escala a bloque, nombrando cuántos lleva', () => {
    const texto = activacion.nudgeActivacion(sinActivar, activacion.CORTE_TX);
    expect(texto).toMatch(new RegExp(activacion.CORTE_TX + ' gastos'));
    expect(texto).toContain('/activar?t=');
    expect(texto.length).toBeGreaterThan(activacion.nudgeActivacion(sinActivar, 2).length);
  });

  it('sigue empujando después del corte (hasta que active)', () => {
    expect(activacion.nudgeActivacion(sinActivar, 12)).toContain('/activar?t=');
  });

  it('sin secreto no inventa un link roto: no empuja', () => {
    expect(cargarModulo('').nudgeActivacion(sinActivar, 3)).toBeNull();
  });
});

describe('mensaje del día 2', () => {
  it('nombra al usuario y cuenta sus gastos', () => {
    const texto = activacion.mensajeActivacionDia2({ id: 'u-1', nombre: 'Ana Prueba' }, 2);
    expect(texto).toMatch(/Ana/);
    expect(texto).toMatch(/2 gastos/);
    expect(texto).toContain('/activar?t=');
  });

  it('funciona sin nombre (el nombre es salteable en el alta)', () => {
    const texto = activacion.mensajeActivacionDia2({ id: 'u-1', nombre: null }, 1);
    expect(texto).toMatch(/primer gasto/i);
    expect(texto).not.toMatch(/null/);
  });
});

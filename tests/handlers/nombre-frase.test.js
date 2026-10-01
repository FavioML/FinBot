import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Clase 7 de "respuestas malas del día 0" (30-sep-2026), en los dos sitios que escriben
 * `usuarios.nombre`: el paso 100 del alta y el intent `cambiar_nombre`. La guarda en sí está
 * probada contra el corpus real en `tests/lib/nombres.test.js`; acá se prueba que los dos
 * sitios la CONSULTAN y qué hacen con el rechazo, mirando la fila y no el copy.
 *
 * El almacén tiene DOS filas: un update que pierda su `.eq('id', …)` pisa la otra y se nota.
 */

require('../../lib/analytics').capture = vi.fn();

let filas;
const supabase = {
  from(tabla) {
    let patch = null;
    const filtros = [];
    const b = {
      update(p) { patch = p; return b; },
      select() { return b; },
      eq(c, v) { filtros.push([c, v]); return b; },
      then(ok, ko) {
        const objetivo = (filas[tabla] || []).filter((f) => filtros.every(([c, v]) => f[c] === v));
        if (patch) for (const f of objetivo) Object.assign(f, patch);
        return Promise.resolve({ data: objetivo.map((f) => ({ id: f.id })), error: null }).then(ok, ko);
      },
    };
    return b;
  },
};
require('../../lib/db').supabase = supabase;

const { manejarOnboarding } = require('../../handlers/onboarding');
const utilidades = require('../../handlers/intents/utilidades');

const fila = (id) => filas.usuarios.find((f) => f.id === id);

beforeEach(() => {
  filas = {
    usuarios: [
      { id: 'u1', whatsapp: '+51999', nombre: null, nombre_intentos: 0, onboarding_paso: 100, onboarding_completado: false },
      { id: 'u-otro', whatsapp: '+51888', nombre: 'Otro', nombre_intentos: 0, onboarding_paso: 0, onboarding_completado: true },
    ],
  };
});

async function alta(msg) {
  const usuario = { ...fila('u1') };
  return manejarOnboarding({ usuario, msg, cmd: msg.toLowerCase().trim() });
}

describe('alta (paso 100): una frase no se guarda como nombre', () => {
  it.each(['Como funciona?', 'Quisiera registrarme', 'Debe estar en apuros económicos.'])(
    '"%s" (real) → no guarda, repregunta una vez, el alta sigue abierta', async (msg) => {
      const res = await alta(msg);
      expect(fila('u1').nombre).toBeNull();
      expect(fila('u1').nombre_intentos).toBe(1);
      expect(fila('u1').onboarding_completado).toBe(false);
      expect(res).toMatch(/No pillé tu nombre/);
      expect(res).not.toMatch(/¡Listo/);
    });

  it('la segunda frase cierra el alta SIN nombre (nadie queda trabado)', async () => {
    await alta('Como funciona?');
    const res = await alta('Quisiera registrarme');
    expect(fila('u1').nombre).toBeNull();
    expect(fila('u1').onboarding_completado).toBe(true);
    expect(res).toMatch(/^¡Listo! 🤝/);
  });

  it('control: después de la repregunta, el nombre real entra', async () => {
    await alta('Como funciona?');
    const res = await alta('Ana');
    expect(fila('u1').nombre).toBe('Ana');
    expect(fila('u1').onboarding_completado).toBe(true);
    expect(res).toMatch(/¡Listo, \*Ana\*!/);
  });

  it.each([
    ['María Laura', 'María Laura'],
    ['Mi nombre es Rubén Campo Verde.', 'Rubén Campo Verde'],
    ['Soy victor zegarra', 'Victor Zegarra'],
    ['Ines Garcia', 'Ines Garcia'],
  ])('nombre real "%s" → guarda "%s" al primer intento', async (msg, esperado) => {
    await alta(msg);
    expect(fila('u1').nombre).toBe(esperado);
    expect(fila('u1').nombre_intentos).toBe(0);
    expect(fila('u-otro').nombre).toBe('Otro');
  });
});

describe('cambiar_nombre: el nombre del modelo tiene que estar escrito y pedido', () => {
  const renombrar = (nombre_nuevo, msg) => {
    filas.usuarios[0].nombre = 'Gerson';
    return utilidades.handle({
      intencion: 'cambiar_nombre', msg, datos: { nombre_nuevo }, usuario: { ...fila('u1') },
      from: '+51999', ctx: { supabase },
    });
  };

  it.each([
    ['Nvf', 'Esto lo quiero usar para mi negocio de consultoría. Lo podemos personalizar?'],
    ['Nvf', 'Mis categorías de gastos son de empresa'],
    ['Hola', 'hola, puedes cambiarme de nombre?'],
    ['Negocio', 'Esto lo quiero usar para mi negocio'],
  ])('"%s" desde "%s" → no cambia y dice cómo pedirlo', async (nombre, msg) => {
    const res = await renombrar(nombre, msg);
    expect(fila('u1').nombre).toBe('Gerson');
    expect(res).toMatch(/No cambié tu nombre/);
    expect(res).toMatch(/llámame Ana/);
    expect(res).not.toMatch(/ahora te llamo/);
  });

  it.each([
    ['Ana', 'llámame Ana', 'Ana'],
    ['annie', 'soy Annie', 'Annie'],
    ['Ana María', 'Ana María', 'Ana María'],
  ])('control: "%s" desde "%s" → cambia a %s', async (nombre, msg, esperado) => {
    const res = await renombrar(nombre, msg);
    expect(fila('u1').nombre).toBe(esperado);
    expect(fila('u-otro').nombre).toBe('Otro');
    expect(res).toMatch(new RegExp('ahora te llamo \\*' + esperado + '\\*'));
  });
});

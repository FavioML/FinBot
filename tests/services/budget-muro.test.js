import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

/**
 * B9 — la alerta de presupuesto pegada al gasto entregaba un agregado gratis.
 *
 * "Llevas S/450 de tus S/500 en Alimentación (90%)" es una lectura agregada sobre el mes, o
 * sea justo lo que el muro cobra. Se colaba porque los presupuestos se crean DURANTE el
 * trial y su alerta seguía disparando para siempre después del día 15: el usuario del muro
 * conservaba un pedazo del dashboard, pegado a cada gasto que anotaba.
 *
 * Lo que NO cambia: escribir. El gasto ya está registrado cuando esto corre; lo único que
 * se calla es el número.
 *
 * El único agregado que sobrevive al muro es el total del mes en la cola de la confirmación
 * (`colaConfirmacionGasto`), y es una decisión explícita del modelo comercial. Este no es
 * ese, y no había nada que lo distinguiera.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

// Presupuesto de S/100 en Alimentación con S/95 gastados: la alerta del 80% dispara seguro.
const PRESUPUESTOS = [{ categoria: 'Alimentación', subcategoria: null, monto_limite: 100, alerta_porcentaje: 80 }];
const GASTOS = [{ monto: 95, monto_pen: 95, categoria: 'Alimentación', subcategoria: 'mercado' }];

const dbMock = {
  supabase: {
    from: (table) => {
      const data = table === 'presupuestos' ? PRESUPUESTOS : GASTOS;
      const chain = new Proxy({}, {
        get(_t, p) {
          if (p === 'then') return (res, rej) => Promise.resolve({ data, error: null }).then(res, rej);
          return () => chain;
        },
      });
      return chain;
    },
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { verificarAlertaPresupuesto } = require('../../services/budget');

beforeEach(() => { logMock.error.mockClear(); });

describe('verificarAlertaPresupuesto: quién ve el agregado', () => {
  it('el Pro PAGADO ve su alerta', async () => {
    const r = await verificarAlertaPresupuesto(
      { id: 'u1', plan: 'premium', trial_estado: 'convertido' }, 'Alimentación', 'mercado');
    expect(r).toMatch(/Alimentación/);
    expect(r).toMatch(/95/);
  });

  it('el que está en TRIAL también: el trial entrega Pro completo', async () => {
    const r = await verificarAlertaPresupuesto(
      { id: 'u1', plan: 'premium', trial_estado: 'activo' }, 'Alimentación', 'mercado');
    expect(r).toMatch(/Alimentación/);
  });

  // El caso del hallazgo.
  it('el del MURO no la ve', async () => {
    const r = await verificarAlertaPresupuesto(
      { id: 'u1', plan: 'free', trial_estado: 'vencido' }, 'Alimentación', 'mercado');
    expect(r).toBeNull();
  });

  it('el que nunca estrenó su prueba tampoco (plan free)', async () => {
    const r = await verificarAlertaPresupuesto(
      { id: 'u1', plan: 'free', trial_estado: null }, 'Alimentación', 'mercado');
    expect(r).toBeNull();
  });

  // Fail-closed: un gate que ante la duda entrega no es un gate.
  it('un usuarioId suelto (la firma vieja) NO entrega la alerta, y se loguea', async () => {
    const r = await verificarAlertaPresupuesto('u1', 'Alimentación', 'mercado');
    expect(r).toBeNull();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('una fila sin id tampoco', async () => {
    const r = await verificarAlertaPresupuesto({ plan: 'premium' }, 'Alimentación', 'mercado');
    expect(r).toBeNull();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('null / undefined no revientan', async () => {
    expect(await verificarAlertaPresupuesto(null, 'Alimentación', null)).toBeNull();
    expect(await verificarAlertaPresupuesto(undefined, 'Alimentación', null)).toBeNull();
  });
});

/**
 * Guard estático. El unit prueba que el gate corta; esto prueba que ningún call-site lo
 * esquiva pasando el id. La firma vieja (`usuario.id`) sigue siendo válida en JavaScript:
 * la función recibiría un string, y sin este guard el fail-closed convertiría el bug de
 * "agregado gratis" en el bug silencioso de "el Pro pagado dejó de ver su alerta".
 */
describe('ningún call-site pasa el id en vez de la fila', () => {
  const RUNTIME = ['handlers', 'services', 'lib', 'routes', 'cron'];

  function archivosJs(dir) {
    const out = [];
    const abs = path.join(projectRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...archivosJs(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }

  const llamadas = [];
  for (const dir of RUNTIME) {
    for (const rel of archivosJs(dir)) {
      const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
      for (const m of src.matchAll(/verificarAlertaPresupuesto\(\s*([^,)]+)/g)) {
        // La declaración de la función y las líneas de import/export no son llamadas.
        if (/^\s*(usuario|usuarioId)\s*$/.test(m[1]) && /function verificarAlertaPresupuesto/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue;
        llamadas.push({ rel, arg: m[1].trim() });
      }
    }
  }

  // Antivacuidad: si el barrido no encuentra llamadas, todo lo de abajo pasa por vacío.
  it('el barrido encuentra las llamadas reales', () => {
    const conArg = llamadas.filter(l => l.arg && !/^\)/.test(l.arg));
    expect(conArg.length, 'no encontré ninguna llamada: el barrido está roto').toBeGreaterThanOrEqual(5);
    // Y las encuentra en los tres archivos que de verdad la llaman.
    const archivos = new Set(conArg.map(l => l.rel.replace(/\\/g, '/')));
    expect(archivos.has('handlers/message-processor.js')).toBe(true);
    expect(archivos.has('handlers/intents/transacciones.js')).toBe(true);
    expect(archivos.has('services/notifications.js')).toBe(true);
  });

  it('ninguna pasa `algo.id`', () => {
    const malas = llamadas.filter(l => /\.id\s*$/.test(l.arg));
    expect(malas, 'pasan el id en vez de la fila: ' + JSON.stringify(malas)).toEqual([]);
  });

  it('ninguna pasa un literal de string', () => {
    const malas = llamadas.filter(l => /^['"`]/.test(l.arg));
    expect(malas, JSON.stringify(malas)).toEqual([]);
  });

  /**
   * El gate lee `usuario.plan`, y una fila que no traiga esa columna da
   * `undefined !== 'premium'` → fail-closed. Eso es lo correcto ante la duda, pero significa
   * que un `select` incompleto deja al Pro PAGADO sin su alerta **en silencio**: el modo de
   * falla más caro de detectar, y exactamente la regla del CLAUDE.md ("una fila parcial no
   * puede decidir"). Los tres call-sites traen la fila entera hoy; esto lo fija.
   * Lo señaló la segunda revisión adversarial.
   */
  it('las filas que alimentan el gate traen la columna `plan`', () => {
    const fuentes = [
      // [archivo, qué produce la fila que llega a verificarAlertaPresupuesto]
      ['helpers/db-helpers.js', /obtenerOCrearUsuario[\s\S]{0,600}?from\('usuarios'\)\s*\.select\('\*'\)/],
      ['services/gmail-scanner.js', /from\('usuarios'\)\s*\.select\('\*'\)/],
    ];
    for (const [rel, rx] of fuentes) {
      const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
      expect(rx.test(src), `${rel} dejó de traer la fila completa: el gate del muro decidiría con plan=undefined`).toBe(true);
    }
  });
});

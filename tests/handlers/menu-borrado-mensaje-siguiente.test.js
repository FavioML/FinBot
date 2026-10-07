import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El menú de ELIMINAR LA CUENTA (07-oct-2026, corrida de `qa-e2e/qa-dia0-respuestas.mjs`).
 *
 * Dos arreglos con el mismo origen. Uno: el mensaje que sigue al menú ya no se pierde, se procesa
 * con el menú cerrado (`handlers/onboarding.js`, paso -1) y en ese turno NO se borra nada; acá se
 * prueba la mitad del pipeline, que es donde vive el freno (`dispatchIntent`). La mitad del webhook
 * está en `webhook-onboarding.test.js`. Dos: el menú se abre solo con un pedido explícito de la
 * cuenta (`pideCuentaExplicita`), y "empecemos de cero, cancela todo" recibe el texto de
 * `reiniciar_o_borrar`. Decidido por Favio con la medición en `docs/DEFECTOS.md`, 07-oct.
 */

// ─── Parchar singletons ANTES de requerir el SUT (patrón de datos-no-dichos-pipeline) ───
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../gmail').tieneGmailConectado = vi.fn().mockResolvedValue(false);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

// Los tres módulos que tienen intents que borran: su `handle` es un espía, así que "el handler
// corrió" es observable sin sembrar filas. El registry captura `mod.handle` al cargar, por eso va
// antes del require del SUT.
const handlerQueBorra = vi.fn(async ({ intencion }) => 'EJECUTADO ' + intencion);
for (const mod of ['transacciones', 'metas', 'presupuestos']) {
  require('../../handlers/intents/' + mod).handle = handlerQueBorra;
}

const escrituras = [];
const FILAS = { usuarios: [{ id: 'u-1' }] };
function chainPara(tabla) {
  let op = null;
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'in', 'is', 'not', 'neq', 'ilike', 'or', 'range', 'match', 'eq']) c[m] = vi.fn(() => c);
  for (const m of ['insert', 'update', 'upsert', 'delete']) c[m] = vi.fn((payload) => { op = m; escrituras.push({ tabla, op: m, payload }); return c; });
  const resolver = () => ({ data: op === 'insert' ? [{ id: 'nuevo' }] : (FILAS[tabla] || []), error: null, count: (FILAS[tabla] || []).length });
  c.single = vi.fn(async () => ({ data: (FILAS[tabla] || [])[0] || null, error: null }));
  c.maybeSingle = c.single;
  c.then = (onF, onR) => Promise.resolve().then(resolver).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn((t) => chainPara(t)), rpc: vi.fn(async () => ({ data: null, error: null })) };

let toolCall = null;
require('../../lib/ai').openai = { chat: { completions: { create: vi.fn(async () => ({
  choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } }],
})) } } };

const { procesarMensajeLibre } = require('../../handlers/message-processor');
const { dispatchIntent, listIntents } = require('../../handlers/intent-registry');
const { INTENTS_QUE_BORRAN, pideCuentaExplicita } = require('../../lib/nlp-guards');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01', onboarding_completado: true };
const abreElMenu = () => escrituras.some((e) => e.tabla === 'usuarios' && e.op === 'update' && e.payload && e.payload.onboarding_paso === -1);

beforeEach(() => {
  escrituras.length = 0;
  handlerQueBorra.mockClear();
});

describe('el turno que sigue al menú de la cuenta no borra nada', () => {
  // Se decide por EFECTO (segunda revisión del 07-oct): un inventario por nombre se evadía con un
  // `vaciar_*`, y uno declarado a mano fijaba una clasificación sin validarla (frenaba una lectura).
  // Acá se lee el código: todo `.delete(` y todo `.rpc(` de `handlers/intents/` se atribuye al `case`
  // o a la función de nivel superior que lo contiene, y tiene que caer en un intent que el freno para
  // o en una exención con motivo, con su CONTEO fijado (una exención por nombre de función, no "todo
  // lo que esté fuera de un case": así se colaba un helper nuevo, tercera revisión del 07-oct).
  // LÍMITE declarado: un DELETE escondido en un servicio que el handler llama no se ve; lo cubre a
  // medias `menu-borrado-base.test.js`, que mira la base con handlers reales. Un `.update` que
  // esconde una fila tampoco: el freno es sobre DELETE, a propósito.
  const EXENTOS = {
    'deudas.js:registrar_deuda': 'borra la anotación opuesta reciente; con sinBorrados la salta (menu-borrado-base.test.js)',
    'deudas.js:dividir_gasto_grupal': 'compensación: deshace el gasto compartido que este mismo mensaje insertó cuando el resto falló',
    'transacciones.js:restaurar_eliminado': 'limpia la exclusión de Gmail del gasto que se está DEVOLVIENDO',
    'transacciones.js:fn descartarSnapshot': 'compensación por id de la copia que este mismo mensaje escribió',
  };
  // Cuántos DELETE hay detrás de cada exención: uno más en el mismo sitio también tiene que decidirse.
  const CONTEO_EXENTO = { 'deudas.js:registrar_deuda': 1, 'deudas.js:dividir_gasto_grupal': 1, 'transacciones.js:restaurar_eliminado': 1, 'transacciones.js:fn descartarSnapshot': 1 };
  function deletesPorIntent() {
    const dir = require('path').join(__dirname, '../../handlers/intents');
    const vistos = [];
    for (const f of require('fs').readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = require('fs').readFileSync(require('path').join(dir, f), 'utf8');
      // `.delete(`, `['delete'](` y `.rpc(` (una función de la base puede borrar sin decir delete).
      for (const m of src.matchAll(/\.delete\s*\(|\[\s*['"`]delete['"`]\s*\]|\.rpc\s*\(/g)) {
        const antes = src.slice(0, m.index);
        const caso = [...antes.matchAll(/case\s+['"`]([a-z_]+)['"`]\s*:/g)].pop();
        const fn = [...antes.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)].pop();
        // Lo que esté más cerca hacia arriba: un helper declarado después del switch no hereda su último case.
        const dueño = !caso && !fn ? '(sin dueño)' : (!fn || (caso && caso.index > fn.index)) ? caso[1] : 'fn ' + fn[1];
        vistos.push(f + ':' + dueño);
      }
    }
    return vistos;
  }

  it('todo DELETE de handlers/intents cae en un intent frenado o en una exención con motivo', () => {
    const vistos = deletesPorIntent();
    expect(vistos.length).toBeGreaterThanOrEqual(7);
    const sueltos = vistos.filter((k) => !INTENTS_QUE_BORRAN.has(k.split(':')[1]) && !EXENTOS[k]);
    expect(sueltos).toEqual([]);
    // Una exención que ya no corresponde a ningún DELETE es basura que tapa el próximo.
    for (const k of Object.keys(EXENTOS)) expect(vistos.filter((v) => v === k).length, k).toBe(CONTEO_EXENTO[k]);
  });

  it('el freno nombra las dos órdenes exactas y no pide repetir', async () => {
    const r = await dispatchIntent({ intencion: 'deshacer_ultimo', msg: 'sí, bórrala ya', datos: {}, usuario: USUARIO, from: '51999', ctx: { sinBorrados: true } });
    expect(r.respuesta).toContain('*borra el último*');
    expect(r.respuesta).toContain('*borrar mi cuenta*');
    expect(r.respuesta).toContain('*confirmo borrar mi cuenta*');
    expect(r.respuesta).not.toMatch(/otra vez|de nuevo/);
  });

  it('cada intent del freno está registrado (un nombre mal escrito no frena nada)', () => {
    for (const i of INTENTS_QUE_BORRAN) expect(listIntents()).toContain(i);
  });

  // Lo que la primera versión frenaba de más: cerrar o saldar no es borrar, y "sí, ya me pagó" al
  // cron de deudas tiene que procesarse aunque el menú estuviera abierto.
  for (const intencion of ['abandonar_plan', 'saldar_todo_contraparte', 'marcar_deuda_pagada', 'consolidar_deudas', 'liquidar_espacio', 'registrar_deuda', 'abonar_deuda']) {
    it(`${intencion} NO está en el freno`, () => {
      expect(INTENTS_QUE_BORRAN.has(intencion)).toBe(false);
    });
  }

  // Cada mensaje nombra lo que borra: si no, la guarda de datos no dichos pregunta y el control no
  // llegaría al handler por otra condición.
  for (const [intencion, msg, datos] of [
    ['eliminar_transaccion', 'borra el gasto de 15 en taxi', { monto: 15, comercio: 'taxi' }],
    ['deshacer_ultimo', 'borra el último', {}],
    ['eliminar_meta', 'elimina la meta Viaje', { nombre: 'Viaje' }],
    ['eliminar_presupuesto', 'elimina el presupuesto de Comida', { categoria: 'Comida' }],
  ]) {
    it(`${intencion}: con sinBorrados no se despacha; sin la marca sí (control)`, async () => {
      const base = { intencion, msg, datos, usuario: USUARIO, from: '51999' };
      const frenado = await dispatchIntent({ ...base, ctx: { sinBorrados: true } });
      expect(handlerQueBorra).not.toHaveBeenCalled();
      expect(frenado.respuesta).toMatch(/^No borré nada/);
      const control = await dispatchIntent({ ...base, ctx: {} });
      expect(handlerQueBorra).toHaveBeenCalledTimes(1);
      expect(control.respuesta).toBe('EJECUTADO ' + intencion);
    });
  }

  it('un intent que no borra se despacha igual con la marca (el turno se procesa)', async () => {
    const r = await dispatchIntent({ intencion: 'registrar_manual', msg: 'gasté 7 en pan', datos: {}, usuario: USUARIO, from: '51999', ctx: { sinBorrados: true } });
    expect(r.respuesta).toBe('EJECUTADO registrar_manual');
  });

  // La marca tiene que VIAJAR desde procesarMensajeLibre hasta el dispatch: el webhook la pasa
  // como cuarto argumento y message-processor la pone en ctx.
  it('por el pipeline: "borra el último gasto" con sinBorrados contesta sin ejecutar; sin la marca ejecuta', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'undo' } };
    const frenado = await procesarMensajeLibre('borra el último gasto', { ...USUARIO }, '51999', { sinBorrados: true });
    expect(frenado).toMatch(/^No borré nada/);
    expect(handlerQueBorra).not.toHaveBeenCalled();
    const control = await procesarMensajeLibre('borra el último gasto', { ...USUARIO }, '51999');
    expect(control).toBe('EJECUTADO deshacer_ultimo');
  });
});

describe('el turno sin borrados, mirando la BASE y no el espía', () => {
  // Revisión adversarial del 07-oct: un mensaje compuesto en ese turno. El freno contesta "pídemelo de
  // nuevo", y si la otra mitad se registraba, el "borra el último" repetido borraba ESO.
  it('"borra el último y registra 100 en comida": no borra y tampoco anota la otra mitad', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'undo' } };
    const r = await procesarMensajeLibre('borra el último y registra 100 en comida', { ...USUARIO }, '51999', { sinBorrados: true });
    expect(r).toMatch(/^No borré nada/);
    expect(r).toMatch(/no lo anoté todavía/);
    expect(handlerQueBorra).not.toHaveBeenCalled();
  });

  // El corpus contra la BASE vive en `menu-borrado-base.test.js`: acá los handlers que borran son espías.
});

describe('el menú de eliminar la cuenta se abre solo con un pedido explícito', () => {
  for (const msg of ['empecemos de cero, cancela todo', 'Quiero reiniciar', 'borra todo y empezamos otra vez', 'quiero empezar desde cero']) {
    it(`"${msg}" clasificado como desconectar_cuenta NO abre el menú: recibe el texto de reiniciar`, async () => {
      toolCall = { name: 'manage_account', args: { action: 'disconnect' } };
      const r = await procesarMensajeLibre(msg, { ...USUARIO }, '51999');
      expect(abreElMenu()).toBe(false);
      expect(r).toMatch(/no tengo un botón para reiniciar/);
      expect(r).toContain('*borrar mi cuenta*');
    });
  }

  for (const msg of ['Quiero eliminar mi cuenta', 'borra mi cuenta', 'Borra todos los datos', 'desconecta mi gmail', 'quiero darme de baja', 'quita mi correo',
    'quita mi email', 'saca mi mail', 'borra mis cuentas', 'elimíname', 'bórrame de neto', 'borra mi perfil', 'elimina mi usuario', 'borra toda mi información', 'delete my account', 'desvincula mi whatsapp']) {
    it(`"${msg}" sí abre el menú (control)`, async () => {
      toolCall = { name: 'manage_account', args: { action: 'disconnect' } };
      const r = await procesarMensajeLibre(msg, { ...USUARIO }, '51999');
      expect(abreElMenu()).toBe(true);
      expect(r).toMatch(/Eliminar tu cuenta/);
    });
  }

  // Bordes del predicado: tildes y mayúsculas no cambian la intención; "todo" o "cero" no nombran la cuenta.
  it('pideCuentaExplicita: bordes', () => {
    expect(pideCuentaExplicita('ELIMINA MIS DATOS')).toBe(true);
    expect(pideCuentaExplicita('desconéctame')).toBe(true);
    expect(pideCuentaExplicita('cancela todo')).toBe(false);
    expect(pideCuentaExplicita('empecemos de cero')).toBe(false);
    expect(pideCuentaExplicita(null)).toBe(false);
    // El borde final: "bajar" no es "baja", "cuentame" no es "cuenta".
    expect(pideCuentaExplicita('quiero bajar mis gastos')).toBe(false);
    expect(pideCuentaExplicita('cuentame algo')).toBe(false);
  });
});

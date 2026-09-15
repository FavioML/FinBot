import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * mlt-005 (QA agent, 15-sep-2026): "borra el último y registra 100 en comida".
 *
 * La continuación multi-intent se detecta DESPUÉS de despachar la primera parte, así que el
 * handler de borrado recibía el mensaje ENTERO. Dos consecuencias:
 *
 *   · la guarda compara la orden completa (`pideBorrarUnGasto`), y "borra el último y registra
 *     100 en comida" no es una orden canónica: Neto le pedía escribir "borra el último" a
 *     quien acababa de escribirlo, y registraba la comida igual;
 *   · el filtro de sujeto no dicho busca el monto EN el mensaje, así que un `monto: 100` del
 *     modelo contaba como dicho por el "100" de la otra mitad, y el borrado apuntaba a OTRO
 *     gasto de S/100.
 *
 * LA BASE TIENE ESTADO, a propósito. La primera versión de este archivo devolvía siempre la
 * misma "última" fila, y la revisión adversarial la evadió con la suite entera verde:
 * despachar el registro ANTES que el borrado hacía que "el último" fuera la comida recién
 * anotada, y el test no podía verlo. Acá registrar agrega una fila, borrar la quita, "el
 * último" es la última viva, y se afirma el ESTADO FINAL, no a quién se llamó.
 */

// ─── Parchar singletons ANTES de requerir el SUT (mismo patrón que muro-dispatch) ───
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

const parsers = require('../../services/parsers');
parsers.parsearRegistroManual = vi.fn();
require('../../services/categories').detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: null });
require('../../services/categories').asegurarCategoriaUsuario = vi.fn().mockResolvedValue('nada');
require('../../services/categories').crearSubcategoriaLibreUsuario = vi.fn().mockResolvedValue(null);
require('../../services/budget').verificarAlertaPresupuesto = vi.fn().mockResolvedValue(null);
require('../../lib/trial').colaConfirmacionGasto = vi.fn().mockResolvedValue('');

// ─── La base: las filas vivas del usuario, en orden de creación ───────────────
// Hay una comida VIEJA de S/100: es la que el borrado alcanzaba cuando el "100" de la otra
// mitad contaba como monto dicho. El último registro es el cine.
const TX_COMIDA_VIEJA = { id: 'tx-comida-vieja', usuario_id: 'u-1', monto: 100, moneda: 'PEN', comercio: 'comida', fecha: '2026-09-10', descripcion_original: null };
const TX_CINE = { id: 'tx-cine', usuario_id: 'u-1', monto: 75, moneda: 'PEN', comercio: 'cine', fecha: '2026-09-15', descripcion_original: null };
let filas = [];
const ids = () => filas.map((f) => f.id);

require('../../services/transactions').obtenerUltimaTransaccion = vi.fn(async () => filas[filas.length - 1] || null);
require('../../services/transactions').guardarTransaccion = vi.fn(async (_uid, datos) => {
  const nueva = { id: 'tx-nueva', usuario_id: 'u-1', monto: datos.monto, moneda: 'PEN', comercio: datos.comercio || 'comida', fecha: '2026-09-15', descripcion_original: null };
  filas.push(nueva);
  return { ...nueva, categoria: 'Alimentacion', subcategoria: 'sin_categoria', conteoTx: filas.length };
});

// Supabase con estado solo para `transacciones`: los filtros que usa el borrado (`eq`,
// `ilike`) se aplican de verdad, y un DELETE saca las filas que matchean. El resto de las
// tablas (snapshot de restauración, etc.) responde vacío.
function chainPara(tabla) {
  const q = { borrar: false, filtros: [] };
  const c = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'order', 'limit', 'gte', 'lte', 'in', 'is', 'not', 'neq']) c[m] = vi.fn(() => c);
  c.delete = vi.fn(() => { q.borrar = true; return c; });
  c.eq = vi.fn((col, val) => { q.filtros.push((f) => f[col] === val); return c; });
  c.ilike = vi.fn((col, pat) => {
    const aguja = String(pat).replace(/%/g, '').toLowerCase();
    q.filtros.push((f) => String(f[col] || '').toLowerCase().includes(aguja));
    return c;
  });
  const resolver = () => {
    if (tabla !== 'transacciones') return { data: null, error: null };
    const match = filas.filter((f) => q.filtros.every((fn) => fn(f)));
    if (q.borrar) {
      filas = filas.filter((f) => !match.includes(f));
      return { data: match.map((f) => ({ id: f.id })), error: null };
    }
    return { data: [...match].reverse(), error: null, count: match.length };
  };
  c.single = vi.fn(async () => { const r = resolver(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null }; });
  c.maybeSingle = c.single;
  c.then = (onF, onR) => Promise.resolve().then(resolver).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn((tabla) => chainPara(tabla)) };

// OpenAI: el clasificador maestro devuelve el tool call que fije cada test.
let toolCall = null;
const crearCompletion = vi.fn(async () => ({
  choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } }],
}));
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

// Qué mensaje recibe el handler de borrado: el defecto original vivía exactamente ahí.
const modTx = require('../../handlers/intents/transacciones.js');
const handleTxReal = modTx.handle;
const vistoPorElBorrado = [];
modTx.handle = async (args) => {
  if (args.intencion === 'eliminar_transaccion' || args.intencion === 'deshacer_ultimo') vistoPorElBorrado.push(args.msg);
  return handleTxReal(args);
};

const { procesarMensajeLibre } = require('../../handlers/message-processor');

const USUARIO = { id: 'u-1', nombre: 'Favio', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-09-29' };
const UNDO = { name: 'manage_transaction', args: { action: 'undo' } };
const DELETE = { name: 'manage_transaction', args: { action: 'delete' } };

beforeEach(() => {
  filas = [{ ...TX_COMIDA_VIEJA }, { ...TX_CINE }];
  vistoPorElBorrado.length = 0;
  parsers.parsearRegistroManual.mockReset();
  parsers.parsearRegistroManual.mockResolvedValue({
    ok: true, monto: 100, moneda: 'PEN', tipo: 'gasto', categoria: 'Alimentacion', subcategoria: null, fecha: null,
  });
});

describe('mlt-005 — el borrado de un mensaje compuesto ve solo su mitad', () => {
  // El estado final es el de mlt-005 en el QA agent: se fue el cine, quedó la comida nueva, y
  // la comida vieja sigue. Si el registro corriera ANTES que el borrado, "el último" sería la
  // comida nueva y el estado final tendría el cine: rojo.
  it.each([['deshacer_ultimo', UNDO], ['eliminar_transaccion', DELETE]])('%s: borra el cine y registra la comida', async (_n, tc) => {
    toolCall = tc;
    const r = await procesarMensajeLibre('borra el último y registra 100 en comida', USUARIO, '51999');
    expect(vistoPorElBorrado).toEqual(['borra el último']);
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-nueva']);
    expect(String(r)).not.toContain('Para confirmarlo');
  });

  // El caso caro: el modelo pone `monto: 100` en el delete. Con el mensaje entero, el "100" de
  // la otra mitad lo volvía un monto DICHO y el borrado se llevaba la comida vieja de S/100.
  it('un monto de la OTRA mitad no apunta el borrado a otro gasto', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'delete', monto: 100, comercio: 'comida' } };
    await procesarMensajeLibre('borra el último y registra 100 en comida', USUARIO, '51999');
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-nueva']);
  });

  // Control: partir el mensaje no puede aflojar la guarda. Sin conjunción no hay mitades, el
  // handler ve la frase entera, y una frase no canónica sigue pidiendo la orden.
  it('sin mensaje compuesto la guarda sigue pidiendo la orden y no toca nada', async () => {
    toolCall = UNDO;
    const r = await procesarMensajeLibre('no espera, bórralo', USUARIO, '51999');
    expect(vistoPorElBorrado).toEqual(['no espera, bórralo']);
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-cine']);
    expect(String(r)).toContain('¿Borro *cine*');
  });
});

/**
 * Hallazgo de la revisión adversarial: "no espera, bórralo y registra 100 en comida". La mitad
 * de borrado no es canónica y pide la orden nombrando el CINE; si la comida se registraba en el
 * mismo turno, pasaba a ser "el último", y la orden que la confirmación acababa de pedir
 * borraba la comida y dejaba el cine. La confirmación afirmaba algo falso.
 */
describe('si el borrado pidió la orden, la otra mitad espera', () => {
  it.each([['deshacer_ultimo', UNDO], ['eliminar_transaccion', DELETE]])('%s: no registra, lo dice, y la orden borra lo que se nombró', async (_n, tc) => {
    toolCall = tc;
    const r = await procesarMensajeLibre('no espera, bórralo y registra 100 en comida', USUARIO, '51999');
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-cine']);
    expect(parsers.parsearRegistroManual).not.toHaveBeenCalled();
    expect(String(r)).toContain('¿Borro *cine*');
    expect(String(r)).toContain('«registra 100 en comida» no lo anoté todavía');

    // El segundo turno: la orden que se pidió borra el cine, que es lo que se nombró.
    toolCall = UNDO;
    await procesarMensajeLibre('borra el último', USUARIO, '51999');
    expect(ids()).toEqual(['tx-comida-vieja']);
  });

  it('una mitad de borrado que no pidió borrar un gasto tampoco registra la otra', async () => {
    toolCall = UNDO;
    const r = await procesarMensajeLibre('empecemos de cero y registra 100 en comida', USUARIO, '51999');
    expect(vistoPorElBorrado).toEqual(['empecemos de cero']);
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-cine']);
    expect(String(r)).toContain('no lo anoté todavía');
  });

  // La segunda revisión: cuando hay VARIOS candidatos el borrado pregunta cuál, y registrar
  // la otra mitad en el mismo turno agregaba una tercera comida de S/100: el monto que se
  // acababa de pedir ya no distinguía.
  it('si el borrado pregunta cuál de varios, la otra mitad también espera', async () => {
    filas = [
      { id: 'tx-comida-40', usuario_id: 'u-1', monto: 40, moneda: 'PEN', comercio: 'comida', fecha: '2026-09-12', descripcion_original: null },
      { ...TX_COMIDA_VIEJA },
      { ...TX_CINE },
    ];
    toolCall = { name: 'manage_transaction', args: { action: 'delete', comercio: 'comida' } };
    const r = await procesarMensajeLibre('borra el de comida y registra 100 en comida', USUARIO, '51999');
    expect(ids()).toEqual(['tx-comida-40', 'tx-comida-vieja', 'tx-cine']);
    expect(parsers.parsearRegistroManual).not.toHaveBeenCalled();
    expect(String(r)).toContain('Encontré 2');
    expect(String(r)).toContain('no lo anoté todavía');
  });
});

/**
 * EL INVARIANTE, no un caso más (segunda revisión, 15-sep-2026). El borrado recibe EXACTAMENTE
 * lo que decide el splitter: su `parte1` si reconoce una continuación, o el mensaje entero si
 * no. La revisión evadió la suite con un corte propio en `message-processor` —"cualquier
 * conjunción", el arreglo obvio del ítem abierto de `RE_REGISTER_PART`— y "borra el último y
 * todo lo demás" pasó a borrar el cine sin preguntar, con 3449/3449 en verde. Era la segunda
 * revisión seguida que encontraba un test evadible, así que en vez de otro ejemplo se ata el
 * corte al splitter: cualquier corte que no salga de ahí rompe esto, sea cual sea la frase.
 * Ensanchar el splitter mismo es otra decisión, con sus tests en `multi-intent-mixto.test.js`.
 */
describe('el borrado ve la mitad que decide el splitter, y ninguna otra', () => {
  const { detectarContinuacion } = require('../../services/multi-intent-splitter');
  const COMPUESTOS = [
    'borra el último y todo lo demás',
    'borra el último y registra 100 en comida',
    'no espera, bórralo y registra 100 en comida',
    'borra el último y apunta 100 en comida',
    'borra el último y luego registra 30',
    'deshaz eso y después registra 20',
    'borra el último pero registra 50 en taxi',
    'borra el de pollo y papas y registra 20',
    'no, y borra el último y registra 5',
  ];
  it.each(COMPUESTOS)('«%s»', async (msg) => {
    toolCall = UNDO;
    await procesarMensajeLibre(msg, USUARIO, '51999');
    const cont = detectarContinuacion(msg, 'deshacer_ultimo');
    expect(vistoPorElBorrado).toEqual([cont && cont.parte1 ? cont.parte1 : msg]);
  });

  // El negativo que el comentario del call-site promete: hoy es seguro PORQUE no se parte.
  it('«borra el último y todo lo demás» no borra nada y pide la orden', async () => {
    toolCall = UNDO;
    const r = await procesarMensajeLibre('borra el último y todo lo demás', USUARIO, '51999');
    expect(ids()).toEqual(['tx-comida-vieja', 'tx-cine']);
    expect(String(r)).toContain('¿Borro *cine*');
  });
});

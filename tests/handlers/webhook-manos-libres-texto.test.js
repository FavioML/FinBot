import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// "Manos libres" escrito a mano, como respuesta al cierre del día 2 (chip 5, 01-oct-2026).
//
// El cierre dice "Escribe /manoslibres". Una persona real contestó "Manos libres", sin barra:
// no llegó al comando, el clasificador lo leyó como el nombre nuevo del último movimiento y le
// renombró un ingreso ("Ingreso independiente → Manos libres"). La guarda de ediciones ya
// impide el renombre; esto hace que el pedido se cumpla.
//
// Lo que se fija: el texto ACTIVA y nunca apaga (el comando con barra sigue siendo un toggle),
// una pregunta no activa nada, y el que no es Pro recibe lo mismo que con el comando.
// Mismo patrón de mocking que webhook-cambiar-categoria.test.js.

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const updates = [];
function makeChain(tabla) {
  const c = {};
  for (const m of ['select', 'insert', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.update = vi.fn((v) => { updates.push({ tabla, v }); return c; });
  // Una fila devuelta: `verificarEscritura` exige que el update haya tocado algo.
  c.then = (onF, onR) => Promise.resolve({ data: [{ id: 'u1' }], error: null, count: 0 }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase.from = vi.fn((t) => makeChain(t));

const procesarMensajeLibre = vi.fn().mockResolvedValue('respuesta del NLP');
const createWebhookHandler = require('../../handlers/webhook');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

let wamidSeq = 0;
async function enviar(texto) {
  const body = {
    entry: [{ changes: [{ value: { messages: [{ from: '51999000222', id: 'wamid-ml-' + (wamidSeq++), type: 'text', text: { body: texto } }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });
  return enviarWhatsapp.mock.calls[0] ? enviarWhatsapp.mock.calls[0][1] : null;
}

const manosLibres = () => updates.filter((u) => u.tabla === 'usuarios' && 'manos_libres' in u.v).map((u) => u.v.manos_libres);

function usuario(extra) {
  return {
    id: 'u1', nombre: 'Ana', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-10-12',
    onboarding_paso: 0, onboarding_completado: true, manos_libres: false, ...extra,
  };
}

describe('"manos libres" escrito sin barra', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear();
    procesarMensajeLibre.mockClear();
    updates.length = 0;
    obtenerOCrearUsuario.mockReset().mockResolvedValue(usuario());
  });

  it.each(['Manos libres', 'manos libres', 'Manoslibres', 'Sí, manos libres', 'quiero manos libres porfa', 'activa el modo manos libres',
    // Cortesías peruanas y typos de teclado (revisión adversarial del chip 5).
    'manos libres por fa', 'manos libres xfa', 'si porfa manos libres', 'activa manos libres pe', 'manos libre', 'mano libres', 'modo manos libre'])(
    '"%s" lo activa y no pasa por el NLP', async (texto) => {
      const r = await enviar(texto);
      expect(manosLibres()).toEqual([true]);
      expect(r).toMatch(/Modo Manos Libres activado/);
      expect(procesarMensajeLibre).not.toHaveBeenCalled();
    });

  it('a quien YA lo tiene no se lo apaga: el texto confirma y no escribe', async () => {
    obtenerOCrearUsuario.mockResolvedValue(usuario({ manos_libres: true }));
    const r = await enviar('Manos libres');
    expect(manosLibres()).toEqual([]);
    expect(r).toMatch(/ya está activado/);
  });

  it('CONTROL: el comando con barra sigue siendo un toggle (lo apaga)', async () => {
    obtenerOCrearUsuario.mockResolvedValue(usuario({ manos_libres: true }));
    await enviar('/manoslibres');
    expect(manosLibres()).toEqual([false]);
  });

  it('a quien silenció los avisos le dice que no le va a llegar, y cómo destrabarlo', async () => {
    obtenerOCrearUsuario.mockResolvedValue(usuario({ recordatorios_activos: false }));
    const r = await enviar('Manos libres');
    expect(manosLibres()).toEqual([true]);
    expect(r).toMatch(/avisos silenciados/);
    expect(r).toMatch(/\/recordar/);
  });

  it('CONTROL: con los avisos activos no aparece esa nota', async () => {
    const r = await enviar('Manos libres');
    expect(r).not.toMatch(/silenciados/);
  });

  // "el manos libres" son también los audífonos.
  it.each(['¿Qué es manos libres?', 'manos libres?', 'no quiero manos libres', 'gasté 20 en un manos libres', 'Manos libres 45', 'el manos libres'])(
    '"%s" no activa nada y sigue al NLP', async (texto) => {
      await enviar(texto);
      expect(manosLibres()).toEqual([]);
      expect(procesarMensajeLibre).toHaveBeenCalledTimes(1);
    });

  it('sin plan Pro recibe lo mismo que con el comando', async () => {
    obtenerOCrearUsuario.mockResolvedValue(usuario({ plan: 'free', trial_estado: 'vencido' }));
    const r = await enviar('Manos libres');
    expect(manosLibres()).toEqual([]);
    expect(r).toMatch(/función Pro/);
  });
});

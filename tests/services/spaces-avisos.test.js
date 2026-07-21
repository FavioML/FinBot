import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

/**
 * Los avisos de reparto son lo que sostiene la regla del producto: la plata FUTURA
 * de alguien no se mueve sin que esa persona se entere.
 *
 * Por eso el reparto lo puede editar cualquier miembro y no solo el owner. Gatearlo
 * al owner no cerraria nada (el owner igual podria cambiarlo en silencio), solo
 * elegiria quien tiene el poder; y en un espacio de pareja dejaria al que no creo
 * el espacio sin poder tocar su propio porcentaje.
 *
 * Lo que fija esta suite: a quien se le escribe, a quien NO, y que el porcentaje
 * anunciado sea el efectivo (el que se cobra), no el peso crudo de la columna.
 */

const TABLAS = {};

function makeChain(tabla) {
  const chain = {};
  for (const m of ['select', 'eq', 'gte', 'neq', 'limit', 'order', 'insert', 'update', 'delete']) {
    chain[m] = () => chain;
  }
  chain.single = () => Promise.resolve({ data: (TABLAS[tabla] || [])[0] || null });
  chain.then = (resolve) => resolve({ data: TABLAS[tabla] || [] });
  return chain;
}

const dbMock = { supabase: { from: vi.fn((tabla) => makeChain(tabla)) } };
const enviados = [];
const waMock = {
  enviarWhatsapp: vi.fn(async (numero, msg) => { enviados.push({ numero, msg }); return true; }),
};

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const waPath = require.resolve(path.join(projectRoot, 'lib/whatsapp.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: waMock };

const { notificarNuevoMiembro, notificarRepartoEditado } = require('../../services/shared-spaces');

const miembro = (id, pct, whatsapp = '519' + id) => ({
  user_id: id,
  split_percentage: pct,
  usuarios: { nombre: id.toUpperCase() + ' Apellido', whatsapp },
});

beforeEach(() => {
  for (const k of Object.keys(TABLAS)) delete TABLAS[k];
  enviados.length = 0;
  TABLAS.shared_spaces = [{ name: 'Depa' }];
});

const paraNumero = (n) => enviados.find((e) => e.numero === n);

describe('notificarNuevoMiembro', () => {
  it('le escribe a los que ya estaban, nunca al que acaba de entrar', async () => {
    TABLAS.space_members = [miembro('a', 80), miembro('b', 40), miembro('c', 60)];
    await notificarNuevoMiembro('sp1', 'c');

    expect(enviados.map((e) => e.numero).sort()).toEqual(['519a', '519b']);
    expect(paraNumero('519c')).toBeUndefined();
  });

  it('anuncia el porcentaje EFECTIVO, no el peso crudo de la columna', async () => {
    TABLAS.space_members = [miembro('a', 80), miembro('b', 40), miembro('c', 60)];
    await notificarNuevoMiembro('sp1', 'c');

    // 80/40 antes = 66.7/33.3. Con el tercero (peso 60) pasa a 44.4/22.2/33.3.
    // El peso de 'a' nunca se toco: sigue en 80. Lo que se le anuncia es su parte.
    expect(paraNumero('519a').msg).toContain('de 66.7% a 44.4%');
    expect(paraNumero('519b').msg).toContain('de 33.3% a 22.2%');
    expect(paraNumero('519a').msg).not.toContain('80%');
  });

  it('nombra a quien entro y enlaza donde se ajusta el reparto', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('c', 50)];
    await notificarNuevoMiembro('sp1', 'c');

    const msg = paraNumero('519a').msg;
    expect(msg).toContain('C se unió a Depa');
    expect(msg).toContain('app.neto.pe/dashboard/espacios');
  });

  it('no escribe nada en un espacio de un solo miembro', async () => {
    TABLAS.space_members = [miembro('a', 50)];
    await notificarNuevoMiembro('sp1', 'a');
    expect(enviados).toHaveLength(0);
  });

  it('un miembro sin WhatsApp no rompe el aviso de los demas', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50, null), miembro('c', 50)];
    await notificarNuevoMiembro('sp1', 'c');
    expect(enviados.map((e) => e.numero)).toEqual(['519a']);
  });
});

describe('notificarRepartoEditado', () => {
  it('le escribe a los demas miembros, nunca a quien hizo el cambio', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 30)];
    await notificarRepartoEditado('sp1', 'a', [miembro('a', 50), miembro('b', 50)]);

    expect(enviados.map((e) => e.numero)).toEqual(['519b']);
    expect(paraNumero('519a')).toBeUndefined();
  });

  it('dice de cuanto a cuanto quedo la parte de cada uno', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 30)];
    await notificarRepartoEditado('sp1', 'a', [miembro('a', 50), miembro('b', 50)]);

    expect(paraNumero('519b').msg).toContain('A cambió el reparto de Depa');
    expect(paraNumero('519b').msg).toContain('de 50% a 30%');
  });

  it('no molesta a quien no le cambio la parte', async () => {
    // 'b' queda igual (33.3%); solo se movieron 'a' y 'c'.
    TABLAS.space_members = [miembro('a', 40), miembro('b', 30), miembro('c', 20)];
    await notificarRepartoEditado('sp1', 'a', [miembro('a', 30), miembro('b', 30), miembro('c', 30)]);

    expect(paraNumero('519b')).toBeUndefined();
    expect(paraNumero('519c').msg).toContain('de 33.3% a 22.2%');
  });

  it('sin datos de "antes" sigue avisando, sin inventar el numero previo', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 30)];
    await notificarRepartoEditado('sp1', 'a', null);

    expect(paraNumero('519b').msg).toContain('de 0% a 30%');
  });

  it('un error de envio no tumba el flujo del que edito', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 30)];
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('Meta caida'));
    await expect(notificarRepartoEditado('sp1', 'a', [miembro('a', 50), miembro('b', 50)]))
      .resolves.toBeUndefined();
  });
});

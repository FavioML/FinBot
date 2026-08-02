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
 * Lo que fija esta suite: a quien se le escribe, a quien NO, que el porcentaje
 * anunciado sea el efectivo (el que se cobra) y no el peso crudo de la columna, y que
 * el aviso salga por los DOS canales.
 *
 * Lo ultimo no es cosmetica. El WhatsApp libre no se entrega fuera de la ventana de 24h
 * de Meta, asi que un aviso que solo viva ahi no llega al miembro que no esta mirando el
 * chat — justo a quien hay que avisarle de que su parte se movio.
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
const enApp = [];
const waMock = {
  enviarWhatsapp: vi.fn(async (numero, msg) => {
    // Red de seguridad web-first del helper real: sin numero no hay envio, pero tampoco
    // excepcion. Replicarlo aca es lo que deja que el bucle siga hasta la in-app.
    if (!numero) return { ok: false, skipped: 'no_whatsapp' };
    enviados.push({ numero, msg });
    return { ok: true, msgId: 'wamid.' + enviados.length };
  }),
};
const notifMock = {
  crearNotificacion: vi.fn(async (usuarioId, tipo, titulo, mensaje, datos) => {
    enApp.push({ usuarioId, tipo, titulo, mensaje, datos });
    return true;
  }),
};

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const waPath = require.resolve(path.join(projectRoot, 'lib/whatsapp.js'));
const notifPath = require.resolve(path.join(projectRoot, 'lib/notifications-db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: waMock };
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: notifMock };

const {
  notificarNuevoMiembro,
  notificarRepartoEditado,
  notificarReglasEditadas,
} = require('../../services/shared-spaces');

const miembro = (id, pct, whatsapp = '519' + id) => ({
  user_id: id,
  split_percentage: pct,
  usuarios: { nombre: id.toUpperCase() + ' Apellido', whatsapp },
});

beforeEach(() => {
  for (const k of Object.keys(TABLAS)) delete TABLAS[k];
  enviados.length = 0;
  enApp.length = 0;
  waMock.enviarWhatsapp.mockClear();
  notifMock.crearNotificacion.mockClear();
  TABLAS.shared_spaces = [{ name: 'Depa' }];
});

const paraNumero = (n) => enviados.find((e) => e.numero === n);
const enAppDe = (userId) => enApp.find((e) => e.usuarioId === userId);

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

  it('un miembro sin WhatsApp no rompe el aviso de los demas, Y SE ENTERA IGUAL', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50, null), miembro('c', 50)];
    await notificarNuevoMiembro('sp1', 'c');

    expect(enviados.map((e) => e.numero)).toEqual(['519a']);
    // Lo que importa: 'b' no tiene WhatsApp y su parte se movio igual. Antes ese miembro
    // se saltaba con un `continue` y no se enteraba por ningun lado.
    expect(enAppDe('b')).toBeDefined();
    expect(enAppDe('b').mensaje).toContain('Tu parte por defecto pasó de');
  });

  it('la in-app va al miembro correcto, con su deeplink y sin el markdown de WhatsApp', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('c', 50)];
    await notificarNuevoMiembro('sp1', 'c');

    // El destinatario es m.user_id. Pasar el id del actor por copy-paste escribiria en la
    // campana de otra persona y crearNotificacion devolveria true igual.
    expect(enApp.map((e) => e.usuarioId)).toEqual(['a']);
    expect(enAppDe('a').titulo).toBe('C se unió a Depa');
    expect(enAppDe('a').mensaje).not.toContain('*');
    expect(enAppDe('a').datos).toEqual({ space_id: 'sp1', link: '/dashboard/espacios' });
  });

  it('a quien no le cambio la parte no le llega NINGUNO de los dos canales', async () => {
    TABLAS.space_members = [miembro('a', 50)];
    await notificarNuevoMiembro('sp1', 'a');
    expect(enviados).toHaveLength(0);
    expect(enApp).toHaveLength(0);
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

  it('si WhatsApp se cae, el aviso igual queda en la campana', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 30)];
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('Meta caida'));

    await expect(notificarRepartoEditado('sp1', 'a', [miembro('a', 50), miembro('b', 50)]))
      .resolves.toBeUndefined();
    // Que no lance no alcanza: sin el aislamiento por canal, el rechazo subiria al catch
    // externo, este test seguiria verde y el miembro se habria quedado sin enterarse.
    expect(enAppDe('b')).toBeDefined();
  });

  it('si WhatsApp se cae con el primer miembro, los demas igual reciben los dos canales', async () => {
    TABLAS.space_members = [miembro('a', 70), miembro('b', 20), miembro('c', 10)];
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('Meta caida'));

    await notificarRepartoEditado('sp1', 'a', [miembro('a', 50), miembro('b', 25), miembro('c', 25)]);

    // El bucle no aborta a mitad: 'c' llega por los dos canales aunque 'b' haya reventado.
    expect(enAppDe('b')).toBeDefined();
    expect(enAppDe('c')).toBeDefined();
    expect(paraNumero('519c')).toBeDefined();
  });
});

/**
 * Las reglas por categoria (Pro) mueven la misma plata futura que el reparto por
 * defecto, solo que por categoria. Por eso el aviso NO puede decir "tu parte pasó
 * de X% a Y%" a secas: la parte de esa persona en todo lo demas no se movio.
 *
 * `despues` se lee de la DB (ya persistido) y `antes` lo manda quien edito.
 */
const conReglas = (reglas) => { TABLAS.shared_spaces = [{ name: 'Depa', split_rules: reglas }]; };
const regla = (category, splits) => ({ id: 'r-' + category, category, splits });

describe('notificarReglasEditadas', () => {
  it('nombra la categoria y anuncia el % efectivo de ESA categoria', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas([regla('Comida', { a: 70, b: 30 })]);
    await notificarReglasEditadas('sp1', 'a', [regla('Comida', { a: 50, b: 50 })]);

    expect(enviados.map((e) => e.numero)).toEqual(['519b']);
    expect(paraNumero('519b').msg).toContain('A cambió el reparto por categoría de Depa');
    expect(paraNumero('519b').msg).toContain('En Comida tu parte pasó de 50% a 30%.');
  });

  it('no le escribe a quien no le movio la parte en ninguna categoria', async () => {
    // Pesos 40/20/30 = 44.4/22.2/33.3. 'c' cae justo en su 33.3 de siempre.
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50), miembro('c', 50)];
    conReglas([regla('Comida', { a: 40, b: 20, c: 30 })]);
    await notificarReglasEditadas('sp1', 'a', []);

    expect(paraNumero('519b').msg).toContain('En Comida tu parte pasó de 33.3% a 22.2%.');
    expect(paraNumero('519c')).toBeUndefined();
  });

  it('una regla borrada avisa que la categoria vuelve al reparto por defecto', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas([]);
    await notificarReglasEditadas('sp1', 'a', [regla('Comida', { a: 70, b: 30 })]);

    expect(paraNumero('519b').msg)
      .toContain('En Comida tu parte pasó de 30% a 50% (vuelve al reparto por defecto).');
  });

  it('varias categorias van en un solo mensaje, en orden estable', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas([regla('Transporte', { a: 20, b: 80 }), regla('Comida', { a: 70, b: 30 })]);
    await notificarReglasEditadas('sp1', 'a', []);

    expect(enviados).toHaveLength(1);
    const msg = paraNumero('519b').msg;
    expect(msg).toContain('En Comida tu parte pasó de 50% a 30%.');
    expect(msg).toContain('En Transporte tu parte pasó de 50% a 80%.');
    expect(msg.indexOf('En Comida')).toBeLessThan(msg.indexOf('En Transporte'));
  });

  it('resume el resto cuando se tocan mas categorias de las que se leen', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas('1234567'.split('').map((n) => regla('Cat' + n, { a: 70, b: 30 })));
    await notificarReglasEditadas('sp1', 'a', []);

    const msg = paraNumero('519b').msg;
    expect(msg).toContain('En Cat5 tu parte pasó de 50% a 30%.');
    expect(msg).not.toContain('En Cat6');
    expect(msg).toContain('Y 2 categorías más.');
  });

  it('guardar sin cambiar nada no manda ningun aviso', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas([regla('Comida', { a: 70, b: 30 })]);
    await notificarReglasEditadas('sp1', 'a', [regla('Comida', { a: 70, b: 30 })]);

    expect(enviados).toHaveLength(0);
  });

  it('un error de envio no tumba el flujo del que edito, y la campana igual recibe', async () => {
    TABLAS.space_members = [miembro('a', 50), miembro('b', 50)];
    conReglas([regla('Comida', { a: 70, b: 30 })]);
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('Meta caida'));

    await expect(notificarReglasEditadas('sp1', 'a', [])).resolves.toBeUndefined();
    expect(enAppDe('b').mensaje).toContain('En Comida tu parte pasó de 50% a 30%.');
  });
});

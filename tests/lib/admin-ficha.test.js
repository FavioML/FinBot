import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// `lib/admin-ficha.js`: cómo se nombra a un cliente en Telegram y cuántas veces pagó.
// El conteo es el que decide "cliente nuevo" vs "recurrente", así que lo que se fija acá son
// sus filtros: sin `monto > 0` una cortesía de `/activar` pasa por pago, y sin excluir la fila
// que se está aprobando el primer pago sale como el segundo.

let respuesta;      // lo que devuelve el await de la consulta
let consultas = [];
function cadena() {
  const q = { filtros: [], head: false };
  const c = {};
  for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'or']) {
    c[m] = (...a) => { q.filtros.push([m, ...a]); return c; };
  }
  c.select = (_cols, opts) => { if (opts && opts.head) q.head = true; q.countOpt = opts && opts.count; return c; };
  c.then = (res, rej) => {
    consultas.push(q);
    if (respuesta instanceof Error) return Promise.reject(respuesta).then(res, rej);
    // Como postgrest-js: sin `count: 'exact'` no manda el `Prefer: count=` y `count` vuelve null.
    // Sin modelarlo, quitarle esa opción al código dejaba esta suite verde y la función muerta.
    if (q.countOpt !== 'exact') return Promise.resolve({ ...respuesta, count: null }).then(res, rej);
    return Promise.resolve(respuesta).then(res, rej);
  };
  return c;
}
const dbMock = { supabase: { from: (t) => { const c = cadena(); c.tabla = t; return c; } } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  telefonoLegible, lineasIdentidad, contarPagosConPlata, lineaHistorialAntes, lineaHistorialAprobado,
} = require('../../lib/admin-ficha');

beforeEach(() => {
  respuesta = { count: 0, error: null };
  consultas = [];
  logMock.warn.mockClear();
});

describe('telefonoLegible', () => {
  it('agrupa un número peruano', () => {
    expect(telefonoLegible('51970398192')).toBe('+51 970 398 192');
  });
  it('otro largo sale con + y los dígitos', () => {
    expect(telefonoLegible('14155550123')).toBe('+14155550123');
  });
  it('sin dígitos no inventa nada', () => {
    expect(telefonoLegible(null)).toBeNull();
  });
  it('un BSUID no es un teléfono (antes salía como "+1049…")', () => {
    expect(telefonoLegible('PE.1049206861029395')).toBeNull();
  });
});

describe('lineasIdentidad', () => {
  it('nombre y teléfono', () => {
    expect(lineasIdentidad({ id: 'u-1', nombre: 'Luis', whatsapp: '51970398192' }))
      .toEqual(['Cliente: Luis', 'WhatsApp: +51 970 398 192']);
  });

  it('con conId agrega el UUID al final, sin backticks', () => {
    const l = lineasIdentidad({ id: 'u-1', nombre: 'Luis', whatsapp: '51970398192' }, { conId: true });
    expect(l[l.length - 1]).toBe('ID: u-1');
  });

  it('quien escribe sin número visible: lo dice y NO pega el BSUID como teléfono', () => {
    const l = lineasIdentidad({ id: 'u-1', nombre: 'Ana', whatsapp: null, bsuid: 'PE.1049206861029395' });
    expect(l).toContain('WhatsApp: sin número visible (escribe con usuario de WhatsApp)');
    expect(l.join('\n')).not.toMatch(/PE\.1049/);
  });

  it('sin número, el correo es lo que lo identifica', () => {
    expect(lineasIdentidad({ id: 'u-1', nombre: 'Ana', whatsapp: null, email: 'ana@x.pe' }))
      .toEqual(['Cliente: Ana', 'WhatsApp: no vinculado', 'Correo: ana@x.pe']);
  });

  it('con número no agrega el correo', () => {
    expect(lineasIdentidad({ nombre: 'Ana', whatsapp: '51970398192', email: 'ana@x.pe' }).join('\n'))
      .not.toMatch(/Correo/);
  });

  it('sin nombre no deja la línea vacía', () => {
    expect(lineasIdentidad({ whatsapp: '51970398192' })[0]).toBe('Cliente: (sin nombre)');
  });
});

describe('contarPagosConPlata', () => {
  it('cuenta solo aprobados con plata y excluye la fila que se está aprobando', async () => {
    respuesta = { count: 3, error: null };
    await expect(contarPagosConPlata('u-1', { excluirPagoId: 'pago-9' })).resolves.toBe(3);
    const [q] = consultas;
    expect(q.head).toBe(true);
    expect(q.filtros).toEqual(expect.arrayContaining([
      ['eq', 'usuario_id', 'u-1'],
      ['eq', 'estado', 'aprobado'],
      ['gt', 'monto', 0],
      ['neq', 'id', 'pago-9'],
    ]));
  });

  it('sin excluirPagoId no filtra por id', async () => {
    await contarPagosConPlata('u-1');
    expect(consultas[0].filtros.some(([m]) => m === 'neq')).toBe(false);
  });

  it('error de lectura: null, NO cero (cero diría "cliente nuevo" sin haberlo leído)', async () => {
    respuesta = { count: null, error: { message: 'db caída' } };
    await expect(contarPagosConPlata('u-1')).resolves.toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('nunca lanza, aunque el cliente lance', async () => {
    respuesta = new Error('socket hang up');
    await expect(contarPagosConPlata('u-1')).resolves.toBeNull();
  });
});

describe('líneas de historial', () => {
  it('antes de aprobar', () => {
    expect(lineaHistorialAntes(0)).toMatch(/Cliente nuevo/);
    expect(lineaHistorialAntes(1)).toBe('🔁 Recurrente: ya pagó 1 vez, este sería el pago N° 2');
    expect(lineaHistorialAntes(3)).toBe('🔁 Recurrente: ya pagó 3 veces, este sería el pago N° 4');
    expect(lineaHistorialAntes(null)).toMatch(/No pude leer/);
  });

  it('después de aprobar', () => {
    expect(lineaHistorialAprobado(0)).toBe('🆕 Pago N° 1 (cliente nuevo)');
    expect(lineaHistorialAprobado(3)).toBe('🔁 Pago N° 4 (recurrente)');
    expect(lineaHistorialAprobado(null)).toMatch(/No pude leer/);
  });
});

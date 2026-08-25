import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

/**
 * 9A-bis · la OTRA rama de `corregir_categoria`, la que no vive en el handler.
 *
 * El ítem se enunció sobre `handlers/intents/transacciones.js` y ahí quedó completo. Pero ese
 * intent BIFURCA: cuando el usuario nombra el comercio ("cambia starbucks a transporte"), el
 * UPDATE lo hace `recategorizarTransaccion`, acá. Y acá faltaba exactamente lo mismo, con una
 * consecuencia peor: la función devolvía `{ ok: true }` con cero filas afectadas, así que el
 * handler seguía de largo, guardaba la regla, la retroaplicaba y contestaba *"Listo! Moví
 * Starbucks (S/45.50)… Apliqué el cambio a todos los pagos anteriores"*. La rama de al lado
 * corta ahí a propósito, y esta no.
 *
 * Es la misma clase que `politica-nueva-en-una-sola-rama` de `docs/DEFECTOS.md`: un perímetro
 * definido por la FORMA del código (los UPDATE de un archivo) no ve una rama que sale por una
 * función, aunque el usuario reciba el mismo mensaje.
 *
 * Tres entradas de producción, no una: el intent por NLP (`message-processor.js:427`), el
 * comando `/cambiar` (`handlers/webhook.js:918`, que imprime `resultado.msg`) y
 * `corregir_multiple` → `corregirTransaccionEspecifica`.
 *
 * ── El mock, y su límite declarado ──────────────────────────────────────────────────────────
 * `desaparece` vacía la tabla DESPUÉS de la lectura, que es el mecanismo real: un borrado
 * concurrente entre `txs[0]` y el update. No es un stub que fuerce "devolvé cero" — el WHERE
 * del propio update es el que no matchea, así que el caso también muere si alguien le quita el
 * `.eq('id', tx.id)`.
 *
 * Y el RETURNING está modelado: una escritura sin `.select()` devuelve `data: null` pase lo que
 * pase, igual que postgrest. Sin eso, quitarle el `.select('id')` al código dejaría el archivo
 * en verde mientras producción contesta "ya no está" a todo el mundo.
 */

const MUTANTES = ['update', 'insert', 'delete', 'upsert'];

function makeSb({ filas = {}, fallos = {}, desaparece = [] } = {}) {
  const tabla_ = {};
  for (const [t, f] of Object.entries(filas)) tabla_[t] = f.map((x) => ({ ...x }));
  const llamadas = [];
  return {
    _llamadas: llamadas,
    intento: (t, v) => llamadas.some((c) => c.tabla === t && c.verbo === v),
    filtros: (t, v, n = 0) => ((llamadas.filter((c) => c.tabla === t && c.verbo === v)[n]) || {}).filtros || null,
    from(tabla) {
      let verbo = 'select';
      let retorno = false;
      const filtros = [];
      const b = {};
      for (const m of ['ilike', 'order', 'limit', 'gte', 'lte', 'neq', 'not']) b[m] = () => b;
      b.eq = (c, v) => { filtros.push([c, v]); return b; };
      b.is = (c, v) => { filtros.push([c, v]); return b; };
      for (const m of MUTANTES) {
        b[m] = (payload) => {
          if (verbo === 'select') { verbo = m; llamadas.push({ tabla, verbo: m, payload, filtros }); }
          return b;
        };
      }
      b.select = () => {
        if (verbo !== 'select') retorno = true;
        else llamadas.push({ tabla, verbo: 'select', filtros });
        return b;
      };
      const resolver = () => {
        const err = fallos[tabla + ':' + verbo];
        if (err) return { data: null, error: { message: err } };
        if (verbo === 'select') {
          const leidas = tabla_[tabla] || [];
          // el borrado concurrente: la lectura ve la fila, y para cuando llega el update ya no está
          if (desaparece.includes(tabla)) tabla_[tabla] = [];
          return { data: leidas, error: null };
        }
        if (!retorno) return { data: null, error: null };
        return { data: (tabla_[tabla] || []).filter((f) => filtros.every(([c, v]) => f[c] === v)), error: null };
      };
      b.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
      const uno = async () => {
        const r = resolver();
        if (r.error) return r;
        return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null };
      };
      b.single = uno;
      b.maybeSingle = uno;
      return b;
    },
  };
}

const TX = {
  id: 'tx-001', usuario_id: 'u-1', monto: 45.5, moneda: 'PEN',
  comercio: 'Starbucks', categoria: 'Alimentacion', fecha: '2026-04-01',
};

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const cargar = (sb) => {
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: sb } };
  delete require.cache[require.resolve(path.join(projectRoot, 'services/transactions.js'))];
  return require('../../services/transactions');
};

describe('recategorizarTransaccion · 0 filas no es un cambio aplicado', () => {
  it('la fila desaparece entre la lectura y el update → NO devuelve ok', async () => {
    const sb = makeSb({ filas: { transacciones: [TX] }, desaparece: ['transacciones'] });
    const { recategorizarTransaccion } = cargar(sb);
    const res = await recategorizarTransaccion('u-1', 'Starbucks', 'Transporte');
    // el update se intentó de verdad, apuntando a la fila leída
    expect(sb.intento('transacciones', 'update')).toBe(true);
    expect(sb.filtros('transacciones', 'update')).toEqual([['id', 'tx-001']]);
    // y NO se confirma: `ok:true` acá es lo que dispara la regla y el "apliqué el cambio a
    // todos los pagos anteriores" en el handler
    expect(res.ok).toBe(false);
    expect(res.msg).toMatch(/ya no esta/i);
    expect(res.msg).not.toMatch(/Listo! Movi/);
  });

  it('control: con la fila viva confirma igual que siempre', async () => {
    const sb = makeSb({ filas: { transacciones: [TX] } });
    const { recategorizarTransaccion } = cargar(sb);
    const res = await recategorizarTransaccion('u-1', 'Starbucks', 'Transporte');
    expect(res.ok).toBe(true);
    expect(res.msg).toMatch(/Listo! Movi/);
  });

  it('control: el update RECHAZADO sigue dando su propio mensaje, no el de 0 filas', async () => {
    // Las dos causas comparten `error: null`/`error` y tienen que quedar distinguibles, que es
    // todo el punto de 9A-bis. Sin este control, "no dice Listo" podría venir de cualquiera.
    const sb = makeSb({ filas: { transacciones: [TX] }, fallos: { 'transacciones:update': 'db caída' } });
    const { recategorizarTransaccion } = cargar(sb);
    const res = await recategorizarTransaccion('u-1', 'Starbucks', 'Transporte');
    expect(res.ok).toBe(false);
    expect(res.msg).toMatch(/Error actualizando/i);
    expect(res.msg).not.toMatch(/ya no esta/i);
  });
});

describe('corregirTransaccionEspecifica · "desaparecido" es un motivo propio', () => {
  it('0 filas devuelve motivo desaparecido, no "error" ni la forma de "no existe"', async () => {
    const sb = makeSb({ filas: { transacciones: [TX] }, desaparece: ['transacciones'] });
    const { corregirTransaccionEspecifica } = cargar(sb);
    const res = await corregirTransaccionEspecifica('u-1', 'Starbucks', null, null, 'Transporte', null);
    expect(sb.intento('transacciones', 'update')).toBe(true);
    expect(res.ok).toBe(false);
    // el motivo tiene que ser el TERCERO: `'error'` manda al "no pude ahora mismo" (invita a
    // reintentar algo que no va a funcionar) y la ausencia de motivo es la forma exacta de "ese
    // comercio no existe", sobre un gasto que esta función acaba de leer.
    expect(res.motivo).toBe('desaparecido');
  });

  it('control: el update rechazado sigue siendo motivo "error"', async () => {
    const sb = makeSb({ filas: { transacciones: [TX] }, fallos: { 'transacciones:update': 'db caída' } });
    const { corregirTransaccionEspecifica } = cargar(sb);
    const res = await corregirTransaccionEspecifica('u-1', 'Starbucks', null, null, 'Transporte', null);
    expect(res.motivo).toBe('error');
  });

  it('control: sin gasto que corregir sigue sin motivo (la forma de "no existe")', async () => {
    const sb = makeSb({ filas: { transacciones: [] } });
    const { corregirTransaccionEspecifica } = cargar(sb);
    const res = await corregirTransaccionEspecifica('u-1', 'Starbucks', null, null, 'Transporte', null);
    expect(res.ok).toBe(false);
    expect(res.motivo).toBeUndefined();
  });

  it('control: el camino feliz devuelve ok', async () => {
    const sb = makeSb({ filas: { transacciones: [TX] } });
    const { corregirTransaccionEspecifica } = cargar(sb);
    const res = await corregirTransaccionEspecifica('u-1', 'Starbucks', null, null, 'Transporte', null);
    expect(res.ok).toBe(true);
  });
});

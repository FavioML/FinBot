import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// Hallazgo B30 — la categoría de una regla por comercio PISA la que dedujo el clasificador
// (`guardarTransaccion`, una línea después de `resolverCategoriaPersistida`). Si entra cruda,
// `reglas_comercio` se vuelve una TERCERA puerta que escribe `transacciones.categoria` sin
// pasar por el invariante que estableció B28.
//
// No es un fix preventivo. Medido contra prod el 12-ago-2026: un usuario real tenía sus gastos
// de comida partidos exactamente en dos, 5 filas en `Alimentacion` y 5 en `Alimentación`, y la
// línea del corte era ESTA — las 5 mal escritas eran las de los comercios con regla, las 5
// bien escritas las de comercios sin regla.
//
// Lo que este archivo fija, y por qué cada caso está acá:
//   1. el alias ortográfico se resuelve (es el bug medido)
//   2. las categorías libres NO se tocan (la trampa: normalizar a secas manda 77 reglas de 13
//      usuarios a 'Otros' = reintroducir B28 por la puerta que B30 viene a cerrar)
//   3. la resolución corre ANTES del filtro de "regla que no clasifica nada", no después
//   4. la función DEVUELVE el destino efectivo (antes no devolvía nada y el handler anunciaba
//      "Regla creada" incluso cuando esta función la había descartado en silencio)
//
// Patrón de mocking: inyección vía require.cache, igual que gmail-dedup.test.js.

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

// Captura lo que se escribiría en `reglas_comercio`. Verificar el PAYLOAD y no el valor de
// retorno es deliberado: la lección de `qa-regla-lote` es que un 200 no prueba nada — lo que
// importa es la fila que queda.
const upserts = [];
// Cómo responde el upsert. Los tres modos son necesarios porque postgrest tiene DOS formas de
// fallar y sólo una de ellas lanza: un rechazo (RLS, constraint) resuelve normal con `{error}`,
// que es el modo de fallo más probable y el que este mock por defecto no ejercitaba.
const upsertMode = { modo: 'ok' };

const dbMock = {
  supabase: {
    from: (tabla) => ({
      upsert: (payload) => {
        upserts.push({ tabla, payload });
        if (upsertMode.modo === 'lanza') return Promise.reject(new Error('ECONNRESET'));
        if (upsertMode.modo === 'error') return Promise.resolve({ error: { code: '42501', message: 'RLS' } });
        return Promise.resolve({ error: null });
      },
    }),
  },
};

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

const { guardarReglaComercio } = require('../../services/transactions');

const ultimoUpsert = () => upserts[upserts.length - 1];

describe('guardarReglaComercio — la categoría de la regla pasa por el mismo resolvedor (B30)', () => {
  beforeEach(() => { upserts.length = 0; upsertMode.modo = 'ok'; });

  it('resuelve el alias ortográfico: "Alimentacion" se guarda como "Alimentación"', async () => {
    const res = await guardarReglaComercio('u1', 'Berny', 'Alimentacion', null);
    expect(ultimoUpsert().tabla).toBe('reglas_comercio');
    expect(ultimoUpsert().payload.categoria).toBe('Alimentación');
    expect(res).toEqual({ ok: true, destino: { categoria: 'Alimentación', subcategoria: null } });
  });

  // El camino difuso de `normalizarCategoria` (mayúsculas, sin tildes). Lo agrega la misma
  // lección de B34: `resolverNombreCategoria` compara EXACTO, así que sin esto "ALIMENTACION"
  // se persistía en mayúsculas y era otra grafía más de la misma categoría.
  it('resuelve la grafía en mayúsculas que devuelve a veces el clasificador', async () => {
    await guardarReglaComercio('u1', 'wong', 'ALIMENTACION', null);
    expect(ultimoUpsert().payload.categoria).toBe('Alimentación');
  });

  it('una canónica pasa igual', async () => {
    await guardarReglaComercio('u1', 'metro', 'Alimentación', 'Supermercado');
    expect(ultimoUpsert().payload).toMatchObject({ categoria: 'Alimentación', subcategoria: 'Supermercado' });
  });

  // LA TRAMPA. Estos cuatro nombres son reales, sacados de las 77 reglas no canónicas que
  // tienen 13 usuarios en producción. Con `normalizarCategoria` a secas las cuatro terminan en
  // 'Otros'. Si este test se pone rojo, el fix está mandando a la basura categorías libres que
  // B28 vino explícitamente a permitir.
  it.each(['Freelance', 'Gastos Hormiga', 'Separación', 'Demaiz.pe'])(
    'NO toca la categoría libre legítima "%s"', async (libre) => {
      await guardarReglaComercio('u1', 'comercio-' + libre, libre, null);
      expect(ultimoUpsert().payload.categoria).toBe(libre);
    });

  // Lo único que sí se le hace a un nombre libre es el `.trim()` de `normalizarDestinoRegla`,
  // que es anterior a B30 y se queda. Va con su propio caso para que quede claro que la única
  // diferencia con los de arriba es el espacio, no la resolución: en prod hay 5 reglas con
  // espacio al final ('PAGOS PENDIENTES ', 'Ahorro ', 'Sueldo ', 'PAREJA ').
  it('al nombre libre solo le recorta los espacios de los bordes', async () => {
    await guardarReglaComercio('u1', 'x', 'PAGOS PENDIENTES ', null);
    expect(ultimoUpsert().payload.categoria).toBe('PAGOS PENDIENTES');
  });

  // El colapso con pérdida se decidió en B26 midiendo y no se reabre acá: lo que se fija es
  // que la regla lo aplique IGUAL que cualquier otra puerta, en vez de esquivarlo.
  it('aplica el colapso con pérdida cuando la regla igual clasifica algo', async () => {
    const res = await guardarReglaComercio('u1', 'latam', 'Viajes', 'Vuelos');
    expect(ultimoUpsert().payload).toMatchObject({ categoria: 'Otros', subcategoria: 'Vuelos' });
    expect(res.destino.categoria).toBe('Otros');
  });

  // El ORDEN, que es una decisión y no un detalle. Resolviendo DESPUÉS del filtro, un 'Viajes'
  // sin subcategoría pasaría el filtro como 'Viajes' y se guardaría como 'Otros': exactamente
  // la regla-que-no-clasifica-nada que el filtro existe para rechazar, y que además condena al
  // comercio a caer sin clasificar para siempre aunque la NLP hubiera acertado.
  it('descarta la regla cuando el nombre RESUELTO no clasifica nada', async () => {
    const res = await guardarReglaComercio('u1', 'latam', 'Viajes', null);
    expect(upserts).toHaveLength(0);
    expect(res).toEqual({ ok: false, motivo: 'no-clasifica' });
  });

  it('sigue descartando "Otros" pelado, como antes', async () => {
    expect(await guardarReglaComercio('u1', 'x', 'Otros', null)).toEqual({ ok: false, motivo: 'no-clasifica' });
    expect(upserts).toHaveLength(0);
  });

  // Preserva el comportamiento viejo: `resolverCategoriaPersistida(null)` devuelve 'Otros', así
  // que sin el ternario que la saltea, una llamada SIN categoría pero CON subcategoría pasaría
  // a crear una regla 'Otros > sub' donde hoy no se guarda nada.
  it('sin categoría no guarda nada, ni siquiera con subcategoría', async () => {
    expect((await guardarReglaComercio('u1', 'x', null, 'Delivery')).ok).toBe(false);
    expect((await guardarReglaComercio('u1', 'x', '', 'Delivery')).ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it('sin comercio lo dice con su propio motivo, no como "no clasifica nada"', async () => {
    expect(await guardarReglaComercio('u1', '', 'Alimentación', null)).toEqual({ ok: false, motivo: 'sin-comercio' });
    // Un comercio de puros espacios pasa los guards del handler y muere acá. Con el motivo
    // colapsado, el usuario recibía un mensaje culpando a la categoría, que no tenía nada malo.
    expect(await guardarReglaComercio('u1', '   ', 'Alimentación', null)).toEqual({ ok: false, motivo: 'sin-comercio' });
    expect(upserts).toHaveLength(0);
  });

  // ── El upsert que falla ────────────────────────────────────────────────────
  // Las DOS formas, porque sólo una lanza. Sin esto la función devolvía "guardada" ante el modo
  // de fallo más probable (un rechazo de RLS o de constraint), y el llamador creaba la raíz en
  // el árbol, retroaplicaba sobre el histórico y anunciaba "Regla creada" sin una sola fila en
  // `reglas_comercio`. La suite entera pasaba porque el mock siempre devolvía `{error: null}`.

  it('un upsert RECHAZADO (postgrest no lanza, devuelve {error}) NO se reporta como guardado', async () => {
    upsertMode.modo = 'error';
    const res = await guardarReglaComercio('u1', 'Berny', 'Alimentación', null);
    expect(upserts).toHaveLength(1);            // se intentó
    expect(res).toEqual({ ok: false, motivo: 'error' });
  });

  it('un upsert que LANZA (red) tampoco', async () => {
    upsertMode.modo = 'lanza';
    expect(await guardarReglaComercio('u1', 'Berny', 'Alimentación', null)).toEqual({ ok: false, motivo: 'error' });
  });

  // El motivo separa dos consejos opuestos: 'no-clasifica' pide cambiar lo que se pidió,
  // 'error' pide reintentar lo mismo. Colapsarlos manda al usuario a probar categorías
  // distintas contra un problema que no es suyo.
  it('el fallo de escritura y el rechazo por política NO comparten motivo', async () => {
    upsertMode.modo = 'error';
    const escritura = await guardarReglaComercio('u1', 'Berny', 'Alimentación', null);
    upsertMode.modo = 'ok';
    const politica = await guardarReglaComercio('u1', 'latam', 'Viajes', null);
    expect(escritura.motivo).not.toBe(politica.motivo);
  });
});

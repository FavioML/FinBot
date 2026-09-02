import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const path = require('path');
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');
const { leerCorreosDesdeCuenta } = require('../gmail.js');

/**
 * **Un barrido que Gmail no dejó hacer devolvía lo mismo que un barrido sin correos.**
 *
 * Los dos `catch` de `leerCorreosDesdeCuenta` sólo logueaban, así que si las dos
 * `messages.list` se comían un 429 de cuota, `todosLosIds` quedaba vacío y la función salía por
 * `{ error: null, mensajes: [] }` — byte por byte lo que devuelve alguien que tiene su Gmail
 * conectado y no compró nada en 30 días.
 *
 * Para el escaneo incremental da igual: vuelve a correr en 15 minutos. Lo que lo vuelve caro es
 * el **barrido histórico**, que reclama `usuarios.historico_importado` ANTES de leer y sólo lo
 * libera si se entera de que algo se saltó. Con los dos vacíos indistinguibles, un 429 durante
 * el callback de OAuth se registraba como "30d completado" y esa persona perdía su import de 30
 * días para siempre: el `if` del tope de `escanearHistoricoInicial` la saca antes de reintentar,
 * así que ni reconectando. Y el histórico es el más expuesto de los dos: pide `maxPerQuery: 100`
 * contra los 20 del incremental.
 *
 * **El transporte se ataca por `auth.request`, no mockeando `googleapis`.** `google.gmail()`
 * delega toda llamada en el `request` del cliente de auth, así que un doble que tira ejercita el
 * camino real —incluidos los `catch` que este guard vigila— sin cargar un mock global de
 * `googleapis` en el worker (otros tests dependen del módulo real: ver `gmail-timeout`) y sin
 * salir a la red, que `tests/setup.js` bloquea.
 */

const ES_LIST = (url) => /\/messages\?/.test(url) || /\/messages$/.test(url);
const ES_GET = (url) => /\/messages\/[^/]+$/.test(url);

/** `authClient` falso: decide por URL si la llamada es un list o un get, y qué contesta. */
function transporte({ list, get }) {
  const llamadas = { list: 0, get: 0 };
  return {
    llamadas,
    request: async (opts) => {
      const url = String(opts.url || '');
      if (ES_LIST(url)) { llamadas.list++; return list(llamadas.list); }
      // **Sin este corte el doble clasifica como `get` cualquier llamada nueva a la API.** Si
      // `leerCorreosDesdeCuenta` agregara un `getProfile` o un refresh de token, `llamadas.get`
      // contaría de más y las aserciones pasarían o fallarían por el motivo equivocado. Un get
      // real siempre trae `/messages/{id}` al final.
      if (!ES_GET(url)) throw new Error('llamada inesperada a la API de Gmail: ' + url);
      llamadas.get++;
      return get(llamadas.get, url);
    },
  };
}

const CUOTA = () => { const e = new Error('Quota exceeded for quota metric'); e.code = 429; throw e; };
const IDS = (n) => ({ data: { messages: Array.from({ length: n }, (_, i) => ({ id: 'm' + i })) } });
const VACIO = () => ({ data: {} });

describe('leerCorreosDesdeCuenta separa "no pude listar" de "no había correos"', () => {
  it('con las DOS queries caídas devuelve `listado_fallido`, no un vacío', async () => {
    const t = transporte({ list: CUOTA, get: CUOTA });
    const r = await leerCorreosDesdeCuenta(t, 'a@b.com', ['banco@bcp.com.pe']);
    expect(t.llamadas.list, 'no se intentaron las dos queries').toBe(2);
    expect(r.error).toBe('listado_fallido');
    expect(r.mensajes).toEqual([]);
    // **Y su contador, que es la mitad que el fixture del agregador no puede probar.** Ese test
    // usa un `CAIDA` escrito a mano con `salteados: 2`; si esta salida dejara de llevarlo, el
    // agregador seguiría verde sobre un valor que en producción no existe. Verificado por
    // mutación: quitarlo de acá dejaba las dos suites en verde.
    expect(r.salteados, 'la cuenta caída no dice cuántos listados se perdió').toBe(2);
  });

  it('CONTROL: si las queries SÍ corrieron y no había correos, el vacío es un hecho', async () => {
    // La mitad que impide que el arreglo se vuelva "todo vacío es sospechoso": acá la persona
    // tiene su Gmail sano y no compró nada. Liberar el claim del histórico por esto lo re-correría
    // en cada reconexión.
    const t = transporte({ list: VACIO, get: CUOTA });
    const r = await leerCorreosDesdeCuenta(t, 'a@b.com', ['banco@bcp.com.pe']);
    expect(r.error).toBeNull();
    expect(r.mensajes).toEqual([]);
    expect(r.salteados, 'no se saltó nada, pero se reportó como incompleto').toBe(0);
  });

  it('con UNA sola query caída no dice `listado_fallido`, pero cuenta el salteado', async () => {
    // No se puede afirmar que no había correos en la mitad que no se listó, y tampoco que el
    // barrido está completo. El histórico lo trata como incompleto y lo rehace entero.
    const t = transporte({ list: (n) => (n === 1 ? VACIO() : CUOTA()), get: CUOTA });
    const r = await leerCorreosDesdeCuenta(t, 'a@b.com', ['banco@bcp.com.pe']);
    expect(r.error, 'una query funcionó: no es "no pude listar"').toBeNull();
    expect(r.salteados).toBe(1);
  });

  it('los correos que Gmail listó pero no entregó se CUENTAN', async () => {
    // Un `messages.get` caído se salteaba en silencio y nunca llegaba al `mapPool` del scanner,
    // así que `estado.fallidos` se quedaba en 0 y el barrido incompleto se daba por completo.
    const t = transporte({ list: (n) => (n === 1 ? IDS(3) : VACIO()), get: CUOTA });
    const r = await leerCorreosDesdeCuenta(t, 'a@b.com', ['banco@bcp.com.pe']);
    expect(r.error).toBeNull();
    expect(r.mensajes).toEqual([]);
    expect(r.salteados, 'tres correos existían y ninguno se miró').toBe(3);
  });

  it('CONTROL: el truncado por `maxProcess` NO cuenta como salteado', async () => {
    // **Contarlo fue un defecto que duró una hora, y lo introduje arreglando el de arriba.** Un
    // usuario con 60 correos bancarios en 30 días —normal— deja 10 ids fuera del cap del
    // histórico (`maxProcess: 50`), así que `salteados` no daba 0 nunca y el barrido liberaba su
    // claim SIEMPRE: `historico_importado` no se marcaba jamás y los 30 días se re-corrían en
    // cada reconexión. Medido: 60 ids listados → `salteados: 10`.
    //
    // Y liberar no compraba nada: re-correr trunca en el mismo orden, así que esos 10 no vuelven
    // igual. `salteados` significa "Gmail no me lo dio", que sí se recupera reintentando; el cap
    // es una decisión de diseño nuestra y su arreglo, si hace falta, es paginar.
    const sano = () => ({ data: { id: 'x', internalDate: String(Date.now()), snippet: 'x', payload: { headers: [] } } });
    const t = transporte({ list: (n) => (n === 1 ? IDS(5) : VACIO()), get: sano });
    const r = await leerCorreosDesdeCuenta(t, 'a@b.com', ['banco@bcp.com.pe'], { maxProcess: 1 });
    expect(t.llamadas.get, 'el cap no truncó').toBe(1);
    expect(r.salteados, 'el cap se reportó como barrido incompleto: el claim se liberaría siempre').toBe(0);
  });
});

/**
 * **La agregación multi-cuenta tenía cobertura CERO, y es la que decide si un barrido cuenta
 * como completo.** Vivía embebida en `leerCorreosBancarios`, que ningún test ejecuta: el guard
 * del scanner mockea esa función entera y el de arriba corre por debajo de ella. Una revisión
 * adversarial dejó sus dos líneas inertes (`salteados = 0`, `todasFallaron = false`) y la suite
 * completa —169 archivos, 3011 tests— siguió en verde.
 */
describe('agregarResultadosDeCuentas: una cuenta caída no desaparece detrás de una sana', () => {
  const { agregarResultadosDeCuentas } = require('../gmail.js');

  const CAIDA = { error: 'listado_fallido', mensajes: [], cuentaEmail: 'a@x.com', salteados: 2 };
  const SANA = { error: null, mensajes: [{ id: 'm1' }, { id: 'm2' }], cuentaEmail: 'b@x.com', salteados: 0 };

  it('la cuenta con 429 sigue contando aunque su hermana venga sana', () => {
    // **El defecto original, intacto en forma multi-cuenta.** `todasFallaron` usa `every`, así
    // que una cuenta sana borra el `listado_fallido` de la otra; si además el error de esa cuenta
    // no aporta `salteados`, el agregado sale `{error:null, salteados:0}` y el histórico conserva
    // el claim. Los 30 días de la cuenta caída se pierden en silencio.
    const r = agregarResultadosDeCuentas([CAIDA, SANA]);
    expect(r.error, 'con una cuenta sana el error deja de ser global, y está bien').toBeNull();
    expect(r.mensajes.length).toBe(2);
    expect(r.salteados, 'la cuenta caída desapareció detrás de la sana').toBe(2);
  });

  it('una cuenta que falló SIN contador propio cuenta como al menos uno', () => {
    // El `catch` genérico por cuenta devuelve `{error: e.message, mensajes: []}` y no sabe cuántos
    // correos quedaron adentro. Para el histórico lo que decide es si quedó algo afuera.
    const r = agregarResultadosDeCuentas([{ error: 'boom', mensajes: [], cuentaEmail: 'a@x.com' }, SANA]);
    expect(r.salteados).toBe(1);
  });

  it('si TODAS fallaron y no hay un solo mensaje, el vacío no es un hecho sobre el usuario', () => {
    const r = agregarResultadosDeCuentas([CAIDA, { error: 'boom', mensajes: [], cuentaEmail: 'b@x.com' }]);
    expect(r.error).toBe('listado_fallido');
  });

  it('`AUTH_EXPIRED` gana y NO suma salteados: su rama ya libera el claim', () => {
    // Tiene su propio aviso al usuario (`notificarAuthExpirada`) y su propia rama de liberación.
    // Contarlo además como salteado no cambia el desenlace y ensucia el log.
    const r = agregarResultadosDeCuentas([{ error: 'AUTH_EXPIRED', mensajes: [], cuentaEmail: 'a@x.com' }, SANA]);
    expect(r.error).toBe('AUTH_EXPIRED');
    expect(r.salteados).toBe(0);
  });

  it('CONTROL: dos cuentas sanas no inventan un barrido incompleto', () => {
    // La mitad que impide que "contar los errores" se vuelva "siempre hay algo saltado". Y el
    // dedup por id + email, que la extracción no puede haber roto.
    const r = agregarResultadosDeCuentas([SANA, { ...SANA, cuentaEmail: 'c@x.com' }]);
    expect(r.error).toBeNull();
    expect(r.salteados).toBe(0);
    expect(r.mensajes.length, 'el mismo id en DOS cuentas son dos correos distintos').toBe(4);
  });
});

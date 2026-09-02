import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Las ramas de la vinculación web↔WhatsApp por BSUID (02-sep-2026).
 *
 * **El doble RESPETA los filtros, y su modelo de error es por CONSULTA, no por tabla.** Las dos
 * cosas se pagaron:
 *
 *   · un doble que devuelve la misma fila mire lo que mire deja en verde el bug que este módulo
 *     existe para evitar — escribir sobre el id equivocado, o sea atarle el WhatsApp de una
 *     persona a la cuenta Google de otra. Por eso `buscar()` compara columna por columna;
 *   · la primera versión indexaba los errores por TABLA, y como las DOS lecturas de filas van a
 *     `usuarios`, la rama `errBs` era **inalcanzable por construcción**: borrarla entera dejaba
 *     los 14 tests en verde. Ahora la clave es `tabla:columna`, así que cada lectura falla sola.
 *
 * Lo encontró una revisión adversarial, ejecutando las mutaciones. Un guard verde por evasión es
 * indistinguible de uno verde por correcto.
 */

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
Object.assign(require('../../lib/logger'), log);

let _estado;      // qué "hay" en la base
let _escrituras;  // a qué fila se escribió y con qué
let _rpc;

/**
 * El error declarado para esta consulta: primero `tabla:columna`, después `tabla` a secas.
 *
 * **Devuelve el PRIMER match**, así que si algún día una consulta tuviera dos columnas con error
 * declarado, ganaría la que el código de producción encadenó primero. Hoy ninguna lo hace (está
 * latente, no vivo), pero deja el fixture atado al ORDEN de los `.eq()`: invertir
 * `.eq('code',…).is('verified_at',…)` cambiaría qué error ve el test sin cambiar un solo
 * comportamiento. Si eso llega a pasar, la salida es declarar el error por consulta completa, no
 * por columna suelta.
 */
function errorDe(tipo, tabla, filtros) {
  const mapa = _estado[tipo] || {};
  for (const col of Object.keys(filtros)) {
    if (mapa[tabla + ':' + col]) return mapa[tabla + ':' + col];
  }
  return mapa[tabla] || null;
}

/**
 * **El doble PROYECTA de verdad: devuelve sólo las columnas que la query pidió.**
 *
 * Sin esto `select()` es un no-op y el fixture entrega la fila completa mire lo que mire, con lo
 * cual **ningún test puede ver que a una consulta le falte una columna que el código lee después**.
 * Dos mutaciones reales quedaban verdes, y las dos son graves:
 *
 *   · quitar `expires_at` del select → `new Date(undefined).getTime()` es `NaN`, y `NaN <= x` es
 *     **false**, así que la rama de expiración deja de dispararse y **todos los códigos pasan a ser
 *     eternos**. El test "uno EXPIRADO no vincula" seguía verde;
 *   · quitar `supabase_auth_id` del select de `filaBsuid` → el corte que impide pisar la cuenta
 *     Google de otro compara contra `undefined` y se saltea entero. Su test seguía verde.
 *
 * Se arregla la CLASE y no los dos casos: taparlos uno por uno deja viva la próxima columna que
 * alguien quite. Ver [[feedback_tapar_el_caso_regenera_la_clase]].
 */
function proyectar(fila, seleccion) {
  if (!fila || !seleccion) return fila;
  const cols = seleccion.split(',').map((s) => s.trim()).filter(Boolean);
  if (cols.includes('*')) return fila;
  return Object.fromEntries(cols.filter((c) => c in fila).map((c) => [c, fila[c]]));
}

function buscar(tabla, filtros, seleccion) {
  const fila = (_estado[tabla] || []).find((f) => Object.entries(filtros).every(([col, val]) => (
    val === null ? (f[col] === null || f[col] === undefined) : f[col] === val
  ))) || null;
  return proyectar(fila, seleccion);
}

function chainDe(tabla) {
  const filtros = {};
  let op = 'select';
  let payload = null;
  let seleccion = null;
  const c = {
    select: vi.fn((cols) => { seleccion = cols || seleccion; return c; }),
    update: vi.fn((p) => { op = 'update'; payload = p; return c; }),
    eq: vi.fn((col, val) => { filtros[col] = val; return c; }),
    is: vi.fn((col, val) => { filtros[col] = val; return c; }),
    maybeSingle: vi.fn(() => {
      const err = errorDe('errorEnLectura', tabla, filtros);
      return Promise.resolve(err ? { data: null, error: err } : { data: buscar(tabla, filtros, seleccion), error: null });
    }),
  };
  // El `await` sobre la cadena sin `.maybeSingle()` es el update con `.select('id')`.
  c.then = (onF, onR) => {
    if (op !== 'update') {
      const err = errorDe('errorEnLectura', tabla, filtros);
      return Promise.resolve(err ? { data: null, error: err } : { data: buscar(tabla, filtros, seleccion), error: null }).then(onF, onR);
    }
    _escrituras.push({ tabla, filtros: { ...filtros }, payload });
    const err = errorDe('errorEnUpdate', tabla, filtros);
    if (err) return Promise.resolve({ data: null, error: err }).then(onF, onR);
    // `desaparece` modela la fila que se fue entre la lectura y la escritura (un merge
    // concurrente, una baja): cero filas afectadas, que llega con la MISMA forma que el éxito si
    // no se pide RETURNING. Es el caso que el `.select('id')` vigila.
    const objetivo = (_estado.desaparece || []).includes(tabla) ? null : buscar(tabla, filtros, 'id');
    return Promise.resolve({ data: objetivo ? [objetivo] : [], error: null }).then(onF, onR);
  };
  return c;
}

const supabase = require('../../lib/db').supabase;
supabase.from = vi.fn((tabla) => chainDe(tabla));
supabase.rpc = vi.fn(async (fn, args) => { _rpc.push({ fn, args }); return _estado.rpcResultado || { data: 'linked', error: null }; });

const { verificarCuentaWebPorBsuid } = require('../../services/otp-sin-numero');

const EN_UNA_HORA = new Date(Date.now() + 3600e3).toISOString();
const AUTH = 'auth-julio';
const BSUID = 'PE.1388235929393206';
const CODE = 'NETO-581556';
const otpVivo = (extra = {}) => ({
  id: 35, code: CODE, supabase_auth_id: AUTH,
  email: 'juliomejia540@gmail.com', nombre: 'Julio Mejia',
  expires_at: EN_UNA_HORA, verified_at: null, ...extra,
});
const filaWeb = (extra = {}) => ({ id: 'u-web', supabase_auth_id: AUTH, nombre: 'Julio Mejia', email: 'j@x.com', bsuid: null, ...extra });

beforeEach(() => {
  _estado = { webapp_otp: [], usuarios: [] };
  _escrituras = [];
  _rpc = [];
  supabase.rpc.mockClear();
  supabase.from.mockClear();
  log.error.mockClear();
});

const escrituraA = (tabla) => _escrituras.find((e) => e.tabla === tabla);

describe('verificarCuentaWebPorBsuid', () => {
  describe('hay cuenta web y el BSUID no es de nadie (el caso de Julio)', () => {
    beforeEach(() => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [filaWeb()];
    });

    it('escribe el BSUID en la cuenta web', async () => {
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('vinculada');
      const upd = escrituraA('usuarios');
      expect(upd.payload.bsuid).toBe(BSUID);
      // El destino importa tanto como el contenido.
      expect(upd.filtros.id).toBe('u-web');
    });

    it('quema el código para que no se pueda reusar', async () => {
      await verificarCuentaWebPorBsuid(BSUID, CODE);
      const upd = escrituraA('webapp_otp');
      expect(upd.payload.verified_at).toBeTruthy();
      expect(upd.filtros.id).toBe(35);
    });

    it('NO inventa un número: `whatsapp` sigue sin tocarse', async () => {
      await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(escrituraA('usuarios').payload).not.toHaveProperty('whatsapp');
    });

    it('un choque del índice único de bsuid no confirma ni quema el código', async () => {
      _estado.errorEnUpdate = { usuarios: { code: '23505', message: 'duplicate key' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('conflicto');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });

    // La fila se fue entre la lectura y la escritura. Sin RETURNING esto llega con la misma forma
    // que el éxito, y se marcaría verificado un vínculo que no se escribió: la persona quedaría
    // con la web destrabada, el BSUID suelto y sin código con el cual reintentar.
    it('cero filas afectadas NO se lee como éxito', async () => {
      _estado.desaparece = ['usuarios'];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('error');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });

    // **`verified_at` es la ÚNICA señal que destraba la webapp en este camino** (con número el
    // fallback es `usuarios.whatsapp`, que acá nunca se escribe). Si falla, la persona sigue en el
    // spinner sin canal para enterarse: no se puede reportar como éxito.
    it('si no se pudo marcar verificado, NO se declara destrabado', async () => {
      _estado.errorEnUpdate = { webapp_otp: { code: '57014', message: 'timeout' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('vinculada_sin_destrabar');
      // El vínculo SÍ se escribió: por eso no es `error`.
      expect(escrituraA('usuarios').payload.bsuid).toBe(BSUID);
    });
  });

  describe('las dos filas existen y son distintas', () => {
    beforeEach(() => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [filaWeb(), { id: 'u-wa', supabase_auth_id: null, nombre: null, email: null, bsuid: BSUID }];
    });

    it('fusiona con la cuenta web como superviviente', async () => {
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('fusionada');
      expect(_rpc[0]).toEqual({ fn: 'merge_and_link', args: { p_survivor: 'u-web', p_loser: 'u-wa' } });
    });

    it('un conflicto del merge no quema el código', async () => {
      _estado.rpcResultado = { data: 'conflict', error: null };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('conflicto');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });

    it('un resultado inesperado del merge no se lee como éxito', async () => {
      _estado.rpcResultado = { data: 'noop', error: null };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('error');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });
  });

  it('si el BSUID ya es de esa misma cuenta, solo quema el código', async () => {
    _estado.webapp_otp = [otpVivo()];
    _estado.usuarios = [filaWeb({ bsuid: BSUID })];
    const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
    expect(r.estado).toBe('ya_vinculada');
    expect(escrituraA('usuarios')).toBeUndefined();
  });

  // **La degradación tiene que valer en las CUATRO ramas, no sólo en `vinculada`.** El bool estaba
  // escrito en las cuatro pero sólo una lo ejercitaba: quitar el tercer argumento en las otras tres
  // dejaba 34 tests en verde, y `salida()` volvía al estado optimista. `fusionada` es la peor de
  // las tres, porque ahí `merge_and_link` ya borró la fila perdedora: la persona queda fusionada,
  // muda y mirando el spinner, y el aviso diría que se destrabó.
  describe('si el código no se puede quemar, NINGUNA rama declara destrabado', () => {
    beforeEach(() => {
      _estado.webapp_otp = [otpVivo()];
      _estado.errorEnUpdate = { webapp_otp: { code: '57014', message: 'timeout' } };
    });

    it('ya_vinculada', async () => {
      _estado.usuarios = [filaWeb({ bsuid: BSUID })];
      expect((await verificarCuentaWebPorBsuid(BSUID, CODE)).estado).toBe('vinculada_sin_destrabar');
    });

    it('fusionada', async () => {
      _estado.usuarios = [filaWeb(), { id: 'u-wa', supabase_auth_id: null, nombre: null, email: null, bsuid: BSUID }];
      expect((await verificarCuentaWebPorBsuid(BSUID, CODE)).estado).toBe('vinculada_sin_destrabar');
    });

    it('adoptada', async () => {
      _estado.usuarios = [{ id: 'u-wa', supabase_auth_id: null, nombre: 'Anon', email: null, bsuid: BSUID }];
      expect((await verificarCuentaWebPorBsuid(BSUID, CODE)).estado).toBe('vinculada_sin_destrabar');
    });
  });

  describe('sin cuenta web pero con fila del BSUID', () => {
    it('adopta esa fila', async () => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [{ id: 'u-wa', supabase_auth_id: null, nombre: 'Anon', email: null, bsuid: BSUID }];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('adoptada');
      const upd = escrituraA('usuarios');
      expect(upd.payload.supabase_auth_id).toBe(AUTH);
      expect(upd.filtros.id).toBe('u-wa');
    });

    // El borde que `merge_and_link` declara `'conflict'` y que esta rama no puede saltearse por no
    // pasar por el RPC. El caso vivo: alguien se loguea con un segundo Google y se auto-desvincula
    // el primero, en silencio.
    it('NO pisa un `supabase_auth_id` que ya es de otra cuenta Google', async () => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [{ id: 'u-wa', supabase_auth_id: 'auth-DE-OTRO', nombre: 'Otro', email: 'otro@x.com', bsuid: BSUID }];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('conflicto');
      expect(_escrituras).toHaveLength(0);
    });

    // El `23505` de esta rama es OTRO índice que el de la rama `vinculada`: acá es el del EMAIL
    // ("ese correo ya es de otra cuenta de WhatsApp"). Degradarlo a `error` cuesta doble: no
    // dispara el Telegram de conflicto, y ADEMÁS entra en la lista de reembolso del webhook, así
    // que el caso que necesita una mano humana se traga en silencio y encima sale gratis.
    it('un choque del índice del EMAIL es conflicto, no error genérico', async () => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [{ id: 'u-wa', supabase_auth_id: null, nombre: 'Anon', email: null, bsuid: BSUID }];
      _estado.errorEnUpdate = { usuarios: { code: '23505', message: 'duplicate key value violates unique constraint "usuarios_email_lower_unique"' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('conflicto');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });

    it('cero filas afectadas en la adopción tampoco es éxito', async () => {
      _estado.webapp_otp = [otpVivo()];
      _estado.usuarios = [{ id: 'u-wa', supabase_auth_id: null, nombre: 'Anon', email: null, bsuid: BSUID }];
      _estado.desaparece = ['usuarios'];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('error');
      expect(escrituraA('webapp_otp')).toBeUndefined();
    });
  });

  describe('el código', () => {
    it('uno que no existe no escribe nada', async () => {
      const r = await verificarCuentaWebPorBsuid(BSUID, 'NETO-000000');
      expect(r.estado).toBe('invalido');
      expect(_escrituras).toHaveLength(0);
    });

    it('uno EXPIRADO no vincula', async () => {
      _estado.webapp_otp = [otpVivo({ expires_at: new Date(Date.now() - 1000).toISOString() })];
      _estado.usuarios = [filaWeb()];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('invalido');
      expect(_escrituras).toHaveLength(0);
    });

    // Lo que hace que el código sea de UN SOLO USO es el `.is('verified_at', null)` de la query.
    // Sin este caso, quitarlo deja toda la suite en verde y un código quemado revive su ventana.
    it('uno YA VERIFICADO no se puede reusar', async () => {
      _estado.webapp_otp = [otpVivo({ verified_at: '2026-09-02T20:00:00Z' })];
      _estado.usuarios = [filaWeb()];
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('invalido');
      expect(_escrituras).toHaveLength(0);
    });

    // Una lectura caída NO es "ese código no existe". La diferencia importa acá más que en el
    // flujo con número: `invalido` no devuelve la ficha del rate limit, y a esta persona no se le
    // puede mandar el "volvé a enviármelo en un minuto".
    it('una lectura caída no lo declara inválido', async () => {
      _estado.errorEnLectura = { webapp_otp: { code: '57014', message: 'statement timeout' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('lectura_fallida');
      expect(_escrituras).toHaveLength(0);
    });

    // `webapp_otp.code` no tiene índice único: dos cuentas pueden tener el mismo código pendiente
    // y `maybeSingle()` devuelve PGRST116. Vincular una de las dos a ciegas ataría el WhatsApp a
    // la cuenta equivocada, así que cae a `invalido` y regenerar lo resuelve.
    it('dos cuentas con el mismo código no vinculan a ciegas', async () => {
      _estado.errorEnLectura = { webapp_otp: { code: 'PGRST116', message: 'multiple rows' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('invalido');
      expect(_escrituras).toHaveLength(0);
    });
  });

  describe('lecturas caídas de `usuarios`: cada una falla SOLA', () => {
    beforeEach(() => { _estado.webapp_otp = [otpVivo()]; });

    it('la de la cuenta web no elige rama a ciegas', async () => {
      _estado.errorEnLectura = { 'usuarios:supabase_auth_id': { code: '57014', message: 'timeout' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('lectura_fallida');
      expect(_escrituras).toHaveLength(0);
    });

    // Sin esta rama, un timeout acá se lee como "ese BSUID no es de nadie" → entra a vincular →
    // choca con el índice único → `conflicto`, y el admin recibe un aviso de "revisión manual"
    // cuando lo que hubo fue un hipo de la base.
    it('la de la fila del BSUID tampoco', async () => {
      _estado.usuarios = [filaWeb()];
      _estado.errorEnLectura = { 'usuarios:bsuid': { code: '57014', message: 'timeout' } };
      const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
      expect(r.estado).toBe('lectura_fallida');
      expect(_escrituras).toHaveLength(0);
    });
  });

  it('un código válido sin ninguna fila a la cual vincular no escribe nada', async () => {
    _estado.webapp_otp = [otpVivo()];
    const r = await verificarCuentaWebPorBsuid(BSUID, CODE);
    expect(r.estado).toBe('sin_cuenta_web');
    expect(_escrituras).toHaveLength(0);
  });

  it('sin bsuid o sin código no hace nada', async () => {
    expect((await verificarCuentaWebPorBsuid(null, CODE)).estado).toBe('error');
    expect((await verificarCuentaWebPorBsuid(BSUID, null)).estado).toBe('error');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

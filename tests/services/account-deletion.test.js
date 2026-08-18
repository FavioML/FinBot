import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Setup: parchar singletons ANTES de requerir el servicio ─────────────────
// `services/account-deletion.js` destructura sus dependencias al cargar, así que hay que
// reemplazar la propiedad en el módulo antes de requerirlo para que la destructuración
// capture el spy. Mismo patrón que `tests/handlers/webhook-onboarding.test.js`.

// El ORDEN de los efectos es la mitad del contrato de este archivo (revocar antes del RPC,
// Storage y auth después), y el orden no se puede afirmar mirando cada mock por separado.
// Todos empujan acá.
const orden = [];

const obtenerCuentasGmail = vi.fn();
const revocarAccesoGmail = vi.fn();
const hashEmailGmail = vi.fn();
require('../../gmail').obtenerCuentasGmail = obtenerCuentasGmail;
require('../../gmail').revocarAccesoGmail = revocarAccesoGmail;
require('../../gmail').hashEmailGmail = hashEmailGmail;

const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;

const registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = registrarError;

// Mock de Supabase. A diferencia del doble del webhook, acá interesa QUÉ se le pasa al RPC y
// EN QUÉ ORDEN pasan las cosas, no simular filtros: el borrado real lo hace Postgres y eso no
// es mockeable (ver el docblock de qa-e2e/qa-borrado-cuenta.mjs).
const rpc = vi.fn();
const storageList = vi.fn();
const storageRemove = vi.fn();
const deleteUser = vi.fn();
// `gmail_cuentas` es la única tabla que el servicio lee/escribe directo (el backfill del hash).
let gmailFilas = [];
let errorLecturaGmail = null;
let errorUpdateHash = null;
const updatesDeHash = [];

const db = require('../../lib/db');
db.supabase.from = vi.fn((tabla) => {
  if (tabla !== 'gmail_cuentas') throw new Error('el servicio no debería tocar la tabla ' + tabla);
  const chain = {
    select: () => ({ eq: () => Promise.resolve({ data: gmailFilas, error: errorLecturaGmail }) }),
    update: (campos) => ({
      eq: (_col, id) => {
        updatesDeHash.push({ id, campos });
        return Promise.resolve({ error: errorUpdateHash });
      },
    }),
  };
  return chain;
});
db.supabase.rpc = (...args) => { orden.push('rpc'); return rpc(...args); };
db.supabase.storage = {
  from: () => ({
    list: (...a) => storageList(...a),
    remove: (...a) => { orden.push('storage.remove'); return storageRemove(...a); },
  }),
};
db.supabase.auth = { admin: { deleteUser: (...a) => { orden.push('auth.deleteUser'); return deleteUser(...a); } } };

const { borrarCuenta } = require('../../services/account-deletion');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'free', supabase_auth_id: 'auth-1' };
const PRO_PAGADO = { ...USUARIO, plan: 'premium', trial_estado: 'convertido', tipo_plan: 'anual', premium_vence: '2027-03-15' };

function avisos() {
  return notificarAdmin.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  orden.length = 0;
  updatesDeHash.length = 0;
  gmailFilas = [];
  errorLecturaGmail = null;
  errorUpdateHash = null;
  vi.clearAllMocks();
  notificarAdmin.mockResolvedValue(true);
  obtenerCuentasGmail.mockResolvedValue([]);
  revocarAccesoGmail.mockImplementation(async () => { orden.push('revocar'); });
  hashEmailGmail.mockReturnValue('hash-de-prueba');
  rpc.mockResolvedValue({ data: { transacciones: 7, deudas: 0, conversaciones: 3, auditoria_purgada: 7, residual: {} }, error: null });
  storageList.mockResolvedValue({ data: [], error: null });
  storageRemove.mockResolvedValue({ error: null });
  deleteUser.mockResolvedValue({ error: null });
});

// ─── Los invariantes que se mudaron al SQL ───────────────────────────────────
//
// Al pasar el borrado a un RPC, dos casos de `webhook-onboarding.test.js` se quedaron sin
// reemplazo: *"el wipe NO baja el plan ni toca premium_vence"* y *"el wipe MARCA la baja en
// cuenta_borrada_at"*. Los dos siguen siendo invariantes vivos —el primero es la decisión
// lockeada que sostiene el Pro de 9 clientes que pagan, el segundo es el hecho del que
// dependen las métricas de churn— pero ahora viven dentro de un `.sql` que ningún test de
// vitest leía. Agregar `plan = 'free'` a ese UPDATE pasaba la suite ENTERA en verde.
//
// Lo único que los miraba era `qa-e2e/qa-borrado-cuenta.mjs`, que está deliberadamente fuera
// del canary y necesita la DB real con dos usuarios sembrados: no corre en CI y no frena un
// push. Este guard es estático a propósito, mismo patrón que `tests/gmail-oauth-gates.test.js`.
//
// Lo encontró la revisión adversarial del diff, no yo.
describe('el SQL del borrado respeta las decisiones lockeadas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'migrations');

  // La definición VIGENTE es la del archivo más alto que la redefine, no un nombre fijo: las
  // migraciones son append-only y un `073d` mañana dejaría este guard mirando código muerto,
  // en verde y sin avisar.
  const archivos = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf-8').includes('FUNCTION public.borrar_cuenta_total'))
    .sort();
  const vigente = archivos[archivos.length - 1];
  const SQL = vigente ? fs.readFileSync(path.join(dir, vigente), 'utf-8') : '';

  // TODOS los `UPDATE public.usuarios SET` del archivo, no solo el ultimo. Con `lastIndexOf`
  // el guard era ASIMETRICO: un `plan = 'free'` metido en un UPDATE ANTES del bloque de la
  // lapida quedaba invisible, y esa es justo la mitad que tomaria un downgrade "de limpieza".
  // Lo levanto la segunda revision adversarial.
  const bloques = [];
  for (const m of SQL.matchAll(/UPDATE public\.usuarios SET/g)) {
    const fin = SQL.indexOf(';', m.index);
    bloques.push(SQL.slice(m.index, fin === -1 ? SQL.length : fin));
  }
  const bloque = bloques.join('\n');

  it('encuentra la migración vigente y el bloque (antivacuidad)', () => {
    expect(archivos.length, 'ninguna migración define borrar_cuenta_total').toBeGreaterThan(0);
    expect(bloques.length, 'no se encontro ningun UPDATE de usuarios: este guard dejo de mirar nada').toBeGreaterThan(0);

    expect(bloque.length).toBeGreaterThan(100);
  });

  // Decisión lockeada: quien pagó conserva su Pro si vuelve. El borrado marca la baja para las
  // MÉTRICAS; el entitlement no se mueve.
  it.each(['plan', 'premium_vence', 'premium_desde', 'tipo_plan', 'estado_pago'])(
    'la lápida NO toca `%s`', (col) => {
      expect(bloque, 'el borrado está tocando el entitlement de quien pagó').not.toMatch(new RegExp('\\b' + col + '\\s*='));
    });

  it('la lápida SÍ escribe cuenta_borrada_at', () => {
    expect(bloque).toMatch(/cuenta_borrada_at\s*=/);
  });

  // Es un HECHO, no un estado: una segunda corrida no puede correrle la fecha.
  it('cuenta_borrada_at no se pisa en un segundo borrado', () => {
    expect(bloque, 'sin COALESCE, reintentar mueve la fecha de la baja').toMatch(/cuenta_borrada_at\s*=\s*COALESCE\(/i);
    expect(SQL, 'falta el corte de idempotencia por cuenta_borrada_at').toMatch(/IF\s+v_ya\s+IS\s+NOT\s+NULL/i);
  });

  // Las tres tablas que llevan el teléfono en columna PROPIA además de la FK. La 073 solo se
  // lo aplicaba a `nlp_errors`; medido, `errores` conservaba 166 números de usuarios vivos.
  it.each(['errores', 'tickets_soporte', 'nlp_errors'])(
    '`%s` se borra también por teléfono, no solo por usuario_id', (tabla) => {
      const i = SQL.indexOf('DELETE FROM public.' + tabla + '\n');
      expect(i, 'no se encontró el DELETE de ' + tabla).toBeGreaterThan(-1);
      const stmt = SQL.slice(i, SQL.indexOf(';', i));
      expect(stmt, tabla + ' se borra solo por usuario_id: el número sobrevive a la baja')
        .toMatch(/whatsapp\s*=\s*v_whatsapp/);
    });
});

describe('borrarCuenta — el cupo de Gmail es la trampa cara', () => {
  // Si el borrado se lleva el correo sin dejar hash, se pierde para siempre el rastro de que
  // ese usuario de Google ya gastó uno de los 100 cupos de por vida. La persona podría volver,
  // conectar otro correo y quemar otro cupo irrecuperable, pagando una sola vez. Por eso el
  // fallo va SIEMPRE hacia conservar el dato: es lo único que no tiene vuelta atrás.
  it('sin pepper (hash null) NO borra el correo, y lo dice', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: null, activa: true }];
    hashEmailGmail.mockReturnValue(null);
    const r = await borrarCuenta(USUARIO, { origen: 'whatsapp' });
    expect(rpc).toHaveBeenCalledWith('borrar_cuenta_total', expect.objectContaining({ p_borrar_email_gmail: false }));
    expect(r.sucio.join(' ')).toMatch(/cupo/i);
    expect(avisos()[0]).toMatch(/qued[oó] a medias/i);
  });

  it('si la fila YA tiene hash, borra el correo sin recalcular nada', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: 'hash-viejo', activa: true }];
    hashEmailGmail.mockReturnValue(null);   // aunque no haya pepper: el hash ya está escrito
    await borrarCuenta(USUARIO, {});
    expect(rpc).toHaveBeenCalledWith('borrar_cuenta_total', expect.objectContaining({ p_borrar_email_gmail: true }));
    expect(updatesDeHash).toHaveLength(0);
  });

  it('si falta el hash y hay pepper, lo escribe ANTES de borrar', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: null, activa: true }];
    await borrarCuenta(USUARIO, {});
    expect(updatesDeHash).toEqual([{ id: 'g1', campos: { email_hash: 'hash-de-prueba' } }]);
    expect(rpc).toHaveBeenCalledWith('borrar_cuenta_total', expect.objectContaining({ p_borrar_email_gmail: true }));
  });

  // supabase-js NO lanza: sin leer el `{ error }` el UPDATE rechazado pasaba por bueno y el
  // borrado se llevaba el correo dejando la fila sin ninguna de las dos caras.
  it('si el UPDATE del hash falla, tampoco borra el correo', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: null, activa: true }];
    errorUpdateHash = { message: 'statement timeout' };
    await borrarCuenta(USUARIO, {});
    expect(rpc).toHaveBeenCalledWith('borrar_cuenta_total', expect.objectContaining({ p_borrar_email_gmail: false }));
  });

  it('si ni siquiera se pueden LEER las filas de Gmail, tampoco borra el correo', async () => {
    errorLecturaGmail = { message: 'connection reset' };
    await borrarCuenta(USUARIO, {});
    expect(rpc).toHaveBeenCalledWith('borrar_cuenta_total', expect.objectContaining({ p_borrar_email_gmail: false }));
  });
});

describe('borrarCuenta — el orden de los efectos', () => {
  // El RPC borra los refresh tokens. Revocar después deja el grant vivo en Google para
  // siempre y sin forma de alcanzarlo: permiso de lectura sobre la bandeja de alguien que
  // se fue.
  it('revoca en Google ANTES del RPC', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: 'h', activa: true }];
    await borrarCuenta(USUARIO, {});
    expect(orden.indexOf('revocar')).toBeGreaterThan(-1);
    expect(orden.indexOf('revocar')).toBeLessThan(orden.indexOf('rpc'));
  });

  it('sin cuentas de Gmail no llama a Google', async () => {
    gmailFilas = [];
    await borrarCuenta(USUARIO, {});
    expect(revocarAccesoGmail).not.toHaveBeenCalled();
  });

  // `revocarAccesoGmail` puede LANZAR (`obtenerCuentasGmail` no está guardado por dentro).
  // Sin el try, esa excepción se llevaba puesto el borrado entero: la persona pedía irse y
  // sus datos se quedaban por un fallo de un tercero.
  it('si la revocación LANZA, el borrado sigue y el admin se entera', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: 'h', activa: true }];
    revocarAccesoGmail.mockRejectedValue(new Error('google 503'));
    const r = await borrarCuenta(USUARIO, {});
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalled();
    expect(r.sucio.join(' ')).toMatch(/google 503/);
  });

  // El caso que rompía DENTRO del catch: un rechazo que no es un Error deja `e.message`
  // undefined, y esa segunda excepción se llevaba el borrado con los datos ya tocados.
  it('un rechazo que no es Error tampoco tumba el borrado', async () => {
    gmailFilas = [{ id: 'g1', email: 'a@x.com', email_hash: 'h', activa: true }];
    revocarAccesoGmail.mockRejectedValue(null);
    const r = await borrarCuenta(USUARIO, {});
    expect(r.ok).toBe(true);
  });
});

describe('borrarCuenta — cuando el RPC falla no se tocó nada', () => {
  it('devuelve ok:false y NO sigue con Storage ni con auth.users', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    storageList.mockResolvedValue({ data: [{ name: '1.jpg' }], error: null });
    const r = await borrarCuenta(USUARIO, { origen: 'webapp' });
    expect(r.ok).toBe(false);
    // Esto es lo que hace honesto el "tu cuenta sigue igual": la transacción se revirtió
    // entera, así que seguir borrando lo de afuera sería destruir lo único que quedó.
    expect(storageRemove).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(avisos()[0]).toMatch(/BORRADO FALLIDO/);
    expect(registrarError).toHaveBeenCalled();
  });
});

describe('borrarCuenta — las superficies que no son tablas', () => {
  it('borra los objetos de Storage del usuario, listados por carpeta', async () => {
    storageList.mockResolvedValue({ data: [{ name: '1.jpg' }, { name: '2.png' }], error: null });
    await borrarCuenta(USUARIO, {});
    expect(storageList).toHaveBeenCalledWith('u-1', expect.anything());
    expect(storageRemove).toHaveBeenCalledWith(['u-1/1.jpg', 'u-1/2.png']);
  });

  it('borra la identidad de Supabase Auth', async () => {
    await borrarCuenta(USUARIO, {});
    expect(deleteUser).toHaveBeenCalledWith('auth-1');
  });

  it('sin cuenta web no intenta borrar ninguna identidad', async () => {
    await borrarCuenta({ ...USUARIO, supabase_auth_id: null }, {});
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('si Storage o auth fallan, los datos ya no están: se reporta, no se revierte', async () => {
    storageList.mockResolvedValue({ data: [{ name: '1.jpg' }], error: null });
    storageRemove.mockResolvedValue({ error: { message: 'bucket 500' } });
    deleteUser.mockResolvedValue({ error: { message: 'auth 500' } });
    const r = await borrarCuenta(USUARIO, {});
    expect(r.ok).toBe(true);
    expect(r.sucio.join(' ')).toMatch(/bucket 500/);
    expect(r.sucio.join(' ')).toMatch(/auth 500/);
    expect(avisos()[0]).toMatch(/qued[oó] a medias/i);
  });
});

describe('borrarCuenta — el aviso al admin', () => {
  it('lleva los conteos que el RPC tomó antes de borrar', async () => {
    await borrarCuenta(USUARIO, { origen: 'webapp' });
    expect(avisos()[0]).toMatch(/BAJA DECLARADA/);
    expect(avisos()[0]).toMatch(/Movimientos que tenia: 7/);
    expect(avisos()[0]).toMatch(/webapp/);
  });

  // Distingue a alguien que probó y se fue de un CLIENTE que pagó y se fue. Y ahora además
  // hay algo que hacer: se le borró el número, así que si vuelve no se lo reconoce solo.
  it('un Pro PAGADO se anuncia como tal, con su vencimiento', async () => {
    await borrarCuenta(PRO_PAGADO, {});
    expect(avisos()[0]).toMatch(/ERA PRO PAGADO/);
    expect(avisos()[0]).toMatch(/2027-03-15/);
  });

  it('un trial en curso NO se anuncia como pagado', async () => {
    await borrarCuenta({ ...PRO_PAGADO, trial_estado: 'activo' }, {});
    expect(avisos()[0]).not.toMatch(/ERA PRO PAGADO/);
  });

  // El residual lo calcula el RPC recomputando de `pg_constraint`. Es el único aviso que
  // existe para "alguien agregó una tabla y no la clasificó", y si no llegara al admin ese
  // caso sería invisible: el usuario recibe su confirmación igual.
  it('un residual no vacío llega al admin', async () => {
    rpc.mockResolvedValue({ data: { transacciones: 0, residual: { 'tabla_nueva.usuario_id': 3 } }, error: null });
    const r = await borrarCuenta(USUARIO, {});
    expect(r.sucio.join(' ')).toMatch(/tabla_nueva\.usuario_id/);
    expect(avisos()[0]).toMatch(/tabla_nueva/);
  });

  // `notificarAdmin` no lanza: devuelve false cuando fallan los dos canales. Este evento no
  // tiene reintento ni cola, así que si el aviso se pierde no queda nada — salvo el log.
  it('un aviso que no sale no rompe la respuesta a la persona', async () => {
    notificarAdmin.mockResolvedValue(false);
    const r = await borrarCuenta(USUARIO, {});
    expect(r.ok).toBe(true);
  });
});

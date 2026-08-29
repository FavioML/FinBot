import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El canal de correo, probado por COMPORTAMIENTO. Su hermano estático es
 * `tests/notificaciones-duales.test.js`, que afirma que nadie lo llame por fuera del
 * chokepoint; acá se afirma lo que hace cuando lo llaman.
 *
 * Lo que este archivo defiende, en orden de cuánto costaría re-descubrirlo:
 *
 *  1. **Que toda salida deje fila en `notification_deliveries`, incluidos los no-op.** Es la
 *     lección de B23 aplicada antes de tiempo: sin la fila, "el canal está apagado" y "nadie
 *     llamó al canal" se ven idénticos desde afuera, y el día que el correo no salga habrá que
 *     deducirlo. Con `RESEND_API_KEY` todavía sin poner en Railway, ésa es HOY la única forma
 *     de verificar en producción que el camino se recorre.
 *  2. **Que sin link de baja no salga el correo.** Fail closed, y es la aserción que más fácil
 *     se "arregla" en la dirección equivocada: degradar a mandar sin link parece más amable y
 *     convierte un transaccional legítimo en algo indefendible.
 *  3. **Que nunca lance.** Vive dentro del bucle de destinatarios de un cron. Una excepción acá
 *     no se lleva un correo: se lleva la corrida entera.
 */

// ── Dobles ────────────────────────────────────────────────────────────────────────────────
let filas = [];
let resultadoInsert = { error: null };
let usuarioDePrueba = false;
let errorAlLeerUsuario = null;
let errorEnLectura = null;   // el `{ error }` que supabase-js devuelve SIN lanzar
let lecturas = 0;
// El conteo del tope diario. Es una consulta `head:true`, o sea que se AWAITEA la cadena
// misma en vez de un `.single()`: por eso el doble tiene `then`, y no un método más.
let conteoTope = { count: 0, error: null };
let filtrosDelConteo = [];

require('../../lib/db').supabase.from = vi.fn((tabla) => {
  const chain = {
    insert: vi.fn(async (fila) => { filas.push({ tabla, fila }); return resultadoInsert; }),
    select: vi.fn(() => chain),
    eq: vi.fn((col, val) => { filtrosDelConteo.push([col, val]); return chain; }),
    gte: vi.fn((col, val) => { filtrosDelConteo.push([col, val]); return chain; }),
    then: (resolve, reject) => Promise.resolve(conteoTope).then(resolve, reject),
    maybeSingle: vi.fn(async () => {
      lecturas++;
      if (errorAlLeerUsuario) throw errorAlLeerUsuario;
      // supabase-js NO lanza ante un 5xx/RLS: devuelve `{ data: null, error }` y RESUELVE.
      if (errorEnLectura) return { data: null, error: errorEnLectura };
      return { data: { is_test_user: usuarioDePrueba }, error: null };
    }),
  };
  return chain;
});

const logMock = require('../../lib/logger');
vi.spyOn(logMock, 'error').mockImplementation(() => {});
vi.spyOn(logMock, 'info').mockImplementation(() => {});
vi.spyOn(logMock, 'warn').mockImplementation(() => {});

const {
  enviarEmail, construirTokenBaja, verificarTokenBaja, construirLinkBaja, construirHtml,
} = require('../../lib/email');

const ENV_ORIGINAL = { ...process.env };
let fetchSpy;

// Cada caso usa su PROPIO usuarioId. `esUsuarioDePrueba` cachea 5 minutos por id dentro del
// módulo, así que reusarlo haría que el resultado del caso anterior decidiera el siguiente —
// un test verde por la caché es indistinguible de uno verde por el código.
let n = 0;
const nuevoId = () => 'u-' + (++n);

beforeEach(() => {
  filas = [];
  resultadoInsert = { error: null };
  usuarioDePrueba = false;
  errorAlLeerUsuario = null;
  errorEnLectura = null;
  lecturas = 0;
  conteoTope = { count: 0, error: null };
  filtrosDelConteo = [];
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_OPTOUT_SECRET = 'secreto-de-prueba';
  process.env.RESEND_FROM = 'Neto <hola@neto.pe>';
  // `vi.spyOn` sobre un método YA espiado devuelve el MISMO spy, así que sin el reset el
  // historial se acumula entre casos. No es cosmético: costó dos falsos rojos que parecían
  // bugs del código —un `not.toHaveBeenCalled()` que veía la llamada del test anterior, y un
  // `mock.calls[0]` que era el payload de OTRO usuario— y el falso VERDE simétrico es peor:
  // un caso que no llama a fetch pasaría un `toHaveBeenCalled()` con la llamada del vecino.
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'resend-abc' }) });
});

afterAll(() => { process.env = ENV_ORIGINAL; });

const delivery = () => filas.filter((f) => f.tabla === 'notification_deliveries').map((f) => f.fila);
const BASE = { asunto: 'Tu deuda vence hoy', titulo: 'Deuda vence hoy', cuerpo: 'Le debes S/ 120 a Juan', tipo: 'deuda' };

describe('enviarEmail: toda salida deja rastro', () => {
  it('sin dirección: no-op, fila skipped_no_email, y NO llama a Resend', async () => {
    const res = await enviarEmail(null, { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: false, skipped: 'no_email' });
    expect(delivery()).toEqual([expect.objectContaining({ canal: 'email', estado: 'skipped_no_email' })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin RESEND_API_KEY: fila skipped_sin_proveedor, y NO llama a Resend', async () => {
    // Es el estado de producción HOY, antes de verificar el dominio. Un no-op silencioso
    // haría imposible distinguirlo de un cron que no se ejecutó.
    delete process.env.RESEND_API_KEY;
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: false, skipped: 'sin_proveedor' });
    expect(delivery()).toEqual([expect.objectContaining({ estado: 'skipped_sin_proveedor' })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin `tipo` no se registra nada: es la regla de registrarEntrega, no una excepción del correo', async () => {
    await enviarEmail(null, { asunto: 'x', titulo: 'x', cuerpo: 'x', usuarioId: nuevoId() });
    expect(delivery()).toEqual([]);
  });

  it('usuario de prueba: no sale, y queda skipped_test', async () => {
    usuarioDePrueba = true;
    const res = await enviarEmail('qa@neto.pe', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: true, skipped: 'test_user' });
    expect(delivery()).toEqual([expect.objectContaining({ estado: 'skipped_test' })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('si la lectura de is_test_user LANZA, falla ABIERTO (el correo sale igual)', async () => {
    // Mismo criterio que `isTestUser` en whatsapp.js: el costo de equivocarse acá es un correo
    // de más a una cuenta de prueba, y el de fallar cerrado es silenciar a un usuario real.
    errorAlLeerUsuario = new Error('PostgREST 503');
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  /**
   * Y el modo de falla REAL, que es otro. El caso de arriba mockea `throw`, o sea la excepción
   * (red caída, cliente roto). **supabase-js no lanza**: un 5xx de PostgREST o un RLS devuelven
   * `{ data: null, error: {...} }` y la promesa RESUELVE. Un test que solo cubre el `throw`
   * declara "fail open" sobre la rama que casi nunca corre.
   *
   * Lo que importa no es solo que salga el correo, sino que NO SE CACHEE ese "no es de prueba".
   * Con la caché envenenada, cinco minutos de hipo de lectura le mandan correo real a la cuenta
   * de QA sin volver a preguntar — el fail-open pasa de ser una decisión por llamada a una
   * decisión que se toma una vez y se sostiene un rato largo.
   */
  it('si la lectura devuelve {error} (lo que supabase-js hace de verdad), NO se cachea', async () => {
    const id = nuevoId();
    errorEnLectura = { message: 'PostgREST 503' };
    await enviarEmail('a@b.com', { ...BASE, usuarioId: id });
    expect(fetchSpy).toHaveBeenCalled();

    // Segunda llamada con la lectura ya sana y el usuario marcado como de prueba: si la
    // primera hubiera cacheado el `false`, esto mandaría un correo real a la cuenta de QA.
    errorEnLectura = null;
    usuarioDePrueba = true;
    fetchSpy.mockClear();
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: id });
    expect(res).toEqual({ ok: true, skipped: 'test_user' });
    expect(fetchSpy, 'la caché envenenada por un error de lectura mandó correo a QA').not.toHaveBeenCalled();
  });

  it('la caché SÍ funciona cuando la lectura fue sana (una query, no una por correo)', () => {
    // El control positivo: sin él, un `esUsuarioDePrueba` que nunca cachee pasaría el test de
    // arriba y agregaría una query por cada correo.
    const id = nuevoId();
    usuarioDePrueba = true;
    return enviarEmail('a@b.com', { ...BASE, usuarioId: id }).then(async () => {
      lecturas = 0;
      const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: id });
      expect(res.skipped).toBe('test_user');
      expect(lecturas, 'no cacheó: una query por correo').toBe(0);
    });
  });
});

describe('enviarEmail: sin salida no hay correo (fail closed)', () => {
  it('sin EMAIL_OPTOUT_SECRET no manda, y lo deja escrito', async () => {
    delete process.env.EMAIL_OPTOUT_SECRET;
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: false, skipped: 'sin_link_baja' });
    expect(delivery()).toEqual([expect.objectContaining({ estado: 'skipped_sin_baja' })]);
    expect(fetchSpy, 'salió un recordatorio del que no se puede salir').not.toHaveBeenCalled();
  });

  it('el correo lleva el link de baja y los DOS headers de one-click', async () => {
    const id = nuevoId();
    await enviarEmail('a@b.com', { ...BASE, usuarioId: id });
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const link = construirLinkBaja(id);
    expect(payload.html).toContain(link);
    expect(payload.text).toContain(link);
    // Los dos headers van juntos o el botón nativo de Gmail/Outlook no aparece.
    expect(payload.headers['List-Unsubscribe']).toBe('<' + link + '>');
    expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('manda html Y texto plano', () => {
    // Un correo solo-HTML puntúa peor en cualquier filtro de spam, y este canal existe
    // justamente porque el otro no entrega.
    return enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() }).then(() => {
      const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(payload.text).toContain('Le debes S/ 120 a Juan');
      expect(payload.html).toContain('Le debes S/ 120 a Juan');
      expect(payload.from).toBe('Neto <hola@neto.pe>');
      expect(payload.subject).toBe('Tu deuda vence hoy');
    });
  });
});

describe('enviarEmail: "Resend aceptó" NO es entrega', () => {
  it('el éxito guarda el id del proveedor, que es lo que el webhook va a cruzar', async () => {
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: true, msgId: 'resend-abc' });
    // `sent`, no `delivered`. `delivered_at` lo escribe el webhook, y sin `wamid` no hay forma
    // de encontrar esta fila cuando el callback llegue: la fila quedaría en `sent` para
    // siempre y el canal reportaría 100% de entrega — el hallazgo B23, otra vez.
    expect(delivery()).toEqual([expect.objectContaining({
      estado: 'sent', canal: 'email', wamid: 'resend-abc', tipo: 'deuda',
    })]);
  });

  it('una respuesta 200 SIN id no cuenta como enviada', async () => {
    // Si `data.id` no viniera y se registrara `sent` igual, la fila sería incruzable: el
    // webhook nunca la encontraría y quedaría como entregada-que-no-se-sabe para siempre.
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res.ok).toBe(false);
    expect(delivery()[0].estado).toBe('error');
  });
});

describe('enviarEmail: nunca lanza', () => {
  it('un error de Resend queda como error con su código', async () => {
    fetchSpy.mockResolvedValue({
      ok: false, status: 422, json: async () => ({ message: 'domain is not verified' }),
    });
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: false, code: 422, error: 'domain is not verified' });
    expect(delivery()).toEqual([expect.objectContaining({
      estado: 'error', code: 422, error: 'domain is not verified',
    })]);
  });

  it('un fetch que rechaza no propaga', async () => {
    // El caso real: `AbortSignal.timeout` a los 15s dentro del bucle de un cron.
    fetchSpy.mockRejectedValue(new Error('The operation was aborted'));
    await expect(enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() }))
      .resolves.toEqual({ ok: false, code: null, error: 'The operation was aborted' });
    expect(delivery()[0].estado).toBe('error');
  });

  it('un cuerpo que no es JSON no propaga', async () => {
    fetchSpy.mockResolvedValue({
      ok: false, status: 502, json: async () => { throw new Error('Unexpected token <'); },
    });
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    // El `.catch(() => ({}))` del parse deja seguir hasta el registro del error con su status.
    expect(res).toEqual({ ok: false, code: 502, error: 'HTTP 502' });
  });
});

describe('el HTML del correo escapa lo que viene de datos del usuario', () => {
  // `contraparte` es texto que escribió la persona ("le debo a <b>Juan</b>") y va derecho al
  // asunto y al cuerpo. Un correo no es un navegador, pero sí renderiza HTML, así que la misma
  // regla del callback de OAuth (`tests/gmail-oauth-gates.test.js`) vale acá.
  it('escapa etiquetas en el título y en el cuerpo', () => {
    const html = construirHtml({
      titulo: '<script>alert(1)</script>',
      cuerpo: 'Le debes a "Juan" & <b>Ana</b>',
      link: '/dashboard/deudas',
      linkBaja: 'https://api.neto.pe/baja-recordatorios?t=x',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });

  it('absolutiza el link relativo de la campana', () => {
    // El mismo `link` alimenta la campana (donde `/dashboard/deudas` es correcto) y el correo
    // (donde no lleva a ningún lado).
    const html = construirHtml({ titulo: 't', cuerpo: 'c', link: '/dashboard/deudas', linkBaja: null });
    expect(html).toContain('https://app.neto.pe/dashboard/deudas');
  });

  it('sin link no inventa un botón', () => {
    const html = construirHtml({ titulo: 't', cuerpo: 'c', link: null, linkBaja: null });
    expect(html).not.toContain('Ver en Neto');
  });
});

describe('token de baja: firmado, sin caducidad, y de un solo usuario', () => {
  it('ida y vuelta', () => {
    const t = construirTokenBaja('u-abc');
    expect(verificarTokenBaja(t)).toEqual({ uid: 'u-abc' });
  });

  it('una firma alterada no vale', () => {
    const t = construirTokenBaja('u-abc');
    expect(verificarTokenBaja(t.slice(0, -1) + 'X')).toBeNull();
  });

  it('un payload alterado no vale: no se puede dar de baja a otro', () => {
    // El ataque obvio: cambiar el uid del payload conservando la firma.
    const forjado = Buffer.from(JSON.stringify({ uid: 'otro' })).toString('base64url')
      + '.' + construirTokenBaja('u-abc').split('.')[1];
    expect(verificarTokenBaja(forjado)).toBeNull();
  });

  it('con otro secreto no vale', () => {
    const t = construirTokenBaja('u-abc');
    process.env.EMAIL_OPTOUT_SECRET = 'otro-secreto';
    expect(verificarTokenBaja(t)).toBeNull();
  });

  it('sin secreto no se emite ni se verifica (fail closed en las dos puntas)', () => {
    const t = construirTokenBaja('u-abc');
    delete process.env.EMAIL_OPTOUT_SECRET;
    expect(construirTokenBaja('u-abc')).toBeNull();
    expect(construirLinkBaja('u-abc')).toBeNull();
    // Y verificar sin secreto no puede pasar: firmaría con '' y aceptaría tokens forjados.
    expect(verificarTokenBaja(t)).toBeNull();
  });

  it.each([[null], [''], ['sin-punto'], ['.'], ['a.'], ['.b']])('basura (%s) no vale', (t) => {
    expect(verificarTokenBaja(t)).toBeNull();
  });

  it('NO caduca: un correo de hace meses tiene que seguir teniendo salida', () => {
    // A diferencia del token de activación, que sí tiene TTL. Un token de baja vencido es un
    // correo del que no se puede salir. El payload no lleva `ts` justamente para que no haya
    // dónde poner una caducidad sin pensarla.
    const t = construirTokenBaja('u-abc');
    const payload = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
    expect(payload).toEqual({ uid: 'u-abc' });
    expect(payload.ts).toBeUndefined();
  });
});

/**
 * Tope diario por PERSONA (29-ago-2026).
 *
 * El envío es por evento, no por persona: el cron de deudas recorre deuda por deuda, así que
 * alguien con varias venciendo el mismo día recibe varios correos separados esa mañana. Medido
 * al ponerlo: 11 usuarios con deudas abiertas y un techo de 7 en uno solo. Y ya hay DOS
 * emisores de correo, no uno.
 *
 * Las dos propiedades que no se pueden ablandar sin romper el motivo por el que existe:
 *
 *  1. **Falla ABIERTO.** Es lo contrario del fail-closed del link de baja, y a propósito: acá
 *     equivocarse hacia el envío cuesta un correo de más, y equivocarse hacia el silencio
 *     apaga el canal entero por un hipo de PostgREST. Es el mismo razonamiento por el que esta
 *     consulta NO vive en `notificarUsuario`.
 *  2. **Deja fila.** `skipped_tope_diario` es lo que distingue "lo frenó el tope" de "nadie lo
 *     intentó", que es la lección de B23 y la razón de ser de todo este canal.
 */
describe('enviarEmail: tope diario por persona', () => {
  it('por debajo del tope manda normal', async () => {
    conteoTope = { count: 4, error: null };
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('en el tope NO manda, deja skipped_tope_diario y no llama a Resend', async () => {
    conteoTope = { count: 5, error: null };
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: false, skipped: 'tope_diario' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(delivery().at(-1).estado).toBe('skipped_tope_diario');
  });

  it('por encima del tope tampoco', async () => {
    conteoTope = { count: 99, error: null };
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res.skipped).toBe('tope_diario');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('si la CONSULTA falla, manda igual: falla abierto', async () => {
    // El modo de falla real de supabase-js: resuelve con `{ error }` y no lanza. Sin leer ese
    // error, `count` viene null y `null >= 5` da false — el mismo resultado, pero por
    // accidente y sin que nadie se entere de que la lectura se cayó.
    conteoTope = { count: null, error: { message: 'PostgREST 503' } };
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('cuenta SOLO los sent, del día de Lima y del canal email', async () => {
    conteoTope = { count: 0, error: null };
    const id = nuevoId();
    await enviarEmail('a@b.com', { ...BASE, usuarioId: id });
    const f = Object.fromEntries(filtrosDelConteo);
    // Un `skipped_*` no llegó a ninguna bandeja: contarlo gastaría cupo sin haber molestado a
    // nadie. Y sin el filtro de canal, los avisos de WhatsApp del mismo día frenarían el correo.
    expect(f.estado).toBe('sent');
    expect(f.canal).toBe('email');
    expect(f.usuario_id).toBe(id);
    // El corte del día va en hora de Lima: con UTC, a las 19:00 de Lima ya es el día siguiente
    // y el tope se reiniciaría a media tarde.
    //
    // La medianoche de Lima son las 05:00Z, y Perú no tiene horario de verano, así que el valor
    // es exacto y no hay que tolerar dos formas. La primera versión de esta línea aceptaba
    // `T00:00:00.000Z` **o** `T05:00:00.000Z` — o sea las dos ramas que quería separar — y
    // pasaba en verde con el corte mutado a UTC. Un guard que acepta el bug no es un guard.
    expect(f.created_at).toMatch(/T05:00:00\.000Z$/);
  });

  it('el usuario de prueba no consume cupo: se salta ANTES de contar', async () => {
    usuarioDePrueba = true;
    conteoTope = { count: 99, error: null };
    const res = await enviarEmail('a@b.com', { ...BASE, usuarioId: nuevoId() });
    expect(res).toEqual({ ok: true, skipped: 'test_user' });
    expect(delivery().at(-1).estado).toBe('skipped_test');
  });
});

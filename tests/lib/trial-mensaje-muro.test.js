import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// El mensaje del muro es el único texto que ve un usuario cuando pierde el acceso, y el
// día 15 es el momento en que todo el rediseño del trial se juega. Este archivo existe
// porque ese mensaje salía MAL y ningún test lo miraba:
//
// `cron/checks.js` seleccionaba `id, whatsapp, nombre, trial_vence` — sin `trial_estado` —
// y `mensajeMuro` ramifica justo por esa columna. Llegaba `undefined`, caía en la rama de
// "nunca tuviste prueba" y le prometía 14 días gratis a quien acababa de gastarlos y que,
// por `trial_estado='vencido'`, no iba a recibir otro nunca.
//
// La lección que codifica este archivo: una fila PARCIAL no puede elegir una rama por
// accidente. `undefined` (la columna no se pidió) y `null` (de verdad nunca tuvo trial)
// son cosas distintas y tienen que responder distinto.

// Mismo patrón que el resto de tests del backend (ver pro-payment-fallos.test.js): se
// inyectan los módulos en require.cache antes de cargar el que se prueba. mensajeMuro es
// puro, así que solo hacen falta los que lib/trial.js requiere al importarse.
let filasTx = [];
// `lib/trial.js` captura `supabase` al cargarse (`const { supabase } = require("./db")`), asi
// que el doble tiene que existir ANTES del require y la variabilidad va en `filasTx`, no en
// reasignar el cliente. Es la cadena minima que usa `totalGastadoMes`.
const dbMock = { supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: () => ({
  lte: () => Promise.resolve({ data: filasTx, error: null }) }) }) }) }) }) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

process.env.ACTIVATION_TOKEN_SECRET = process.env.ACTIVATION_TOKEN_SECRET || 'secreto-de-prueba';

process.env.ACTIVATION_TOKEN_SECRET = process.env.ACTIVATION_TOKEN_SECRET || 'secreto-de-prueba';
const { mensajeMuro, mensajeDashboard, enlaceApp, mensajeGmailProPagado, nudgeMuro, COLUMNAS_MURO, TRIAL_DIAS } = require('../../lib/trial');

const BASE = { id: 'u1', nombre: 'Favio Mendoza' };

beforeEach(() => { logMock.error.mockClear(); });

describe('mensajeMuro — la rama la decide trial_estado', () => {
  it('NUNCA tuvo prueba (null): la invita, sin afirmar que algo terminó', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: null }, 12);
    expect(msg).toContain(TRIAL_DIAS + ' días gratis');
    expect(msg).not.toMatch(/terminó|venció/);
  });

  it('sin transacciones dice "primer gasto", con transacciones dice "próximo"', () => {
    expect(mensajeMuro({ ...BASE, trial_estado: null }, 0)).toContain('tu primer gasto');
    expect(mensajeMuro({ ...BASE, trial_estado: null }, 7)).toContain('tu próximo gasto');
  });

  /**
   * El TERCER valor de `conteoTx`, que hasta el 31-ago no existía y por eso el defecto era
   * posible: `undefined` es "no se pudo contar", `null`/`0` es "de verdad no anotó nada".
   * Con `count` de PostgREST volviendo `null` al fallar, quien lea un `{ error }` y pase ese
   * `null` tal cual le afirma a alguien con decenas de gastos que le falta el primero.
   * Alcanzable: 19 usuarios reales free con `trial_estado` NULL y transacciones (máx. 63).
   */
  it('sin poder contar (undefined) no afirma NI primero NI próximo', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: null }, undefined);
    expect(msg).toContain('registres un gasto');
    expect(msg).not.toContain('primer gasto');
    expect(msg).not.toContain('próximo gasto');
    // Y el resto del cartel sale igual: degradar no es callarse.
    expect(msg).toContain(TRIAL_DIAS + ' días gratis');
  });

  it('`undefined` y `null` NO dicen lo mismo (si convergen, el contrato se perdió)', () => {
    const sinDatos = mensajeMuro({ ...BASE, trial_estado: null }, null);
    const sinPoder = mensajeMuro({ ...BASE, trial_estado: null }, undefined);
    expect(sinPoder).not.toBe(sinDatos);
  });

  it('terminó su prueba (vencido): la nombra con fecha y NO le ofrece otra', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'vencido', trial_vence: '2026-08-31' }, 40);
    expect(msg).toContain('prueba de *Neto Pro* terminó el');
    // La regresión exacta que motivó este archivo.
    expect(msg).not.toContain('días gratis');
  });

  it('ex-pagador (convertido con historial de pago): le habla de su Pro, no de una prueba', () => {
    const msg = mensajeMuro(
      { ...BASE, trial_estado: 'convertido', premium_desde: '2026-06-03', premium_vence: '2026-07-03' },
      87,
    );
    expect(msg).toContain('*Neto Pro* venció el');
    // Fue cliente. Decirle que se le acabó una prueba le borra eso, y es el segmento más
    // valioso que hay para recuperar.
    expect(msg).not.toContain('prueba');
    expect(msg).not.toContain('días gratis');
  });

  it('convertido SIN historial de pago cae en el texto de prueba, no en el de cliente', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'convertido', trial_vence: '2026-08-31' }, 3);
    expect(msg).toContain('prueba de *Neto Pro*');
  });
});

describe('mensajeMuro — una fila incompleta no puede elegir rama', () => {
  it('sin trial_estado (columna no pedida) NO promete un trial: usa el texto genérico', () => {
    const msg = mensajeMuro({ ...BASE, trial_vence: '2026-08-31' }, 40);
    expect(msg).not.toContain('días gratis');   // ← el bug
    expect(msg).not.toMatch(/terminó|venció/);  // tampoco afirma lo contrario
    expect(msg).toContain('necesitas *Neto Pro*');
  });

  it('y lo loguea como error, porque es un bug del llamador y no un estado del usuario', () => {
    mensajeMuro({ ...BASE }, 1);
    // Se busca la llamada por su CONTENIDO en vez de fijar el conteo en 1. El 05-sep-2026 la
    // misma clase apareció en una segunda columna (`supabase_auth_id`, abajo), así que este
    // fixture mínimo dispara DOS detectores y un `toHaveBeenCalledOnce` fallaba por el
    // detector nuevo, no por una regresión de éste.
    const trial = logMock.error.mock.calls.filter(c => /trial_estado/.test(c[1]));
    expect(trial).toHaveLength(1);
  });

  // Misma lección, otra columna, y el daño es peor porque no se ve en el texto: `pieMuro`
  // pasa el usuario a `enlacePro`, que elige entre el panel y un link de activación FIRMADO
  // según `supabase_auth_id`. Con la columna ausente, `linkPanelPro` la lee como `undefined`
  // —o sea "WhatsApp-only"— y le manda a un usuario CON cuenta web un token inerte que lo
  // deposita en /login. Un select acotado nuevo reintroduce el bug sin cambiar una sola letra
  // del mensaje, que es justo lo que ningún test de copy puede ver.
  it('sin supabase_auth_id avisa y NO inventa un link de activación', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'vencido', trial_vence: '2026-08-31' }, 5);
    const auth = logMock.error.mock.calls.filter(c => /supabase_auth_id/.test(c[1]));
    expect(auth, 'una fila sin la columna tiene que delatarse').toHaveLength(1);
    expect(msg).toContain('/dashboard/pro');
    expect(msg, 'el link firmado lleva ?t= y no debe salir por adivinanza').not.toContain('?t=');
  });

  it('con la columna presente en null NO se queja: null es un dato, no un select incompleto', () => {
    mensajeMuro({ ...BASE, trial_estado: 'vencido', supabase_auth_id: null }, 5);
    expect(logMock.error.mock.calls.filter(c => /supabase_auth_id/.test(c[1]))).toHaveLength(0);
  });

// La evasión que una revisión adversarial midió el 05-sep-2026 y que la primera versión del
// detector NO veía: `'supabase_auth_id' in usuario` da **true** para una clave puesta
// explícitamente en `undefined`. No es rebuscado — lo produce cualquier proyección del tipo
// `{ id: u.id, supabase_auth_id: u.supabase_auth_id }` sobre una fila cuyo select perdió la
// columna, que es un patrón que este repo ya usa. Con `in`, detector mudo, suite verde, y el
// usuario CON cuenta web recibiendo el token inerte que lo deposita en /login.
it('la clave presente pero en undefined TAMBIÉN se delata (no alcanza con `in`)', () => {
  const proyeccion = { id: 'u1', nombre: 'Favio', trial_estado: 'vencido', supabase_auth_id: undefined };
  expect('supabase_auth_id' in proyeccion, 'el fixture tiene que engañar a `in` o no prueba nada').toBe(true);
  mensajeMuro(proyeccion, 5);
  expect(logMock.error.mock.calls.filter(c => /supabase_auth_id/.test(c[1]))).toHaveLength(1);
});

  it('usuario null (sin fila) sigue devolviendo texto, no revienta', () => {
    expect(typeof mensajeMuro(null, 0)).toBe('string');
  });
});

describe('mensajeMuro — lo que las tres ramas comparten', () => {
  const casos = [
    ['nunca tuvo', { trial_estado: null }],
    ['vencido', { trial_estado: 'vencido', trial_vence: '2026-08-31' }],
    ['ex-pagador', { trial_estado: 'convertido', premium_vence: '2026-07-03' }],
  ];

  it.each(casos)('%s: nunca dice que Neto dejó de anotar', (_, extra) => {
    const msg = mensajeMuro({ ...BASE, ...extra }, 20);
    // La promesa que no se negocia: escribir nunca se corta. Un muro que se lee como
    // "Neto se rompió" no vende, hace que la persona se vaya.
    expect(msg.toLowerCase()).toMatch(/anot|gasto/);
  });

  it.each(casos.slice(1))('%s: nombra el precio y el camino de pago', (_, extra) => {
    const msg = mensajeMuro({ ...BASE, ...extra }, 20);
    expect(msg).toContain('/dashboard/pro');
    expect(msg).toMatch(/S\/\d+/);
  });
});

// Los cuatro mensajes de Pro que salen POR WHATSAPP hardcodeaban `/dashboard/pro` y nunca
// llamaban a `linkPanelPro`, que existe justo para no hacer eso. Medido contra producción el
// 05-sep-2026: **47 usuarios en el muro son WhatsApp-only** y 11 tienen gastos, o sea que
// reciben `nudgeMuro` pegado a cada confirmación. A todos ellos `/dashboard/pro` los deposita
// en /login, donde un "Continuar con Google" les crea una cuenta HUÉRFANA en vez de vincularse
// a su número — el daño que el docblock de `linkPanelPro` ya nombraba.
//
// Se prueba por el MENSAJE y no por el helper: lo que se rompió no fue `linkPanelPro`, que
// siempre estuvo bien, sino que nadie lo llamaba.
describe('el link de Pro del muro respeta la identidad del usuario', () => {
  it('al WhatsApp-only le da el link firmado, no el panel que lo deja en /login', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'vencido', trial_vence: '2026-08-31', supabase_auth_id: null }, 5);
    expect(msg).toContain('/activar?t=');
    expect(msg, 'el panel es justo el destino que no sirve para este usuario').not.toContain('/dashboard/pro');
  });

  it('a quien ya tiene cuenta web lo manda al panel', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'vencido', trial_vence: '2026-08-31', supabase_auth_id: 'auth-9' }, 5);
    expect(msg).toContain('/dashboard/pro');
    expect(msg).not.toContain('/activar?t=');
  });

  it('mensajeDashboard hace la misma bifurcación, y fuera del muro no promete lo que hay detrás', () => {
    const enMuro = mensajeDashboard({ ...BASE, plan: 'free', trial_estado: 'vencido', supabase_auth_id: null });
    expect(enMuro).toContain('/activar?t=');
    expect(enMuro, 'prometer gráficos a quien no puede verlos es el bug').not.toContain('gráficos, metas, reportes PDF');
    expect(enMuro, 'anotar sigue siendo gratis y hay que decirlo').toMatch(/no se cobra nunca/);

    const conPro = mensajeDashboard({ ...BASE, plan: 'premium', trial_estado: 'activo', supabase_auth_id: 'auth-9' });
    expect(conPro).toContain('gráficos, metas, reportes PDF');
  });
});

// El select del cron es LITERAL a propósito y no `COLUMNAS_MURO + '...'`: el guard hermano
// `tests/cron/email-necesita-su-columna.test.js` sólo puede resolver literales, y su docblock
// ya había decidido esa disyuntiva ("el literal es la condición, no un detalle"). Consolidarlo
// en la constante lo dejaba ciego sobre ese call-site — la clase
// `feedback_arreglo_que_ciega_al_instrumento`, y lo atrapó él solo.
//
// Así que la copia se queda, pero deja de ser silenciosa: la PREGUNTA sale de `COLUMNAS_MURO`
// (lo que `mensajeMuro` necesita para no elegir rama por accidente) y la RESPUESTA se lee del
// código del cron. Ninguna de las dos mitades está escrita a mano acá.
//
// Existe porque sin él la mutación pasaba: quitarle `supabase_auth_id` al select dejaba los
// 3165 tests en verde y el link de Pro saliendo por el canal equivocado. Medido por una
// revisión adversarial el 05-sep-2026.
describe('el cron que manda el mensaje del muro trae TODAS las columnas que ese mensaje decide', () => {
  const fuente = fs.readFileSync(path.join(projectRoot, 'cron/checks.js'), 'utf8');

  // El select de `checkTrialExpiry`: el único que alimenta a `mensajeMuro` desde un cron.
  const selects = [...fuente.matchAll(/\.select\('([^']*)'\)/g)].map(m => m[1]);
  const delMuro = selects.filter(s => s.includes('trial_estado') && s.includes('trial_vence'));

  it('el select existe y se puede leer (si no, este guard no está mirando nada)', () => {
    expect(delMuro.length, 'no se encontró el select que alimenta mensajeMuro en cron/checks.js').toBeGreaterThan(0);
  });

  it.each(COLUMNAS_MURO.split(',').map(c => c.trim()))('trae la columna %s', (col) => {
    for (const s of delMuro) {
      expect(s.split(',').map(c => c.trim()), 'a un select de checkTrialExpiry le falta ' + col).toContain(col);
    }
  });
});

// `enlaceApp` nació sin un solo test y una revisión adversarial lo demostró reemplazándolo
// entero por la versión con el bug: 3175 en verde. Su gemelo `enlacePro` tenía tres tests y
// éste ninguno, así que el arreglo del hallazgo más grave era justo el menos vigilado.
describe('enlaceApp — la ruta profunda respeta la identidad', () => {
  const RUTA = '/dashboard/configuracion';

  it('a quien tiene cuenta web le da la ruta directa, sin activación', () => {
    const r = enlaceApp({ id: 'u1', supabase_auth_id: 'auth-1' }, RUTA);
    expect(r.url).toBe('https://app.neto.pe' + RUTA);
    expect(r.requiereActivacion).toBe(false);
  });

  it('al WhatsApp-only le da el link de activación, NO la ruta profunda', () => {
    const r = enlaceApp({ id: 'u2', supabase_auth_id: null }, RUTA);
    expect(r.requiereActivacion).toBe(true);
    expect(r.url).toContain('/activar?t=');
    expect(r.url, 'la ruta profunda sin sesión lo deposita en /login').not.toContain(RUTA);
  });

  it('`requiereActivacion` NUNCA contradice a la url que devuelve', () => {
    for (const u of [null, { id: 'a', supabase_auth_id: 'x' }, { id: 'b', supabase_auth_id: null }, { id: 'c' }]) {
      const r = enlaceApp(u, RUTA);
      expect(r.requiereActivacion, JSON.stringify(u)).toBe(r.url.includes('/activar?t='));
    }
  });

  it('una fila sin la columna se delata y cae a la ruta directa, no adivina', () => {
    logMock.error.mockClear();
    const r = enlaceApp({ id: 'u3' }, RUTA);
    expect(logMock.error.mock.calls.filter(c => /supabase_auth_id/.test(c[1]))).toHaveLength(1);
    expect(r.requiereActivacion).toBe(false);
  });

  it('usuario null no revienta', () => {
    expect(() => enlaceApp(null, RUTA)).not.toThrow();
  });
});

// Los CUATRO mensajes que salen por WhatsApp con un link de Pro. Sólo la rama `vencido` de
// `pieMuro` estaba cubierta: una revisión adversarial revirtió los otros tres a la URL
// hardcodeada y la suite quedó en 3175 verde. `nudgeMuro` es el de más volumen (se pega a
// CADA confirmación de gasto de alguien en el muro) y la rama CONVERTIDO es el ex-pagador.
describe('los cuatro mensajes de Pro por WhatsApp respetan la identidad', () => {
  const WA_ONLY = { id: 'u-wa', nombre: 'Luis', supabase_auth_id: null };

  it('pieMuro, rama del ex-pagador (trial_estado convertido)', () => {
    const msg = mensajeMuro({ ...WA_ONLY, plan: 'free', trial_estado: 'convertido', premium_vence: '2026-08-01' }, 5);
    expect(msg).toContain('/activar?t=');
    expect(msg).not.toContain('/dashboard/pro');
  });

  it('pieMuro, rama de la fila incompleta (sin trial_estado) igual respeta el canal', () => {
    const msg = mensajeMuro({ ...WA_ONLY, plan: 'free' }, 5);
    expect(msg).toContain('/activar?t=');
  });

  it('mensajeGmailProPagado, que es el pitch a quien no paga', () => {
    const msg = mensajeGmailProPagado({ ...WA_ONLY, plan: 'free', trial_estado: 'vencido' });
    expect(msg).toContain('/activar?t=');
    expect(msg).not.toContain('/dashboard/pro');
  });

  it('mensajeDashboard fuera del muro NO manda a activar a quien ya tiene cuenta web', () => {
    const msg = mensajeDashboard({ id: 'x', nombre: 'Ana', plan: 'premium', supabase_auth_id: 'auth-1' });
    expect(msg).not.toContain('/activar?t=');
  });
});

// `nudgeMuro` es el mensaje de Pro de MÁS volumen: se pega a cada confirmación de gasto de
// alguien en el muro (11 usuarios WhatsApp-only con gastos, medido el 05-sep-2026). Era el
// único de los cuatro que sobrevivía a la mutación —revertirlo a la URL hardcodeada dejaba
// los 39 tests en verde— porque es async y consulta la base, así que el fixture del resto del
// archivo no lo alcanzaba. Se le da a `supabase` la cadena mínima que `totalGastadoMes` usa.
describe('nudgeMuro — el de más volumen, y el que más tarde quedó cubierto', () => {
  it('al WhatsApp-only en el muro le da el link firmado, no el panel', async () => {
    filasTx = [{ monto: 50, monto_pen: 50 }];
    const msg = await nudgeMuro({ id: 'u-wa', nombre: 'Luis', plan: 'free', supabase_auth_id: null });
    expect(msg).toContain('/activar?t=');
    expect(msg, '/dashboard/pro lo deposita en /login y le crea una cuenta huérfana').not.toContain('/dashboard/pro');
  });

  it('a quien tiene cuenta web le da el panel', async () => {
    filasTx = [{ monto: 50, monto_pen: 50 }];
    const msg = await nudgeMuro({ id: 'u-web', nombre: 'Ana', plan: 'free', supabase_auth_id: 'auth-1' });
    expect(msg).toContain('/dashboard/pro');
    expect(msg).not.toContain('/activar?t=');
  });

  it('fuera del muro no dice nada (no es un aviso para el que paga)', async () => {
    filasTx = [{ monto: 50, monto_pen: 50 }];
    expect(await nudgeMuro({ id: 'u', plan: 'premium', supabase_auth_id: 'a' })).toBeNull();
  });
});
// ── LO QUE ESTE ARCHIVO NO VE ────────────────────────────────────────────────────────────
//
// Dos evasiones quedaron ABIERTAS a propósito, medidas el 05-sep-2026. Se escriben acá porque
// un guard cuyos huecos no están declarados se lee como cobertura, que es peor que no tenerlo.
//
// 1. UNA PROMESA REFORMULADA PASA. El test de `mensajeDashboard` afirma
//    `.not.toContain('gráficos, metas, reportes PDF')`, o sea una CADENA. Volver a meter la
//    misma mentira con otras palabras ("Ahí mismo ves cuánto llevas gastado este mes", que es
//    literalmente el defecto que este commit arregló) deja los 42 tests en verde. No es
//    cerrable acá: decidir si una frase arbitraria es cierta sobre una pantalla de la webapp
//    no es algo que un test del backend pueda hacer. Lo que SÍ lo atrapó las dos veces fue una
//    revisión adversarial leyendo el copy contra el código de la webapp.
//
// 2. UNA FILA PROYECTADA EN EL CALL-SITE PASA. El guard del select lee el `.select('...')` de
//    `cron/checks.js`, así que dejar el select intacto y pasarle a `mensajeMuro` un objeto
//    armado a mano sin `supabase_auth_id` no lo despierta. La red que queda ahí es de runtime,
//    no de suite: `enlacePro`/`enlaceApp` emiten `log.error` y el link cae al panel, que es el
//    comportamiento anterior y no el peor. Cerrarlo pediría inspeccionar el objeto en el
//    call-site, que este guard no puede hacer sin atarse a la forma del código.
//
// La regla que queda: cuando toques copy que describe una pantalla, la verificación no es un
// test — es abrir el código de esa pantalla. Las tres mentiras que esta sesión encontró
// (PDF por WhatsApp, "ves cuánto gastaste", "reordenar el árbol") salieron así, y las tres
// habían pasado la suite entera.

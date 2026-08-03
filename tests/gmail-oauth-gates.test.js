import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'path';

/**
 * Guard de las puertas de OAuth de Gmail, hermano de `tests/cron/lecturas-proactivas.test.js`.
 *
 * Conectar Gmail no es una feature más: cada usuario conectado consume uno de los 100 cupos
 * gratuitos de Google que tenemos hasta la certificación CASA. El cupo es el recurso escaso
 * del producto, y se fugaba por los dos extremos.
 *
 * La ENTRADA se fugaba porque durante el trial `plan` vale `'premium'` (migración 052). Los
 * gates de entonces preguntaban `plan !== 'premium'` (webhook) o
 * `getUserPlanConfig(u).maxGmailAccounts === 0` (consultas) — dos dialectos de la MISMA
 * pregunta, y ninguno distingue al que prueba del que paga. O sea que 14 días de prueba
 * quemaban un cupo permanente sin un sol de por medio. La pregunta correcta es la tercera de
 * `lib/trial.js`: `esProPagado()`, que mira las DOS columnas.
 *
 * Por eso este archivo no acepta `plan === 'premium'` como señal de gate. Es justo la señal
 * que estaba puesta cuando el agujero existía.
 *
 * Y hay una asimetría que hace que gatear la generación NO alcance: `STATE_TTL_MS` son 7 días
 * (gmail.js), a propósito, porque el link post-pago vive en un chat de WhatsApp y se abre
 * horas o días después. Un link emitido durante el trial sigue siendo canjeable una semana
 * más tarde. El cupo no se consume al generar el link: se consume al canjearlo, en
 * `routes/public.js` justo antes de `guardarTokens`. Ese es el único gate que de verdad
 * protege el cupo, y tiene su propio test acá abajo.
 */

const RAIZ = process.cwd();
const DIRS = ['handlers', 'routes', 'lib', 'services', 'cron', 'helpers', 'tasks'];

/** Un callsite real, no el `require`: el destructuring nunca lleva paréntesis pegado. */
const EMITE = /generarUrlAutorizacion\s*\(/g;

/**
 * Quién puede emitir una URL de OAuth, y cuántas veces.
 *
 * Los conteos están fijados a propósito. Agregar un callsite en un archivo YA gateado rompe
 * el build igual que agregarlo en uno nuevo: obliga a mirar si esa puerta concreta quedó
 * detrás del gate, en vez de asumir que el archivo "ya estaba cubierto".
 */
const EMISORES = {
  'handlers/intents/consultas.js': 2,   // agregar_gmail (reemplazo) y cambiar_gmail
  'handlers/onboarding.js': 1,          // paso 30: el emisor real de /conectar y agregar_gmail
  'routes/pro.js': 1,                   // GET /pro/gmail-auth-url (lo llama la webapp)
  'lib/pro-payment.js': 1,              // activarPro — exento, ver abajo
};

/**
 * Emisores que NO miran `esProPagado`, a propósito.
 *
 * Uno solo, y el motivo es de orden de escritura, no de permisos: `activarPro` actualiza la
 * fila a `plan='premium'` + `trial_estado='convertido'` y RECIÉN DESPUÉS arma el link. El
 * objeto `usuario` que tiene en memoria es el de ANTES de ese UPDATE, así que un
 * `esProPagado(usuario)` ahí le negaría el Gmail justo a quien acaba de pagar. Por eso el
 * gate tampoco vive dentro de `generarUrlAutorizacion`: rompería este flujo.
 *
 * Que quede sin gate no abre el agujero, porque el canje sí revalida contra la base ya
 * actualizada (ver el describe de abajo).
 */
const SIN_GATE_DE_PRO_PAGADO = new Map([
  ['lib/pro-payment.js', 'activarPro: la fila en memoria es anterior al UPDATE que lo hace pagado; el callback revalida contra la DB'],
]);

const SENAL_DE_GATE = /esProPagado\s*\(/;

function archivosJs(dir) {
  const abs = path.join(RAIZ, dir);
  let out = [];
  let entradas;
  try { entradas = readdirSync(abs); } catch { return out; }
  for (const e of entradas) {
    if (e === 'node_modules') continue;
    const full = path.join(abs, e);
    if (statSync(full).isDirectory()) out = out.concat(archivosJs(path.join(dir, e)));
    else if (e.endsWith('.js')) out.push(path.join(dir, e).replace(/\\/g, '/'));
  }
  return out;
}

/** Todo archivo del backend que emite al menos una URL de OAuth, con su conteo. */
const EMISORES_REALES = new Map(
  archivosJs('.').length === 0
    ? []
    : DIRS.flatMap(archivosJs)
        .map((rel) => [rel, (readFileSync(path.join(RAIZ, rel), 'utf-8').match(EMITE) || []).length])
        .filter(([, n]) => n > 0),
);

describe('puertas de OAuth de Gmail', () => {
  // Si el descubrimiento se rompe (se renombra la función, se mueve un directorio), todo lo
  // de abajo filtra sobre una lista vacía y pasa por vacuidad. Ese verde sería peor que no
  // tener el archivo: entrena a confiar en algo que ya no mira nada.
  it('encuentra los emisores (si el descubrimiento se rompe, el resto del archivo miente)', () => {
    expect(EMISORES_REALES.size).toBeGreaterThanOrEqual(4);
    expect([...EMISORES_REALES.keys()]).toContain('handlers/onboarding.js');
  });

  it('no hay emisores nuevos ni callsites nuevos sin declarar', () => {
    const declarado = Object.entries(EMISORES).sort();
    const real = [...EMISORES_REALES.entries()].sort();
    expect(real).toEqual(declarado);
  });

  it('todo emisor mira esProPagado, o está declarado exento con su motivo', () => {
    const sinGate = [...EMISORES_REALES.keys()]
      .filter((rel) => !SENAL_DE_GATE.test(readFileSync(path.join(RAIZ, rel), 'utf-8')))
      .filter((rel) => !SIN_GATE_DE_PRO_PAGADO.has(rel));

    expect(sinGate).toEqual([]);
  });

  it('no hay exenciones fantasma (archivos que ya no emiten)', () => {
    const fantasma = [...SIN_GATE_DE_PRO_PAGADO.keys()].filter((rel) => !EMISORES_REALES.has(rel));
    expect(fantasma).toEqual([]);
  });

  // `plan === 'premium'` es verdadero durante el trial. Que un emisor "mire el plan" no prueba
  // que gatee al que prueba — era exactamente el estado del código cuando el cupo se fugaba.
  it.each([
    ['handlers/onboarding.js', 'el paso 30 es el emisor real de /conectar y de agregar_gmail'],
    ['handlers/intents/consultas.js', 'agregar_gmail y cambiar_gmail entregan el link directo'],
    ['routes/pro.js', 'la webapp entra por acá; era la puerta sin ningún gate de plan'],
  ])('%s gatea por Pro pagado, no por plan a secas (%s)', (rel) => {
    const src = readFileSync(path.join(RAIZ, rel), 'utf-8');
    // Primero que sigue emitiendo: un archivo que dejó de emitir pasaría el gate por vacuidad.
    expect((src.match(EMITE) || []).length, rel + ' ya no emite: actualiza EMISORES').toBeGreaterThan(0);
    expect(SENAL_DE_GATE.test(src), rel + ' no llama esProPagado').toBe(true);
  });
});

/**
 * El canje es el único momento en que el cupo se consume de verdad. Con un TTL de 7 días,
 * gatear la emisión deja pasar el link viejo del que probó y no pagó.
 */
describe('el canje del código OAuth revalida contra la base', () => {
  const CALLBACK = readFileSync(path.join(RAIZ, 'routes', 'public.js'), 'utf-8');

  it('routes/public.js gatea ANTES de guardar los tokens', () => {
    const gate = CALLBACK.search(SENAL_DE_GATE);
    const guarda = CALLBACK.indexOf('guardarTokens(');
    expect(guarda, 'el callback ya no llama guardarTokens: ¿se movió el canje?').toBeGreaterThan(-1);
    expect(gate, 'el callback no llama esProPagado: un link de 7 días se canjea sin mirar el plan').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(guarda);
  });
});

/**
 * La capability tiene tres caras y las tres cobran lo mismo:
 *   CONECTAR (arriba) · ELEGIR BANCOS · LEER.
 *
 * Elegir bancos no consume cupo por sí solo, pero sin Gmail conectado no lee nada: dejarlo
 * abierto configuraba una lectura que nunca iba a ocurrir. Y la LECTURA automática era la
 * mitad silenciosa — gateada por plan, o sea que a un usuario en prueba con una cuenta
 * heredada se le seguían leyendo los correos del banco sin que ninguna pantalla lo dijera.
 */
describe('las otras dos caras: elegir bancos y leer', () => {
  it.each([
    ['handlers/webhook.js', 'el comando /bancos'],
    ['handlers/onboarding.js', 'el paso 31 (editar bancos), con el mismo punto ciego que el 30'],
    ['services/gmail-scanner.js', 'el barrido automático: la lectura sin pantalla de por medio'],
  ])('%s gatea por Pro pagado (%s)', (rel) => {
    const src = readFileSync(path.join(RAIZ, rel), 'utf-8');
    expect(SENAL_DE_GATE.test(src), rel + ' no llama esProPagado').toBe(true);
  });

  // `maxGmailAccounts === 0` es `plan === 'free'` con otro nombre: responde "¿tiene Pro?",
  // no "¿paga?". Que sobreviva en un camino de Gmail significa que ese camino quedó abierto
  // al trial. Se fija en cero para que reaparecer rompa el build.
  it('ningún camino de Gmail decide con maxGmailAccounts (es plan disfrazado)', () => {
    const sospechosos = ['services/gmail-scanner.js', 'handlers/onboarding.js', 'routes/pro.js', 'routes/public.js']
      .filter((rel) => /maxGmailAccounts/.test(readFileSync(path.join(RAIZ, rel), 'utf-8')));
    expect(sospechosos).toEqual([]);
  });

  // La lectura tiene tres disparadores y es fácil gatear solo el automático: los manuales
  // no tienen pantalla de pago de por medio, así que un gate flojo ahí no se ve nunca.
  it('los disparadores MANUALES de lectura también gatean', () => {
    const consultas = readFileSync(path.join(RAIZ, 'handlers', 'intents', 'consultas.js'), 'utf-8');
    const webhook = readFileSync(path.join(RAIZ, 'handlers', 'webhook.js'), 'utf-8');
    // escanear_gmail (intent NLP) y /escanear (comando) llaman al mismo escáner.
    expect(consultas, 'escanear_gmail dejó de gatear').toMatch(/escanear_gmail[\s\S]{0,400}?esProPagado\s*\(/);
    expect(webhook, '/escanear dejó de gatear').toMatch(/'\/escanear'[\s\S]{0,300}?esProPagado\s*\(/);
  });
});

/**
 * Desconectar tiene que hablarle a Google, venga de donde venga.
 *
 * El `activa: false` a secas es la trampa original: le corta la lectura al usuario y deja el
 * permiso vivo de nuestro lado. En los crons ya estaba; faltaba el camino en que el usuario
 * lo pide él mismo, que es donde peor queda — le respondemos "Gmail desconectado" mientras
 * seguimos con el grant. Y en el wipe importa el ORDEN: borrar la fila tira el refresh token,
 * y sin token el grant queda vivo para siempre sin forma de alcanzarlo.
 */
describe('desconectar revoca en Google, no solo marca la fila', () => {
  const ONBOARDING = readFileSync(path.join(RAIZ, 'handlers', 'onboarding.js'), 'utf-8');

  it('el flujo de desconexión del usuario (paso -1) revoca', () => {
    const paso = ONBOARDING.slice(ONBOARDING.indexOf('onboarding_paso === -1'));
    const flips = (paso.match(/from\('gmail_cuentas'\)\s*\.update\(\{\s*activa:\s*false/g) || []).length;
    expect(flips, 'quedó un `activa: false` suelto: revoca en Google en vez de marcar la fila').toBe(0);
    expect((paso.match(/revocarAccesoGmail\s*\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('el wipe revoca ANTES de borrar la fila (después ya no hay token)', () => {
    const wipe = ONBOARDING.indexOf("from('gmail_cuentas').delete()");
    expect(wipe, 'ya no hay wipe: actualiza este test').toBeGreaterThan(-1);
    const revocaAntes = ONBOARDING.lastIndexOf('revocarAccesoGmail(', wipe);
    expect(revocaAntes, 'el delete no viene precedido de una revocación').toBeGreaterThan(-1);
    // Pegados: si entre medio se coló otra cosa, es que el orden se rompió.
    expect(wipe - revocaAntes).toBeLessThan(300);
  });
});

/**
 * Todos los gates de arriba delegan en un predicado. Si alguien lo degrada a
 * `plan === 'premium'`, las puertas se abren TODAS a la vez, en silencio, y los tests de
 * arriba siguen verdes porque la llamada sigue estando escrita.
 */
describe('esProPagado sigue siendo la pregunta que creemos', () => {
  const TRIAL = readFileSync(path.join(RAIZ, 'lib', 'trial.js'), 'utf-8');

  it('mira las DOS columnas: plan y trial_estado', () => {
    const m = TRIAL.match(/function esProPagado\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(m, 'esProPagado ya no se declara así en lib/trial.js').not.toBeNull();
    expect(m[1]).toMatch(/plan\s*===\s*['"]premium['"]/);
    expect(m[1]).toMatch(/trial_estado\s*!==\s*['"]activo['"]/);
  });

  it('sigue exportado (los gates lo importan de acá)', () => {
    expect(TRIAL).toMatch(/module\.exports\s*=\s*\{[\s\S]*\besProPagado\b/);
  });
});

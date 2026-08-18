import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
 *
 * ── Y la SALIDA se cerró consolidando el canal ────────────────────────────────────────────
 *
 * Había seis puertas repartidas en dos canales. Cinco eran de WhatsApp, y la del selector de
 * bancos (pasos 30 y 31 del onboarding) guardaba estado en la DB ENTRE dos mensajes, o sea
 * que el gate del comando quedaba atrás cuando llegaba la respuesta: cada paso necesitaba su
 * propio gate duplicado para que un trial vencido en el medio no se llevara el enlace.
 *
 * Conectar es ahora web-only y queda UNA puerta. Ese es el invariante que fija este archivo,
 * y es más fuerte que el conteo viejo: no alcanza con que cada emisor gatee, es que `handlers/`
 * —todo el canal de WhatsApp— no puede emitir NADA. Un callsite nuevo ahí adentro rompe el
 * build aunque venga con su `esProPagado` al lado, porque el problema no era el gate faltante
 * sino la cantidad de sitios donde había que acordarse de ponerlo.
 */

const RAIZ = process.cwd();
const DIRS = ['handlers', 'routes', 'lib', 'services', 'cron', 'helpers', 'tasks'];

/** Un callsite real, no el `require`: el destructuring nunca lleva paréntesis pegado. */
const EMITE = /generarUrlAutorizacion\s*\(/g;

/**
 * Quién puede emitir una URL de OAuth, y cuántas veces.
 *
 * Los conteos están fijados a propósito. Agregar un callsite en un archivo YA declarado rompe
 * el build igual que agregarlo en uno nuevo: obliga a mirar si esa puerta concreta quedó
 * detrás del gate, en vez de asumir que el archivo "ya estaba cubierto".
 *
 * Hoy hay UNA sola entrada, y esa es la noticia. Antes eran cuatro archivos: los tres de
 * WhatsApp murieron con la consolidación, y `lib/pro-payment.js` —el único exento que llegó
 * a existir— dejó de emitir cuando el mensaje post-pago pasó a mandar el atajo al panel en
 * vez de la URL de OAuth cruda.
 */
const EMISORES = {
  'routes/pro.js': 1,                   // GET /pro/gmail-auth-url (lo llama la webapp)
};

/**
 * Emisores que NO miran `esProPagado`, a propósito.
 *
 * Vacío, y se queda vacío salvo que alguien tenga un motivo escrito. El único que hubo fue
 * `activarPro`, y el motivo era de orden de escritura, no de permisos: actualizaba la fila a
 * `plan='premium'` + `trial_estado='convertido'` y RECIÉN DESPUÉS armaba el link, con el
 * objeto `usuario` en memoria todavía viejo, así que un `esProPagado(usuario)` ahí le negaba
 * el Gmail justo a quien acababa de pagar. (Ese es también el motivo de que el gate no viva
 * dentro de `generarUrlAutorizacion`.) Hoy ese flujo no emite OAuth y la excepción murió con
 * él: el test de exenciones fantasma de abajo impide que vuelva sin llamador.
 */
const SIN_GATE_DE_PRO_PAGADO = new Map([]);

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
  //
  // Con un solo emisor el riesgo es mayor que antes, porque "cero emisores" ya no se ve raro:
  // es un solo paso más allá de lo esperado. De ahí que se afirme el archivo por nombre.
  it('encuentra el emisor (si el descubrimiento se rompe, el resto del archivo miente)', () => {
    expect([...EMISORES_REALES.keys()]).toContain('routes/pro.js');
    expect(EMISORES_REALES.get('routes/pro.js')).toBeGreaterThan(0);
  });

  it('no hay emisores nuevos ni callsites nuevos sin declarar', () => {
    const declarado = Object.entries(EMISORES).sort();
    const real = [...EMISORES_REALES.entries()].sort();
    expect(real).toEqual(declarado);
  });

  /**
   * El invariante que compró la consolidación: WhatsApp no es una puerta de OAuth.
   *
   * Es redundante con el conteo de arriba —un callsite en `handlers/` ya rompería `EMISORES`—
   * y está a propósito. El de arriba se arregla agregando una línea a un objeto; este obliga
   * a leer por qué el canal entero está cerrado. Cada conexión quema un cupo IRRECUPERABLE,
   * así que el número de sitios donde hay que acordarse del gate importa tanto como el gate.
   *
   * Si alguna vez hay un motivo real para reabrirlo, hay que borrar este test a mano y dejar
   * escrito el porqué. Esa fricción es el punto.
   */
  it('ningún handler de WhatsApp emite OAuth: conectar es web-only', () => {
    const enHandlers = [...EMISORES_REALES.keys()].filter((rel) => rel.startsWith('handlers/'));
    expect(enHandlers, 'un handler volvió a emitir OAuth: el cupo se protege cerrando el canal, no gateando otra puerta más').toEqual([]);
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
    ['routes/pro.js', 'la única puerta que queda; era la que no tenía ningún gate de plan'],
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
  /**
   * Elegir bancos ya no se escribe desde el backend: la selección se guarda en
   * `webapp/src/app/api/pro/bancos`, que tiene su gate y su propio test (`route.test.ts`).
   * Acá quedaría un assert vacío — `handlers/onboarding.js` sigue nombrando `esProPagado`
   * por otras razones, así que pasaría sin significar nada.
   *
   * Lo que sí se queda es la LECTURA, que es la mitad silenciosa: no tiene pantalla de por
   * medio, y estaba gateada por plan, o sea que a un usuario en prueba con una cuenta
   * heredada se le seguían leyendo los correos del banco sin que nada lo dijera.
   */
  it('el barrido automático gatea por Pro pagado (la lectura sin pantalla de por medio)', () => {
    const src = readFileSync(path.join(RAIZ, 'services', 'gmail-scanner.js'), 'utf-8');
    expect(SENAL_DE_GATE.test(src), 'services/gmail-scanner.js no llama esProPagado').toBe(true);
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
  const BORRADO = readFileSync(path.join(RAIZ, 'services', 'account-deletion.js'), 'utf-8');

  it('el flujo de desconexión del usuario (paso -1) revoca', () => {
    const paso = ONBOARDING.slice(ONBOARDING.indexOf('onboarding_paso === -1'));
    const flips = (paso.match(/from\('gmail_cuentas'\)\s*\.update\(\{\s*activa:\s*false/g) || []).length;
    expect(flips, 'quedó un `activa: false` suelto: revoca en Google en vez de marcar la fila').toBe(0);
  });

  /**
   * Antes esto era `>= 4 llamadas a revocarAccesoGmail después del paso -1`, y ese número
   * estaba acoplado a que el wipe estuviera COPIADO dos veces. Al unificar las tres copias
   * en `ejecutarBorradoTotal` el conteo bajó a 3 y el guard se puso rojo sin que ninguna
   * salida hubiera dejado de revocar — un falso positivo que invitaba a bajar el número
   * hasta que dejara de molestar, que es como un guard se convierte en decoración.
   *
   * Lo que de verdad se quiere afirmar es que CADA salida de desconexión le habla a Google,
   * y eso son los cuatro motivos. Es más estricto que un conteo (un motivo que desaparece
   * se nombra) y no se rompe porque el código cambie de lugar. Se busca en el archivo
   * entero, no desde el paso -1: la función del wipe vive arriba a propósito.
   */
  const MOTIVOS_QUE_REVOCAN = [
    'usuario_desconecto_una',    // multi-cuenta, una sola
    'usuario_desconecto_todas',  // multi-cuenta, todas
    'usuario_desconecto',        // cuenta única
    'usuario_borro_cuenta',      // wipe total
  ];
  // Las cuatro salidas ya no viven en un solo archivo: desde la migración 073 el wipe se
  // mudó entero a `services/account-deletion.js`, porque la webapp es una segunda puerta al
  // mismo borrado y escribirlo dos veces sería repetir el error que se unificó el 17-ago.
  // Se barren los dos archivos juntos, que es justo lo que el comentario de arriba promete:
  // este guard afirma que CADA salida le habla a Google, no dónde está escrita.
  const RUTAS_DE_DESCONEXION = ONBOARDING + '\n' + BORRADO;

  it.each(MOTIVOS_QUE_REVOCAN)('la salida "%s" revoca en Google', (motivo) => {
    const re = new RegExp("revocarAccesoGmail\\([^)]*motivo:\\s*'" + motivo + "'");
    expect(re.test(RUTAS_DE_DESCONEXION), 'no hay revocación con motivo ' + motivo).toBe(true);
  });

  // El invariante es el mismo de siempre —revocar mientras todavía hay token— pero cambió
  // de forma con la 073: el borrado ya no hace un `delete` sobre `gmail_cuentas`, lo hace el
  // RPC `borrar_cuenta_total` dentro de su transacción, y ahí es donde se pierden los tokens.
  // Si la revocación quedara después, el grant sobrevive en Google para siempre y sin forma
  // de alcanzarlo: seguiríamos con permiso de lectura sobre la bandeja de alguien que se fue.
  it('el borrado revoca ANTES del RPC (después ya no hay token que usar)', () => {
    const rpc = BORRADO.indexOf("rpc('borrar_cuenta_total'");
    expect(rpc, 'el borrado ya no llama al RPC: actualiza este test').toBeGreaterThan(-1);
    const revocaAntes = BORRADO.lastIndexOf('revocarAccesoGmail(', rpc);
    expect(revocaAntes, 'el RPC no viene precedido de una revocación').toBeGreaterThan(-1);
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

/**
 * S′8 — el callback ya no responde HTML armado con datos del usuario.
 *
 * Habia una rama que hacia `res.send('<html>…<h1>Gmail conectado' + nombre + '!</h1>…')`.
 * Self-XSS por severidad (hay que ponerse uno mismo el markup en el nombre), pero `nombre`
 * viene del perfil de Google o del onboarding por WhatsApp: no es un campo que el producto
 * controle. Se borro en vez de escaparse, porque era **codigo muerto medido**: el unico
 * emisor de produccion (`routes/pro.js`) siempre manda `origen: 'web'`, y los enlaces
 * viejos de las puertas de WhatsApp vencieron el 10-ago-2026 (web-only entro el 03-ago,
 * `STATE_TTL_MS` = 7 dias).
 *
 * El guard de arriba —cero emisores en `handlers/`— es lo que impide que la rama pueda
 * revivir. Este fija la otra mitad: que la respuesta del callback no vuelva a interpolar
 * datos ajenos sin escapar.
 */
describe('el callback OAuth no devuelve HTML con datos del usuario (S8)', () => {
  const CALLBACK = readFileSync(path.join(RAIZ, 'routes', 'public.js'), 'utf-8');

  /**
   * Identificadores que SI pueden ir crudos dentro de una respuesta HTML de este archivo.
   * Los dos son constantes del modulo o parametros que solo reciben literales; ninguno
   * lleva datos de un usuario. La lista es corta a proposito: si crece, la pregunta es por
   * que una respuesta HTML necesita otra variable.
   */
  // `REINTENTAR` es el helper del propio modulo, y no se lo cree por su nombre: su CUERPO
  // se extrae aparte y pasa por el mismo detector, asi que si algun dia interpola algo
  // ajeno se marca ahi. Permitirlo aca sin barrerlo seria la clase
  // `guard-que-bendice-lo-que-vino-a-vigilar`.
  const CRUDOS_PERMITIDOS = new Set(['PANEL_PRO_URL', 'titulo', 'LANDING_URL', 'REINTENTAR']);

  /**
   * El barrido va por ARGUMENTO de `res.send/write/end`, con parentesis balanceados.
   *
   * Hubo dos versiones antes de ésta y las dos eran ciegas:
   *
   *   1. Buscar `+ identificador` dentro de `res.send(...)` con una regex plana. No veía
   *      template literals, ni parentesis, ni la variable armada antes.
   *   2. Buscar POR LÍNEA cualquier línea con una etiqueta HTML. Parecía más ancha y
   *      seguía siendo ciega, porque **la unidad no es la línea**. Medido con probes que
   *      agregan HTML nuevo SIN tocar el `res.redirect` (para que no muera por la otra
   *      aserción): las tres pasaban VERDE.
   *
   *      res.send(`<html><body>          const p = ['<h1>Hola</h1>'];
   *      ${req.query.hola}               p.push(req.query.hola);
   *      </body></html>`);               res.send(p.join(''));
   *
   * La forma correcta es preguntar por lo que SALE: se extrae el argumento completo de
   * cada `send/write/end`, se le quitan los `escaparHtml(...)` (que son justamente lo
   * correcto) y los literales estáticos, y **todo identificador que quede** tiene que
   * estar declarado. Eso cubre el armado a distancia sin necesidad de dataflow: si la
   * respuesta sale de `p.join('')`, el identificador que queda es `p`, y `p` no está
   * declarado.
   *
   * La primera mutación que probé (reemplazar el redirect por HTML) moría igual, pero por
   * la aserción del redirect, no por el detector. Un mutante que muere por otra razón no
   * mide lo que uno cree.
   */
  const sinComentarios = (src) => src
    .split(/\r?\n/).map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  /**
   * El texto entre los parentesis de `.send(` … `)`, con balanceo.
   *
   * El patron NO ancla en `res.`: la mayoria de las respuestas de este archivo son
   * `res.status(400).send(...)`, o sea que el receptor es el resultado de `status()`.
   * Anclado en `res.` el barrido encontraba **1 de 5** —solo el `res.send('NETO v5')` de
   * la raiz— y la antivacuidad lo delato. `.append(` y compania no matchean: el caracter
   * anterior a `end` tiene que ser el punto.
   */
  function argumentosDeRespuesta(src) {
    const out = [];
    // El helper REINTENTAR arma HTML sin pasar por un `.send()` propio.
    for (const m of src.matchAll(/const REINTENTAR\s*=\s*\([^)]*\)\s*=>\s*([\s\S]*?);\n/g)) out.push(m[1]);
    for (const m of src.matchAll(/\.\s*(?:send|write|end)\s*\(/g)) {
      let i = m.index + m[0].length;
      const desde = i;
      let prof = 1;
      while (i < src.length && prof > 0) {
        if (src[i] === '(') prof++;
        else if (src[i] === ')') prof--;
        i++;
      }
      out.push(src.slice(desde, i - 1));
    }
    return out;
  }

  /**
   * Identificadores que sobreviven a quitar lo seguro. Se conservan las expresiones
   * `${...}` de un template literal (el resto del template es estático) y se descarta el
   * contenido de los literales de comilla.
   */
  function identificadoresCrudos(arg) {
    const soloExpresiones = arg
      .replace(/escaparHtml\s*\([^)]*\)/g, ' ')       // lo correcto, se quita
      .replace(/`(?:[^`\\]|\\.)*`/g, (t) => [...t.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' '))
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    return [...new Set(
      [...soloExpresiones.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map((x) => x[0]),
    )].filter((id) => !CRUDOS_PERMITIDOS.has(id.split('.')[0]));
  }

  const ARGUMENTOS = argumentosDeRespuesta(sinComentarios(CALLBACK));

  it('el barrido encuentra las respuestas del archivo (antivacuidad)', () => {
    expect(ARGUMENTOS.length).toBeGreaterThanOrEqual(3);
    expect(ARGUMENTOS.some((a) => a.includes('escaparHtml'))).toBe(true);
    // Y que el extractor traiga el argumento ENTERO, no hasta el primer parentesis: el de
    // `escaparHtml` cierra en el medio, asi que un extractor sin balanceo cortaria ahi.
    expect(ARGUMENTOS.some((a) => a.includes('escaparHtml') && a.includes('</p>'))).toBe(true);
  });

  it('nada se interpola crudo: o es constante del modulo o pasa por escaparHtml', () => {
    const crudos = ARGUMENTOS.flatMap(identificadoresCrudos);
    expect([...new Set(crudos)], 'interpolado crudo en una respuesta del callback').toEqual([]);
  });

  /**
   * Contraprueba: el detector corre contra fixtures, no solo contra el archivo real —
   * que hoy esta limpio, asi que su ceguera seria invisible por construccion.
   */
  it('reconoce las formas en que se reescribiria la rama borrada', () => {
    const forma = (src) => argumentosDeRespuesta(sinComentarios(src)).flatMap(identificadoresCrudos);

    // Las de una linea.
    expect(forma("res.send('<h1>Gmail conectado' + nombre + '</h1>');")).toContain('nombre');
    expect(forma('res.send(`<h1>Gmail conectado, ${usuario.nombre}!</h1>`);')).toContain('usuario.nombre');
    expect(forma("res.send('<h1>' + (usuario.nombre) + '</h1>');")).toContain('usuario.nombre');
    expect(forma("res.write('<p>' + emailConectado + '</p>');")).toContain('emailConectado');
    // Las TRES que pasaban verde con el barrido por linea, medidas con probes reales.
    expect(forma('res.send(`<html><body>\n${usuario.nombre}\n</body></html>`);')).toContain('usuario.nombre');
    expect(forma("res.send('<h1>Hola</h1>' +\n  usuario.nombre +\n  '<p>chau</p>');")).toContain('usuario.nombre');
    expect(forma("const p = ['<h1>Hola</h1>']; p.push(usuario.nombre); res.send(p.join(''));")).toContain('p.join');

    // Y lo que es correcto no se marca.
    expect(forma("res.send('<b>' + escaparHtml(emailPrevio) + '</b>');")).toEqual([]);
    expect(forma("res.send('<a href=\"' + PANEL_PRO_URL + '\">app.neto.pe</a>');")).toEqual([]);
    // Una expresion que no sale por una respuesta no entra al barrido.
    expect(forma("const primerNombre = usuario.nombre.split(' ')[0];")).toEqual([]);
    // Y un comentario que muestra la forma prohibida no puede romper el build.
    expect(forma("// antes decia res.send('<h1>' + usuario.nombre + '</h1>')")).toEqual([]);
  });

  it('la rama de exito redirige y no manda HTML', () => {
    expect(CALLBACK).toMatch(/res\.redirect\('https:\/\/app\.neto\.pe\/dashboard\?gmail=conectado'\)/);
    // El HTML que quedaba en esa rama nombraba a WhatsApp; un usuario web-only no tiene
    // WhatsApp al que volver. Si reaparece, es que alguien resucito la bifurcacion.
    expect(CALLBACK).not.toMatch(/Vuelve a WhatsApp/);
    expect(CALLBACK).not.toMatch(/origenConexion/);
  });
});

/**
 * Migracion 071 — **una sola fila espejo por deuda**, y quien puede crearla.
 *
 * El indice unico parcial sobre `deudas.deuda_vinculada_id` es lo que sostiene el
 * invariante contra dos joins concurrentes; el `if` de la ruta no puede. Pero un indice
 * unico rechaza escrituras, asi que este guard existe para responder mecanicamente la
 * pregunta que hay que hacerse antes de agregar uno: **¿quien MAS escribe esa columna?**
 *
 * La segunda revision adversarial la planteo y la contesto MAL: afirmo que
 * `renovarDeudaRecurrente()` en `services/debts.js:412-441` copiaba `deuda_vinculada_id`
 * al renovar una deuda recurrente, y que por eso la renovacion moriria con un 23505
 * silencioso. Esa funcion **no existe** —`services/debts.js` tiene 281 lineas— y la
 * renovacion es un UPDATE sobre la misma fila (`periodos_pagados + 1`), no un INSERT. El
 * unico INSERT a `deudas` del backend es `registrarDeuda`, que no toca la columna.
 *
 * O sea que la respuesta era correcta y la comprobacion era un grep mio. Esto la vuelve
 * un control: si alguien agrega un segundo escritor, se entera acá y no con un 23505 en
 * produccion. Es la clase `invariante-con-una-puerta-sin-barrer` de `docs/DEFECTOS.md`.
 */
describe('deuda_vinculada_id tiene un solo escritor (migracion 071)', () => {
  const DIRS = ['handlers', 'services', 'routes', 'cron', 'helpers', 'webapp/src/app/api'];

  function archivos(dir) {
    const out = [];
    const abs = path.join(RAIZ, dir);
    if (!existsSync(abs)) return out;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...archivos(rel));
      else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !/\.test\.(js|ts)$/.test(e.name)) out.push(rel);
    }
    return out;
  }

  // `deuda_vinculada_id: <algo>` en un objeto. `null` no cuenta: es el DESVINCULADO que
  // hace el DELETE del original, y el indice parcial ni lo ve.
  const ESCRIBE = /deuda_vinculada_id\s*:\s*([^,\n}]+)/g;
  const esTipoTs = (v) => /^(string|number|boolean|any|unknown)\b/.test(v);

  const escritores = [];
  for (const rel of DIRS.flatMap(archivos).map((p) => p.replace(/\\/g, '/'))) {
    const src = readFileSync(path.join(RAIZ, rel), 'utf-8')
      .split(/\r?\n/).map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
    for (const m of src.matchAll(ESCRIBE)) {
      const valor = m[1].trim().replace(/;$/, '');
      if (valor === 'null' || valor === 'undefined' || esTipoTs(valor)) continue;
      escritores.push(rel);
      break;
    }
  }

  it('solo /api/debts/join escribe un valor NO NULO', () => {
    expect([...new Set(escritores)]).toEqual(['webapp/src/app/api/debts/join/route.ts']);
  });

  it('el detector reconoce la forma que la revision creyo ver (contraprueba)', () => {
    const inventado = 'await supabase.from("deudas").insert({ deuda_vinculada_id: deuda.deuda_vinculada_id });';
    const hits = [...inventado.matchAll(ESCRIBE)]
      .map((m) => m[1].trim()).filter((v) => v !== 'null' && !esTipoTs(v));
    expect(hits).toHaveLength(1);
    // Y el desvinculado del DELETE no cuenta como escritor.
    const desvincula = ".update({ deuda_vinculada_id: null }).eq('deuda_vinculada_id', id)";
    expect([...desvincula.matchAll(ESCRIBE)].map((m) => m[1].trim()).filter((v) => v !== 'null')).toEqual([]);
  });
});

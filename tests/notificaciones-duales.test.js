import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard del chokepoint de notificaciones, hermano de `tests/cron/lecturas-proactivas.test.js`
 * y de `webapp/src/lib/supabase/lectura-callsites.test.ts`.
 *
 * El hecho que lo obliga: el WhatsApp libre NO se entrega fuera de la ventana de 24h de Meta
 * (error 131047) y las plantillas están descartadas por decisión de producto (ver
 * docs/whatsapp-templates.md). O sea que un aviso que sale solo por WhatsApp no llega a quien
 * no escribió hoy — y quien no escribió hoy es justamente la población a la que se le quiere
 * avisar: el trial por vencer, el inactivo, el que ni sabe que le cargaron un gasto en un
 * espacio. La notificación in-app es el único canal que llega a todos.
 *
 * El modo de falla que este archivo previene: un envío proactivo NUEVO escrito con
 * `enviarWhatsapp` a secas. No se detecta mirando producción — el cron corre, no falla, y
 * `notification_deliveries` hasta registra 'sent' porque Meta aceptó el POST. Se ve igual que
 * un usuario al que se le avisó y que simplemente no reaccionó.
 *
 * Por eso la regla es binaria y no depende de leer la intención de nadie:
 *
 *   Ningún archivo del backend, fuera de los declarados abajo, llama `enviarWhatsapp`
 *   directamente. Todo aviso proactivo pasa por `notificarUsuario`, y `notificarUsuario` no
 *   se escribe sin declarar sus canales.
 *
 * Si agregas un envío y este archivo se pone rojo, la respuesta por defecto es
 * `notificarUsuario` con `CANALES.AMBOS`. Declararlo como excepción es la excepción, no el
 * atajo.
 */

const RAIZ = process.cwd();

/** Directorios de runtime. `scripts/`, `qa-e2e/`, `migrations/` y `webapp/` no corren en el server. */
const DIRS = ['cron', 'services', 'routes', 'lib', 'handlers', 'helpers'];
const SUELTOS = ['index.js', 'gmail.js'];

const ENVIO_CRUDO = /\benviarWhatsapp\s*\(/g;
const IN_APP_CRUDO = /\bcrearNotificacion\s*\(/g;
const CHOKEPOINT = /\bnotificarUsuario\s*\(/g;

/** El chokepoint declara canales como PRIMERA clave. Eso es lo que hace la regex exacta. */
const CON_CANALES = /\bnotificarUsuario\(\s*\{\s*canales\s*:/g;
const CANAL_UNICO = /CANALES\.SOLO_\w+/g;
/**
 * `motivo` va inmediatamente después de `canales`. El look-ahead negativo impide que el match
 * se cuele hasta el `motivo` de la LLAMADA SIGUIENTE cuando la actual no lo tiene.
 *
 * Consecuencia práctica a documentar (falla cerrada, o sea rojo y no verde): un comentario
 * largo entre las dos claves rompe el match. Poné el `motivo` pegado al `canales`.
 */
const UNICO_CON_MOTIVO = /canales\s*:\s*CANALES\.SOLO_\w+\s*,(?:(?!canales\s*:)[\s\S]){0,400}?motivo\s*:\s*['"`]/g;
const AMBOS_CON_MOTIVO = /canales\s*:\s*CANALES\.AMBOS\s*,(?:(?!canales\s*:)[\s\S]){0,200}?motivo\s*:/g;

/**
 * Los ÚNICOS archivos que pueden llamar `enviarWhatsapp` crudo, por familia.
 *
 * `usos` está fijado a propósito: agregar una llamada rompe este test. Si lo que agregaste es
 * una RESPUESTA, subí el número acá. Si es un EMPUJE, no lo subas — usá `notificarUsuario`.
 * Excluir el archivo entero en vez de fijar el conteo dejaría el agujero justo donde más
 * duele: alguien mete un push proactivo dentro de `webhook.js` y nadie se entera.
 *
 * · TRANSPORTE — la definición y el chokepoint.
 * · RESPUESTA  — turno de conversación. El usuario acaba de escribir (o acaba de autorizar en
 *                el navegador): la ventana de 24h está abierta por construcción y no hay nada
 *                que espejar en la campana.
 * · ADMIN      — le escriben a Favio, que no tiene bandeja in-app.
 * · SOPORTE    — hilo humano; la webapp no tiene bandeja de soporte donde aterrizarlo.
 * · VOLUMEN    — la tarjeta por transacción. El dato ya vive en /dashboard/transacciones y es
 *                la única fuente de alto volumen del sistema (una por gasto detectado, no una
 *                por evento): una fila por transacción convierte la campana en ruido.
 */
const WHATSAPP_CRUDO = new Map([
  ['lib/whatsapp.js', { usos: 1, familia: 'TRANSPORTE', motivo: 'la definición de enviarWhatsapp' }],
  ['lib/notify-user.js', { usos: 1, familia: 'TRANSPORTE', motivo: 'el chokepoint: el único autorizado a llamarlo' }],
  ['lib/admin-notify.js', { usos: 1, familia: 'ADMIN', motivo: 'notificarAdmin escribe al número de Favio, no a un usuario' }],
  ['handlers/webhook.js', { usos: 26, familia: 'RESPUESTA', motivo: 'turnos de conversación: imágenes, audios, OTP, onboarding' }],
  // Baja de 5 a 4: se fue el aviso de "cuenta Gmail adicional conectada", que preguntaba por
  // WhatsApp cómo agrupar los reportes. Un usuario tiene UNA cuenta (cada una cuesta un cupo
  // de por vida), así que esa rama del callback ya no existe.
  ['routes/public.js', { usos: 4, familia: 'RESPUESTA', motivo: 'callback de OAuth de Gmail: el usuario acaba de autorizar en el navegador' }],
  ['routes/admin.js', { usos: 1, familia: 'ADMIN', motivo: 'mensaje manual que el operador decide mandarle a un usuario' }],
  ['lib/pro-payment.js', { usos: 1, familia: 'RESPUESTA', motivo: '"comprobante recibido" contesta la captura que el usuario acaba de mandar' }],
  ['lib/support-tickets.js', { usos: 2, familia: 'SOPORTE', motivo: 'el hilo de soporte vive en WhatsApp; la webapp no tiene bandeja donde aterrizarlo' }],
  ['services/notifications.js', { usos: 1, familia: 'VOLUMEN', motivo: 'tarjeta "Nuevo gasto": el dato ya está en /dashboard/transacciones y es una por transacción' }],
]);

/**
 * Los ÚNICOS que pueden escribir la in-app cruda.
 *
 * Existe para que nadie "cierre un hueco" pegando un `crearNotificacion` al lado de un
 * `enviarWhatsapp` — que es exactamente cómo se escribió el patrón que este chokepoint viene
 * a reemplazar, y por qué 19 avisos se quedaron sin la mitad in-app.
 */
const IN_APP_CRUDA = new Map([
  ['lib/notifications-db.js', { usos: 1, motivo: 'la definición de crearNotificacion' }],
  ['lib/notify-user.js', { usos: 1, motivo: 'el chokepoint' }],
  ['services/notifications.js', { usos: 1, motivo: 'la nota de "gasto inusual" se ADJUNTA a un mensaje que arma otro; no es un envío propio' }],
]);

function archivosJs(dir) {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return archivosJs(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

const cuenta = (txt, re) => (txt.match(re) || []).length;

const FUENTES = [
  ...DIRS.filter((d) => existsSync(join(RAIZ, d))).flatMap((d) => archivosJs(join(RAIZ, d))),
  ...SUELTOS.filter((f) => existsSync(join(RAIZ, f))).map((f) => join(RAIZ, f)),
].map((full) => ({
  rel: relative(RAIZ, full).replace(/\\/g, '/'),
  src: readFileSync(full, 'utf-8'),
}));

describe('chokepoint de notificaciones proactivas', () => {
  // ── Antivacuidad ──────────────────────────────────────────────────────────────
  it('el barrido encuentra el backend (si esto se rompe, todo lo de abajo miente)', () => {
    expect(FUENTES.length).toBeGreaterThan(40);
    const rels = FUENTES.map((f) => f.rel);
    for (const obligatorio of [
      'cron/checks.js',
      'services/shared-spaces.js',
      'services/survey-triggers.js',
      'services/referrals.js',
      'lib/notify-user.js',
    ]) {
      expect(rels, obligatorio + ' no entró al barrido').toContain(obligatorio);
    }
    // Y encuentra envíos: un barrido que no ve ninguno está roto, no limpio.
    const totalChoke = FUENTES.reduce((s, f) => s + cuenta(f.src, CHOKEPOINT), 0);
    expect(totalChoke).toBeGreaterThanOrEqual(30);
  });

  it('el detector reconoce un envío crudo y una declaración válida (contraprueba)', () => {
    // Sin esto, los tests de abajo podrían estar verdes solo porque la regex dejó de matchear.
    expect(cuenta("await enviarWhatsapp(u.whatsapp, msg, { tipo: 'x' });", ENVIO_CRUDO)).toBe(1);
    expect(cuenta("const { enviarWhatsapp } = require('./whatsapp');", ENVIO_CRUDO)).toBe(0);

    const bueno = 'await notificarUsuario({ canales: CANALES.AMBOS, usuarioId: u.id });';
    expect(cuenta(bueno, CHOKEPOINT)).toBe(1);
    expect(cuenta(bueno, CON_CANALES)).toBe(1);

    const malo = 'await notificarUsuario({ usuarioId: u.id, mensaje: msg });';
    expect(cuenta(malo, CHOKEPOINT)).toBe(1);
    expect(cuenta(malo, CON_CANALES)).toBe(0);

    // Un canal único sin motivo NO puede robarse el motivo de la llamada siguiente.
    const robo = "notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, tipo: 'a' });\n" +
      "notificarUsuario({ canales: CANALES.SOLO_IN_APP, motivo: 'x' });";
    expect(cuenta(robo, CANAL_UNICO)).toBe(2);
    expect(cuenta(robo, UNICO_CON_MOTIVO)).toBe(1);
  });

  // ── Sin clasificar ────────────────────────────────────────────────────────────
  it('nadie llama enviarWhatsapp crudo sin estar declarado', () => {
    const sinDeclarar = FUENTES
      .filter((f) => cuenta(f.src, ENVIO_CRUDO) > 0)
      .map((f) => f.rel)
      .filter((rel) => !WHATSAPP_CRUDO.has(rel));

    expect(sinDeclarar).toEqual([]);
  });

  it('nadie escribe la in-app cruda sin estar declarado', () => {
    const sinDeclarar = FUENTES
      .filter((f) => cuenta(f.src, IN_APP_CRUDO) > 0)
      .map((f) => f.rel)
      .filter((rel) => !IN_APP_CRUDA.has(rel));

    expect(sinDeclarar).toEqual([]);
  });

  // ── Anti-fantasma + conteos fijados ───────────────────────────────────────────
  it('no hay exenciones fantasma, y los conteos declarados son los reales', () => {
    const reales = new Map(
      FUENTES.filter((f) => cuenta(f.src, ENVIO_CRUDO) > 0)
        .map((f) => [f.rel, cuenta(f.src, ENVIO_CRUDO)]),
    );
    expect(
      [...WHATSAPP_CRUDO.keys()].filter((rel) => !reales.has(rel)),
      'exenciones que ya no llaman enviarWhatsapp: bórralas',
    ).toEqual([]);

    // Si esto falla porque agregaste una RESPUESTA, subí el número.
    // Si agregaste un EMPUJE, no lo subas: usá notificarUsuario.
    expect(
      [...WHATSAPP_CRUDO.entries()]
        .filter(([rel, d]) => reales.get(rel) !== d.usos)
        .map(([rel, d]) => rel + ': declarado ' + d.usos + ', real ' + reales.get(rel)),
    ).toEqual([]);

    const inAppReales = new Map(
      FUENTES.filter((f) => cuenta(f.src, IN_APP_CRUDO) > 0)
        .map((f) => [f.rel, cuenta(f.src, IN_APP_CRUDO)]),
    );
    expect([...IN_APP_CRUDA.keys()].filter((rel) => !inAppReales.has(rel))).toEqual([]);
    expect(
      [...IN_APP_CRUDA.entries()]
        .filter(([rel, d]) => inAppReales.get(rel) !== d.usos)
        .map(([rel]) => rel),
    ).toEqual([]);
  });

  it('toda exención declara familia y motivo de verdad', () => {
    for (const [rel, d] of WHATSAPP_CRUDO) {
      expect(d.familia, rel + ' sin familia').toBeTruthy();
      expect(String(d.motivo).length, rel + ' sin motivo real').toBeGreaterThan(15);
    }
  });

  // ── La declaración de canales es obligatoria ──────────────────────────────────
  it('toda llamada a notificarUsuario declara canales como primera clave', () => {
    const sinCanales = FUENTES
      .filter((f) => f.rel !== 'lib/notify-user.js')   // ahí vive la definición
      .map((f) => ({ rel: f.rel, total: cuenta(f.src, CHOKEPOINT), ok: cuenta(f.src, CON_CANALES) }))
      .filter((f) => f.total !== f.ok)
      .map((f) => f.rel + ': ' + f.total + ' llamadas, ' + f.ok + ' con `canales:` primero');

    expect(sinCanales).toEqual([]);
  });

  it('todo canal único lleva su motivo, y AMBOS no lo lleva', () => {
    const sinMotivo = FUENTES
      .filter((f) => f.rel !== 'lib/notify-user.js')
      .map((f) => ({
        rel: f.rel,
        unicos: cuenta(f.src, CANAL_UNICO),
        conMotivo: cuenta(f.src, UNICO_CON_MOTIVO),
      }))
      .filter((f) => f.unicos !== f.conMotivo)
      .map((f) => f.rel + ': ' + f.unicos + ' canales únicos, ' + f.conMotivo + ' con motivo');
    expect(sinMotivo).toEqual([]);

    // Un `motivo` sobre el default es ruido: diluye el grep que audita las excepciones.
    expect(FUENTES.filter((f) => cuenta(f.src, AMBOS_CON_MOTIVO) > 0).map((f) => f.rel)).toEqual([]);
  });

  // ── Nominales: los huecos del incidente, uno por uno ──────────────────────────
  // Si alguien revierte uno, este test dice cuál y por qué importaba.
  it.each([
    ['services/shared-spaces.js', 3, 'nuevo miembro, reparto editado, reglas editadas, gasto compartido, liquidación'],
    ['services/referrals.js', 1, 'el referrer gana un mes irreversible y solo se enteraba por WhatsApp'],
    ['services/survey-triggers.js', 5, 'los 4 recordatorios + wake_up_inactive + feedback_30tx'],
    ['services/gmail-scanner.js', 2, 'Gmail desconectado: el usuario deja de registrar gastos sin saberlo'],
    ['routes/internal.js', 1, 'activación web completada'],
    ['cron/checks.js', 19, 'los 15 duales + trial + pro_upsell_d28 + inactivity'],
  ])('%s manda por el chokepoint (>=%i llamadas): %s', (rel, minimo) => {
    const f = FUENTES.find((x) => x.rel === rel);
    expect(f, rel + ' ya no existe: actualiza este test').toBeDefined();
    expect(cuenta(f.src, ENVIO_CRUDO), rel + ' volvió a llamar enviarWhatsapp crudo').toBe(0);
    expect(cuenta(f.src, CHOKEPOINT)).toBeGreaterThanOrEqual(minimo);
  });

  // El caso que sostiene la regla del módulo de espacios: cualquier miembro puede cambiar el
  // reparto, y lo que hace que eso sea seguro no es el permiso, es que se ANUNCIE.
  it('los avisos de espacios no filtran por whatsapp antes de notificar', () => {
    const f = FUENTES.find((x) => x.rel === 'services/shared-spaces.js');
    // Estos filtros dejaban al miembro web-only sin enterarse de que su parte se movió.
    expect(f.src).not.toMatch(/if\s*\(\s*!\s*m\.usuarios\?\.whatsapp\s*\)\s*continue/);
    expect(f.src).not.toMatch(/if\s*\(\s*toUsuario\?\.whatsapp\s*\)/);
  });

  // Los tres destinatarios que legítimamente no tienen dónde recibir una in-app: por
  // construcción, la query que los selecciona exige que NO tengan cuenta web.
  it.each([
    ['cron/checks.js', 2, 'checkActivacionDia2 y checkRecordatorioOnboarding'],
    ['services/survey-triggers.js', 2, 'webapp_invite_10tx y wake_up_onboarding'],
  ])('%s tiene exactamente %i exenciones de canal (%s)', (rel, esperadas) => {
    const f = FUENTES.find((x) => x.rel === rel);
    expect(cuenta(f.src, CANAL_UNICO)).toBe(esperadas);
  });
});

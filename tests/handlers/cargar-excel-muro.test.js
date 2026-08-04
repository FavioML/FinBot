import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Hallazgo M9 de la auditoría CTO (2026-08-04).
//
// La importación de Excel/CSV se pide en DOS momentos separados por minutos:
//   1. el intent `cargar_excel` → "descarga la plantilla, llénala, mándamela"
//   2. el archivo, ya llenado, que entra por `message.type === 'document'` en webhook.js
//
// Los dos miran el mismo flag `excelUpload` de PLAN_CONFIG, pero solo el segundo lo
// comprobaba. Resultado: al usuario del muro se le daba el instructivo completo, bajaba
// la plantilla, la llenaba a mano, y recién al enviarla se le decía que era Pro. El bot
// invitaba a hacer un trabajo que después rechazaba.
//
// Decisión de Favio (04-ago-2026): se alinea el bot al gate, no al revés. `excelUpload`
// ya era Pro; "escribir nunca se corta" protege anotar el gasto del día, no importar 500
// filas de historial —que es sembrar la data que el dashboard, lo que se paga, vuelve
// legible—. El intent sigue en INTENTS_LIBRES porque NO es una lectura: su gate no es el
// muro sino este flag.

const moderacion = require('../../handlers/intents/moderacion');
const { mensajeCargaMasivaPro } = require('../../lib/trial');

const EN_MURO = { id: 'u1', plan: 'free', trial_estado: 'vencido' };
const NUNCA_EMPEZO = { id: 'u2', plan: 'free', trial_estado: null };
const EN_TRIAL = { id: 'u3', plan: 'premium', trial_estado: 'activo' };
const PAGADO = { id: 'u4', plan: 'premium', trial_estado: 'convertido' };

const pedirTutorial = (usuario) =>
  moderacion.handle({ intencion: 'cargar_excel', msg: 'quiero subir mi excel', datos: {}, usuario, from: '51999', ctx: {} });

const SENAL_TUTORIAL = 'plantilla_gastos.xlsx';

describe('cargar_excel: el intent y el archivo responden lo mismo', () => {
  it('al del muro le da el pitch Pro, NO el instructivo', async () => {
    const r = await pedirTutorial(EN_MURO);
    expect(r, 'sigue entregando la plantilla a quien después va a rechazar').not.toContain(SENAL_TUTORIAL);
    expect(r).toBe(mensajeCargaMasivaPro(EN_MURO));
  });

  it('al que nunca registró nada también (mismo flag, no depende del trial_estado)', async () => {
    expect(await pedirTutorial(NUNCA_EMPEZO)).toBe(mensajeCargaMasivaPro(NUNCA_EMPEZO));
  });

  it('al del trial le da el instructivo: durante la prueba excelUpload está abierto', async () => {
    const r = await pedirTutorial(EN_TRIAL);
    expect(r).toContain(SENAL_TUTORIAL);
    expect(r).not.toBe(mensajeCargaMasivaPro(EN_TRIAL));
  });

  it('al pagador también', async () => {
    expect(await pedirTutorial(PAGADO)).toContain(SENAL_TUTORIAL);
  });

  // El "no" tiene que dejar en pie la promesa que el muro SÍ cumple, o se lee como si
  // registrar también estuviera cortado.
  it('el pitch recuerda que anotar por WhatsApp sigue gratis', () => {
    expect(mensajeCargaMasivaPro(EN_MURO)).toMatch(/no tiene límite ni costo/i);
  });

  /**
   * El pitch NO puede mandar a `"ver plan"`. Ese comando llega a `ver_premium`, que para
   * el usuario del muro llama `solicitarComprobante` y abre 48h en las que toda foto se
   * lee como comprobante de pago: una que no parece el pago a Neto se rechaza SIN
   * registrar el gasto. O sea que le rompería justo la escritura por foto que el mensaje
   * le acaba de prometer dos líneas antes. Es la trampa B12 de la ola 1.
   */
  it('empuja al panel, no al comando que arma la espera de comprobante', () => {
    const conWeb = { id: 'u10', plan: 'free', trial_estado: 'vencido', supabase_auth_id: 'auth-123' };
    const m = mensajeCargaMasivaPro(conWeb);
    expect(m, 'manda a "ver plan": eso abre 48h que le rompen el registro por foto')
      .not.toMatch(/ver plan/i);
    expect(m).toContain('/dashboard/pro');
  });

  // Un WhatsApp-only no tiene sesión web: mandarlo a /dashboard/pro lo deposita en /login,
  // donde "Continuar con Google" le crea una cuenta huérfana sin sus gastos. `linkPanelPro`
  // bifurca a un link de activación firmado, y el pitch hereda esa bifurcación por usarlo
  // en vez de armar la URL a mano.
  it('al WhatsApp-only le manda un link de activación, no el panel', () => {
    const soloWa = { id: 'u9', plan: 'free', trial_estado: 'vencido', supabase_auth_id: null };
    const prev = process.env.ACTIVATION_TOKEN_SECRET;
    process.env.ACTIVATION_TOKEN_SECRET = 'secreto-de-test';
    try {
      const m = mensajeCargaMasivaPro(soloWa);
      expect(m).toContain('/activar?t=');
      expect(m, 'lo manda al panel: cae en /login y se le crea una cuenta huérfana').not.toContain('/dashboard/pro');
    } finally {
      if (prev === undefined) delete process.env.ACTIVATION_TOKEN_SECRET;
      else process.env.ACTIVATION_TOKEN_SECRET = prev;
    }
  });

  // Sin el secreto configurado no hay link que emitir (degradación de infra, no un estado
  // de usuario). El mensaje tiene que seguir siendo coherente: nunca una línea "👉" vacía,
  // y nunca una instrucción de pago que nadie va a atender —pedirle la captura sin que
  // `solicitarComprobante` haya corrido la registraría como un gasto cualquiera—.
  it('sin link, el pitch no queda colgado ni pide una captura que nadie espera', () => {
    const soloWa = { id: 'u9', plan: 'free', trial_estado: 'vencido', supabase_auth_id: null };
    const prev = process.env.ACTIVATION_TOKEN_SECRET;
    delete process.env.ACTIVATION_TOKEN_SECRET;
    try {
      const m = mensajeCargaMasivaPro(soloWa);
      expect(m).not.toMatch(/👉\s*$/);
      expect(m).not.toMatch(/captura/i);
      expect(m, 'perdió el precio, que es lo único que le queda para decidir').toContain('S/');
    } finally {
      if (prev !== undefined) process.env.ACTIVATION_TOKEN_SECRET = prev;
    }
  });
});

/**
 * Guard estático: lo que se arregló fue que DOS puntos decidieran por separado. Si el copy
 * se vuelve a duplicar, vuelven a poder divergir sin que ningún test unitario lo note —
 * fue exactamente el modo de falla original.
 */
describe('un solo dueño del "no" y un solo gate', () => {
  const leer = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf-8');
  const WEBHOOK = leer('handlers/webhook.js');
  const MODERACION = leer('handlers/intents/moderacion.js');
  const TRIAL = leer('lib/trial.js');

  // Antivacuidad: si los archivos se renombran o el read devuelve vacío, esto cae primero.
  it('los tres archivos del flujo se leyeron de verdad', () => {
    expect(WEBHOOK.length).toBeGreaterThan(1000);
    expect(MODERACION.length).toBeGreaterThan(500);
    expect(TRIAL).toContain('function mensajeCargaMasivaPro');
  });

  // Vive en lib/trial.js, con el resto del copy del muro y con `linkPanelPro` al lado —
  // no en helpers/pro-wall.js, que es el gate genérico y no debería arrastrar el grafo de
  // dependencias de trial (db, activación, analytics) a cada intent que lo importa.
  it('el literal del pitch vive SOLO en lib/trial.js', () => {
    const marca = 'carga masiva de Excel/CSV* es una función Pro';
    expect(TRIAL).toContain(marca);
    expect(WEBHOOK, 'webhook.js volvió a hardcodear el copy').not.toContain(marca);
    expect(MODERACION, 'moderacion.js hardcodeó el copy').not.toContain(marca);
  });

  it('los dos call-sites llaman a la misma función, con el usuario', () => {
    expect(WEBHOOK).toContain('mensajeCargaMasivaPro(usuario)');
    expect(MODERACION).toContain('mensajeCargaMasivaPro(usuario)');
  });

  // Si alguien quita el gate de webhook.js, el intent seguiría cobrando y el archivo
  // entraría gratis: la contradicción de M9 al revés, igual de invisible en producción.
  it('el handler de documentos conserva su propio gate por excelUpload', () => {
    expect(WEBHOOK).toMatch(/checkProWall\(usuario,\s*'excelUpload'\)/);
    expect(MODERACION).toMatch(/checkProWall\(usuario,\s*'excelUpload'\)/);
  });

  /**
   * El ORDEN dentro de la rama `document` es parte del arreglo, y ningún assert de
   * contenido lo ve.
   *
   * El chequeo de formato ("acepto .xlsx o .csv") reparte el link de la plantilla. Mientras
   * estuvo ANTES del gate, M9 seguía vivo en la rama hermana: al usuario del muro que
   * mandaba un PDF —su estado de cuenta, típicamente— se le decía "descarga la plantilla",
   * la llenaba a mano, la enviaba, y RECIÉN ahí se le cobraba. Mismo bug, seis líneas más
   * arriba del gate que lo arreglaba. Lo encontró el revisor adversarial del diff, no esta
   * suite.
   *
   * A quien no puede importar no se le explica el formato: se le dice que no puede importar.
   */
  it('el gate corre ANTES del chequeo de formato', () => {
    const rama = WEBHOOK.slice(WEBHOOK.indexOf("message.type === 'document'"));
    expect(rama.length, 'no se pudo aislar la rama de documentos').toBeGreaterThan(500);
    const iGate = rama.indexOf("checkProWall(usuario, 'excelUpload')");
    const iFormato = rama.indexOf('Acepto archivos Excel');
    expect(iGate, 'el gate desapareció de la rama de documentos').toBeGreaterThan(-1);
    expect(iFormato, 'el chequeo de formato desapareció').toBeGreaterThan(-1);
    expect(iGate, 'el "descarga la plantilla" vuelve a correr antes del gate: M9 revivido en la rama del PDF')
      .toBeLessThan(iFormato);
  });

  // El gate tiene que estar antes de gastar la llamada a Meta, también.
  it('el gate corre antes de descargar el archivo desde Meta', () => {
    const rama = WEBHOOK.slice(WEBHOOK.indexOf("message.type === 'document'"));
    const iGate = rama.indexOf("checkProWall(usuario, 'excelUpload')");
    const iDescarga = rama.indexOf('graph.facebook.com');
    expect(iDescarga).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iDescarga);
  });
});

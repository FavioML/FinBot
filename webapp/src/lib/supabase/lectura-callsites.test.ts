import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard del muro de lectura, hermano de `auth-callsites.test.ts`.
 *
 * La regla del producto tras el trial de 14 días es que **escribir nunca se corta; lo que
 * se cobra es leer**. Eso lo aplica `requireLectura` (402 si el usuario cayó al muro).
 *
 * El modo de falla que este archivo previene: una ruta de lectura NUEVA que use
 * `requireNetoUser` a secas y entregue gratis exactamente lo que el paywall cobra. Eso no
 * se detecta mirando producción — se ve como un usuario contento que nunca paga.
 *
 * Por eso cada ruta que use `requireNetoUser` tiene que estar en la lista de abajo, con su
 * motivo. Si agregas una ruta y este test falla, la respuesta por defecto es
 * `requireLectura`; agregarla a la lista es la excepción, no el atajo.
 */

const USA_REQUIRE_NETO = /\brequireNetoUser\s*\(/;

/**
 * Rutas que legítimamente NO exigen derecho de lectura, por familia:
 *
 * · ESCRITURA — registrar y corregir gastos es gratis para siempre. Es la promesa del
 *   sprint de activación y la razón de que el muro sea de lectura y no de servicio.
 * · CONVERSIÓN — cerrarle a quien está en el muro el camino de pagar sería absurdo.
 * · IDENTIDAD / PREFERENCIAS — perfil, notificaciones, tour, desvincular WhatsApp.
 *   Nada de esto devuelve data financiera acumulada.
 * · BANDEJA — el aviso de "tu prueba terminó" aterriza acá: bloquearla ocultaría
 *   justamente el mensaje que explica el muro.
 * · COLABORATIVO — espacios, splits e invitaciones se autorizan por el modelo "host paga"
 *   (`requireSpaceMember` / `requireSpaceOwner`), donde el tier que manda es el del dueño
 *   del espacio, no el del que pide. Meterles `requireLectura` rompería justo el caso que
 *   ese modelo existe para soportar: un Pro que invita a alguien que no paga.
 *
 *   OJO con el alcance: la exención es de ARCHIVO y este motivo no cubre a todos sus métodos.
 *   `api/split/route.ts` aparece acá porque sus ESCRITURAS (POST/PATCH/PUT/DELETE) son
 *   colaborativas, pero su GET filtra por `creador_id = userId` — el que pide ES el dueño, así
 *   que "host paga" nunca aplicó y el ledger agregado se leía gratis desde el muro (M13,
 *   auditoría 10-ago-2026). Por eso ese GET lleva `requireLectura` y hay un caso abajo que lo
 *   fija: una exención de archivo no puede volverse un permiso para todo lo que viva dentro.
 * · ADMIN / INFRA — su propio gate.
 */
const SIN_MURO = new Set([
  // Escritura
  'api/transactions/route.ts',
  'api/categories/route.ts', // el selector de categorías al anotar a mano
  // Importar escribe transacciones, así que el muro de LECTURA no es su gate: su gate es
  // `excelUpload` (Pro), el mismo flag que aplican las dos puertas de WhatsApp, y la ruta lo
  // comprueba explícitamente devolviendo 403. Con `requireLectura` el resultado coincidía
  // pero la razón era la contraria a la del backend, y el usuario recibía un 402 que decía
  // "no puedes leer" sobre una operación de escritura.
  'api/transactions/import/route.ts',
  // Conversión
  'api/pro/status/route.ts',
  'api/pro/bancos/route.ts',
  'api/pro/gmail-auth-url/route.ts',
  'api/pro/solicitud/route.ts',
  // Alimenta a la pantalla del muro: gatearla dejaría al usuario mirando una pantalla
  // vacía. Solo devuelve el conteo de movimientos y el total del mes — el número que se
  // decidió dejar del lado gratis.
  'api/pro/muro/route.ts',
  'api/user/referrals/route.ts',
  // Identidad y preferencias
  'api/user/route.ts',
  'api/user/tour-visto/route.ts',
  'api/notifications/route.ts',
  'api/whatsapp/unlink/route.ts',
  // Bandeja de entrada
  'api/notifications/inbox/route.ts',
  // Colaborativo (host paga)
  'api/spaces/route.ts',
  'api/spaces/join/route.ts',
  'api/split/route.ts',
  'api/split/invite/route.ts',
  'api/split/join/route.ts',
  'api/debts/invite/route.ts',
  'api/debts/join/route.ts',
  'api/goals/invite/route.ts',
  'api/goals/join/route.ts',
]);

const API_DIR = join(process.cwd(), 'src', 'app', 'api');

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivosTs(full);
    // Los `.test.ts` colocados junto a su ruta mencionan `requireNetoUser` para mockearlo;
    // contarlos como call-sites obligaría a listar tests en una tabla de permisos.
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

const rutas = archivosTs(API_DIR).map((full) => ({
  rel: relative(join(process.cwd(), 'src', 'app'), full).replace(/\\/g, '/'),
  contenido: readFileSync(full, 'utf-8'),
}));

describe('muro de lectura en las rutas de API', () => {
  it('encuentra rutas para revisar (el barrido no puede quedar vacío en silencio)', () => {
    expect(rutas.length).toBeGreaterThan(30);
  });

  it('toda ruta que usa requireNetoUser está declarada como exenta del muro', () => {
    const sinClasificar = rutas
      .filter((r) => !r.rel.startsWith('api/admin/'))
      .filter((r) => USA_REQUIRE_NETO.test(r.contenido))
      .map((r) => r.rel)
      .filter((rel) => !SIN_MURO.has(rel));

    expect(sinClasificar).toEqual([]);
  });

  it('no hay exenciones fantasma (rutas listadas que ya no existen o ya no la usan)', () => {
    const usan = new Set(
      rutas.filter((r) => USA_REQUIRE_NETO.test(r.contenido)).map((r) => r.rel),
    );
    const fantasma = [...SIN_MURO].filter((rel) => !usan.has(rel));
    expect(fantasma).toEqual([]);
  });

  /**
   * Importar salió del muro de lectura y quedó con UN solo gate: su propio chequeo de Pro
   * (`excelUpload` del backend, replicado como `plan !== 'premium'` → 403). Antes tenía dos
   * redes y este archivo cubría una; ahora no cubría ninguna, así que borrar tres líneas
   * dejaba la importación masiva gratis desde la webapp sin que nada se pusiera rojo.
   * Lo señaló el revisor del diff de la ola 4.
   */
  /**
   * El GET de split lee y las demás operaciones escriben, así que el archivo entero no puede
   * estar de un solo lado. Mientras la exención siga siendo por archivo, este caso es lo único
   * que impide que alguien "simplifique" el GET de vuelta a `requireNetoUser` y que el guard
   * lo dé por cubierto: el archivo seguiría en SIN_MURO y los dos tests de arriba, en verde.
   */
  it('la exención de split/ no cubre su GET, que sí exige lectura', () => {
    const ruta = rutas.find((r) => r.rel === 'api/split/route.ts');
    expect(ruta, 'la ruta de split desapareció: revisar esta exención').toBeDefined();
    const get = ruta!.contenido.match(/export async function GET\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(get, 'no se encontró el handler GET de split').not.toBeNull();
    expect(get![0]).toMatch(/\brequireLectura\s*\(/);
    expect(get![0]).not.toMatch(/\brequireNetoUser\s*\(/);
  });

  it('la exención de import/ trae su propio gate de Pro, no queda desnuda', () => {
    const ruta = rutas.find((r) => r.rel === 'api/transactions/import/route.ts');
    expect(ruta, 'la ruta de import desapareció: revisar esta exención').toBeDefined();
    expect(ruta!.contenido).toMatch(/plan\s*!==\s*'premium'/);
    expect(ruta!.contenido).toMatch(/status:\s*403/);
    // Y que el gate esté ANTES de leer el archivo: rechazar después de parsear 5MB paga el
    // trabajo de alguien que no puede importar (mismo criterio que el gate de WhatsApp,
    // que corre antes de descargar el media de Meta).
    expect(ruta!.contenido.indexOf("plan !== 'premium'"))
      .toBeLessThan(ruta!.contenido.indexOf('request.formData()'));
  });

  // Si alguien mueve una de estas a la lista de exentas, el paywall queda decorativo:
  // basta con pegarle a /api/dashboard con la sesión para llevarse todo lo que cobra.
  it('las rutas que devuelven data acumulada exigen derecho de lectura', () => {
    for (const rel of [
      'api/dashboard/route.ts',
      'api/export/route.ts',
      'api/score/route.ts',
      'api/alerts/route.ts',
      'api/budgets/route.ts',
      'api/goals/route.ts',
      'api/debts/route.ts',
      'api/achievements/route.ts',
      'api/categories/usage/route.ts',
      'api/advice/route.ts',
    ]) {
      const ruta = rutas.find((r) => r.rel === rel);
      expect(ruta, `${rel} ya no existe: actualiza este test`).toBeDefined();
      expect(ruta!.contenido, `${rel} debe usar requireLectura`).toMatch(/\brequireLectura\s*\(/);
      expect(USA_REQUIRE_NETO.test(ruta!.contenido), `${rel} no puede usar requireNetoUser`).toBe(false);
    }
  });

  // La promesa que no se negocia.
  it('registrar un gasto desde la webapp NUNCA pasa por el muro', () => {
    const tx = rutas.find((r) => r.rel === 'api/transactions/route.ts')!;
    expect(tx.contenido).not.toMatch(/\brequireLectura\s*\(/);
  });
});

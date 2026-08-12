import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * M19 + M20: `PRO_ONLY_FEATURES` dice ser la fuente única de qué es Pro, y la mitad de sus
 * claves no la consultaba nadie.
 *
 * Los dos síntomas de ese hueco, y son opuestos:
 *
 *  - **M20**: Manos Libres es una feature Pro REAL y se gateaba inline con
 *    `plan === 'premium'` en `api/notifications/route.ts`, sin figurar en la lista. Un gate
 *    inline es un gate que la próxima superficie no hereda.
 *  - **M19**: `gmail_reading` SÍ figuraba, así que `canAccess` respondía **true durante el
 *    trial** — y conectar Gmail exige Pro PAGADO porque cada conexión quema uno de los 100
 *    cupos de Google, que no se recuperan. Tenía cero call-sites; el primero que alguien
 *    escribiera lo habría producido.
 *
 * Este guard exige que cada clave esté USADA o DECLARADA con su gate real y su motivo. La
 * forma es la misma que `merge-and-link-columnas` y `intents-acceso`: una clave nueva sin
 * clasificar rompe el build en vez de quedar como una promesa que nadie cumple.
 */

const SRC = join(process.cwd(), 'src');

/**
 * Claves que NO se consultan con `canAccess` desde la webapp, con dónde vive su gate real.
 * Agregar una acá es una decisión: si tu feature se muestra u oculta en la webapp, se
 * consulta con `canAccess` y no pertenece a esta lista.
 */
const GATEADAS_EN_OTRO_LADO: Record<string, string> = {
  heatmap:
    'el heatmap del dashboard lo arma el backend: `PLAN_CONFIG.free.heatmap` en ' +
    'lib/constants.js decide si los datos siquiera llegan.',
  daily_summary:
    'lo empuja un cron (`cron/checks.js`), no una pantalla. Su gate es el de plan del cron, ' +
    'fijado por `tests/cron/lecturas-proactivas.test.js`.',
  daily_reminder:
    'igual que daily_summary: cron de las 8pm, gate de plan del cron.',
  metas_viability:
    'la calcula el intent `viabilidad_plan` por WhatsApp (`handlers/intents/metas.js`); ' +
    'su gate es `checkProWall`. La webapp no tiene esa pantalla todavía.',
  metas_cuts:
    'igual que metas_viability: intent `sugerir_recortes`, gate `checkProWall`.',
};

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return archivos(full);
    return /\.(ts|tsx)$/.test(full) && !/\.test\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

function clavesDeProOnly(): string[] {
  const src = readFileSync(join(SRC, 'lib', 'plan.ts'), 'utf8');
  const i = src.indexOf('const PRO_ONLY_FEATURES');
  const bloque = src.slice(i, src.indexOf('];', i));
  return [...bloque.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
}

describe('M19/M20 — toda feature Pro está usada o declarada', () => {
  const claves = clavesDeProOnly();
  const fuentes = archivos(SRC)
    .filter((f) => relative(SRC, f).replace(/\\/g, '/') !== 'lib/plan.ts')
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it('la lista se pudo leer (si esto falla, el resto es verde por vacuidad)', () => {
    expect(claves.length).toBeGreaterThan(15);
    expect(claves).toContain('reports_pdf');
  });

  it('cada clave tiene un canAccess o está declarada con su gate real', () => {
    const huerfanas = claves.filter(
      (c) => !new RegExp(`canAccess\\([^)]*'${c}'`).test(fuentes) && !(c in GATEADAS_EN_OTRO_LADO)
    );
    expect(huerfanas).toEqual([]);
  });

  it('las declaraciones siguen siendo de claves que existen', () => {
    // Una declaración sobre una clave borrada es ruido que sobrevive a su motivo, que es
    // exactamente lo que este guard existe para no repetir.
    const fantasma = Object.keys(GATEADAS_EN_OTRO_LADO).filter((c) => !claves.includes(c));
    expect(fantasma).toEqual([]);
  });

  it('cada declaración trae un motivo, no solo el nombre', () => {
    for (const [clave, motivo] of Object.entries(GATEADAS_EN_OTRO_LADO)) {
      expect(motivo.length, `${clave} sin motivo`).toBeGreaterThan(40);
    }
  });

  it('gmail_reading NO está en la lista: exige Pro PAGADO, no Pro', () => {
    // Durante el trial `plan` vale 'premium', así que `canAccess` diría true — y cada
    // conexión de Gmail quema un cupo de Google irrecuperable. El gate real es
    // `esProPagado` en el backend. Fuera del enum ni siquiera compila.
    expect(claves).not.toContain('gmail_reading');
    expect(readFileSync(join(SRC, 'lib', 'plan.ts'), 'utf8')).not.toMatch(/\|\s*'gmail_reading'/);
  });

  it('manos_libres SÍ está, y no se gatea a mano', () => {
    expect(claves).toContain('manos_libres');
    const notif = readFileSync(join(SRC, 'app', 'api', 'notifications', 'route.ts'), 'utf8');
    expect(notif).toMatch(/canAccess\([^)]*'manos_libres'/);
    // El gate inline que había: `usuario.plan === 'premium'` decidiendo la escritura.
    expect(notif).not.toMatch(/if \(usuario\.plan === 'premium'\)/);
  });
});

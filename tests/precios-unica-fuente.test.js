import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * El precio de Pro se escribe UNA vez, en `PRO_PRECIOS` (lib/config.js).
 *
 * Registrado en la ola 3 y cerrado en la ola 4 de la auditoría CTO. El ledger listaba tres
 * sitios con "S/10/mes o S/99/año" a mano; el barrido real encontró **quince**, en ocho
 * archivos, incluidos dos crons y el paso 2 del onboarding. Un cambio de precio obligaba a
 * un barrido manual, y los archivos que se olvidan son siempre los intents menos
 * transitados — o sea los que nadie revisa después, cotizando el precio viejo a gente real.
 *
 * Este guard es lo único que impide que vuelvan a aparecer: el copy se toca todo el tiempo y
 * escribir "S/10" es más cómodo que importar una función.
 */

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

// La WEBAPP entra al barrido a propósito. La primera versión solo miraba el backend, y el
// revisor del diff lo marcó: los precios seguían escritos a mano en `upgrade-prompt`,
// `pro-gate`, la tarjeta de Configuración y el panel admin — o sea justo en las pantallas
// donde el usuario decide pagar, que son las que más caro salen si quedan desactualizadas.
const DIRS = ['handlers', 'lib', 'services', 'routes', 'cron', 'webapp/src'];
// Las dos fuentes: ahí los números TIENEN que estar escritos.
const EXENTOS = new Set(['lib/config.js', 'webapp/src/lib/constants.ts']);

function archivosCodigo(dir) {
  const out = [];
  const abs = path.join(projectRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...archivosCodigo(path.join(dir, e.name)));
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx|js)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const ARCHIVOS = DIRS.flatMap(archivosCodigo)
  .map(p => p.replace(/\\/g, '/'))
  .filter(p => !EXENTOS.has(p));

/** Quita comentarios de línea y de bloque: explicar el precio en prosa no es cotizarlo. */
function soloCodigo(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}

// El precio de lista de hoy. Si cambia, cambia acá Y en lib/config.js — y este test es el
// que obliga a que el resto del código no tenga nada que cambiar.
const PRECIOS_LITERALES = [/S\/10\b/, /S\/99\b/];

describe('el precio de Pro no se escribe a mano', () => {
  it('el barrido alcanza el runtime de verdad, backend Y webapp', () => {
    expect(ARCHIVOS.length).toBeGreaterThan(40);
    expect(ARCHIVOS).toContain('handlers/webhook.js');
    expect(ARCHIVOS).toContain('cron/checks.js');
    expect(ARCHIVOS).toContain('handlers/onboarding.js');
    // Las cuatro superficies de la webapp que el revisor encontró fuera del barrido.
    expect(ARCHIVOS).toContain('webapp/src/components/shared/upgrade-prompt.tsx');
    expect(ARCHIVOS).toContain('webapp/src/components/shared/pro-gate.tsx');
    expect(ARCHIVOS).toContain('webapp/src/app/dashboard/configuracion/page.tsx');
    expect(ARCHIVOS).toContain('webapp/src/app/admin/operacion/page.tsx');
  });

  it.each(PRECIOS_LITERALES.map(r => [r.source, r]))('ningún archivo de runtime contiene %s', (_src, rx) => {
    const culpables = ARCHIVOS.filter(rel => rx.test(soloCodigo(fs.readFileSync(path.join(projectRoot, rel), 'utf8'))));
    expect(culpables, 'escriben el precio a mano: ' + culpables.join(', ')).toEqual([]);
  });

  // Contraprueba: el regex tiene que ENCONTRAR el precio cuando de verdad está escrito. Sin
  // esto, un `soloCodigo` que devolviera cadena vacía dejaría el guard verde para siempre.
  it('el regex detecta un precio escrito a mano (contraprueba)', () => {
    const falso = "return 'Pro cuesta S/10 al mes';";
    expect(PRECIOS_LITERALES[0].test(soloCodigo(falso))).toBe(true);
    // …y no confunde otros montos que sí van a mano (validaciones, ejemplos de gasto).
    expect(PRECIOS_LITERALES[0].test(soloCodigo("'entre S/0.01 y S/999,999.99'"))).toBe(false);
    expect(PRECIOS_LITERALES[1].test(soloCodigo("'gasté S/990 en el mercado'"))).toBe(false);
  });

  it('lineaPrecioPro sale de PRO_PRECIOS y no de un literal', async () => {
    const { lineaPrecioPro, PRO_PRECIOS } = await import('../lib/config.js');
    expect(lineaPrecioPro()).toContain('S/' + PRO_PRECIOS.mensual + '/mes');
    expect(lineaPrecioPro()).toContain('S/' + PRO_PRECIOS.anual + '/año');
  });

  // Backend y webapp son procesos distintos con su propia constante; nada las obliga a
  // coincidir salvo esto. Que diverjan significa cotizarle un precio por WhatsApp y otro
  // en la pantalla de pago, a la misma persona el mismo día.
  it('el precio del backend y el de la webapp son el MISMO número', () => {
    const cfg = fs.readFileSync(path.join(projectRoot, 'lib/config.js'), 'utf8');
    const cts = fs.readFileSync(path.join(projectRoot, 'webapp/src/lib/constants.ts'), 'utf8');
    const num = (src, rx) => { const m = src.match(rx); return m ? Number(m[1]) : null; };
    const backMensual = num(cfg, /mensual:\s*(\d+)/);
    const backAnual = num(cfg, /anual:\s*(\d+)/);
    const webMensual = num(cts, /PRO_PRICE_MONTHLY_PEN\s*=\s*(\d+)/);
    const webAnual = num(cts, /PRO_PRICE_YEARLY_PEN\s*=\s*(\d+)/);
    expect([backMensual, backAnual, webMensual, webAnual].every(n => typeof n === 'number')).toBe(true);
    expect(webMensual).toBe(backMensual);
    expect(webAnual).toBe(backAnual);
  });
});

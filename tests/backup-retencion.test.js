/**
 * Quién borra los backups viejos, y con qué piso.
 *
 * `backup-prune.test.js` prueba que `prune()` respeta el piso de 7. Lo que NO
 * probaba —y por eso este archivo existe— es que `prune()` sea el mecanismo que
 * de verdad corre. Un test verde sobre una función que nadie invoca es el modo
 * de falla más caro que tiene una suite: da confianza sin dar cobertura.
 *
 * Y había un segundo mecanismo compitiendo. `r2.mjs` exponía `set-lifecycle`,
 * que le pide a Cloudflare que expire `daily/` a los 30 días **server-side**.
 * Una regla de lifecycle de S3 no sabe contar: borra por antigüedad y punto, no
 * existe forma de expresarle "pero nunca dejes menos de 7". O sea que correr ese
 * comando una sola vez desactiva el piso para siempre, en silencio, y justo en
 * el escenario para el que el piso existe: si el workflow se rompe y pasan 30
 * días sin subir nada, el lifecycle vacía el bucket mientras el `prune` —que sí
 * habría frenado— ya no llega a opinar porque el workflow no corre.
 *
 * El docstring de `setLifecycle` decía exactamente lo contrario ("para que la
 * retención siga siendo correcta aunque el workflow se rompa"). Es el peor tipo
 * de comentario: describe la intención y esconde el efecto.
 *
 * Así que el invariante es doble y este guard lo fija por los dos lados:
 *   1. `backup.sh` invoca `r2.mjs prune` (el mecanismo con piso está enchufado).
 *   2. `r2.mjs` no ofrece ninguna forma de fijar expiración server-side.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const SH = readFileSync(join(RAIZ, 'scripts', 'backup', 'backup.sh'), 'utf8');
const R2 = readFileSync(join(RAIZ, 'scripts', 'backup', 'r2.mjs'), 'utf8');

// Las mismas expresiones que se usan abajo, para poder probarlas contra un
// fixture roto. Un regex que no matchea nada da un test verde por vacuidad.
const RE_PRUNE_INVOCADO = /r2\.mjs["']?\s+prune/;
const RE_LIFECYCLE_ESCRITURA = /set-lifecycle|setLifecycle|<Expiration>/;
/** El último argumento de `prune(prefijo, dias, piso)`. */
const RE_PISO = (n) => new RegExp(`,\\s*${n}\\s*\\)`);

describe('retención de backups: el piso está enchufado', () => {
  it('backup.sh invoca el prune (si no, nada borra y nada frena)', () => {
    expect(RE_PRUNE_INVOCADO.test(SH), 'backup.sh dejó de llamar a `r2.mjs prune`').toBe(true);
  });

  it('el prune corre con piso en los DOS prefijos', () => {
    // Los pisos viven en la rama CLI de r2.mjs, que es la que usa backup.sh.
    // Se busca por línea y no con un regex que atraviese la llamada entera: el
    // `Number(process.env...)` del medio lleva paréntesis y hace que cualquier
    // patrón "hasta el cierre" sea un acertijo en vez de un guard.
    const lineas = R2.split('\n');
    const daily = lineas.find((l) => l.includes("prune('daily/'"));
    const monthly = lineas.find((l) => l.includes("prune('monthly/'"));
    expect(daily, 'desapareció la llamada a prune de daily/').toBeDefined();
    expect(monthly, 'desapareció la llamada a prune de monthly/').toBeDefined();
    expect(daily, 'daily/ perdió su piso de 7').toMatch(RE_PISO(7));
    expect(monthly, 'monthly/ perdió su piso de 3').toMatch(RE_PISO(3));
  });

  it('nadie puede fijar expiración server-side desde este repo', () => {
    // Una regla de lifecycle ignora el piso por construcción. Si alguna vez hace
    // falta, tiene que ser una decisión explícita fuera del repo, no un comando
    // que quedó a mano en el CLI del backup.
    expect(RE_LIFECYCLE_ESCRITURA.test(R2),
      'r2.mjs volvió a exponer una forma de expirar objetos server-side, que anula el piso de 7').toBe(false);
  });
});

describe('retención de backups: el guard detecta la regresión', () => {
  // Contraprueba. Sin esto, los tres tests de arriba podrían estar verdes porque
  // los regex no matchean nada, no porque el código esté bien.
  it('los patrones reconocen una versión rota', () => {
    expect(RE_PRUNE_INVOCADO.test('echo "sin retencion"\nexit 0\n')).toBe(false);
    expect(RE_PRUNE_INVOCADO.test('node "${AQUI}/r2.mjs" prune | tee x.txt')).toBe(true);

    expect(RE_LIFECYCLE_ESCRITURA.test("} else if (cmd === 'set-lifecycle') {")).toBe(true);
    expect(RE_LIFECYCLE_ESCRITURA.test('<Rule><Expiration><Days>30</Days></Expiration></Rule>')).toBe(true);
    expect(RE_LIFECYCLE_ESCRITURA.test('export async function prune(prefix, dias, pisoMinimo) {}')).toBe(false);

    // Y el piso: un prune al que le sacan el tercer argumento no matchea.
    expect(RE_PISO(7).test("const d = await prune('daily/', 30, 7);")).toBe(true);
    expect(RE_PISO(7).test("const d = await prune('daily/', 30);")).toBe(false);
    expect(RE_PISO(3).test("const m = await prune('monthly/', Number(x || 365), 3);")).toBe(true);
  });
});

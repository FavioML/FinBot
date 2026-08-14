import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * F4: un fetch que falla no es "no tienes nada".
 *
 * El patrón que este guard vigila es `const { data: x = [] } = useAlgo()`. Con el default
 * puesto y sin mirar `isError`, una caída de red renderiza exactamente el mismo empty state
 * que ve un usuario recién creado — y en un producto de finanzas eso se lee como "perdí mis
 * datos", sin siquiera un botón para reintentar. Estaba en SEIS páginas a la vez, así que
 * no era un descuido: era el default de cómo se escribía una página nueva.
 *
 * Este test existe para que la séptima no nazca igual. Toda página del dashboard que
 * fetchee data tiene que MANEJAR el fallo, y la forma canónica es `<ErrorState>`
 * (`components/shared/error-state.tsx`), que además unificó las cuatro copias que el fix
 * correcto ya tenía regadas por el árbol.
 *
 * ── Lo que este guard NO puede ver ──────────────────────────────────────────────────
 * Es un barrido de texto: comprueba que la página NOMBRE `isError`, no que ramifique bien
 * ni que la condición sea la correcta (`isError && data.length === 0`, para no tapar una
 * lista cacheada). Eso lo tiene que mirar quien revisa el diff. Lo que sí decide sin
 * ambigüedad —y es el modo de falla real que se vio seis veces— es la AUSENCIA total.
 *
 * ── Por qué también mira /admin (F8, 2026-08-14) ────────────────────────────────────
 * El mismo patrón estaba vivo en `/admin/operacion`: cuatro queries colapsadas a `?? []`
 * y `?? 0`, así que una caída de la API imprimía `S/—` de MRR y *"No hay errores NLP
 * registrados aun"*. El guard cubría `dashboard/` nada más, o sea que el panel de admin
 * era exactamente el sitio donde la clase podía repetirse sin que nada chillara.
 *
 * `/admin` acepta DOS formas de nombrar el fallo, y no es laxitud: `costs` y `economics`
 * ya lo manejaban con el `error` que devuelve React Query en vez de `isError`, y un guard
 * que se queja del código que ya está bien se termina desactivando. Lo que se exige es que
 * la señal venga de un HOOK (`{ ..., error } = useAlgo()`), no de un `useState` local —
 * que en estas páginas abunda para los errores de formulario y no dice nada del fetch.
 */

const DASHBOARD = path.resolve(__dirname);
const ADMIN = path.resolve(__dirname, '../admin');

// Páginas que fetchean pero no necesitan estado de error propio, cada una con su motivo.
// Agregar una entrada acá es una decisión, no un trámite: si tu página muestra una lista
// del usuario, no pertenece a esta lista.
const EXENTAS: Record<string, string> = {
  'configuracion/page.tsx':
    'no lista data del usuario: es un formulario de preferencias sobre `useUser`, que el ' +
    'shell ya gatea. Un fallo deja los toggles en su valor por defecto, no un vacío que ' +
    'se lea como pérdida.',
};

function paginas(dir: string, rel = ''): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(dir)) {
    const abs = path.join(dir, e);
    if (statSync(abs).isDirectory()) salida.push(...paginas(abs, path.join(rel, e)));
    else if (e === 'page.tsx') salida.push(path.join(rel, e));
  }
  return salida;
}

describe('F4 — toda página del dashboard que fetchea maneja el fallo', () => {
  const todas = paginas(DASHBOARD).map((p) => p.split(path.sep).join('/'));

  it('el barrido encuentra las páginas (si esto falla, el resto es verde por vacuidad)', () => {
    expect(todas.length).toBeGreaterThanOrEqual(10);
    expect(todas).toContain('page.tsx');
    expect(todas).toContain('transacciones/page.tsx');
  });

  it('las exentas siguen existiendo (una exención sobre un archivo borrado es ruido)', () => {
    for (const f of Object.keys(EXENTAS)) expect(todas).toContain(f);
  });

  it('ninguna página fetchea sin manejar isError', () => {
    const sinManejo = todas.filter((rel) => {
      if (rel in EXENTAS) return false;
      const src = readFileSync(path.join(DASHBOARD, rel), 'utf8');
      const fetchea = /from '@\/lib\/hooks\//.test(src);
      return fetchea && !/\bisError\b/.test(src);
    });
    expect(sinManejo).toEqual([]);
  });

  it('el patrón sí detecta el caso malo (guard no vacuo)', () => {
    const malo = "import { useGoals } from '@/lib/hooks/use-goals';\nconst { data = [] } = useGoals();";
    expect(/from '@\/lib\/hooks\//.test(malo) && !/\bisError\b/.test(malo)).toBe(true);
  });

  it('el componente compartido existe y no se volvió a copiar a mano', () => {
    const comp = path.resolve(DASHBOARD, '../../components/shared/error-state.tsx');
    expect(readFileSync(comp, 'utf8')).toContain('export function ErrorState');

    // Lo que se busca es el BOTÓN de reintentar escrito a mano, no la frase del copy: la
    // frase puede aparecer legítimamente como `descripcion` de `<ErrorState>` (alertas la
    // personaliza a propósito), mientras que un `<button>Reintentar</button>` propio solo
    // puede significar que alguien volvió a pegar el bloque en vez de importarlo.
    //
    // La primera versión buscaba la frase y por eso marcó a `alertas` DESPUÉS de migrarla:
    // un guard que se queja del uso correcto se termina desactivando.
    //
    // `pro/page.tsx` queda fuera a propósito: su tarjeta lleva una descripción condicional
    // y un enlace de texto dentro de un header propio, o sea que no es una copia de esto.
    const BOTON_A_MANO = /<button[^>]*>[\s\S]{0,120}?Reintentar/;
    expect(BOTON_A_MANO.test('<button onClick={x} className="y">\n  Reintentar\n</button>')).toBe(true);

    // La exención de `pro/page.tsx` es del DASHBOARD, y por eso se escribe con su área
    // pegada: aplicada al mapa combinado, un futuro `admin/pro/page.tsx` la heredaría en
    // silencio sin que nadie hubiera decidido nada.
    const copias = [
      ...paginas(DASHBOARD).map((p) => ({ dir: DASHBOARD, area: 'dashboard', rel: p })),
      ...paginas(ADMIN).map((p) => ({ dir: ADMIN, area: 'admin', rel: p })),
    ]
      .map((e) => ({ ...e, rel: e.rel.split(path.sep).join('/') }))
      .filter((e) => !(e.area === 'dashboard' && e.rel === 'pro/page.tsx'))
      .filter((e) => BOTON_A_MANO.test(readFileSync(path.join(e.dir, e.rel), 'utf8')))
      .map((e) => `${e.area}/${e.rel}`);
    expect(copias).toEqual([]);
  });
});

/**
 * F8 — la misma clase, en el panel de admin.
 *
 * Señal aceptada: `isError`, o `error` sacado de la desestructuración de un hook. NO vale
 * un `useState` de error (esas páginas lo usan para los formularios y no habla del fetch).
 */
const SENAL_DE_FALLO = (src: string) =>
  /\bisError\b/.test(src) || /\{[^{}]*\berror\b[^{}]*\}\s*=\s*use[A-Z]\w*\(/.test(src);

describe('F8 — toda página de /admin que fetchea maneja el fallo', () => {
  const todas = paginas(ADMIN).map((p) => p.split(path.sep).join('/'));

  it('el barrido encuentra las páginas (si esto falla, el resto es verde por vacuidad)', () => {
    expect(todas.length).toBeGreaterThanOrEqual(6);
    expect(todas).toContain('operacion/page.tsx');
    expect(todas).toContain('economics/page.tsx');
  });

  it('ninguna página de admin fetchea sin nombrar el fallo', () => {
    const sinManejo = todas.filter((rel) => {
      const src = readFileSync(path.join(ADMIN, rel), 'utf8');
      return /from '@\/lib\/hooks\//.test(src) && !SENAL_DE_FALLO(src);
    });
    expect(sinManejo).toEqual([]);
  });

  it('el detector distingue el `error` de un hook del de un useState (guard no vacuo)', () => {
    const malo = "import { useAdminStats } from '@/lib/hooks/use-admin-operacion';\nconst { data } = useAdminStats();";
    expect(SENAL_DE_FALLO(malo)).toBe(false);

    // El modo de falla que se vio en costs/economics: `error` del hook, sin `isError`.
    expect(SENAL_DE_FALLO('const { data, isLoading, error } = useAdminCosts();')).toBe(true);

    // Y el falso positivo que haría inútil al guard: un error de formulario en estado local
    // NO cuenta como manejo del fetch.
    expect(SENAL_DE_FALLO("const [error, setError] = useState<string | null>(null);")).toBe(false);
  });

  it('operacion nombra el fallo de sus CUATRO queries, no de una', () => {
    // El hallazgo era exactamente que las cuatro colapsaban a `?? []` / `?? 0`. Un solo
    // `isError` en el archivo alcanzaría para el barrido de arriba y dejaría tres mudas.
    const src = readFileSync(path.join(ADMIN, 'operacion/page.tsx'), 'utf8');
    for (const q of ['usersQuery', 'statsQuery', 'nlpQuery', 'ticketsQuery']) {
      expect(src, `${q} no consulta isError`).toMatch(new RegExp(`${q}\\.isError\\b`));
    }
    expect((src.match(/<ErrorState/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

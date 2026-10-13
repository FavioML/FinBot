import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Texto de color BASE sobre un fondo teñido o elevado: en claro no llega a 4.5:1.
 *
 * POR QUÉ EXISTE (12-oct-2026)
 *
 * `text-warning` sobre `bg-warning/12` da 3.3-4.4:1 en claro, y `text-primary` o `text-negative`
 * sobre `surface-elevated` (o `muted`, `secondary`, `.glass-card-elevated`) 4.2-4.4:1. Para eso
 * existen los `-ink` (`text-warning-ink`, `tinta()` en JS). El codemod de la paleta B sólo veía
 * tinte y texto en el MISMO elemento, con clases literales, y dejó 154 sitios: el texto en un hijo,
 * el par dentro de un ternario de template literal y `style={{ color: 'var(--negative)' }}`. El
 * barrido en navegador no los vio porque la cuenta QA está vacía y los diálogos no se abrían.
 *
 * QUÉ MIRA
 *
 * Tres reglas, sobre cada `.ts` y `.tsx` de `src/`:
 *
 * 1. **Un literal que trae tinte y texto juntos** (`'bg-warning/12 text-warning'`), esté donde
 *    esté: en el `className`, en una constante, en un mapa de tonos, en un `cva()`.
 * 2. **El árbol JSX con contexto de fondo.** Un ancestro con tinte o superficie elevada
 *    (`bg-{color}/NN`, `bg-accent`, `bg-surface-elevated`, `bg-muted`, `bg-secondary`, con o sin
 *    `/NN`, `glass-card-elevated`) abre contexto; un fondo sólido (`bg-card`, `glass-card`,
 *    `bg-primary`...) lo cierra. Adentro, `text-{color}` sin `-ink` (con cualquier prefijo de
 *    estado), `text-(--{color})`, `text-[var(--{color})]` y `style={{ color: 'var(--{color})' }}`
 *    son hallazgos. Cuentan los prefijos responsive y los de estado persistente (`data-*`,
 *    `aria-*`), no `dark:`: en oscuro el `-ink` vale casi lo mismo que el base, el problema es
 *    del claro.
 * 3. **Un objeto con fondo y color** (`{ backgroundColor: x, color: 'var(--warning)' }`), sea el
 *    `style` en línea o una constante: si el fondo no es un token sólido, el color va con `-ink`.
 *
 * Política, no medición: adentro de un tinte TODO texto de color va con `-ink`, también un ícono
 * o un número grande que pasarían con 3:1. Así la regla no depende de medir cada caso.
 *
 * LÍMITES DECLARADOS
 *
 * - El fondo y el texto tienen que estar en el mismo archivo Y en el mismo árbol JSX: un
 *   componente (de este u otro archivo) que pinta texto de color y se usa adentro de un tinte no
 *   se ve, ni el tinte que trae por defecto un componente (`<Badge variant="secondary">`,
 *   `TabsTrigger`). Para eso está el barrido en navegador (`products/neto/docs/paleta-neto-capturas.mjs`,
 *   modos `dialogos` y `admin`).
 * - Un color que llega por variable (`style={{ color: c }}`) no se ve: va con `tinta(c)`. Lo mismo un
 *   mapa de tonos (`{ color: 'var(--warning)', bg: conAlfa(...) }`): se aplica en otro lado y es ahí
 *   donde el color tiene que pasar por `tinta()`.
 * - El par partido entre dos variantes de un `cva`, o entre entradas de un mapa grande, no se ve.
 * - Texto SVG pintado con `fill` (`<text fill="var(--positive)">`) no se mira.
 * - Un portal (`TooltipContent`, `PopoverContent`) adentro de un tinte se cuenta como teñido
 *   aunque renderice afuera. Falso positivo aceptado: el `-ink` sobre una superficie normal
 *   también pasa.
 *
 * SI ESTE TEST TE FRENA: usa el `-ink` (`text-primary-ink`, `var(--primary-ink)`, `tinta()`).
 */

const SRC = join(process.cwd(), 'src');
const COL = '(?:primary|positive|negative|destructive|warning|accent-pro|info)';
// Prefijos que dejan el fondo puesto en claro: responsive y estado persistente. `dark:` no.
const PRE = String.raw`(?:(?:sm|md|lg|xl|2xl|data-\[[^\]]+\]|data-[a-z-]+|aria-\[[^\]]+\]|aria-[a-z-]+|group-data-\[[^\]]+\]):)*`;
const TINTE = new RegExp(String.raw`(?:^|\s)${PRE}(?:bg-(?:${COL}\/(?:\d+|\[[^\]]+\])|accent|surface-elevated|muted|secondary)(?:\/(?:\d+|\[[^\]]+\]))?|from-${COL}\/(?:\d+|\[[^\]]+\])|glass-card-elevated)(?=\s|$)`);
const SOLIDO = new RegExp(String.raw`(?:^|\s)(?:glass-card|bg-(?:card|background|popover|nav|sidebar|${COL.slice(3, -1)}|hero-[a-z]+))(?=\s|$)`);
const TEXTO = new RegExp(String.raw`(?<![\w-])(?:[a-z0-9-]+:|[a-z-]+-\[[^\]]+\]:)*text-(?:${COL}|\(--(?:color-)?${COL}\)|\[var\(--(?:color-)?${COL}\)\])(?![\w-])`, 'g');
const VAR_BASE = new RegExp(String.raw`var\(--(?:color-)?${COL}\)`, 'g');
// Fondos que no tiñen: un token sólido, o ningún fondo (`none`, `transparent`, `inherit`).
const FONDO_SOLIDO = new RegExp(String.raw`^['"\`]?(?:var\(--(?:color-)?(?:card|background|popover|nav|sidebar|${COL.slice(3, -1)}|hero-[a-z]+)\)|none|transparent|inherit)['"\`]?$`);
const PROPS_FONDO = ['backgroundColor', 'background'];
const AGRUPA = /^(?:cn|clsx|cx|cva|twMerge|classNames)$/;

function literales(n: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const g = (x: ts.Node) => {
    if (ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) out.push(x);
    x.forEachChild(g);
  };
  g(n);
  return out;
}
const texto = (n: ts.Node) => (n as ts.LiteralLikeNode).text;

const atributo = (attrs: ts.JsxAttributes, nombre: string) =>
  attrs.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === nombre);

// Atajo sobre el texto crudo: sin un tinte ni un color base, ninguna regla encuentra nada y no hace
// falta parsear. Sin esto el guard parseaba los ~200 archivos y la suite completa empujaba a otro
// test a su timeout de 5 s (medido el 13-oct-2026).
const CANDIDATO = new RegExp(String.raw`bg-(?:${COL}\/|accent|surface-elevated|muted|secondary)|glass-card-elevated|from-${COL}\/|var\(--(?:color-)?${COL}\)`);

export function hallazgos(rel: string, src: string): string[] {
  if (!CANDIDATO.test(src)) return [];
  const kind =rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind);
  const vistos = new Set<string>();
  const out: string[] = [];
  const linea = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const anotar = (n: ts.Node, que: string) => {
    const k = `${rel}:${linea(n)} — ${que}`;
    if (!vistos.has(k)) { vistos.add(k); out.push(k); }
  };
  const textosBase = (n: ts.Node) => { for (const m of texto(n).matchAll(TEXTO)) anotar(n, m[0]); };
  const colorBase = (n: ts.Node) => { for (const m of n.getText(sf).matchAll(VAR_BASE)) anotar(n, `style ${m[0]}`); };

  const visitar = (node: ts.Node, enTinte: boolean) => {
    let tinte = enTinte;
    // Regla 1: tinte y texto en el mismo literal, en cualquier parte del archivo.
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (TINTE.test(texto(node))) textosBase(node);
    }
    // Regla 1b: el par partido entre literales de UNA misma expresión de clases: `cn(tinte, texto)`,
    // `cva(base, { variants })`, una plantilla, un objeto `{ fondo: …, texto: … }`.
    // En `cva` sólo cuenta el tinte de la BASE: dos variantes nunca se aplican juntas. Un objeto se
    // combina sólo si es chico (la forma `{ fondo, texto }`), no un mapa de variantes.
    const esCva = ts.isCallExpression(node) && node.expression.getText(sf) === 'cva';
    const agrupa = (ts.isCallExpression(node) && AGRUPA.test(node.expression.getText(sf))) || ts.isTemplateExpression(node)
      || (ts.isObjectLiteralExpression(node) && node.properties.length <= 3 && !node.properties.some((p) => ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)));
    if (agrupa) {
      const lits = literales(node);
      const base = esCva ? literales((node as ts.CallExpression).arguments[0] ?? node) : lits;
      if (base.some((l) => TINTE.test(texto(l)))) lits.forEach(textosBase);
    }
    // Regla 3: un objeto con fondo que no sea sólido y color base, sea `style` en línea o una
    // constante. El fondo puede venir abreviado (`{ backgroundColor, color }`) o con otro nombre.
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, ts.Node>();
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.getText(sf), p.name);
      }
      const color = props.get('color');
      const fondo = PROPS_FONDO.map((k) => props.get(k)).find(Boolean);
      if (color && fondo && !FONDO_SOLIDO.test(fondo.getText(sf).trim())) colorBase(color);
    }
    // Regla 2: el contexto de fondo del árbol JSX.
    const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : ts.isJsxSelfClosingElement(node) ? node.attributes : null;
    if (attrs) {
      const cls = atributo(attrs, 'className')?.initializer;
      if (cls) {
        const lits = literales(cls);
        // Un ternario puede traer el tinte en una rama: si ALGÚN literal tiñe, el elemento cuenta.
        if (lits.some((l) => TINTE.test(texto(l)))) tinte = true;
        else if (lits.some((l) => SOLIDO.test(texto(l)))) tinte = false;
        if (tinte) lits.forEach(textosBase);
      }
      const estilo = atributo(attrs, 'style')?.initializer;
      const obj = estilo && ts.isJsxExpression(estilo) ? estilo.expression : undefined;
      if (tinte && obj && ts.isObjectLiteralExpression(obj)) {
        const color = obj.properties.filter(ts.isPropertyAssignment).find((p) => p.name.getText(sf) === 'color');
        if (color) colorBase(color.initializer);
      }
    }
    node.forEachChild((c) => visitar(c, tinte));
  };
  visitar(sf, false);
  return out;
}

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return archivos(p);
    return /\.tsx?$/.test(n) && !/\.(test|d)\.ts$/.test(n) ? [p] : [];
  });
}

const rel = (p: string) => relative(SRC, p).split('\\').join('/');

describe('texto de color sobre tinte o superficie elevada', () => {
  it('el barrido ve el árbol entero (antivacuidad)', () => {
    const rels = archivos(SRC).map(rel);
    expect(rels.length).toBeGreaterThan(120);
    expect(rels).toEqual(expect.arrayContaining(['components/dashboard/global-search.tsx', 'app/admin/operacion/page.tsx', 'app/dashboard/planes/page.tsx']));
  });

  it('ningún .tsx de src/ pone texto de color base sobre un tinte', () => {
    const todos = archivos(SRC).flatMap((p) => hallazgos(rel(p), readFileSync(p, 'utf8')));
    expect(todos, `Texto de color base sobre tinte o superficie elevada (usa el -ink):\n${todos.join('\n')}`).toEqual([]);
  }, 30_000);

  it('detecta las formas que dejó el codemod', () => {
    const casos = [
      '<div className="bg-warning/10"><p className="text-warning">x</p></div>',
      '<div className="rounded bg-primary/8"><span><b className="font-bold text-primary">x</b></span></div>',
      '<div className={`px-2 ${ok ? "bg-primary/8 text-primary" : "bg-warning/8 text-warning"}`}>x</div>',
      '<DialogContent className="glass-card-elevated"><span className="text-negative">S/ 3</span></DialogContent>',
      '<div className="bg-surface-elevated"><a className="text-primary hover:underline">x</a></div>',
      '<div className="bg-muted"><button className="text-muted-foreground hover:text-destructive">x</button></div>',
      '<div className="bg-secondary"><TxMonto style={{ color: tx.ok ? "var(--positive)" : "var(--negative)" }} /></div>',
      "<span style={{ backgroundColor: conAlfa(c, 12), color: 'var(--warning)' }}>x</span>",
      '<div className="md:bg-info/10"><p className="text-info">x</p></div>',
      // Evasiones de la revisión adversarial del 12-oct-2026:
      "const CHIP = 'bg-warning/12 text-warning'; const C = () => <span className={CHIP}>x</span>;",
      "const TONO = { alerta: 'bg-warning/12 text-warning' }; const C = ({ t }) => <span className={cn('px-2', TONO[t])}>x</span>;",
      "const chip = cva('rounded', { variants: { tono: { warning: 'bg-warning/12 text-warning' } } });",
      '<div className="bg-muted/50"><p className="text-primary">x</p></div>',
      '<div className="bg-warning/12"><p className="text-(--warning)">x</p><p className="text-[var(--negative)]">y</p></div>',
      '<div className="data-[active=true]:bg-primary/10 data-[active=true]:text-primary">x</div>',
      "const est = { backgroundColor: 'color-mix(in srgb, var(--warning) 10%, transparent)', color: 'var(--warning)' }; const C = () => <span style={est}>x</span>;",
      "const fondo = conAlfa(c, 12); const C = () => <span style={{ backgroundColor: fondo, color: 'var(--primary)' }}>x</span>;",
      "<div className=\"bg-warning/12\"><span style={{ color: 'var(--color-warning)' }}>x</span></div>",
      "<span style={{ background: 'var(--surface-elevated)', color: 'var(--primary)' }}>x</span>",
      // Segunda vuelta:
      "const chip = cva('rounded bg-warning/12', { variants: { e: { si: 'text-warning' } } });",
      "const CLS = cn('bg-warning/12 px-2', 'text-warning');",
      "const s = { fondo: 'bg-warning/12', texto: 'text-warning' };",
      "const c = `bg-primary/10 ${x} text-primary`;",
      "const C = ({ backgroundColor }) => <span style={{ backgroundColor, color: 'var(--primary)' }}>x</span>;",
      '<div className="bg-muted"><div className="md:bg-card"><p className="text-primary">x</p></div></div>',
      '<div className="bg-muted/[0.6]"><p className="text-primary">x</p></div>',
      '<div className="bg-linear-to-r from-warning/15 to-warning/5"><p className="text-warning">x</p></div>',
    ];
    for (const c of casos) expect(hallazgos('x.tsx', c), c).not.toEqual([]);
  });

  it('no confunde lo que está bien', () => {
    const casos = [
      '<div className="bg-warning/10"><p className="text-warning-ink">x</p></div>',
      '<div className="bg-warning/10"><div className="bg-card"><p className="text-warning">x</p></div></div>',
      '<div className="glass-card"><p className="text-negative">x</p></div>',
      '<div className="hover:bg-negative/10"><p className="text-negative">x</p></div>',
      '<div className="bg-primary text-primary-foreground">x</div>',
      "<span style={{ backgroundColor: conAlfa(c, 12), color: tinta(c) }}>x</span>",
      "<span style={{ color: 'var(--negative)' }}>x</span>",
      '<div className="bg-muted"><p className="text-foreground">x</p></div>',
      '<div className="bg-card dark:bg-muted"><p className="text-primary">x</p></div>',
      "<span style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>x</span>",
      "const CHIP = 'bg-warning/12 text-warning-ink';",
      "<span style={{ background: 'none', color: 'var(--primary)' }}>x</span>",
      "<span style={{ backgroundColor: 'var(--color-card)', color: 'var(--primary)' }}>x</span>",
    ];
    for (const c of casos) expect(hallazgos('x.tsx', c), c).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Todo link a `/dashboard/<x>` que el backend le manda a una persona tiene que caer en una página
 * que EXISTE en la webapp.
 *
 * Por qué existe (11-oct-2026): el bot mandaba `https://app.neto.pe/dashboard/metas` en cuatro
 * mensajes (lista de metas, meta creada, abono, metas homónimas) y esa ruta nunca existió: la
 * página de metas vive en `webapp/src/app/dashboard/planes`. Quien tocaba el link caía en un 404.
 * Ningún test lo veía porque el backend y la webapp están en el mismo repo pero ningún archivo
 * los cruzaba.
 *
 * Qué cuenta como página: la carpeta `webapp/src/app/dashboard/<x>/` CON su `page.tsx`. Una
 * carpeta sin página también es un 404, y un redirect de `next.config.ts` no alcanza: existe para
 * los mensajes YA enviados, no para que un mensaje nuevo dependa de él.
 *
 * Qué se mira: las cadenas que empiezan con `/dashboard/` (`WEBAPP_URL + '/dashboard/x'`, el
 * `link:` de la campana) y las URLs completas `app.neto.pe/dashboard/x`, en todo el runtime menos
 * lo excluido abajo. Barrido de lista NEGRA a propósito, igual que `railway.json`: una carpeta de
 * runtime nueva entra sola.
 *
 * Lo que NO ve, declarado: una ruta armada en tiempo de ejecución (`'/dashboard/' + seccion`), y
 * los segmentos de más adentro (`/dashboard/espacios/<id>` se juzga solo por `espacios`).
 */

const RAIZ = path.resolve(__dirname, '..');
const DASHBOARD = path.join(RAIZ, 'webapp', 'src', 'app', 'dashboard');

// `tests/` lleva fixtures con rutas inventadas; `webapp/` es el destino, no el emisor; `docs/` no
// le llega a nadie.
const DIRS_EXCLUIDOS = new Set(['node_modules', 'webapp', 'tests', 'docs', '.git', '.claude']);
const EXTENSIONES = new Set(['.js', '.mjs', '.cjs', '.txt', '.html', '.md']);

// Segmento sin `_`: en WhatsApp la URL suele ir dentro de una cursiva (`_..._dashboard/planes_`) y
// el guion bajo de cierre no es parte de la ruta.
const RUTA = /(?:['"`]|app\.neto\.pe)\/dashboard\/([A-Za-z0-9-]+)/g;

function segmentos(texto) {
  return [...texto.matchAll(RUTA)].map((m) => m[1]);
}

function archivos(dir, esRaiz = true) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!DIRS_EXCLUIDOS.has(e.name)) out.push(...archivos(p, false));
    } else if (EXTENSIONES.has(path.extname(e.name))) {
      // Los .md de la raíz (CLAUDE.md) son documentación; los de `prompts/` sí llegan al modelo.
      if (esRaiz && path.extname(e.name) === '.md') continue;
      out.push(p);
    }
  }
  return out;
}

function tienePagina(segmento) {
  const carpeta = path.join(DASHBOARD, segmento);
  return ['page.tsx', 'page.ts', 'page.jsx', 'page.js'].some((f) => fs.existsSync(path.join(carpeta, f)));
}

const referencias = archivos(RAIZ).flatMap((archivo) => {
  const texto = fs.readFileSync(archivo, 'utf8');
  return segmentos(texto).map((segmento) => ({ archivo: path.relative(RAIZ, archivo), segmento }));
});

describe('links del backend a /dashboard/<x>', () => {
  it('el detector separa la ruta de la cursiva de WhatsApp y de una ruta de componentes', () => {
    expect(segmentos("'_Dashboard: https://app.neto.pe/dashboard/metas_'")).toEqual(['metas']);
    expect(segmentos("WEBAPP_URL + '/dashboard/planes_'")).toEqual(['planes']);
    expect(segmentos("link: '/dashboard/espacios/' + id")).toEqual(['espacios']);
    // Ruta de un archivo, no un link: no empieza con comilla ni con el dominio.
    expect(segmentos('`webapp/src/components/dashboard/dashboard-shell.tsx`')).toEqual([]);
  });

  it('el barrido encuentra los links que existen (antivacuidad)', () => {
    expect(referencias.length).toBeGreaterThan(50);
    const metas = referencias.filter((r) => r.archivo === path.join('handlers', 'intents', 'metas.js'));
    expect(metas.map((r) => r.segmento)).toEqual(['planes', 'planes', 'planes']);
  });

  it('todo /dashboard/<x> que manda el backend tiene página en la webapp', () => {
    const muertos = referencias.filter((r) => !tienePagina(r.segmento));
    expect(muertos.map((r) => `${r.archivo} -> /dashboard/${r.segmento}`)).toEqual([]);
  });
});

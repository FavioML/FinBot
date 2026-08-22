import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Las cuatro pantallas de invitación tienen que traer su contenido en el HTML inicial.
 *
 * Hermano de `app/entrada-no-transparente.test.ts`, y la otra mitad del mismo problema. Ese
 * guard cuida que lo que se pinta primero no sea INVISIBLE; éste cuida que exista. Se puede
 * tener un FCP impecable y aun así hacer esperar a la persona, que es exactamente lo que
 * pasaba acá: el HTML traía un spinner puntualísimo y el contenido llegaba dos segundos
 * después.
 *
 * Hasta el 22-ago-2026 las cuatro pantallas eran componentes de cliente que pedían su propio
 * contenido con `fetch` dentro de un `useEffect`. Eso encadena tres esperas antes de mostrar
 * nada: bajar el bundle, hidratar, y recién ahí la request. Medido contra producción
 * (412×823, 1.6 Mbps, CPU 4×, contexto limpio, 5 corridas por ruta):
 *
 *   /join/gasto   fp = fcp 1640ms → LCP 3776ms    gap 2136ms
 *   /join/deuda   fp = fcp 1664ms → LCP 4172ms    gap 2508ms
 *   /join/meta    fp = fcp 1636ms → LCP 4464ms    gap 2828ms  (una corrida seguía cargando a los 6s)
 *   /join/space   fp = fcp 1624ms → LCP 4060ms    gap 2436ms
 *   /login        fp = fcp 1660ms → LCP 1660ms    gap 0ms     ← el control, ya servido del HTML
 *
 * Cae sobre quien llega de una invitación de WhatsApp y todavía no tiene cuenta en Neto.
 *
 * QUÉ MIRA Y QUÉ NO
 *
 * - Deriva las rutas de `join/` del árbol: una invitación nueva entra sola.
 * - Exige dos cosas por página: que NO sea un componente de cliente, y que resuelva su
 *   contenido con un `await` a `lib/invitaciones` antes de renderizar. La segunda es la que
 *   de verdad decide — sin ella, una página de servidor que igual buscara sus datos desde el
 *   cliente pasaría. Las islas de `accion.tsx` sí son de cliente, y está bien: su `fetch`
 *   sale cuando alguien aprieta el botón, no al montar.
 * - NO prueba el pintado. Un guard estático no puede: lee archivos. Lo que prueba el
 *   invariante es medir contra producción después del deploy, con el first-paint al lado del
 *   FCP y del LCP, porque el número que delata es la DISTANCIA entre ellos.
 */

const JOIN = join(process.cwd(), 'src', 'app', 'join');

function paginasDeInvitacion(dir = JOIN): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return paginasDeInvitacion(ruta);
    return e.name === 'page.tsx' ? [ruta] : [];
  });
}

/** Los comentarios explican el bug; no pueden ser el bug. Mismo criterio que el guard hermano. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** Qué le falta a esta página para que su contenido viaje en el HTML. */
export function faltantes(codigo: string): string[] {
  const limpio = sinComentarios(codigo);
  const fallos: string[] = [];
  if (/^\s*['"]use client['"]/m.test(limpio)) {
    fallos.push("es 'use client': su contenido no puede estar en el HTML inicial");
  }
  if (!/await\s+vistaInvitacion\w*\s*\(/.test(limpio)) {
    fallos.push('no resuelve la invitación en el servidor (falta `await vistaInvitacion…`)');
  }
  return fallos;
}

const PAGINAS = paginasDeInvitacion();
const ruta = (p: string) => relative(JOIN, p).split(sep).join('/');

describe('las invitaciones traen su contenido en el HTML', () => {
  it('deriva el alcance del árbol y encuentra las cuatro invitaciones', () => {
    expect(PAGINAS.map(ruta).sort()).toEqual([
      'deuda/[code]/page.tsx',
      'gasto/[code]/page.tsx',
      'meta/[code]/page.tsx',
      'space/[code]/page.tsx',
    ]);
  });

  it.each(PAGINAS.map((p) => [ruta(p), p]))('%s resuelve en el servidor', (nombre, archivo) => {
    const fallos = faltantes(readFileSync(archivo, 'utf8'));
    expect(fallos, `${nombre}: ${fallos.join(' · ')}`).toEqual([]);
  });

  /**
   * Sin esto, un cambio que rompa `faltantes` deja el barrido de arriba verde por vacuidad
   * — que es exactamente como se ve un guard que no mira nada. Los dos primeros casos son
   * la regresión REAL, copiada de cómo estaban escritas estas páginas hasta hoy.
   */
  it('atrapa la regresión real, y deja pasar lo legítimo', () => {
    const comoEstaba = `'use client';
      import { useState, useEffect, use } from 'react';
      export default function JoinGastoPage({ params }) {
        useEffect(() => { fetch(\`/api/split/invite?code=\${code}\`).then(setPreview); }, [code]);
      }`;
    expect(faltantes(comoEstaba)).toHaveLength(2);

    // El escondite intermedio: página de servidor que igual trae los datos desde el cliente.
    const servidorPeroFetchDeCliente = `
      import { PreviewCliente } from './preview-cliente';
      export default async function Page({ params }) {
        const { code } = await params;
        return <PreviewCliente code={code} />;
      }`;
    expect(faltantes(servidorPeroFetchDeCliente)).toEqual([
      'no resuelve la invitación en el servidor (falta `await vistaInvitacion…`)',
    ]);

    // Lo legítimo: servidor, resuelve antes de renderizar, y delega el botón a una isla.
    const correcto = `
      import { vistaInvitacionGasto } from '@/lib/invitaciones';
      import { AccionConfirmarGasto } from './accion';
      export default async function Page({ params }) {
        const { code } = await params;
        const preview = await vistaInvitacionGasto(code);
        return <AccionConfirmarGasto code={code} />;
      }`;
    expect(faltantes(correcto)).toEqual([]);

    // Y la prosa que documenta el bug no es el bug: este mismo archivo cita las dos formas.
    const soloComentarios = `
      /* antes decia 'use client' y hacia el fetch en un useEffect */
      // import { useEffect } from 'react';
      import { vistaInvitacionMeta } from '@/lib/invitaciones';
      export default async function Page() { const v = await vistaInvitacionMeta(c); }`;
    expect(faltantes(soloComentarios)).toEqual([]);
  });
});

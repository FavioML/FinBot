import { NextResponse } from 'next/server';

/**
 * TEMPORAL — solo vive en las ramas del A/B de region (item 16 del backlog de
 * confiabilidad). NO se fusiona a main.
 *
 * Mide el salto de SALIDA desde la region donde corre esta funcion hacia los tres
 * destinos que la webapp toca del lado servidor: Supabase (sa-east-1), el backend
 * en Railway (region desconocida) y OpenAI (EE.UU.). Mover la funcion a `gru1`
 * acerca Supabase y ALEJA lo que este en EE.UU.; sin este numero la decision seria
 * "el dashboard mejora" sin saber que se paga a cambio.
 *
 * Los destinos estan cableados a proposito: una lista fija no es un SSRF.
 */
export const dynamic = 'force-dynamic';

const DESTINOS: Array<[string, string]> = [
  ['supabase', `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`],
  ['railway', 'https://api.neto.pe/health'],
  ['openai', 'https://api.openai.com/v1/models'],
];

async function medir(url: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    try {
      const r = await fetch(url, { cache: 'no-store' });
      await r.arrayBuffer();
    } catch { /* el numero de un fallo tambien informa: no lo escondemos */ }
    out.push(Date.now() - t);
  }
  return out;
}

export async function GET() {
  const n = 5;
  const res: Record<string, unknown> = {
    region: process.env.VERCEL_REGION ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
  };
  for (const [nombre, url] of DESTINOS) {
    const ms = await medir(url, n);
    const s = [...ms].sort((a, b) => a - b);
    res[nombre] = { ms, mediana: s[s.length >> 1], min: s[0], max: s[s.length - 1] };
  }
  return NextResponse.json(res);
}

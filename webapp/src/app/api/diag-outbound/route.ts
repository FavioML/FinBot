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

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * `${SUPA}/rest/v1/` SIN credenciales NO sirve para esto: la primera version de esta
 * ruta lo midio en 27 ms desde iad1, que es imposible contra sa-east-1 y por lo tanto
 * evidencia de que ese 401 lo contesta el borde y nunca toca Postgres. El instrumento
 * estaba sano y contestaba otra pregunta. La consulta autenticada si baja hasta la base.
 */
const DESTINOS: Array<[string, string, Record<string, string>]> = [
  [
    'supabase',
    `${SUPA}/rest/v1/usuarios?select=id&limit=1`,
    { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  ],
  ['railway', 'https://api.neto.pe/health', {}],
  ['openai', 'https://api.openai.com/v1/models', {}],
];

async function medir(
  url: string,
  headers: Record<string, string>,
  n: number,
): Promise<Array<{ ms: number; status: number }>> {
  const out: Array<{ ms: number; status: number }> = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    let status = 0;
    try {
      const r = await fetch(url, { headers, cache: 'no-store' });
      await r.arrayBuffer();
      status = r.status;
    } catch {
      /* el numero de un fallo tambien informa: no lo escondemos, queda status 0 */
    }
    out.push({ ms: Date.now() - t, status });
  }
  return out;
}

export async function GET() {
  const n = 5;
  const res: Record<string, unknown> = {
    region: process.env.VERCEL_REGION ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
  };
  for (const [nombre, url, headers] of DESTINOS) {
    const filas = await medir(url, headers, n);
    const ms = filas.map((f) => f.ms);
    const s = [...ms].sort((a, b) => a - b);
    res[nombre] = {
      ms,
      // El status va al lado del tiempo a proposito: un 401 rapido y un 200 rapido
      // se ven igual en el numero y no miden lo mismo.
      status: [...new Set(filas.map((f) => f.status))],
      mediana: s[s.length >> 1],
      min: s[0],
      max: s[s.length - 1],
    };
  }
  return NextResponse.json(res);
}

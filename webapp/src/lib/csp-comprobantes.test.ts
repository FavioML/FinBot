import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * El visor de comprobantes de /admin/pagos (y la miniatura del modal de Operación) cargan una
 * URL firmada de Supabase Storage dentro de la página. Con el `img-src` de la CSP sin ese host,
 * el navegador bloqueaba la imagen y solo se veía en otra pestaña. Pasó sin que nada fallara:
 * el fetch de la URL respondía 200 y la imagen moría en el navegador.
 */
async function imgSrc(): Promise<string> {
  vi.resetModules();
  const { default: config } = await import('../../next.config');
  const reglas = await config.headers!();
  const csp = reglas[0].headers.find((h) => h.key === 'Content-Security-Policy')!.value;
  return csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src'))!;
}

describe('CSP: comprobantes de pago', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('permite solo la ruta firmada del bucket comprobantes del proyecto', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc123.supabase.co/');
    const src = await imgSrc();
    expect(src).toContain('https://abc123.supabase.co/storage/v1/object/sign/comprobantes/');
    // Ni el comodín ni el host entero: el resto de Storage no se muestra como imagen.
    expect(src).not.toMatch(/\*\.supabase\.co/);
    expect(src).not.toMatch(/https:\/\/abc123\.supabase\.co(\s|$)/);
  });

  it('sin la variable no inventa un host', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(await imgSrc()).not.toContain('supabase');
  });
});

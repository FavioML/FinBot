import { NextResponse } from 'next/server';
import { vistaInvitacionEspacio } from '@/lib/invitaciones';

// GET — vista publica de la invitacion (sin auth). La resolucion vive en
// `lib/invitaciones.ts` porque el consumidor principal ya no es esta ruta sino la
// pantalla `/join/*`, que la llama en el servidor antes de mandar el HTML. Esto queda
// para los harness de `qa-e2e/`, que la consultan sin navegador.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const vista = await vistaInvitacionEspacio(code);
  if (!vista)
    return NextResponse.json({ error: 'Código inválido' }, { status: 404 });

  return NextResponse.json(vista);
}

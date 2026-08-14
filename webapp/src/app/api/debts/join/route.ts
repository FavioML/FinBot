import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { parseMontoDinero } from '@/lib/money';

// POST /api/debts/join — accept a shared debt (creates mirror "debo" debt)
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { code } = body;

  if (!code)
    return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Find the original debt by invite code
  const { data: deudaOriginal } = await getServiceClient()
    .from('deudas')
    .select('id, usuario_id, contraparte, monto_original, monto_pendiente, moneda, descripcion, fecha_vencimiento, es_recurrente, frecuencia, fecha_fin, proxima_fecha, periodos_pagados')
    .eq('invite_code', code)
    .single();

  if (!deudaOriginal)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  // Cannot confirm your own debt
  if (deudaOriginal.usuario_id === userId)
    return NextResponse.json({ error: 'No puedes confirmar tu propia deuda' }, { status: 400 });

  // ¿Ya la confirmó ALGUIEN? La pregunta es por deuda, no por usuario.
  //
  // Esto filtraba además por `usuario_id`, o sea que solo impedía que la MISMA persona
  // confirmara dos veces. Con una deuda "me deben" —que por definición debe UNA
  // contraparte— eso dejaba entrar a un segundo confirmante, y no es cosmético: cada
  // confirmación deja una fila espejo con `deuda_vinculada_id`, y `PUT /api/debts`
  // propaga desde el espejo a la deuda del acreedor. Reproducido contra prod el
  // 14-ago-2026 con `qa-e2e/qa-invite-codes.mjs` (check `deuda_segundo_confirmante`):
  // el segundo entraba con 200, marcaba pagada su espejo y la deuda del acreedor
  // quedaba en `estado=pagada, monto_pendiente=0`.
  //
  // El GET de preview ya contaba global (`ya_confirmada` con `count` sobre
  // `deuda_vinculada_id`) y la UI escondía el botón: los dos endpoints de la misma
  // feature se contradecían, y el que mandaba era el que no gateaba nada.
  //
  // `.limit(1)` y no `.maybeSingle()`: con el filtro global puede haber más de una fila
  // espejo (las que dejó el bug antes de este arreglo), y `maybeSingle()` devuelve error
  // con 2+ filas → `existing` null → seguiría entrando gente, justo en las deudas ya
  // afectadas.
  //
  // Y el `error` se LEE. Esta query era decorativa mientras el gate real era por usuario;
  // ahora es lo único que sostiene el invariante, así que un timeout de Supabase no puede
  // significar "no hay ninguna": `supabase-js` no lanza, devuelve `{ data: null, error }`,
  // y `null` se leía como vía libre. Un gate que falla ABIERTO es el bug que este bloque
  // viene a cerrar, con otra ropa.
  const { data: existentes, error: errorExistentes } = await getServiceClient()
    .from('deudas')
    .select('id')
    .eq('deuda_vinculada_id', deudaOriginal.id)
    .limit(1);

  if (errorExistentes) {
    console.error('[debt-join-existentes]', errorExistentes.message);
    return NextResponse.json({ error: 'No pudimos verificar la invitación. Intenta de nuevo.' }, { status: 500 });
  }
  if (existentes && existentes.length > 0)
    return NextResponse.json({ error: 'Esta deuda ya fue confirmada' }, { status: 409 });

  // Get creditor name to use as contraparte
  const { data: acreedor } = await getServiceClient()
    .from('usuarios')
    .select('nombre')
    .eq('id', deudaOriginal.usuario_id)
    .single();

  // El monto se copia de una fila que YA existe, así que no es entrada del usuario —
  // pero copiarla sin mirar es lo que convierte una deuda envenenada en dos. El P0 de
  // `qa-money-edge` demostró que `monto_pendiente` podía quedar en null/NaN de forma
  // permanente; si eso vuelve a pasar, el espejo no lo propaga: falla cerrado y el
  // deudor ve un error en vez de una deuda fantasma. Medido antes de aplicarlo: 0 de
  // 62 filas de `deudas` en prod están fuera de rango, así que hoy no rechaza a nadie.
  const montoOriginal = parseMontoDinero(deudaOriginal.monto_original);
  const montoPendiente = parseMontoDinero(deudaOriginal.monto_pendiente, { allowZero: true });
  if (montoOriginal === null || montoPendiente === null) {
    return NextResponse.json(
      { error: 'Esta deuda tiene un monto inválido. Pídele a quien te la compartió que la revise.' },
      { status: 409 }
    );
  }

  // Create mirror "debo" debt — copia los campos de recurrencia para que el
  // deudor también vea el compromiso como recurrente. Los abonos y avances
  // de periodo se sincronizan en /api/debts (PUT action=abonar) via vinculación.
  const { data: nuevaDeuda, error } = await getServiceClient()
    .from('deudas')
    .insert({
      usuario_id: userId,
      tipo: 'debo',
      contraparte: acreedor?.nombre || deudaOriginal.contraparte,
      monto_original: montoOriginal,
      monto_pendiente: montoPendiente,
      moneda: deudaOriginal.moneda,
      descripcion: deudaOriginal.descripcion,
      fecha_vencimiento: deudaOriginal.fecha_vencimiento,
      estado: 'activa',
      deuda_vinculada_id: deudaOriginal.id,
      es_recurrente: deudaOriginal.es_recurrente ?? false,
      frecuencia: deudaOriginal.frecuencia ?? null,
      fecha_fin: deudaOriginal.fecha_fin ?? null,
      proxima_fecha: deudaOriginal.proxima_fecha ?? null,
      periodos_pagados: deudaOriginal.periodos_pagados ?? 0,
    })
    .select()
    .single();

  // 23505 = el índice único parcial de la migración 070 (`deuda_vinculada_id` where not
  // null). Es la mitad estructural del chequeo de arriba: dos personas abriendo el mismo
  // link a la vez pasan las dos por el SELECT y llegan las dos hasta acá, así que el
  // invariante "un espejo por deuda" no lo puede sostener un `if`. Se traduce al mismo
  // 409, que es lo que el segundo tenía que ver.
  if (error && error.code === '23505')
    return NextResponse.json({ error: 'Esta deuda ya fue confirmada' }, { status: 409 });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Notify creditor that debt was confirmed
  try {
    const { data: joiner } = await getServiceClient().from('usuarios').select('nombre').eq('id', userId).single();
    await getServiceClient().from('notificaciones').insert({
      usuario_id: deudaOriginal.usuario_id,
      tipo: 'sistema',
      titulo: 'Deuda confirmada',
      mensaje: (joiner?.nombre || 'Alguien') + ' confirmó la deuda de ' + (deudaOriginal.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(deudaOriginal.monto_original as unknown as string).toFixed(2),
      datos: { link: '/dashboard/deudas', deuda_id: deudaOriginal.id },
      leida: false,
      fecha: new Date().toISOString(),
    });
  } catch (e) { console.error('[debt-join-notify]', e); }

  return NextResponse.json(nuevaDeuda);
}

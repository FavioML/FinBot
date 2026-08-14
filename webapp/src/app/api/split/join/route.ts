import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { parseMontoDinero } from '@/lib/money';

// POST /api/split/join — confirm participation in a shared expense
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { code } = body;

  if (!code)
    return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Find participant by invite code
  const { data: participante } = await getServiceClient()
    .from('gasto_participantes')
    .select('id, nombre, monto_debe, monto_pagado, gasto_id, usuario_id')
    .eq('invite_code', code)
    .single();

  if (!participante)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  // Get the expense
  const { data: gasto } = await getServiceClient()
    .from('gastos_compartidos')
    .select('id, creador_id, descripcion, moneda')
    .eq('id', participante.gasto_id)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

  // Cannot confirm your own expense
  if (gasto.creador_id === userId)
    return NextResponse.json({ error: 'No puedes confirmar tu propio gasto' }, { status: 400 });

  // Check if already confirmed
  if (participante.usuario_id)
    return NextResponse.json({ error: 'Ya confirmaste esta participacion' }, { status: 409 });

  // Get creator name for contraparte
  const { data: creador } = await getServiceClient()
    .from('usuarios')
    .select('nombre')
    .eq('id', gasto.creador_id)
    .single();

  // Mismo criterio que `/api/debts/join`: el monto viene de una fila que ya existe, no
  // del request, pero copiarlo sin mirar convierte una fila corrupta en una deuda
  // corrupta. `monto_pagado` es una RESTA, así que basta con que uno de los dos venga
  // mal para que el pendiente salga NaN y la deuda quede envenenada de nacimiento.
  // `allowZero` NO es un detalle: `POST /api/split` crea participantes con
  // `parseMontoDinero(p?.monto_debe, { allowZero: true })`, o sea que una parte de S/0
  // es un dato que la propia API escribe a propósito (alguien invitado que no paga
  // nada). Sin esto, esa persona abría su link y recibía 409 PARA SIEMPRE, y la línea
  // de abajo —`estado: montoPendiente <= 0 ? 'pagada'`— ya contemplaba ese caso: la
  // ruta se contradecía consigo misma.
  const montoDebe = parseMontoDinero(participante.monto_debe, { allowZero: true });
  const montoPagado = parseMontoDinero(participante.monto_pagado ?? 0, { allowZero: true });
  if (montoDebe === null || montoPagado === null) {
    return NextResponse.json(
      { error: 'Este gasto compartido tiene un monto inválido. Pídele a quien lo creó que lo revise.' },
      { status: 409 }
    );
  }
  const montoPendiente = Math.max(0, Math.round((montoDebe - montoPagado) * 100) / 100);

  // ── RECLAMAR primero, y de forma CONDICIONAL ────────────────────────────────
  //
  // `gasto_participantes.usuario_id` es el único token de idempotencia de esta ruta: el
  // 409 de arriba lo lee, y este UPDATE es lo único que lo escribe. Estaba DESPUÉS del
  // insert de la deuda y sin leer su `error`, o sea que un fallo del UPDATE devolvía
  // **200 con la deuda ya creada** y dejaba al participante sin reclamar: el mismo link
  // acuñaba otra deuda "debo" en cada canje, sin cota. Acá no hay red estructural — el
  // índice único de `gasto_participantes` es sobre `invite_code`, no sobre `usuario_id`,
  // así que no existe el equivalente de la migración 071 de este lado.
  //
  // El `.is('usuario_id', null)` cierra además la carrera: dos personas abriendo el mismo
  // link pasan las dos por el chequeo de arriba, y sólo una consigue la fila.
  //
  // El orden importa por la DIRECCIÓN en que falla cada uno. Reclamar primero puede dejar
  // "reclamado sin deuda", que es recuperable y no duplica plata; insertar primero deja
  // "N deudas por un gasto", que sí. Si el insert falla después del claim, se suelta.
  const { data: reclamadas, error: errorReclamo } = await getServiceClient()
    .from('gasto_participantes')
    .update({ usuario_id: userId })
    .eq('id', participante.id)
    .is('usuario_id', null)
    .select('id');

  if (errorReclamo) {
    console.error('[split-join-reclamo]', errorReclamo.message);
    return NextResponse.json({ error: 'No pudimos confirmar tu parte. Intenta de nuevo.' }, { status: 500 });
  }
  if (!reclamadas || reclamadas.length === 0)
    return NextResponse.json({ error: 'Ya confirmaste esta participacion' }, { status: 409 });

  // Create a "debo" debt for the participant
  const { data: nuevaDeuda, error: debtError } = await getServiceClient()
    .from('deudas')
    .insert({
      usuario_id: userId,
      tipo: 'debo',
      contraparte: creador?.nombre || 'Alguien',
      monto_original: montoDebe,
      monto_pendiente: montoPendiente,
      moneda: gasto.moneda,
      descripcion: gasto.descripcion,
      estado: montoPendiente <= 0 ? 'pagada' : 'activa',
    })
    .select()
    .single();

  if (debtError) {
    // Soltar el reclamo: si no, el participante queda marcado como confirmado sin deuda y
    // no puede reintentar nunca. Best-effort y acotado a la fila que ESTA corrida reclamó.
    await getServiceClient()
      .from('gasto_participantes')
      .update({ usuario_id: null })
      .eq('id', participante.id)
      .eq('usuario_id', userId);
    return NextResponse.json({ error: debtError.message }, { status: 400 });
  }

  // Notify the expense creator
  try {
    const { data: joiner } = await getServiceClient().from('usuarios').select('nombre').eq('id', userId).single();
    await getServiceClient().from('notificaciones').insert({
      usuario_id: gasto.creador_id,
      tipo: 'sistema',
      titulo: 'Gasto compartido confirmado',
      mensaje: (joiner?.nombre || 'Alguien') + ' confirmo su parte de ' + (gasto.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(String(participante.monto_debe)).toFixed(2) + ' en "' + gasto.descripcion + '"',
      datos: { link: '/dashboard/deudas' },
      leida: false,
      fecha: new Date().toISOString(),
    });
  } catch (e) { console.error('[split-join-notify]', e); }

  return NextResponse.json(nuevaDeuda);
}

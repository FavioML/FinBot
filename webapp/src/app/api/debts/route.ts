import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { hoyPeru } from '@/lib/dates';

const FRECUENCIAS = ['semanal', 'quincenal', 'mensual', 'anual'] as const;
type Frecuencia = typeof FRECUENCIAS[number];

// Suma un periodo a una fecha (ISO yyyy-mm-dd) según la frecuencia
function addPeriodo(fechaISO: string, frecuencia: Frecuencia): string {
  const d = new Date(fechaISO + 'T12:00:00');
  if (frecuencia === 'semanal') d.setDate(d.getDate() + 7);
  else if (frecuencia === 'quincenal') d.setDate(d.getDate() + 15);
  else if (frecuencia === 'mensual') d.setMonth(d.getMonth() + 1);
  else if (frecuencia === 'anual') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

// GET /api/debts — lista todas las deudas activas
export async function GET() {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { data, error } = await getServiceClient()
    .from('deudas')
    .select('*, deuda_abonos(id, monto, fecha, nota, created_at)')
    .eq('usuario_id', netoUser.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// POST /api/debts — crear deuda
export async function POST(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const {
    tipo,
    contraparte,
    monto_original,
    moneda,
    descripcion,
    fecha_vencimiento,
    es_recurrente,
    frecuencia,
    fecha_fin,
  } = body;

  if (!tipo || !contraparte || !monto_original) {
    return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 });
  }

  const monto = parseFloat(monto_original);
  if (isNaN(monto) || monto <= 0) {
    return NextResponse.json({ error: 'Monto inválido' }, { status: 400 });
  }

  // Validación de campos recurrentes
  const recurrente = !!es_recurrente;
  let frecValida: Frecuencia | null = null;
  let proximaFecha: string | null = null;
  if (recurrente) {
    if (!FRECUENCIAS.includes(frecuencia)) {
      return NextResponse.json({ error: 'Frecuencia inválida' }, { status: 400 });
    }
    frecValida = frecuencia as Frecuencia;
    // proxima_fecha = fecha_vencimiento si fue dado, sino +1 periodo desde hoy
    const base = fecha_vencimiento || hoyPeru();
    proximaFecha = fecha_vencimiento ? base : addPeriodo(base, frecValida);
  }

  const { data, error } = await getServiceClient()
    .from('deudas')
    .insert({
      usuario_id: netoUser.id,
      tipo,
      contraparte: contraparte.trim(),
      monto_original: monto,
      monto_pendiente: monto,
      moneda: moneda || 'PEN',
      descripcion: descripcion?.trim() || null,
      fecha_vencimiento: fecha_vencimiento || null,
      estado: 'activa',
      es_recurrente: recurrente,
      frecuencia: frecValida,
      fecha_fin: recurrente ? (fecha_fin || null) : null,
      proxima_fecha: proximaFecha,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// PUT /api/debts — actualizar deuda (editar campos o registrar abono)
export async function PUT(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const { id, action, ...fields } = body;

  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Verificar que la deuda pertenece al usuario
  const { data: deuda } = await getServiceClient()
    .from('deudas')
    .select('*')
    .eq('id', id)
    .eq('usuario_id', netoUser.id)
    .single();

  if (!deuda) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // action=abonar → registrar abono + actualizar monto_pendiente
  if (action === 'abonar') {
    const montoAbono = parseFloat(fields.monto);
    if (isNaN(montoAbono) || montoAbono <= 0) {
      return NextResponse.json({ error: 'Monto de abono inválido' }, { status: 400 });
    }

    // Insertar abono
    await getServiceClient().from('deuda_abonos').insert({
      deuda_id: id,
      monto: montoAbono,
      fecha: fields.fecha || hoyPeru(),
      nota: fields.nota || null,
    });

    // Recalculate monto_pendiente from all abonos (atomic — avoids race conditions)
    const { data: allAbonos } = await getServiceClient()
      .from('deuda_abonos')
      .select('monto')
      .eq('deuda_id', id);
    const totalAbonado = (allAbonos || []).reduce((sum, a) => sum + parseFloat(a.monto), 0);
    const nuevoPendiente = Math.max(0, parseFloat(deuda.monto_original) - totalAbonado);
    const completada = nuevoPendiente === 0;

    // Si el periodo se completó y la deuda es recurrente, abrir el siguiente
    // periodo en lugar de marcarla como pagada (a menos que ya pasó la fecha_fin).
    let updateFields: Record<string, unknown> = {
      monto_pendiente: nuevoPendiente,
      estado: completada ? 'pagada' : 'activa',
      updated_at: new Date().toISOString(),
    };

    let recurrenteRenovada = false;
    if (completada && deuda.es_recurrente && deuda.frecuencia) {
      const baseFecha = deuda.proxima_fecha || deuda.fecha_vencimiento || hoyPeru();
      const siguiente = addPeriodo(baseFecha, deuda.frecuencia as Frecuencia);
      const seguimosVigentes = !deuda.fecha_fin || siguiente <= deuda.fecha_fin;

      if (seguimosVigentes) {
        // Reset al siguiente periodo
        updateFields = {
          monto_pendiente: parseFloat(deuda.monto_original),
          estado: 'activa',
          proxima_fecha: siguiente,
          fecha_vencimiento: siguiente,
          periodos_pagados: (deuda.periodos_pagados || 0) + 1,
          updated_at: new Date().toISOString(),
        };
        recurrenteRenovada = true;
      } else {
        // Llegó al límite: queda completada de verdad
        updateFields.periodos_pagados = (deuda.periodos_pagados || 0) + 1;
      }
    }

    // Actualizar deuda
    const { data: updated, error } = await getServiceClient()
      .from('deudas')
      .update(updateFields)
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Sincronizar el lado vinculado (deuda compartida): si esta deuda tiene
    // mirror (otro usuario aceptó el invite) o es el mirror de una original,
    // propagamos monto_pendiente, estado, periodo y fechas para que ambas
    // partes vean lo mismo.
    try {
      const linkedQuery = getServiceClient()
        .from('deudas')
        .select('id');
      const filter = deuda.deuda_vinculada_id
        ? linkedQuery.or(`id.eq.${deuda.deuda_vinculada_id},deuda_vinculada_id.eq.${id}`)
        : linkedQuery.eq('deuda_vinculada_id', id);
      const { data: linked } = await filter;
      if (linked && linked.length > 0) {
        const syncFields: Record<string, unknown> = {
          monto_pendiente: updateFields.monto_pendiente,
          estado: updateFields.estado,
          updated_at: new Date().toISOString(),
        };
        if ('proxima_fecha' in updateFields) syncFields.proxima_fecha = updateFields.proxima_fecha;
        if ('fecha_vencimiento' in updateFields) syncFields.fecha_vencimiento = updateFields.fecha_vencimiento;
        if ('periodos_pagados' in updateFields) syncFields.periodos_pagados = updateFields.periodos_pagados;
        await getServiceClient()
          .from('deudas')
          .update(syncFields)
          .in('id', linked.map(d => d.id));
      }
    } catch (e) {
      console.error('[debt-sync-linked]', e);
    }

    return NextResponse.json({ ...updated, completada: completada && !recurrenteRenovada, recurrenteRenovada });
  }

  // action=marcar_pagada → poner monto_pendiente=0 y estado=pagada
  if (action === 'marcar_pagada') {
    const { data: updated, error } = await getServiceClient()
      .from('deudas')
      .update({
        monto_pendiente: 0,
        estado: 'pagada',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Sync linked debt
    try {
      const linkedQuery = getServiceClient().from('deudas').select('id');
      const filter = deuda.deuda_vinculada_id
        ? linkedQuery.or(`id.eq.${deuda.deuda_vinculada_id},deuda_vinculada_id.eq.${id}`)
        : linkedQuery.eq('deuda_vinculada_id', id);
      const { data: linked } = await filter;
      if (linked && linked.length > 0) {
        await getServiceClient()
          .from('deudas')
          .update({ monto_pendiente: 0, estado: 'pagada', updated_at: new Date().toISOString() })
          .in('id', linked.map(d => d.id));
      }
    } catch (e) {
      console.error('[debt-sync-linked]', e);
    }

    return NextResponse.json(updated);
  }

  // Edición general
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.contraparte !== undefined) updateData.contraparte = fields.contraparte.trim();
  if (fields.descripcion !== undefined) updateData.descripcion = fields.descripcion?.trim() || null;
  if (fields.fecha_vencimiento !== undefined) updateData.fecha_vencimiento = fields.fecha_vencimiento || null;
  if (fields.estado !== undefined) updateData.estado = fields.estado;
  if (fields.es_recurrente !== undefined) {
    updateData.es_recurrente = !!fields.es_recurrente;
    if (!fields.es_recurrente) {
      updateData.frecuencia = null;
      updateData.fecha_fin = null;
      updateData.proxima_fecha = null;
    }
  }
  if (fields.frecuencia !== undefined) {
    if (fields.frecuencia && !FRECUENCIAS.includes(fields.frecuencia)) {
      return NextResponse.json({ error: 'Frecuencia inválida' }, { status: 400 });
    }
    updateData.frecuencia = fields.frecuencia || null;
  }
  if (fields.fecha_fin !== undefined) updateData.fecha_fin = fields.fecha_fin || null;

  const { data: updated, error } = await getServiceClient()
    .from('deudas')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync recurrencia + fecha_vencimiento + descripcion al lado vinculado.
  // contraparte NO se sincroniza (cada usuario ve a la otra persona).
  try {
    const linkedQuery = getServiceClient().from('deudas').select('id');
    const filter = deuda.deuda_vinculada_id
      ? linkedQuery.or(`id.eq.${deuda.deuda_vinculada_id},deuda_vinculada_id.eq.${id}`)
      : linkedQuery.eq('deuda_vinculada_id', id);
    const { data: linked } = await filter;
    if (linked && linked.length > 0) {
      const linkedSync: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ('descripcion' in updateData) linkedSync.descripcion = updateData.descripcion;
      if ('fecha_vencimiento' in updateData) linkedSync.fecha_vencimiento = updateData.fecha_vencimiento;
      if ('es_recurrente' in updateData) linkedSync.es_recurrente = updateData.es_recurrente;
      if ('frecuencia' in updateData) linkedSync.frecuencia = updateData.frecuencia;
      if ('fecha_fin' in updateData) linkedSync.fecha_fin = updateData.fecha_fin;
      // Si se desactiva recurrencia, también limpiar proxima_fecha
      if (updateData.es_recurrente === false) linkedSync.proxima_fecha = null;
      if (Object.keys(linkedSync).length > 1) {
        await getServiceClient()
          .from('deudas')
          .update(linkedSync)
          .in('id', linked.map(d => d.id));
      }
    }
  } catch (e) {
    console.error('[debt-sync-linked-edit]', e);
  }

  return NextResponse.json(updated);
}

// DELETE /api/debts?id=xxx — eliminar deuda
export async function DELETE(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Delete abonos first (FK constraint)
  await getServiceClient().from('deuda_abonos').delete().eq('deuda_id', id);

  // Unlink any deuda that references this one (deuda_vinculada_id FK)
  await getServiceClient()
    .from('deudas')
    .update({ deuda_vinculada_id: null })
    .eq('deuda_vinculada_id', id);

  const { error } = await getServiceClient()
    .from('deudas')
    .delete()
    .eq('id', id)
    .eq('usuario_id', netoUser.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}

import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { parseCSV, parseExcel, type ImportRow } from '@/lib/import-parser';
import crypto from 'crypto';

// exceljs necesita el runtime Node (streams), no edge.
export const runtime = 'nodejs';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROWS = 500;

/** Valida monto: número positivo <= 999999.99 (espejo del backend). */
function validarMonto(valor: unknown): number | null {
  const n = parseFloat(String(valor));
  if (isNaN(n) || !isFinite(n) || n <= 0 || n > 999999.99) return null;
  return Math.round(n * 100) / 100;
}

/** Dedup hash con el mismo formato que services/transactions.js y POST /api/transactions. */
function generarDedupHash(userId: string, fecha: string, monto: number, comercio: string | null, tipo: string): string {
  const raw = userId + '|' + fecha + '|' + monto + '|' + (comercio || '') + '|' + tipo;
  return crypto.createHash('md5').update(raw).digest('hex');
}

// Importar ESCRIBE transacciones, así que su gate NO es el muro de lectura: es `excelUpload`,
// el mismo flag de PLAN_CONFIG que aplica el backend en sus dos puertas de WhatsApp (el intent
// `cargar_excel` y la rama `document` del webhook).
//
// Antes esta ruta encadenaba `requireLectura` y encima el chequeo de plan. El RESULTADO era el
// mismo —el muro y "no es Pro" cubren hoy a la misma gente—, pero la JUSTIFICACIÓN era la
// contraria a la del backend, y eso importa por dos cosas: el usuario recibía 402 ("no puedes
// leer") en vez de 403 ("esto es Pro"), que es una razón falsa para lo que le pasó; y el día
// que `requireLectura` cambie de semántica, los dos canales de la MISMA capability se moverían
// en direcciones distintas sin que nada lo detecte. Alineado al backend (auditoría CTO ola 4).
//
// La exención del muro está declarada en `lectura-callsites.test.ts`, que es lo que impide que
// esto se lea como un gate olvidado.
export async function POST(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = { id: auth.user.id, plan: (auth.user.plan as string) || 'free' };

  // Carga masiva Excel/CSV es Pro (paridad con el gate excelUpload del backend).
  if (usuario.plan !== 'premium') {
    return NextResponse.json({ error: 'La carga masiva Excel/CSV es una función Pro.' }, { status: 403 });
  }

  if (!checkRateLimit(usuario.id, 5, 60_000)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  // Leer archivo del multipart
  let file: File | null = null;
  try {
    const formData = await request.formData();
    const f = formData.get('file');
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: 'No pude leer el archivo.' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'Falta el archivo.' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'El archivo supera 5MB.' }, { status: 400 });
  }

  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  const esCSV = name.endsWith('.csv') || type.includes('csv') || type.includes('text/plain');
  const esExcel = name.endsWith('.xlsx') || name.endsWith('.xls') || type.includes('spreadsheet') || type.includes('excel') || type.includes('officedocument');
  if (!esCSV && !esExcel) {
    return NextResponse.json({ error: 'Formato no soportado. Sube un Excel (.xlsx) o CSV (.csv).' }, { status: 400 });
  }

  // Parsear
  const buf = Buffer.from(await file.arrayBuffer());
  let rows: ImportRow[];
  try {
    rows = esCSV ? parseCSV(buf.toString('utf-8')) : await parseExcel(buf);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error parseando el archivo.' }, { status: 400 });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No encontré datos válidos. Usa la plantilla o tu estado de cuenta CSV.' }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Máximo ${MAX_ROWS} transacciones por archivo. El tuyo tiene ${rows.length}.` }, { status: 400 });
  }

  // Construir filas para insert, deduplicando por dedup_hash dentro del mismo archivo
  // (evita que dos líneas idénticas dupliquen). El import es siempre en PEN.
  const seen = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];
  let descartadas = 0;
  for (const r of rows) {
    const monto = validarMonto(r.monto);
    if (monto === null || !r.fecha) {
      descartadas++;
      continue;
    }
    const tipo = r.tipo === 'ingreso' ? 'ingreso' : 'gasto';
    const comercio = r.comercio || null;
    const dedupHash = generarDedupHash(usuario.id, r.fecha, monto, comercio, tipo);
    if (seen.has(dedupHash)) {
      descartadas++;
      continue;
    }
    seen.add(dedupHash);
    toInsert.push({
      usuario_id: usuario.id,
      tipo,
      monto,
      monto_pen: monto,
      moneda: 'PEN',
      tipo_cambio: null,
      comercio,
      categoria: r.categoria || 'Otros',
      subcategoria: r.subcategoria || 'sin_categoria',
      fecha: r.fecha,
      metodo_pago: r.metodo_pago || null,
      banco: r.banco || null,
      descripcion_original: 'Import webapp: ' + (comercio || ''),
      dedup_hash: dedupHash,
    });
  }

  if (toInsert.length === 0) {
    return NextResponse.json({ error: 'Ninguna fila era válida para importar.' }, { status: 400 });
  }

  // Insert en lotes de 200
  let insertados = 0;
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { data, error } = await getServiceClient().from('transacciones').insert(chunk).select('id');
    if (error) {
      return NextResponse.json(
        { error: 'Error guardando: ' + error.message, insertados },
        { status: 500 },
      );
    }
    insertados += data?.length ?? chunk.length;
  }

  const gastos = toInsert.filter((r) => r.tipo === 'gasto');
  const ingresos = toInsert.filter((r) => r.tipo === 'ingreso');
  const totalGastos = gastos.reduce((s, r) => s + (r.monto as number), 0);
  const totalIngresos = ingresos.reduce((s, r) => s + (r.monto as number), 0);

  return NextResponse.json({
    ok: true,
    insertados,
    descartadas,
    gastos: gastos.length,
    ingresos: ingresos.length,
    totalGastos: Math.round(totalGastos * 100) / 100,
    totalIngresos: Math.round(totalIngresos * 100) / 100,
  });
}

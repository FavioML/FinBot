import { getServiceClient } from '@/lib/supabase/service';
import { indexarPagosConPlata, type PagosConPlata } from '@/lib/admin-revenue';

/**
 * La ÚNICA query que arma el índice de "a este usuario le entró plata".
 *
 * Vive acá y no en cada ruta porque el modo de falla no es un crash: es un MRR creíble y
 * falso. Si un call-site construyera el índice con la query de `pagosMes` —que existe en
 * las dos rutas y filtra `created_at >= inicio de mes`— un cliente que borró su cuenta en
 * junio y volvió a pagar en julio no tendría su pago en el índice, y el panel lo sacaría
 * del MRR estando al día. Con una sola implementación ese error no tiene dónde ocurrir.
 *
 * `usuarioIds` acota la lectura a las filas que pueden cambiar una decisión (los que
 * pidieron la baja, más los Pro pagados en la ruta que además reporta
 * `pro_sin_pago_registrado`). No es cosmético: PostgREST corta en 1000 filas SIN error, así
 * que el techo pasa a ser "1000 pagos repartidos entre esos usuarios" en vez de 1000 pagos
 * en total. Con la lista vacía ni siquiera va a la red.
 */
/**
 * Cuántos ids entran en un `.in(...)`.
 *
 * La lista crece MONÓTONAMENTE: son todos los que alguna vez pidieron la baja (más los Pro
 * pagados en la ruta que reporta `pro_sin_pago_registrado`), y `cuenta_borrada_at` no se
 * limpia nunca. Un `.in()` con cientos de UUIDs pasa el largo de URL que aceptan PostgREST y
 * su proxy, y como acá el fallo es CERRADO, eso no degrada: deja el panel en 500 permanente.
 * Trocear lo vuelve un problema de cantidad de requests en vez de uno de largo de URL.
 */
// 25 y no 100: contra el techo de 1000 filas de abajo, un lote de 100 hace saltar la guarda
// cuando el PROMEDIO pasa 10 pagos por usuario, y ese disparador es el exito del negocio
// (100 pagadores con 10 meses de antiguedad), no una anomalia. Con 25 el punto se corre 4x.
const IDS_POR_LOTE = 25;

/** Techo de PostgREST. Llegar exacto a esta cifra es indistinguible de estar truncado. */
const TECHO_POSTGREST = 1000;

export async function cargarPagosConPlata(
  usuarioIds: string[],
): Promise<PagosConPlata> {
  const ids = [...new Set(usuarioIds.filter(Boolean))];
  if (ids.length === 0) return new Map<string, number[]>();

  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_POR_LOTE) {
    lotes.push(ids.slice(i, i + IDS_POR_LOTE));
  }

  const db = getServiceClient();
  const filas = [];
  for (const lote of lotes) {
    const { data, error } = await db
      .from('pagos')
      .select('usuario_id, monto, estado, aprobado_at, created_at')
      .eq('estado', 'aprobado')
      .gt('monto', 0)
      .in('usuario_id', lote);

    // Falla CERRADO, a propósito, y es la política de todo lo que decide plata en estas dos
    // rutas. supabase-js no lanza: sin este chequeo, un hipo de red devuelve `data: null`,
    // el índice sale vacío y el panel muestra como baja a TODO el que alguna vez pidió
    // borrar su cuenta —incluido el que volvió y está pagando—. Un MRR silenciosamente más
    // bajo se lee como una caída del negocio; un 500 se lee como lo que es.
    if (error) {
      throw new Error('No se pudo leer `pagos` para el índice de bajas: ' + error.message);
    }
    // PostgREST corta en 1000 filas SIN error. Un truncado acá no se nota y se equivoca del
    // lado caro: falta el pago del que volvió, así que un cliente al día sale del MRR y
    // entra al churn. El docblock declaraba esa cota y no la vigilaba nadie.
    if ((data || []).length >= TECHO_POSTGREST) {
      throw new Error(
        `La lectura de \`pagos\` llegó al techo de ${TECHO_POSTGREST} filas: puede venir ` +
          'truncada y el índice de bajas quedaría incompleto. Hay que paginar.',
      );
    }
    filas.push(...(data || []));
  }

  return indexarPagosConPlata(filas);
}

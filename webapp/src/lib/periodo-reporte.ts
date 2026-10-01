/**
 * El periodo que muestra /dashboard/reportes: un mes, una semana o un rango libre.
 *
 * Todo opera sobre strings `YYYY-MM-DD` con aritmética en UTC, porque `transacciones.fecha`
 * es DATE y lo que importa es el día calendario, no un instante. Un `new Date(y, m, d)` local
 * daría otro día en una máquina que no corre en Lima. "Hoy" lo pasa el llamador
 * (`todayIsoLima()`), así que esta función no lee el reloj y se prueba con fechas fijas.
 *
 * `hasta` es EXCLUSIVO en todo el módulo (el mismo `gte`/`lt` que ya usa `useTransactions`
 * para el mes). En la URL el rango se escribe inclusivo, que es como lo piensa una persona:
 * "del 1 al 5" incluye el 5.
 */
import { MESES } from './constants';

export type TipoPeriodo = 'mes' | 'semana' | 'rango';

export interface RangoFechas {
  /** Primer día, inclusivo. */
  desde: string;
  /** Día siguiente al último, exclusivo. */
  hasta: string;
}

export interface Periodo extends RangoFechas {
  tipo: TipoPeriodo;
  etiqueta: string;
  /** El periodo inmediatamente anterior, contra el que se comparan los KPIs. */
  previo: RangoFechas;
  etiquetaComparacion: string;
  /** Cada día del periodo, en orden. */
  dias: string[];
  /** El rango pedido superaba MAX_DIAS_RANGO y se acortó: la UI tiene que decirlo. */
  recortado: boolean;
}

export interface ParamsPeriodo {
  mes?: string | null;
  semana?: string | null;
  desde?: string | null;
  hasta?: string | null;
}

/**
 * Tope del rango libre. `useTransactions` trae `select('*')` sin paginar y PostgREST corta en
 * 1000 filas: medido el 01-oct-2026, el usuario más activo tiene 180 tx en su peor mes y 1105
 * en un año, así que un rango de un año le daría totales truncados sin ningún aviso. Con 92
 * días el peor caso ronda las 540. Para el año entero está Transacciones → Anual.
 */
export const MAX_DIAS_RANGO = 92;

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

function aUtc(fecha: string): Date {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function aIso(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Años que se aceptan desde la URL. Debajo de 2000 no hay datos de Neto, y `Date.UTC` trata los
 * años 0-99 como 1900-1999: `?mes=0050-1` armaba un rango que Postgres no entiende.
 */
const ANIO_MINIMO = 2000;

/** `YYYY-MM-DD` que además es un día que existe (rechaza 2026-02-30). */
export function esFechaIso(valor: string | null | undefined): valor is string {
  if (!valor) return false;
  const m = RE_FECHA.exec(valor);
  if (!m || Number(m[1]) < ANIO_MINIMO) return false;
  return aIso(aUtc(valor)) === valor;
}

export function sumarDias(fecha: string, n: number): string {
  const d = aUtc(fecha);
  d.setUTCDate(d.getUTCDate() + n);
  return aIso(d);
}

/** El lunes de la semana de `fecha`. La semana va de lunes a domingo. */
export function lunesDe(fecha: string): string {
  const dow = aUtc(fecha).getUTCDay(); // 0 = domingo
  return sumarDias(fecha, dow === 0 ? -6 : 1 - dow);
}

/** Cuántos días hay de `desde` (inclusivo) a `hasta` (exclusivo), sin recorrerlos. */
function largoEnDias(desde: string, hasta: string): number {
  return Math.round((aUtc(hasta).getTime() - aUtc(desde).getTime()) / 86_400_000);
}

/**
 * Días de `desde` (inclusivo) a `hasta` (exclusivo). Recorre por índice sobre un largo calculado,
 * no "hasta que la fecha llegue": si la aritmética de fechas se rompiera (por ejemplo, alguien
 * cambia `aUtc` a hora local), un `while (f < hasta)` se queda en el mismo día para siempre y
 * congela la pestaña en una zona al este de UTC. Medido en la revisión del 01-oct-2026.
 */
export function diasEntre(desde: string, hasta: string): string[] {
  const n = Math.max(0, largoEnDias(desde, hasta));
  return Array.from({ length: n }, (_, i) => sumarDias(desde, i));
}

function cortaConAnio(fecha: string, conAnio: boolean): string {
  const d = aUtc(fecha);
  const base = `${d.getUTCDate()} ${MESES_CORTOS[d.getUTCMonth()]}`;
  return conAnio ? `${base} ${d.getUTCFullYear()}` : base;
}

/** "29 sep – 5 oct"; con año en las dos puntas si cruza de año. */
function etiquetaDeRango(desde: string, ultimo: string): string {
  if (desde === ultimo) return cortaConAnio(desde, true);
  const cruzaAnio = desde.slice(0, 4) !== ultimo.slice(0, 4);
  return `${cortaConAnio(desde, cruzaAnio)} – ${cortaConAnio(ultimo, cruzaAnio)}`;
}

function periodoMes(anio: number, mes: number): Periodo {
  const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const hasta = aIso(new Date(Date.UTC(anio, mes, 1)));
  const previoDesde = aIso(new Date(Date.UTC(anio, mes - 2, 1)));
  return {
    tipo: 'mes',
    desde,
    hasta,
    etiqueta: `${MESES[mes]} ${anio}`,
    previo: { desde: previoDesde, hasta: desde },
    etiquetaComparacion: 'vs mes anterior',
    dias: diasEntre(desde, hasta),
    recortado: false,
  };
}

function periodoSemana(lunes: string, hoy: string): Periodo {
  const hasta = sumarDias(lunes, 7);
  const lunesPrevio = sumarDias(lunes, -7);
  // La semana en curso se compara contra los MISMOS días de la anterior: el jueves, lunes-jueves
  // contra la semana pasada entera daba "-40% de gasto" siempre, sin que nadie gastara menos.
  const enCurso = hoy < sumarDias(lunes, 6);
  const transcurridos = largoEnDias(lunes, sumarDias(hoy, 1));
  return {
    tipo: 'semana',
    desde: lunes,
    hasta,
    etiqueta: etiquetaDeRango(lunes, sumarDias(lunes, 6)),
    previo: enCurso
      ? { desde: lunesPrevio, hasta: sumarDias(lunesPrevio, transcurridos) }
      : { desde: lunesPrevio, hasta: lunes },
    etiquetaComparacion: enCurso ? 'vs los mismos días de la semana anterior' : 'vs semana anterior',
    dias: diasEntre(lunes, hasta),
    recortado: false,
  };
}

function periodoRango(desde: string, ultimo: string, recortado: boolean): Periodo {
  const hasta = sumarDias(ultimo, 1);
  const largo = largoEnDias(desde, hasta);
  return {
    tipo: 'rango',
    desde,
    hasta,
    etiqueta: etiquetaDeRango(desde, ultimo),
    previo: { desde: sumarDias(desde, -largo), hasta: desde },
    etiquetaComparacion: 'vs periodo anterior',
    dias: diasEntre(desde, hasta),
    recortado,
  };
}

function mesDesdeParam(valor: string | null | undefined): { anio: number; mes: number } | null {
  if (!valor) return null;
  const m = /^(\d{4})-(\d{1,2})$/.exec(valor);
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (anio < ANIO_MINIMO || mes < 1 || mes > 12) return null;
  return { anio, mes };
}

/**
 * Resuelve el periodo a partir de la URL. Precedencia: rango (`desde`+`hasta`) > `semana` >
 * `mes` > el mes de hoy. Una entrada que no se entiende cae al mes de hoy en vez de romper la
 * pantalla, que es lo que ya hacía `?mes=` con un valor desconocido.
 */
export function resolverPeriodo(params: ParamsPeriodo, hoy: string): Periodo {
  if (esFechaIso(params.desde) && esFechaIso(params.hasta)) {
    let desde = params.desde;
    let ultimo = params.hasta;
    if (desde > ultimo) [desde, ultimo] = [ultimo, desde];
    if (ultimo > hoy) ultimo = hoy;
    if (desde <= ultimo) {
      // Con aritmética y no contando días: `?desde=1000-...` ya no llega acá (ANIO_MINIMO),
      // pero 26 años de rango igual armaban ~9500 strings solo para medir el largo.
      if (largoEnDias(desde, sumarDias(ultimo, 1)) > MAX_DIAS_RANGO) {
        // Se conserva el final: lo reciente es lo que más se consulta.
        return periodoRango(sumarDias(ultimo, -(MAX_DIAS_RANGO - 1)), ultimo, true);
      }
      return periodoRango(desde, ultimo, false);
    }
  }

  if (esFechaIso(params.semana)) {
    const lunes = lunesDe(params.semana);
    const lunesHoy = lunesDe(hoy);
    return periodoSemana(lunes > lunesHoy ? lunesHoy : lunes, hoy);
  }

  const mes = mesDesdeParam(params.mes);
  if (mes) return periodoMes(mes.anio, mes.mes);

  return periodoMes(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)));
}

/** Rótulo del eje X del gráfico diario: "lun 29" en semana, "29" en un mes, "29/9" si el rango cruza de mes. */
export function etiquetaDia(periodo: Periodo, fecha: string): string {
  const d = aUtc(fecha);
  if (periodo.tipo === 'semana') return `${DIAS_CORTOS[d.getUTCDay()]} ${d.getUTCDate()}`;
  const unSoloMes = periodo.desde.slice(0, 7) === sumarDias(periodo.hasta, -1).slice(0, 7);
  return unSoloMes ? String(d.getUTCDate()) : `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

/** Título del diálogo de un día: "lun 29 sep 2026". */
export function etiquetaDiaLarga(fecha: string): string {
  const d = aUtc(fecha);
  return `${DIAS_CORTOS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES_CORTOS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

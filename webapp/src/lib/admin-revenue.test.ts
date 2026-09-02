import { describe, it, expect } from 'vitest';
import {
  isRevenueUser,
  computeRevenue,
  esProPagado,
  esBajaDeclarada,
  esProActivo,
  computeChurn,
  churnedInMonth,
  wasProAtMonthEnd,
  newProInMonth,
  mrrAtMonthEnd,
  indexarPagosConPlata,
  esCortesia,
  esCortesiaAl,
  altaComercial,
  tienePagoConPlata,
  idsParaIndicePagos,
  type PagosConPlata,
} from './admin-revenue';
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from './constants';
import { msDeFechaLima } from './date-lima';

/**
 * Quién entra al MRR. Es la métrica con la que se decide si el producto funciona, así que el
 * modo de falla que importa no es un crash: es un número creíble y falso.
 *
 * Pasó el 2026-08-02. `isRevenueUser` excluía cuentas internas por una lista de números de
 * WhatsApp, y dos cuentas de prueba con `plan: 'premium'` (un seed de demo web-first, sin
 * número que listar, y un QA nuevo que nadie agregó a la lista) sumaban S/20 sobre ~S/56 de
 * MRR real. El panel exageraba un tercio y no había forma de notarlo mirándolo.
 */
const base = { plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido' };

/**
 * Un dominio que cubre a cualquiera.
 *
 * Los casos de este archivo miden MRR, churn y cortesía; que el índice cubra al usuario es
 * una precondición de todos ellos, no lo que están midiendo. Enumerar los ids caso por caso
 * haría que agregar un usuario a un fixture rompiera el test por el motivo equivocado y tapara
 * el que sí importa. **El guard del dominio tiene su propio bloque, más abajo**, y ahí se
 * verifica que preguntar de más lance.
 */
// `as unknown as` y no un `Set` real: lo único que se necesita es que `has` diga que sí. Un
// Set con los ids enumerados obligaría a mantener esa lista al agregar cualquier fixture.
const DOMINIO_ABIERTO = { has: () => true } as unknown as ReadonlySet<string>;

/**
 * Un pago viejo, anterior a cualquier fecha que usen estos casos.
 *
 * Existe porque un Pro pagado SIN una fila de `pagos` ya no es un fixture neutro: desde que
 * `esCortesia` saca del MRR a quien nunca pagó, un índice vacío convierte a todos los
 * fixtures en cortesías y ninguna aserción sobre MRR o churn mide lo que dice medir. Y el
 * fixture vacío nunca fue realista: alguien que se dio de baja PAGÓ antes de irse.
 *
 * Va en enero a propósito: es anterior a todas las bajas y retornos de este archivo, así que
 * no revierte ninguna baja (`bajaVigenteAl` solo mira pagos POSTERIORES a la baja).
 */
const PAGO_VIEJO = Date.parse('2026-01-01T00:00:00Z');

/**
 * Índice donde todo usuario pagó alguna vez, salvo los que el caso declare explícitamente.
 * No es un Map: responde para cualquier id, por el mismo motivo que `DOMINIO_ABIERTO`.
 */
function conPagoBase(real: ReadonlyMap<string, number[]>): ReadonlyMap<string, number[]> {
  return {
    get: (k: string) => real.get(k) ?? [PAGO_VIEJO],
    has: () => true,
  } as unknown as ReadonlyMap<string, number[]>;
}

/** Todos pagaron en su momento; nadie volvió a pagar DESPUÉS de irse. */
const SIN_RETORNOS: PagosConPlata = {
  dominio: DOMINIO_ABIERTO,
  porUsuario: conPagoBase(new Map<string, number[]>()),
};

/**
 * El instante desde el que se pregunta TODO. Va explícito y compartido porque el bug que
 * costó la segunda revisión fue justamente tener dos: `esBajaDeclarada` preguntaba "alguna
 * vez" (Infinity) y `computeChurn` preguntaba por `now`, así que una fila con fecha futura
 * caía de los dos lados del mismo ratio.
 */
const HOY = new Date('2026-08-20T00:00:00Z');

describe('isRevenueUser', () => {
  it('una cuenta de prueba nunca es ingreso, aunque no tenga whatsapp que listar', () => {
    // El caso exacto que se coló: seed de demo web-first, premium, sin número.
    expect(isRevenueUser({ whatsapp: null, is_test_user: true })).toBe(false);
  });

  it('una cuenta de prueba con número tampoco, aunque no esté en la lista', () => {
    // El otro caso: QA nuevo (…9996) mientras la lista solo tenía …9997.
    expect(isRevenueUser({ whatsapp: '51999999996', is_test_user: true })).toBe(false);
  });

  it('el fundador sigue excluido por lista (no está marcado como test)', () => {
    expect(isRevenueUser({ whatsapp: '51970398192', is_test_user: false })).toBe(false);
  });

  it('un cliente web-first (sin whatsapp) SÍ es negocio real', () => {
    // La regla no puede volverse "sin número no cuenta": el alta web-first es el camino nuevo.
    expect(isRevenueUser({ whatsapp: null })).toBe(true);
    expect(isRevenueUser({ whatsapp: null, is_test_user: null })).toBe(true);
  });

  it('un cliente normal con número cuenta', () => {
    expect(isRevenueUser({ whatsapp: '51987654321' })).toBe(true);
  });
});

describe('computeRevenue', () => {
  it('no factura las cuentas de prueba', () => {
    const rev = computeRevenue([
      { ...base, id: 'r1', whatsapp: '51987654321' },
      { ...base, id: 'r2', whatsapp: null, is_test_user: true },
      { ...base, id: 'r3', whatsapp: '51999999996', is_test_user: true },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('un trial activo entrega Pro pero no factura', () => {
    const rev = computeRevenue([
      { ...base, id: 'r1', whatsapp: '51987654321', trial_estado: 'activo' },
      { ...base, id: 'r2', whatsapp: '51987654322' },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('el anual se normaliza a mensual (precio/12)', () => {
    const rev = computeRevenue([{ ...base, id: 'r1', tipo_plan: 'anual', whatsapp: '51987654321' }], SIN_RETORNOS, HOY);
    expect(rev.proYearly).toBe(1);
    expect(rev.mrr).toBeCloseTo(PRO_PRICE_YEARLY_PEN / 12, 2);
  });
});

describe('esProPagado', () => {
  it('premium + trial activo NO paga; premium + convertido sí', () => {
    expect(esProPagado({ plan: 'premium', tipo_plan: 'mensual', trial_estado: 'activo' })).toBe(false);
    expect(esProPagado({ plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido' })).toBe(true);
    expect(esProPagado({ plan: 'free', tipo_plan: 'mensual', trial_estado: 'vencido' })).toBe(false);
  });
});

// ── Baja declarada ──────────────────────────────────────────────────────────
//
// Al 17-ago-2026, dos de los cinco Pro pagados habían borrado su cuenta y seguían sumando
// al MRR. Uno con plan anual vigente hasta 2027-07-01: catorce meses de ingreso que nadie
// iba a cobrar. Los dos usaron "Quiero eliminar mi cuenta" → borrado total.
const BAJA = '2026-08-09T00:42:06Z'; // el caso real: borró 13h después de pagar
/**
 * Índice con los pagos declarados, más el pago viejo para todo el resto. Es lo que hace que
 * un caso sobre BAJAS siga hablando de bajas y no se convierta en un caso sobre cortesías.
 */
const idx = (pagos: Parameters<typeof indexarPagosConPlata>[0]): PagosConPlata => ({
  dominio: DOMINIO_ABIERTO,
  porUsuario: conPagoBase(indexarPagosConPlata(pagos, []).porUsuario),
});

/** El índice tal cual sale de `indexarPagosConPlata`, para los casos que miden el INDEXADO. */
const idxLiteral = (pagos: Parameters<typeof indexarPagosConPlata>[0]) =>
  indexarPagosConPlata(pagos, []);

/** Un pago de verdad: aprobado y con plata. */
const pagoReal = (usuario_id: string, aprobado_at: string) => ({
  usuario_id, monto: '10.00', estado: 'aprobado', aprobado_at, created_at: aprobado_at,
});

describe('el testigo de "volvió" es una fila de pagos, no una columna de usuarios', () => {
  const seFue = { ...base, id: 'u1', whatsapp: '51987654321', cuenta_borrada_at: BAJA };

  it('sin pago posterior, es baja', () => {
    expect(esBajaDeclarada(seFue, SIN_RETORNOS, HOY)).toBe(true);
  });

  it('un pago aprobado POSTERIOR a la baja la revierte', () => {
    const pagos = idx([pagoReal('u1', '2026-08-15T10:00:00Z')]);
    expect(esBajaDeclarada(seFue, pagos, HOY)).toBe(false);
    expect(computeRevenue([seFue], pagos, HOY).proCount).toBe(1);
  });

  it('el pago ANTERIOR a la baja no la revierte (el caso real: pagó, y al día siguiente se fue)', () => {
    const pagos = idx([pagoReal('u1', '2026-08-08T11:52:40Z')]);
    expect(esBajaDeclarada(seFue, pagos, HOY)).toBe(true);
    expect(computeRevenue([seFue], pagos, HOY).bajasDeclaradas).toBe(1);
  });

  // El motivo por el que el testigo NO son `fecha_pago` ni `premium_desde`: las escribe
  // `activarPro` en TODA activación, comps incluidos. Un regalo del admin resucitaba al
  // churneado al MRR a precio de lista.
  it('un COMP posterior (fila en pagos con monto 0) NO revierte la baja', () => {
    const comp = { usuario_id: 'u1', monto: 0, estado: 'aprobado',
      aprobado_at: '2026-08-15T10:00:00Z', created_at: '2026-08-15T10:00:00Z' };
    expect(esBajaDeclarada(seFue, idx([comp]), HOY)).toBe(true);
  });

  // Y el otro: `premium_desde` lo escribe el premio de referidos sin pasar por `activarPro`
  // ni dejar fila en `pagos`. Un TERCERO no puede meter al MRR a alguien que se fue.
  it('las columnas que se escriben sin plata no revierten nada', () => {
    const conColumnas = { ...seFue, fecha_pago: '2026-08-25T10:00:00Z', premium_desde: '2026-08-25' };
    expect(esBajaDeclarada(conColumnas, SIN_RETORNOS, HOY)).toBe(true);
    expect(computeRevenue([conColumnas], SIN_RETORNOS, HOY).mrr).toBe(0);
  });

  it('un pago pendiente o rechazado no es plata', () => {
    const pendiente = { ...pagoReal('u1', '2026-08-15T10:00:00Z'), estado: 'pendiente' };
    const rechazado = { ...pagoReal('u1', '2026-08-15T10:00:00Z'), estado: 'rechazado' };
    expect(esBajaDeclarada(seFue, idx([pendiente, rechazado]), HOY)).toBe(true);
  });

  it('el pago de OTRO usuario no revierte esta baja', () => {
    expect(esBajaDeclarada(seFue, idx([pagoReal('u2', '2026-08-15T10:00:00Z')]), HOY)).toBe(true);
  });

  // `pagos.monto` es NUMERIC y PostgREST lo devuelve como string: comparar '10.00' > 0 sin
  // parsear da false y ningún retorno se vería nunca.
  it('el monto llega como string desde PostgREST y se parsea', () => {
    expect(idxLiteral([pagoReal('u1', '2026-08-15T10:00:00Z')]).porUsuario.get('u1')).toHaveLength(1);
  });
});

describe('computeRevenue descuenta la baja declarada', () => {
  it('un Pro pagado que borró su cuenta NO cuenta en el MRR', () => {
    const rev = computeRevenue([
      { ...base, id: 'u1', whatsapp: '51987654321' },
      { ...base, id: 'u2', whatsapp: '51987654322', cuenta_borrada_at: BAJA },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
    expect(rev.bajasDeclaradas).toBe(1);
  });

  // El anual es el caso caro: su premium_vence lejano lo mantenía en el MRR más de un año.
  it('el anual dado de baja tampoco cuenta, ni en proYearly', () => {
    const rev = computeRevenue([
      { ...base, id: 'u1', whatsapp: '51987654321', tipo_plan: 'anual',
        cuenta_borrada_at: '2026-08-03T15:40:56Z' },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(0);
    expect(rev.proYearly).toBe(0);
    expect(rev.mrr).toBe(0);
  });

  // No se cuenta como baja DE INGRESO quien nunca estuvo en el MRR.
  it('un trial que borra su cuenta no figura como baja de ingreso', () => {
    const rev = computeRevenue([
      { ...base, id: 'u1', whatsapp: '51987654321', trial_estado: 'activo', cuenta_borrada_at: BAJA },
    ], SIN_RETORNOS, HOY);
    expect(rev.bajasDeclaradas).toBe(0);
    expect(rev.mrr).toBe(0);
  });

  // La marca NO puede tocar el entitlement: quien pagó conserva su Pro si vuelve, y los ~40
  // gates que miran `plan` tienen que seguir viendo exactamente lo mismo.
  it('la baja no cambia esProPagado (es métrica, no permiso)', () => {
    const u = { ...base, id: 'u1', whatsapp: '51987654321', cuenta_borrada_at: BAJA };
    expect(esProPagado(u)).toBe(true);
    expect(esProActivo(u, SIN_RETORNOS, HOY)).toBe(false);
  });
});

// ── Coherencia entre métricas ───────────────────────────────────────────────
//
// El primer intento descontaba la baja SOLO de computeRevenue. El numerador del churn
// quedaba igual y la base la seguía contando, así que dos clientes que se iban BAJABAN la
// tasa de churn — y como `ltvProPen = margen / churn`, subían el LTV. La señal más fuerte
// de abandono que tiene el producto mejoraba los números.
describe('la baja declarada es coherente en TODAS las métricas', () => {
  const proActivo = { ...base, id: 'u1', whatsapp: '51987654321' };
  const proQueSeFue = { ...base, id: 'u2', whatsapp: '51987654322', cuenta_borrada_at: BAJA };

  it('la baja SUBE el churn, no lo baja', () => {
    const solos = computeChurn([proActivo], HOY, SIN_RETORNOS).rate;
    const conBaja = computeChurn([proActivo, proQueSeFue], HOY, SIN_RETORNOS);
    expect(conBaja.rate).toBeGreaterThan(solos);
    expect(conBaja.churned).toBe(1);
  });

  // El anual que se fue en agosto vence en 2027: sin mirar `cuenta_borrada_at` no aparecía
  // como churn hasta dentro de once meses.
  it('el anual dado de baja cuenta como churn HOY, no cuando vence', () => {
    const anualQueSeFue = { ...base, id: 'u3', whatsapp: '51987654323', tipo_plan: 'anual',
      premium_vence: '2027-07-01', cuenta_borrada_at: '2026-08-03T15:40:56Z' };
    expect(computeChurn([anualQueSeFue], HOY, SIN_RETORNOS).churned).toBe(1);
  });

  it('una baja no cuenta como Pro activo en la base del churn', () => {
    expect(computeChurn([proQueSeFue], HOY, SIN_RETORNOS).rate).toBe(100);
  });

  // El error espejo, que encontró la segunda revisión sobre el arreglo de la primera: las
  // ramas nuevas entraban con solo mirar `cuenta_borrada_at`, así que un FREE que borraba
  // sus datos entraba al numerador mientras la base solo contaba pagadores.
  it('un FREE que borra sus datos no es churn', () => {
    const free = { plan: 'free', tipo_plan: null, trial_estado: 'vencido',
      id: 'u4', whatsapp: '51987654324', cuenta_borrada_at: '2026-08-10T00:00:00Z' };
    const trial = { plan: 'premium', tipo_plan: 'mensual', trial_estado: 'activo',
      id: 'u5', whatsapp: '51987654325', cuenta_borrada_at: '2026-08-10T00:00:00Z' };
    expect(computeChurn([proActivo, free, trial], HOY, SIN_RETORNOS).churned).toBe(0);
    expect(churnedInMonth([free, trial], new Date('2026-08-01'), new Date('2026-08-31'), SIN_RETORNOS)).toBe(0);
  });

  it('el histórico la suelta en SU mes, no en el actual', () => {
    const finJulio = new Date('2026-07-31T23:59:59Z');
    const finAgosto = new Date('2026-08-31T23:59:59Z');
    const u = { ...proQueSeFue, premium_desde: '2026-07-01', premium_vence: '2026-09-08' };
    expect(wasProAtMonthEnd(u, finJulio, SIN_RETORNOS)).toBe(true);
    expect(wasProAtMonthEnd(u, finAgosto, SIN_RETORNOS)).toBe(false);
  });

  // El que se fue y VOLVIÓ. `esBajaDeclarada` es una pregunta sobre HOY; usarla dentro de
  // una función sobre el cierre del mes X le cobraba MRR por los meses en que tenía la
  // cuenta borrada, solo porque más adelante volvió a pagar.
  it('el que volvió sigue fuera de los meses en que estuvo borrado', () => {
    const volvio = { ...base, id: 'u6', whatsapp: '51987654326',
      cuenta_borrada_at: '2026-06-10T00:00:00Z', premium_desde: '2026-05-01', premium_vence: '2026-09-30' };
    // Los DOS pagos: el del alta de mayo y el del retorno de agosto. El de mayo no es
    // decorado — sin él este usuario nunca pagó antes de junio, o sea que era una cortesía, y
    // el caso dejaría de hablar de bajas para hablar de otra cosa.
    const pagos = idx([
      pagoReal('u6', '2026-05-01T10:00:00Z'),
      pagoReal('u6', '2026-08-05T10:00:00Z'),
    ]);
    expect(esBajaDeclarada(volvio, pagos, HOY)).toBe(false); // hoy es cliente
    expect(wasProAtMonthEnd(volvio, new Date('2026-05-31T23:59:59Z'), pagos)).toBe(true);
    expect(wasProAtMonthEnd(volvio, new Date('2026-06-30T23:59:59Z'), pagos)).toBe(false);
    expect(wasProAtMonthEnd(volvio, new Date('2026-07-31T23:59:59Z'), pagos)).toBe(false);
    expect(wasProAtMonthEnd(volvio, new Date('2026-08-31T23:59:59Z'), pagos)).toBe(true);
    expect(mrrAtMonthEnd([volvio], new Date('2026-07-31T23:59:59Z'), pagos)).toBe(0);
    expect(mrrAtMonthEnd([volvio], new Date('2026-08-31T23:59:59Z'), pagos)).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  // Irse y volver en el MISMO mes: la fila del chart reporta los DOS eventos y reconcilia.
  //
  // La primera versión suprimía la baja en este caso, con el argumento de "no contradecir al
  // MRR", y lograba justo lo contrario: `newProInMonth` sí veía el retorno, así que agosto
  // decía **+1 Pro nuevo con el MRR plano** y ninguna columna explicaba de dónde salía. Con
  // los dos eventos, `+1 − 1 = 0` es exactamente el movimiento del MRR. Lo encontró la
  // revisión del ARREGLO, no la del cambio original.
  it('irse y volver en el mismo mes deja UN alta y UNA baja que se cancelan', () => {
    const ida = { ...base, id: 'u7', whatsapp: '51987654327',
      cuenta_borrada_at: '2026-08-03T00:00:00Z', premium_desde: '2026-07-01', premium_vence: '2026-09-30' };
    const pagos = idx([pagoReal('u7', '2026-08-15T10:00:00Z')]);
    const ini = new Date('2026-08-01T05:00:00Z');
    const fin = new Date('2026-09-01T04:59:59.999Z');
    expect(wasProAtMonthEnd(ida, fin, pagos)).toBe(true); // el mes cierra con él pagando
    expect(churnedInMonth([ida], ini, fin, pagos)).toBe(1);
    expect(newProInMonth([ida], ini, fin, pagos)).toBe(1); // +1 − 1 = 0, el MRR no se movió
  });

  // Y el caso que originó el hallazgo: sin la baja reportada, la fila decía "+1 Pro nuevo"
  // sobre un MRR que no se movía.
  it('el retorno nunca aparece solo: si hay alta hay baja en la misma fila', () => {
    const volvioEnAgosto = { ...base, id: 'u7', whatsapp: '51987654327',
      premium_desde: '2026-03-10', cuenta_borrada_at: '2026-08-05T00:00:00Z' };
    const pagos = idx([pagoReal('u7', '2026-08-10T10:00:00Z')]);
    const ini = new Date('2026-08-01T05:00:00Z');
    const fin = new Date('2026-09-01T04:59:59.999Z');
    expect(newProInMonth([volvioEnAgosto], ini, fin, pagos)).toBe(1);
    expect(churnedInMonth([volvioEnAgosto], ini, fin, pagos)).toBe(1);
  });
});

// ── Lo que las revisiones adversariales encontraron sin testigo ─────────────
//
// Todo este bloque existe porque una mutación lo dejaba en verde. No son casos hipotéticos:
// cada uno mata una mutación concreta que antes pasaba.
describe('el índice de pagos: los detalles que ninguna aserción sostenía', () => {
  const seFue = { ...base, id: 'u1', whatsapp: '51987654321', cuenta_borrada_at: BAJA };

  // Lo que este caso fija es que un monto corrupto NO cuenta como plata. Lo que NO fija —y
  // conviene saberlo antes de creerle de más— es el `parseFloat`: `isNaN` coacciona el
  // string igual, así que la mutación que lo saca deja este test en verde. No hay input
  // realista de un NUMERIC que separe las dos versiones; está anotado en el código.
  it('un monto no numérico no es plata', () => {
    const basura = { usuario_id: 'u1', monto: 'abc', estado: 'aprobado',
      aprobado_at: '2026-08-15T10:00:00Z', created_at: '2026-08-15T10:00:00Z' };
    expect(idxLiteral([basura]).porUsuario.get('u1')).toBeUndefined();
    expect(esBajaDeclarada(seFue, idx([basura]), HOY)).toBe(true);
  });

  // `pagos.aprobado_at` es NULLABLE y no hay constraint que lo ate a `estado='aprobado'`.
  // Sin el fallback a `created_at`, ese pago no entra al índice y el cliente que volvió
  // queda descontado del MRR para siempre — el modo de falla que el cargador declara
  // inaceptable. Todos los casos de arriba ponen las dos fechas iguales, así que ninguno
  // ejercitaba el fallback.
  it('sin aprobado_at cae a created_at', () => {
    const sinAprobado = { usuario_id: 'u1', monto: '10.00', estado: 'aprobado',
      aprobado_at: null, created_at: '2026-08-15T10:00:00Z' };
    expect(esBajaDeclarada(seFue, idx([sinAprobado]), HOY)).toBe(false);
  });

  // Y el orden importa en el otro sentido: manda `aprobado_at`, que es cuando la plata se
  // confirmó. Un comprobante SUBIDO antes de la baja y APROBADO después es un retorno.
  it('manda aprobado_at sobre created_at cuando difieren', () => {
    const creadoAntesAprobadoDespues = { usuario_id: 'u1', monto: '10.00', estado: 'aprobado',
      created_at: '2026-08-01T10:00:00Z', aprobado_at: '2026-08-15T10:00:00Z' };
    expect(esBajaDeclarada(seFue, idx([creadoAntesAprobadoDespues]), HOY)).toBe(false);
    const creadoDespuesAprobadoAntes = { usuario_id: 'u1', monto: '10.00', estado: 'aprobado',
      created_at: '2026-08-15T10:00:00Z', aprobado_at: '2026-08-01T10:00:00Z' };
    expect(esBajaDeclarada(seFue, idx([creadoDespuesAprobadoAntes]), HOY)).toBe(true);
  });

  // El límite estricto por la izquierda estaba declarado en un comentario y no probado.
  it('un pago en el MISMO instante que la baja no es un retorno', () => {
    expect(esBajaDeclarada(seFue, idx([pagoReal('u1', BAJA)]), HOY)).toBe(true);
  });

  // Igual la guarda de fecha ilegible: dos comportamientos posibles y ninguno fijado. El
  // elegido es dejarlo DENTRO del MRR — una fecha corrupta no es prueba de que alguien pidió
  // la baja, y sacar plata del ingreso pide más evidencia que meterla.
  it('una cuenta_borrada_at ilegible no saca a nadie del MRR', () => {
    const rota = { ...base, id: 'u9', whatsapp: '51987654329', cuenta_borrada_at: 'no-es-fecha' };
    expect(esBajaDeclarada(rota, SIN_RETORNOS, HOY)).toBe(false);
    expect(computeRevenue([rota], SIN_RETORNOS, HOY).mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });
});

// El bug que encontró la segunda revisión: `esBajaDeclarada` preguntaba "alguna vez"
// (Infinity) y `computeChurn` preguntaba por `now`. Dos instantes = dos universos, que es
// exactamente la clase que este cambio vino a cerrar, con el signo invertido.
describe('todas las métricas preguntan por el MISMO instante', () => {
  it('un pago con fecha FUTURA no revive a nadie, ni en el MRR ni en el churn', () => {
    const seFue = { ...base, id: 'u1', whatsapp: '51987654321', cuenta_borrada_at: BAJA };
    // Con su pago real de julio, además del futuro: sin el primero sería un Pro que nunca
    // pagó, o sea una cortesía, y saldría del churn por otro motivo que el que mide el caso.
    const futuro = idx([
      pagoReal('u1', '2026-07-01T00:00:00Z'),
      pagoReal('u1', '2027-01-01T00:00:00Z'),
    ]);
    // Con dos instantes distintos, este usuario entraba al MRR (retorno "alguna vez") y al
    // numerador del churn (todavía de baja según `now`): sumaba en los dos lados del ratio.
    const rev = computeRevenue([seFue], futuro, HOY);
    const churn = computeChurn([seFue], HOY, futuro);
    expect(rev.proCount).toBe(0);
    expect(rev.bajasDeclaradas).toBe(1);
    expect(churn.churned).toBe(1);
    expect(churn.rate).toBe(100); // numerador 1, base 0: no está de los dos lados
  });

  it('una baja con fecha FUTURA todavía no es baja', () => {
    const futura = { ...base, id: 'u1', whatsapp: '51987654321',
      cuenta_borrada_at: '2027-01-01T00:00:00Z' };
    const rev = computeRevenue([futura], SIN_RETORNOS, HOY);
    // Antes salía del MRR (`baja > Infinity` es falso) y se quedaba en la base del churn.
    expect(rev.proCount).toBe(1);
    expect(rev.bajasDeclaradas).toBe(0);
    expect(computeChurn([futura], HOY, SIN_RETORNOS).churned).toBe(0);
  });
});

// El chart de 6 meses tiene tres columnas por fila y las tres tienen que contar la misma
// historia. Una reactivación subía el MRR con `new_pro = 0` Y `churned = 0`: las dos únicas
// columnas que existen para explicar el delta decían cero.
describe('newProInMonth ve las reactivaciones', () => {
  const AGO_START = new Date('2026-08-01T05:00:00Z');
  const AGO_END = new Date('2026-08-31T23:59:59Z');

  const volvio = { ...base, id: 'u6', whatsapp: '51987654326',
    cuenta_borrada_at: '2026-06-10T00:00:00Z', premium_desde: '2026-05-01', premium_vence: '2026-09-30' };

  it('el que vuelve cuenta como alta del mes en que volvió', () => {
    // Los DOS pagos: el del alta de mayo y el del retorno de agosto. El de mayo no es
    // decorado — sin él este usuario nunca pagó antes de junio, o sea que era una cortesía, y
    // el caso dejaría de hablar de bajas para hablar de otra cosa.
    const pagos = idx([
      pagoReal('u6', '2026-05-01T10:00:00Z'),
      pagoReal('u6', '2026-08-05T10:00:00Z'),
    ]);
    expect(newProInMonth([volvio], AGO_START, AGO_END, pagos)).toBe(1);
    // Y no en los meses en que estuvo borrado.
    expect(newProInMonth([volvio], new Date('2026-07-01T05:00:00Z'), new Date('2026-07-31T23:59:59Z'), pagos)).toBe(0);
  });

  it('`premium_desde` no se mueve al volver, por eso hace falta la segunda rama', () => {
    // Es el motivo real: `activarPro` hace `usuario.premium_desde || hoy`, así que la fecha
    // de alta del que vuelve sigue siendo la vieja y la rama original no lo ve nunca.
    expect(newProInMonth([volvio], AGO_START, AGO_END, SIN_RETORNOS)).toBe(0);
  });

  it('el alta y la baja en el mismo mes siguen contando como alta (el caso real de agosto)', () => {
    // Pagó el 08-ago y borró el 09-ago: es un alta de agosto aunque hoy tenga la marca.
    const altaYBaja = { ...base, id: 'u2', whatsapp: '51987654322',
      premium_desde: '2026-08-08', cuenta_borrada_at: BAJA };
    expect(newProInMonth([altaYBaja], AGO_START, AGO_END, SIN_RETORNOS)).toBe(1);
  });

  it('nadie se cuenta dos veces aunque su alta y su retorno caigan en el mismo mes', () => {
    const dobles = { ...base, id: 'u8', whatsapp: '51987654328',
      premium_desde: '2026-08-02', cuenta_borrada_at: '2026-08-03T00:00:00Z' };
    const pagos = idx([pagoReal('u8', '2026-08-10T10:00:00Z')]);
    expect(newProInMonth([dobles], AGO_START, AGO_END, pagos)).toBe(1);
  });
});

// ── El día 1, que es donde el arreglo anterior rompió algo que andaba ───────
//
// `monthWindowLima` movió el borde del mes de 00:00Z a 05:00Z para que un timestamptz
// (`cuenta_borrada_at`) cayera en el mes Lima correcto. Con eso desalineó a las columnas
// DATE, que sí andaban: `new Date('2026-08-01')` da 00:00Z, cinco horas ANTES del nuevo
// inicio de agosto, así que toda fecha del día 1 se caía al mes anterior. Medido contra
// producción el 18-ago: 1 usuario con `premium_desde` en día 1 y 2 con `premium_vence` en
// día 1, y crece ~1 de cada 30 altas.
describe('las columnas DATE del día 1 caen en SU mes, no en el anterior', () => {
  const AGO = {
    ini: new Date('2026-08-01T05:00:00Z'),
    fin: new Date('2026-09-01T04:59:59.999Z'),
  };
  const JUL = {
    ini: new Date('2026-07-01T05:00:00Z'),
    fin: new Date('2026-08-01T04:59:59.999Z'),
  };

  const altaDia1 = { ...base, id: 'd1', whatsapp: '51987654331', premium_desde: '2026-08-01' };

  it('un alta del día 1 es alta de SU mes', () => {
    expect(newProInMonth([altaDia1], AGO.ini, AGO.fin, SIN_RETORNOS)).toBe(1);
    expect(newProInMonth([altaDia1], JUL.ini, JUL.fin, SIN_RETORNOS)).toBe(0);
  });

  it('y no era Pro al cierre del mes ANTERIOR', () => {
    // Con el parseo UTC, `premium_desde` quedaba dentro de julio y este usuario contaba
    // como Pro al cierre de un mes en el que todavía no lo era: MRR inflado un mes antes.
    expect(wasProAtMonthEnd(altaDia1, JUL.fin, SIN_RETORNOS)).toBe(false);
    expect(mrrAtMonthEnd([altaDia1], JUL.fin, SIN_RETORNOS)).toBe(0);
    expect(wasProAtMonthEnd(altaDia1, AGO.fin, SIN_RETORNOS)).toBe(true);
  });

  it('un vencimiento del día 1 sigue vigente al cierre del mes anterior', () => {
    // `premium_vence` es el día hasta el que corre la suscripción. Con el parseo UTC caía
    // cinco horas antes del cierre de julio y este usuario salía del MRR de julio, un mes
    // antes de vencer.
    const venceDia1 = { ...base, id: 'd4', whatsapp: '51987654334',
      premium_desde: '2026-06-01', premium_vence: '2026-08-01' };
    expect(wasProAtMonthEnd(venceDia1, JUL.fin, SIN_RETORNOS)).toBe(true);
    expect(mrrAtMonthEnd([venceDia1], JUL.fin, SIN_RETORNOS)).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  // El borde de la ventana de 30 días cae a una hora cualquiera, no a medianoche, así que
  // ahí las cinco horas de diferencia entre las dos lecturas de la fecha sí separan.
  it('el borde de los 30 días se mide en día Lima', () => {
    const ahoraConHora = new Date('2026-08-20T03:00:00Z'); // thirtyAgo = 21-jul 03:00Z
    const venceJusto = { plan: 'free', tipo_plan: 'mensual', trial_estado: 'vencido',
      id: 'd5', whatsapp: '51987654335', premium_vence: '2026-07-21' };
    // Lima: 21-jul 05:00Z, DENTRO de la ventana. Parseado como UTC: 00:00Z, fuera.
    expect(computeChurn([venceJusto], ahoraConHora, SIN_RETORNOS).churned).toBe(1);
  });

  it('un vencimiento del día 1 churnea en SU mes', () => {
    const venceDia1 = { plan: 'free', tipo_plan: 'mensual', trial_estado: 'vencido',
      id: 'd2', whatsapp: '51987654332', premium_vence: '2026-08-01' };
    expect(churnedInMonth([venceDia1], AGO.ini, AGO.fin, SIN_RETORNOS)).toBe(1);
    expect(churnedInMonth([venceDia1], JUL.ini, JUL.fin, SIN_RETORNOS)).toBe(0);
  });

  it('el churn de 30 días también mide el vencimiento en día Lima', () => {
    // Ventana [21-jul, 20-ago). Un vencimiento el 21-jul es el borde exacto: en Lima entra,
    // parseado como UTC queda cinco horas antes y se pierde.
    const venceEnElBorde = { plan: 'free', tipo_plan: 'mensual', trial_estado: 'vencido',
      id: 'd3', whatsapp: '51987654333', premium_vence: '2026-07-21' };
    expect(computeChurn([venceEnElBorde], HOY, SIN_RETORNOS).churned).toBe(1);
  });
});

// ── Pro de cortesía ─────────────────────────────────────────────────────────
//
// El 2026-09-01 el panel mostraba 11 "Pro pagado" y S/10 de esos eran un regalo: Favio le
// activó Pro a su hermana con el botón "Extender +30 días", que escribe `plan='premium'` y
// `estado_pago='pagado'` — la misma fila que deja un pago real — y no registra nada en
// `pagos`. El comentario del código afirmaba que un comp SÍ se registra con monto 0; medido
// contra producción, ninguno de los tres caminos que regalan Pro escribía esa fila.
describe('la cortesía no es MRR', () => {
  const regalado = { ...base, id: 'c1', whatsapp: '51987654321' };
  const pagador = { ...base, id: 'c2', whatsapp: '51987654322' };

  /** Índice donde SOLO `c2` pagó. `c1` es el Pro de cortesía. */
  const pagos = (): PagosConPlata => ({
    dominio: DOMINIO_ABIERTO,
    porUsuario: new Map([['c2', [Date.parse('2026-08-01T00:00:00Z')]]]),
  });

  it('un Pro sin un solo pago con plata es cortesía', () => {
    expect(esCortesia(regalado, pagos(), HOY)).toBe(true);
    expect(esCortesia(pagador, pagos(), HOY)).toBe(false);
  });

  it('un trial no es cortesía: no es Pro pagado, y ya sale del MRR por otro lado', () => {
    expect(esCortesia({ ...regalado, trial_estado: 'activo' }, pagos(), HOY)).toBe(false);
  });

  it('sale del MRR y se reporta aparte, en vez de descontarse en silencio', () => {
    const rev = computeRevenue([regalado, pagador], pagos(), HOY);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
    expect(rev.proCount).toBe(1);
    expect(rev.cortesias).toBe(1);
  });

  it('no es Pro activo', () => {
    expect(esProActivo(regalado, pagos(), HOY)).toBe(false);
    expect(esProActivo(pagador, pagos(), HOY)).toBe(true);
  });

  // El día que la persona paga, vuelve al MRR sin que nadie toque una marca. Es la razón de
  // derivarlo en vez de guardarlo en una columna: no hay estado que sincronizar.
  it('el pago la convierte en cliente sin intervención', () => {
    const conPago: PagosConPlata = {
      dominio: DOMINIO_ABIERTO,
      porUsuario: new Map([['c1', [Date.parse('2026-08-15T00:00:00Z')]]]),
    };
    expect(esCortesia(regalado, conPago, HOY)).toBe(false);
    expect(computeRevenue([regalado], conPago, HOY).mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  // `esCortesiaAl` toma un instante por el mismo motivo que `bajaVigenteAl`: sin techo, quien
  // recibió cortesía en julio y pagó en septiembre aparecería cobrando MRR en julio.
  it('en el histórico se pregunta por el cierre de ESE mes, no por hoy', () => {
    const pagoTardio: PagosConPlata = {
      dominio: DOMINIO_ABIERTO,
      porUsuario: new Map([['c1', [Date.parse('2026-08-15T00:00:00Z')]]]),
    };
    const finJulio = Date.parse('2026-07-31T23:59:59Z');
    expect(esCortesiaAl(regalado, pagoTardio, finJulio)).toBe(true);
    expect(esCortesiaAl(regalado, pagoTardio, HOY.getTime())).toBe(false);
    expect(wasProAtMonthEnd({ ...regalado, premium_desde: '2026-06-01' },
      new Date(finJulio), pagoTardio)).toBe(false);
    expect(mrrAtMonthEnd([{ ...regalado, premium_desde: '2026-06-01' }],
      new Date(finJulio), pagoTardio)).toBe(0);
  });

  // Está fuera de los DOS lados del ratio de churn. Contarla en uno solo movería la tasa sin
  // que se hubiera ido nadie — es exactamente el error que costó la segunda revisión del
  // cambio de bajas, con el signo invertido.
  it('no entra al churn ni al numerador ni a la base', () => {
    const vencido = { ...regalado, plan: 'free', trial_estado: 'convertido',
      premium_vence: '2026-08-10' };
    const churn = computeChurn([vencido, pagador], HOY, pagos());
    expect(churn.churned).toBe(0);
    expect(churnedInMonth([regalado], new Date('2026-08-01T05:00:00Z'),
      new Date('2026-08-31T23:59:59Z'), pagos())).toBe(0);
  });

  it('una cortesía no cuenta como Pro nuevo del mes', () => {
    const conAlta = { ...regalado, premium_desde: '2026-08-05' };
    expect(newProInMonth([conAlta], new Date('2026-08-01T05:00:00Z'),
      new Date('2026-08-31T23:59:59Z'), pagos())).toBe(0);
  });

  // Cuando alguien es baja Y cortesía, se cuenta UNA vez. No cambia el MRR (los dos salen),
  // sí el desglose que lo explica en la pantalla.
  it('la baja gana sobre la cortesía en el desglose', () => {
    const ambas = { ...regalado, cuenta_borrada_at: '2026-08-09T00:00:00Z' };
    const rev = computeRevenue([ambas], pagos(), HOY);
    expect(rev.bajasDeclaradas).toBe(1);
    expect(rev.cortesias).toBe(0);
    expect(rev.mrr).toBe(0);
  });
});

// ── El dominio del índice ───────────────────────────────────────────────────
//
// `cargarPagosConPlata` acota la lectura a una lista de ids. Mientras la única pregunta fue
// "¿alguno volvió?", `/api/admin/stats` le pasaba solo los que pidieron la baja y alcanzaba.
// Preguntarle a ESE índice "¿a este le entró plata?" responde que no sobre todos los
// pagadores del producto: el MRR se va a cero sin un solo error en pantalla. Estos casos
// fijan que eso lance en vez de contestar un número falso.
describe('preguntar fuera del dominio del índice es un error, no un "no"', () => {
  const acotado: PagosConPlata = { dominio: new Set(['otro']), porUsuario: new Map() };
  const pagador = { ...base, id: 'p1', whatsapp: '51987654321' };

  it('lanza en vez de devolver "no tiene pagos"', () => {
    expect(() => esCortesia(pagador, acotado, HOY)).toThrow(/no cubre a p1/);
    expect(() => computeRevenue([pagador], acotado, HOY)).toThrow(/no cubre a p1/);
  });

  /**
   * La defensa del ÚNICO lector que no pasa por una métrica: `/api/admin/users` deriva
   * `tiene_pago` para el badge, y esa ruta no llama a `computeRevenue`, así que el guard
   * estático de call-sites no puede comparar poblaciones ahí. Una revisión adversarial acotó
   * esa población a la lista corta de bajas y el guard quedó verde: `tiene_pago` daba `false`
   * para todos los pagadores y el panel pintaba "Pro cortesía" sobre cada cliente que paga,
   * sin un error visible. Lo que cierra ese caso es que el lector pase por el dominio.
   */
  it('leer el índice para el badge también exige el dominio', () => {
    expect(() => tienePagoConPlata(pagador, acotado)).toThrow(/no cubre a p1/);
  });

  it('también lanza para el testigo de la baja', () => {
    const seFue = { ...pagador, cuenta_borrada_at: BAJA };
    expect(() => esBajaDeclarada(seFue, acotado, HOY)).toThrow(/no cubre a p1/);
  });

  it('un usuario sin id no se puede responder', () => {
    const sinId = { ...base, whatsapp: '51987654321' };
    expect(() => esCortesia(sinId, acotado, HOY)).toThrow(/sin `id`/);
  });

  // La lista que arma el dominio tiene que cubrir las TRES preguntas de este archivo. Un
  // usuario free y sin historial de Pro no entra: nadie le pregunta nada.
  it('idsParaIndicePagos cubre pagadores, ex-Pro y bajas, y nada más', () => {
    const ids = idsParaIndicePagos([
      { ...base, id: 'pagador' },
      { ...base, id: 'exPro', plan: 'free', premium_desde: '2026-05-01' },
      // Vencimiento SIN fecha de alta: es lo que deja el panel admin al dar Pro a mano, y al
      // 2026-09-01 hay 4 filas así en producción. El churn le pregunta a este usuario, así que
      // sin esta rama el índice no lo cubre y la ruta entera revienta.
      { ...base, id: 'venceSinAlta', plan: 'free', premium_vence: '2026-08-10' },
      { ...base, id: 'baja', plan: 'free', trial_estado: null, cuenta_borrada_at: BAJA },
      { ...base, id: 'free', plan: 'free', trial_estado: 'vencido' },
      { ...base, id: 'trial', trial_estado: 'activo' },
    ]);
    expect([...ids].sort()).toEqual(['baja', 'exPro', 'pagador', 'venceSinAlta']);
  });

  // El caso que motivó separar `nuncaPagoAl` de `esCortesiaAl`: acá el usuario ya es FREE, así
  // que `esProPagado` es false y la cortesía contesta "no" sin haber mirado un solo pago. Con
  // ese predicado, una cortesía que vence entraba al churn como un cliente que se fue.
  it('una cortesía vencida no es churn: nunca hubo ingreso que perder', () => {
    const cortesiaVencida = { ...base, id: 'v1', plan: 'free', trial_estado: 'convertido',
      premium_vence: '2026-08-10' };
    const clienteVencido = { ...base, id: 'v2', plan: 'free', trial_estado: 'convertido',
      premium_vence: '2026-08-10' };
    const pagos: PagosConPlata = {
      dominio: new Set(['v1', 'v2']),
      porUsuario: new Map([['v2', [Date.parse('2026-07-01T00:00:00Z')]]]),
    };
    expect(computeChurn([cortesiaVencida], HOY, pagos).churned).toBe(0);
    // Anti-vacuidad: el mismo caso con un pago de verdad SÍ es churn, así que el cero de
    // arriba no viene de que el fixture no llegue nunca a la rama del vencimiento.
    expect(computeChurn([clienteVencido], HOY, pagos).churned).toBe(1);
    const AGO = [new Date('2026-08-01T05:00:00Z'), new Date('2026-08-31T23:59:59Z')] as const;
    expect(churnedInMonth([cortesiaVencida], AGO[0], AGO[1], pagos)).toBe(0);
    expect(churnedInMonth([clienteVencido], AGO[0], AGO[1], pagos)).toBe(1);
  });

  // Anti-vacuidad de lo de arriba: con la lista bien armada, las métricas NO lanzan. Sin este
  // caso, un `idsParaIndicePagos` que devolviera todo pasaría el test anterior por accidente
  // y este archivo no notaría la diferencia.
  it('con la lista bien armada, las métricas corren', () => {
    const users = [pagador, { ...base, id: 'p2', plan: 'free', trial_estado: 'vencido' }];
    const idxOk: PagosConPlata = {
      dominio: new Set(idsParaIndicePagos(users)),
      porUsuario: new Map([['p1', [Date.parse('2026-08-01T00:00:00Z')]]]),
    };
    expect(() => computeRevenue(users, idxOk, HOY)).not.toThrow();
    expect(computeRevenue(users, idxOk, HOY).mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });
});

// ── Las dos regresiones que encontró la revisión adversarial ────────────────
//
// Los casos de este archivo usan `DOMINIO_ABIERTO`, o sea que ninguno podía ver el primero:
// con un índice que responde por cualquiera, un predicado que pregunta de más no se nota. Acá
// el dominio se arma con la MISMA función que usan las rutas, sobre la MISMA población.
describe('las métricas corren sobre una población real, sin preguntar de más', () => {
  // Una base como la de producción: pagadores, gente en prueba, free que nunca tuvo Pro, y
  // ex-Pro vencidos. Los tres últimos grupos NO entran al índice de pagos.
  const POBLACION = [
    { ...base, id: 'pagador', whatsapp: '51987654321' },
    { ...base, id: 'trial', whatsapp: '51987654322', trial_estado: 'activo' },
    { ...base, id: 'free', whatsapp: '51987654323', plan: 'free', trial_estado: null },
    { ...base, id: 'sinEstrenar', whatsapp: '51987654324', plan: 'free', trial_estado: null },
    { ...base, id: 'exPro', whatsapp: '51987654325', plan: 'free', trial_estado: 'convertido',
      premium_desde: '2026-05-01', premium_vence: '2026-08-10' },
  ];
  const indice = (): PagosConPlata => ({
    dominio: new Set(idsParaIndicePagos(POBLACION)),
    porUsuario: new Map([
      ['pagador', [Date.parse('2026-07-01T00:00:00Z')]],
      ['exPro', [Date.parse('2026-05-01T00:00:00Z')]],
    ]),
  });

  // Antivacuidad: si el dominio cubriera a todos, estos casos pasarían sin medir nada. Lo que
  // los hace valer es que TRES de los cinco quedan afuera a propósito.
  it('la población de prueba deja usuarios fuera del dominio', () => {
    expect([...idsParaIndicePagos(POBLACION)].sort()).toEqual(['exPro', 'pagador']);
  });

  // El bug: `computeChurn` y `churnedInMonth` consultaban el índice como PRIMERA línea del
  // predicado, sobre todos los usuarios reales. Un free —o alguien en prueba— caía fuera del
  // dominio, `pagosDe` lanzaba, y las dos rutas del panel devolvían 500. Con cualquier base
  // real, o sea siempre.
  it('el churn no le pregunta al índice por quien no puede ser churn', () => {
    expect(() => computeChurn(POBLACION, HOY, indice())).not.toThrow();
    expect(() =>
      churnedInMonth(POBLACION, new Date('2026-08-01T05:00:00Z'),
        new Date('2026-08-31T23:59:59Z'), indice()),
    ).not.toThrow();
    // Y sigue contando lo que tiene que contar: el ex-Pro venció el 10-ago, dentro de los 30
    // días previos a HOY (20-ago), y sí había pagado.
    expect(computeChurn(POBLACION, HOY, indice()).churned).toBe(1);
  });

  it('ninguna de las otras métricas pregunta de más tampoco', () => {
    const [ini, fin] = [new Date('2026-08-01T05:00:00Z'), new Date('2026-08-31T23:59:59Z')];
    expect(() => computeRevenue(POBLACION, indice(), HOY)).not.toThrow();
    expect(() => mrrAtMonthEnd(POBLACION, fin, indice())).not.toThrow();
    expect(() => newProInMonth(POBLACION, ini, fin, indice())).not.toThrow();
  });
});

// La segunda: `newProInMonth` DOCUMENTABA que la cortesía que paga cuenta como alta del mes en
// que pagó, y no lo implementaba. Sus dos ramas eran `premium_desde` —que la cortesía ya traía
// del regalo— y `primerRetorno`, que exige `cuenta_borrada_at`.
describe('la cortesía que empieza a pagar es un alta de ESE mes', () => {
  const AGO = [new Date('2026-08-01T05:00:00Z'), new Date('2026-08-31T23:59:59Z')] as const;
  const JUL_FIN = new Date('2026-07-31T23:59:59Z');
  // Regalo en junio, primer pago el 15 de agosto. `premium_desde` NO se mueve al pagar.
  const convertida = { ...base, id: 'k1', whatsapp: '51987654321', premium_desde: '2026-06-01' };
  const pagos: PagosConPlata = {
    dominio: new Set(['k1']),
    porUsuario: new Map([['k1', [Date.parse('2026-08-15T00:00:00Z')]]]),
  };

  it('el MRR se mueve y la columna que lo explica no dice cero', () => {
    // Sin la rama, esto era 0 con el MRR saltando de 0 a 10 en la misma fila del chart.
    expect(newProInMonth([convertida], AGO[0], AGO[1], pagos)).toBe(1);
    expect(mrrAtMonthEnd([convertida], JUL_FIN, pagos)).toBe(0);
    expect(mrrAtMonthEnd([convertida], AGO[1], pagos)).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('y no la cuenta dos veces ni la anticipa a los meses de regalo', () => {
    expect(newProInMonth([convertida], new Date('2026-06-01T05:00:00Z'),
      JUL_FIN, pagos)).toBe(0);
    // Setiembre: ya es cliente viejo, no un alta nueva.
    expect(newProInMonth([convertida], new Date('2026-09-01T05:00:00Z'),
      new Date('2026-09-30T23:59:59Z'), pagos)).toBe(0);
  });

  // Y la rama nueva no le cambia el mes a quien pagó desde el día uno: su alta sigue siendo
  // `premium_desde`, que es lo que ya funcionaba.
  it('al que pagó desde el alta no se le mueve el mes', () => {
    const normal = { ...base, id: 'k2', premium_desde: '2026-08-05' };
    const suPago: PagosConPlata = {
      dominio: new Set(['k2']),
      porUsuario: new Map([['k2', [Date.parse('2026-08-05T12:00:00Z')]]]),
    };
    expect(newProInMonth([normal], AGO[0], AGO[1], suPago)).toBe(1);
  });
});

// El doble conteo que encontró la segunda revisión adversarial, sobre el arreglo de la
// primera. `newProInMonth` tenía tres ramas en `or` y la guarda de la de `premium_desde` era
// `esCortesiaAl`, que exige ser Pro pagado HOY: apenas la fila cae a `free` deja de proteger,
// y la misma persona se contaba como alta en DOS meses.
describe('una persona tiene UNA sola fecha de alta', () => {
  const mes = (m: number) =>
    [new Date(`2026-0${m}-01T05:00:00Z`), new Date(`2026-0${m}-28T23:59:59Z`)] as const;

  // El caso medido: cortesía en junio (premium_desde se escribe sin que entre plata, vía el
  // premio de referidos o un comp), paga el 10-jul, se le vence el 10-ago. HOY es free.
  const cortesiaQuePagoYVencio = {
    ...base,
    id: 'd1',
    plan: 'free',
    trial_estado: 'convertido',
    premium_desde: '2026-06-01',
    premium_vence: '2026-08-10',
  };
  const pagos: PagosConPlata = {
    dominio: new Set(['d1']),
    porUsuario: new Map([['d1', [Date.parse('2026-07-10T00:00:00Z')]]]),
  };

  it('no cuenta el alta en el mes del regalo Y en el del pago', () => {
    const junio = newProInMonth([cortesiaQuePagoYVencio], ...mes(6), pagos);
    const julio = newProInMonth([cortesiaQuePagoYVencio], ...mes(7), pagos);
    expect(junio + julio).toBe(1);
    // Y el alta cae en el mes en que el MRR se movió, que es cuando pagó.
    expect(junio).toBe(0);
    expect(julio).toBe(1);
  });

  it('el mes del alta es el mes en que el MRR sube', () => {
    const finJunio = new Date('2026-06-30T23:59:59Z');
    const finJulio = new Date('2026-07-31T23:59:59Z');
    expect(mrrAtMonthEnd([cortesiaQuePagoYVencio], finJunio, pagos)).toBe(0);
    expect(mrrAtMonthEnd([cortesiaQuePagoYVencio], finJulio, pagos)).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  // `altaComercial` es `max(premium_desde, primer pago)`, no `min`, porque `wasProAtMonthEnd`
  // exige las DOS condiciones: que la fecha de alta haya pasado Y que ya hubiera entrado plata.
  // Con `min`, quien pagó en julio y tiene `premium_desde` en junio anunciaría su alta un mes
  // antes de aportar un sol.
  it('el alta es el más tardío de los dos instantes', () => {
    expect(altaComercial(cortesiaQuePagoYVencio, pagos)).toBe(Date.parse('2026-07-10T00:00:00Z'));
    // Y al revés: quien pagó ANTES de que le arrancara el plan, aporta desde que arrancó.
    const pagoAdelantado = { ...base, id: 'd2', premium_desde: '2026-08-01' };
    const antes: PagosConPlata = {
      dominio: new Set(['d2']),
      porUsuario: new Map([['d2', [Date.parse('2026-07-31T20:00:00Z')]]]),
    };
    expect(altaComercial(pagoAdelantado, antes)).toBe(msDeFechaLima('2026-08-01'));
  });

  it('sin un solo pago no hay alta que anunciar', () => {
    const regalo: PagosConPlata = { dominio: new Set(['d1']), porUsuario: new Map() };
    expect(altaComercial(cortesiaQuePagoYVencio, regalo)).toBeNull();
    expect(newProInMonth([cortesiaQuePagoYVencio], ...mes(6), regalo)).toBe(0);
    expect(newProInMonth([cortesiaQuePagoYVencio], ...mes(7), regalo)).toBe(0);
  });

  // La reconciliación es la propiedad de fondo del chart: cada fila tiene que poder explicar
  // su propio delta de MRR con las dos columnas que trae al lado. Se comprueba sobre la serie
  // completa, no mes a mes, porque el doble conteo aparecía en el mes DEL MEDIO.
  it('cada mes del chart explica su delta con newPro y churned', () => {
    const users = [cortesiaQuePagoYVencio];
    let previo = 0;
    for (let m = 5; m <= 9; m++) {
      const [ini, fin] = mes(m);
      const mrr = mrrAtMonthEnd(users, fin, pagos);
      const altas = newProInMonth(users, ini, fin, pagos);
      const bajas = churnedInMonth(users, ini, fin, pagos);
      // El MRR se movió si y solo si hubo un evento que lo explique.
      expect(mrr !== previo, `mes ${m}: MRR ${previo}->${mrr} con ${altas} altas y ${bajas} bajas`)
        .toBe(altas + bajas > 0);
      previo = mrr;
    }
  });
});

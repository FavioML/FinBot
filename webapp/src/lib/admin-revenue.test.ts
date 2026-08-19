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
  type PagosConPlata,
} from './admin-revenue';
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from './constants';

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

/** Nadie volvió a pagar después de irse. Es el caso de los dos usuarios reales. */
const SIN_RETORNOS: PagosConPlata = new Map<string, number[]>();

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
      { ...base, whatsapp: '51987654321' },
      { ...base, whatsapp: null, is_test_user: true },
      { ...base, whatsapp: '51999999996', is_test_user: true },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('un trial activo entrega Pro pero no factura', () => {
    const rev = computeRevenue([
      { ...base, whatsapp: '51987654321', trial_estado: 'activo' },
      { ...base, whatsapp: '51987654322' },
    ], SIN_RETORNOS, HOY);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('el anual se normaliza a mensual (precio/12)', () => {
    const rev = computeRevenue([{ ...base, tipo_plan: 'anual', whatsapp: '51987654321' }], SIN_RETORNOS, HOY);
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
const idx = (pagos: Parameters<typeof indexarPagosConPlata>[0]) => indexarPagosConPlata(pagos);

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
    expect(idx([pagoReal('u1', '2026-08-15T10:00:00Z')]).get('u1')).toHaveLength(1);
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
    const pagos = idx([pagoReal('u6', '2026-08-05T10:00:00Z')]);
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
    expect(idx([basura]).get('u1')).toBeUndefined();
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
    const futuro = idx([pagoReal('u1', '2027-01-01T00:00:00Z')]);
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
    const pagos = idx([pagoReal('u6', '2026-08-05T10:00:00Z')]);
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

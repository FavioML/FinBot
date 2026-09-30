import { describe, it, expect } from 'vitest';
import {
  resolverMes,
  primerDiaDelMes,
  fechaLima,
  etiquetaMes,
  etiquetaPagador,
  etiquetaTipoPago,
  sumaALaCaja,
  filasCsv,
  contar,
  notaNoSuma,
  CSV_HEADERS,
} from './admin-pagos';
import type { AdminPagoFila } from './types-admin';

function fila(parcial: Partial<AdminPagoFila> = {}): AdminPagoFila {
  return {
    id: 'p1',
    usuario_id: 'u1',
    cuando: '2026-09-14T15:00:00+00:00',
    monto: 10,
    tipo_plan: 'mensual',
    metodo_pago: 'yape',
    origen: 'webapp',
    estado: 'aprobado',
    aprobado_por: 'admin:telegram',
    premium_desde: '2026-09-14',
    premium_vence: '2026-10-14',
    n_pago: 1,
    tipo_plan_anterior: null,
    interno: false,
    tiene_comprobante: true,
    nombre: 'Luis',
    whatsapp: '51900000000',
    email: 'luis@example.com',
    cuenta_borrada: false,
    ...parcial,
  };
}

describe('resolverMes', () => {
  it('sin parámetro es el mes en curso EN LIMA, no el del servidor en UTC', () => {
    // 30-sep 21:00 Lima = 1-oct 02:00 UTC. En UTC ya sería octubre.
    expect(resolverMes(null, new Date('2026-10-01T02:00:00Z'))).toBe('2026-09');
    expect(resolverMes('', new Date('2026-10-01T06:00:00Z'))).toBe('2026-10');
  });

  it('acepta YYYY-MM y rechaza lo mal formado en vez de caer a otro mes', () => {
    expect(resolverMes('2026-09')).toBe('2026-09');
    expect(resolverMes('2026-13')).toBeNull();
    expect(resolverMes('2026-9')).toBeNull();
    expect(resolverMes('2026-09-01')).toBeNull();
    expect(resolverMes("2026-09'; drop")).toBeNull();
    // Postgres rechaza el año 0: tiene que ser 400 acá, no 500 en la RPC.
    expect(resolverMes('0000-01')).toBeNull();
  });

  it('primerDiaDelMes arma el DATE de la RPC', () => {
    expect(primerDiaDelMes('2026-09')).toBe('2026-09-01');
  });
});

describe('fechaLima', () => {
  it('un pago de noche en Lima se fecha el día de Lima, no el día UTC', () => {
    expect(fechaLima('2026-10-01T02:00:00Z')).toBe('2026-09-30');
    expect(fechaLima('2026-09-14T15:00:00+00:00')).toBe('2026-09-14');
  });
});

describe('etiquetaMes', () => {
  it('no se corre al mes anterior por la zona horaria', () => {
    // es-PE escribe "setiembre"; lo que importa es que no salga agosto.
    expect(etiquetaMes('2026-09-01')).toMatch(/^Set?iembre de 2026$/);
    expect(etiquetaMes('2026-09-01')).not.toMatch(/gosto/);
    expect(etiquetaMes('2026-01')).toBe('Enero de 2026');
  });
});

describe('etiquetaPagador', () => {
  it('la cuenta borrada gana aunque quede algún dato', () => {
    expect(etiquetaPagador(fila({ cuenta_borrada: true, nombre: null, whatsapp: null }))).toBe('Cuenta eliminada');
    expect(etiquetaPagador(fila({ cuenta_borrada: true }))).toBe('Cuenta eliminada');
  });

  it('cae de nombre a WhatsApp a correo, y nunca a "null"', () => {
    expect(etiquetaPagador(fila())).toBe('Luis');
    expect(etiquetaPagador(fila({ nombre: null }))).toBe('51900000000');
    expect(etiquetaPagador(fila({ nombre: null, whatsapp: null }))).toBe('luis@example.com');
    expect(etiquetaPagador(fila({ nombre: null, whatsapp: null, email: null }))).toBe('Sin nombre');
  });
});

describe('etiquetaTipoPago', () => {
  it('distingue primer pago de renovación por el ordinal de la RPC', () => {
    expect(etiquetaTipoPago(fila({ n_pago: 1 }))).toBe('Primer pago');
    expect(etiquetaTipoPago(fila({ n_pago: 3, tipo_plan_anterior: 'mensual' }))).toBe('Renovación (pago n.º 3)');
  });

  it('nombra el cambio de plan en la renovación', () => {
    expect(etiquetaTipoPago(fila({ n_pago: 2, tipo_plan: 'anual', tipo_plan_anterior: 'mensual' }))).toBe(
      'Renovación (pago n.º 2) · antes mensual',
    );
  });

  it('un aprobado sin ordinal es cortesía, no un pago', () => {
    expect(etiquetaTipoPago(fila({ monto: 0, n_pago: null }))).toBe('Cortesía');
  });

  it('un aprobado SIN monto no se disfraza de cortesía', () => {
    expect(etiquetaTipoPago(fila({ monto: null, n_pago: null }))).toBe('Aprobado sin monto registrado');
  });

  it('pendiente y rechazado no se leen como pago aunque traigan ordinal', () => {
    expect(etiquetaTipoPago(fila({ estado: 'pendiente', n_pago: null }))).toBe('Pendiente');
    expect(etiquetaTipoPago(fila({ estado: 'rechazado', n_pago: 1 }))).toBe('Rechazado');
  });
});

describe('contar y notaNoSuma', () => {
  it('singular y plural', () => {
    expect(contar(1, 'renovación', 'renovaciones')).toBe('1 renovación');
    expect(contar(0, 'renovación', 'renovaciones')).toBe('0 renovaciones');
  });

  it('solo nombra lo que existe, y nada si no hay nada', () => {
    expect(notaNoSuma({ n_cortesia: 0, n_pendiente: 0, n_rechazado: 1 })).toBe(
      'Además: 1 rechazado. No suman a la caja.',
    );
    expect(notaNoSuma({ n_cortesia: 2, n_pendiente: 1, n_rechazado: 0 })).toBe(
      'Además: 2 aprobados sin plata, 1 pendiente. No suman a la caja.',
    );
    expect(notaNoSuma({ n_cortesia: 0, n_pendiente: 0, n_rechazado: 0 })).toBeNull();
  });
});

describe('sumaALaCaja', () => {
  it('solo aprobados con monto de cuentas reales, igual que admin_pnl_monthly', () => {
    expect(sumaALaCaja(fila())).toBe(true);
    expect(sumaALaCaja(fila({ interno: true }))).toBe(false);
    expect(sumaALaCaja(fila({ estado: 'pendiente' }))).toBe(false);
    expect(sumaALaCaja(fila({ monto: null }))).toBe(false);
    // Una cortesía suma S/0: entra a la suma igual que en el P&L, y no mueve el total.
    expect(sumaALaCaja(fila({ monto: 0, n_pago: null }))).toBe(true);
  });
});

describe('filasCsv', () => {
  it('una celda por header, con fecha Lima y sin el número de una cuenta borrada', () => {
    const [f] = filasCsv([fila({ cuando: '2026-10-01T02:00:00Z', cuenta_borrada: true })]);
    expect(f).toHaveLength(CSV_HEADERS.length);
    expect(f[0]).toBe('2026-09-30');
    expect(f[1]).toBe('Cuenta eliminada');
    expect(f[2]).toBe('');
    expect(f[9]).toBe('sí');
  });
});

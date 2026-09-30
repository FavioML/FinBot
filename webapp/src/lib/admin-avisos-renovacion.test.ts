import { describe, it, expect } from 'vitest';
import {
  adjuntarEntregas,
  etiquetaPlazo,
  fechaLima,
  inicioVentanaEntregas,
  monitorRenovacion,
  sumarDias,
  MONITOR_DESDE,
} from './admin-avisos-renovacion';
import type { AdminAvisoEntrega, AdminRenovacion } from './types-admin';

type Base = Pick<AdminRenovacion, 'premium_vence' | 'email_web' | 'recordatorios_activos' | 'entregas'>;

function ren(parcial: Partial<Base> = {}): Base {
  return { premium_vence: '2026-10-10', email_web: 'g@example.com', recordatorios_activos: true, entregas: [], ...parcial };
}

function fila(parcial: Partial<AdminAvisoEntrega>): AdminAvisoEntrega {
  return {
    tipo: 'premium_expiry_3d',
    canal: 'email',
    estado: 'sent',
    created_at: '2026-10-07T13:05:00Z',
    delivered_at: '2026-10-07T13:05:02Z',
    failed_at: null,
    read_at: null,
    fail_code: null,
    error: null,
    ...parcial,
  };
}

/** Un instante de Lima (UTC-5) como Date. */
const lima = (fechaHora: string) => new Date(`${fechaHora}-05:00`);

/** Las filas sanas de un vencimiento el 10-oct: correo entregado + WhatsApp fuera de ventana. */
function cicloSano(): AdminAvisoEntrega[] {
  const par = (tipo: AdminAvisoEntrega['tipo'], dia: string) => [
    fila({ tipo, canal: 'email', created_at: `${dia}T13:05:00Z`, delivered_at: `${dia}T13:05:03Z` }),
    fila({ tipo, canal: 'whatsapp', created_at: `${dia}T13:05:00Z`, delivered_at: null, failed_at: `${dia}T13:05:01Z`, fail_code: 131047 }),
  ];
  return [...par('premium_expiry_3d', '2026-10-07'), ...par('premium_expiry_hoy', '2026-10-10'), ...par('premium_expired', '2026-10-11')];
}

const SIN_CORREO =
  'Sin correo probado (no tiene cuenta web): el aviso solo sale por WhatsApp, que no llega si no escribió en las últimas 24h.';

describe('fechas', () => {
  it('sumarDias cruza meses', () => {
    expect(sumarDias('2026-10-01', -3)).toBe('2026-09-28');
    expect(sumarDias('2026-09-30', 1)).toBe('2026-10-01');
  });
  it('fechaLima usa el calendario de Lima, no el UTC', () => {
    // 02:00 UTC del 01-oct son las 21:00 del 30-sep en Lima.
    expect(fechaLima(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09-30');
    expect(fechaLima('2026-10-01T05:00:00Z')).toBe('2026-10-01');
  });
  it('la ventana de entregas empieza a las 00:00 Lima del día del aviso de 3 días', () => {
    expect(inicioVentanaEntregas('2026-10-04')).toBe('2026-10-01T05:00:00.000Z');
  });
  it('etiquetaPlazo', () => {
    expect(etiquetaPlazo({ dias: 0 })).toBe('vence hoy');
    expect(etiquetaPlazo({ dias: 1 })).toBe('vence mañana');
    expect(etiquetaPlazo({ dias: 4 })).toBe('vence en 4 días');
    expect(etiquetaPlazo({ dias: -1 })).toBe('venció ayer');
    expect(etiquetaPlazo({ dias: -40 })).toBe('venció hace 40 días');
  });
});

describe('monitorRenovacion: cuándo salió cada aviso', () => {
  it('un ciclo completo con los correos entregados no tiene excepciones, aunque el WhatsApp no llegue', () => {
    const m = monitorRenovacion(ren({ entregas: cicloSano() }), lima('2026-10-12T10:00:00'));
    expect(m.excepciones).toEqual([]);
    expect(m.avisos.map((a) => a.estado)).toEqual(['salio', 'salio', 'salio']);
    expect(m.avisos[0].correo).toEqual({ texto: 'entregado', tono: 'ok' });
    expect(m.avisos[0].whatsapp).toEqual({ texto: 'fuera de la ventana de 24h', tono: 'neutro' });
  });

  it('antes de su fecha un aviso es futuro, y su propio día está pendiente hasta que termina', () => {
    const futuro = monitorRenovacion(ren(), lima('2026-10-05T12:00:00'));
    expect(futuro.avisos.map((a) => a.estado)).toEqual(['futuro', 'futuro', 'futuro']);
    // El cron es horario y sin alBoot: un deploy corre la corrida, así que ninguna hora del día
    // alcanza para decir "no salió".
    for (const hora of ['08:30', '13:30', '23:59']) {
      const m = monitorRenovacion(ren(), lima(`2026-10-07T${hora}:00`));
      expect(m.avisos[0].estado).toBe('pendiente');
      expect(m.excepciones).toEqual([]);
    }
  });

  it('el de plan vencido, que sale de madrugada, tampoco se juzga en su propio día', () => {
    const sinVencido = cicloSano().filter((e) => e.tipo !== 'premium_expired');
    const m = monitorRenovacion(ren({ entregas: sinVencido }), lima('2026-10-11T00:20:00'));
    expect(m.avisos[2].estado).toBe('pendiente');
    expect(m.excepciones).toEqual([]);
  });

  it('el día siguiente sin ninguna fila, el aviso no salió', () => {
    const m = monitorRenovacion(ren(), lima('2026-10-08T00:30:00'));
    expect(m.avisos[0].estado).toBe('no_salio');
    expect(m.excepciones).toEqual(['No salió el aviso de 3 días (07/10).']);
  });

  it('una fila de OTRO aviso no cuenta como salida de este', () => {
    const m = monitorRenovacion(
      ren({ entregas: [fila({ tipo: 'premium_expiry_hoy', created_at: '2026-10-07T13:00:00Z' })] }),
      lima('2026-10-10T12:00:00'),
    );
    expect(m.avisos[0].estado).toBe('no_salio');
    expect(m.avisos[1].estado).toBe('pendiente');
  });

  it('una fila del aviso de 3 días o de hoy en OTRO día es de otro vencimiento', () => {
    // Vencía el 10-oct, salió el aviso de hoy y el admin extendió al 12-oct: la fila del 10 cae
    // dentro de la ventana nueva pero no es el aviso del 12.
    const m = monitorRenovacion(
      ren({ premium_vence: '2026-10-12', entregas: [fila({ tipo: 'premium_expiry_hoy', created_at: '2026-10-10T13:05:00Z' })] }),
      lima('2026-10-13T12:00:00'),
    );
    expect(m.avisos[1].estado).toBe('no_salio');
    expect(m.excepciones).toContain('No salió el aviso del día que vence (12/10).');
  });

  it('una fila del aviso de 3 días POSTERIOR a su día tampoco es este aviso', () => {
    // Vencía el 13-oct (aviso de 3 días el 10) y el admin lo corrigió al 10-oct: ese aviso no es
    // el de 3 días del vencimiento nuevo, que tocaba el 07.
    const m = monitorRenovacion(
      ren({ entregas: [fila({ created_at: '2026-10-10T13:05:00Z', delivered_at: '2026-10-10T13:05:02Z' })] }),
      lima('2026-10-11T12:00:00'),
    );
    expect(m.avisos[0].estado).toBe('no_salio');
  });

  it('un aviso que sale de noche en Lima (otro día en UTC) cuenta en su día de Lima', () => {
    // 01:30 UTC del 11-oct son las 20:30 del 10-oct en Lima.
    const m = monitorRenovacion(
      ren({ entregas: [fila({ tipo: 'premium_expiry_hoy', created_at: '2026-10-11T01:30:00Z', delivered_at: '2026-10-11T01:30:02Z' })] }),
      lima('2026-10-11T12:00:00'),
    );
    expect(m.avisos[1].estado).toBe('salio');
  });

  it('una fila de plan vencido ANTERIOR a su fecha es del vencimiento previo', () => {
    // Venció el 07, recibió el aviso el 08 y el admin extendió al 10: el aviso del ciclo nuevo
    // toca el 11 y la fila del 08, dentro de la ventana, no lo es.
    const m = monitorRenovacion(
      ren({ entregas: [fila({ tipo: 'premium_expired', created_at: '2026-10-08T13:05:00Z' })] }),
      lima('2026-10-12T12:00:00'),
    );
    expect(m.avisos[2].estado).toBe('no_salio');
  });

  it('el de plan vencido vale aunque salga días después (el downgrade se reintenta)', () => {
    const entregas = [
      ...cicloSano().filter((e) => e.tipo !== 'premium_expired'),
      fila({ tipo: 'premium_expired', created_at: '2026-10-13T15:00:00Z', delivered_at: '2026-10-13T15:00:02Z' }),
    ];
    const m = monitorRenovacion(ren({ entregas }), lima('2026-10-14T12:00:00'));
    expect(m.avisos[2].estado).toBe('salio');
    expect(m.excepciones).toEqual([]);
  });

  it('las filas de fixture (skipped_test) no cuentan, en ningún canal', () => {
    for (const canal of ['email', 'whatsapp'] as const) {
      const m = monitorRenovacion(ren({ entregas: [fila({ canal, estado: 'skipped_test' })] }), lima('2026-10-08T12:00:00'));
      expect(m.avisos[0].estado).toBe('no_salio');
    }
  });

  it('una persona sin WhatsApp: la fila skipped_no_whatsapp cuenta como aviso salido', () => {
    const m = monitorRenovacion(
      ren({ entregas: [fila({ canal: 'whatsapp', estado: 'skipped_no_whatsapp', delivered_at: null }), fila({})] }),
      lima('2026-10-08T12:00:00'),
    );
    expect(m.avisos[0].estado).toBe('salio');
    expect(m.avisos[0].whatsapp).toEqual({ texto: 'no tiene', tono: 'neutro' });
    expect(m.excepciones).toEqual([]);
  });

  it('toma la fila más reciente de cada canal', () => {
    const m = monitorRenovacion(
      ren({
        entregas: [
          fila({ estado: 'error', delivered_at: null, created_at: '2026-10-07T13:00:00Z' }),
          fila({ created_at: '2026-10-07T14:00:00Z' }),
        ],
      }),
      lima('2026-10-08T12:00:00'),
    );
    expect(m.avisos[0].correo?.texto).toBe('entregado');
    expect(m.excepciones).toEqual([]);
  });
});

describe('monitorRenovacion: el correo', () => {
  it('marca el correo rebotado, el spam, el que falló, el que no salió y el que nunca se confirmó', () => {
    const casos: [Partial<AdminAvisoEntrega>, string][] = [
      [{ delivered_at: null, failed_at: '2026-10-07T13:06:00Z', error: 'bounced' }, 'rebotó'],
      [{ failed_at: '2026-10-07T13:06:00Z', error: 'complained' }, 'lo marcó como spam'],
      [{ estado: 'error', delivered_at: null }, 'falló al enviarse'],
      [{ estado: 'skipped_tope_diario', delivered_at: null }, 'no salió: tope diario de correos'],
      [{ estado: 'skipped_sin_proveedor', delivered_at: null }, 'no salió: el canal de correo está apagado'],
      [{ estado: 'skipped_sin_baja', delivered_at: null }, 'no salió: falta el link de baja'],
      [{ estado: 'skipped_no_email', delivered_at: null }, 'no salió: sin correo'],
      [{ delivered_at: null }, 'sigue sin confirmar después de 24h'],
    ];
    for (const [parcial, texto] of casos) {
      const m = monitorRenovacion(ren({ entregas: [fila(parcial)] }), lima('2026-10-08T12:00:00'));
      expect(m.excepciones).toEqual([`El correo del aviso de 3 días (07/10) ${texto}.`]);
    }
  });

  it('un correo enviado sin confirmación no es excepción antes de las 24h', () => {
    const m = monitorRenovacion(ren({ entregas: [fila({ delivered_at: null })] }), lima('2026-10-08T07:00:00'));
    expect(m.avisos[0].correo).toEqual({ texto: 'enviado, sin confirmar', tono: 'neutro' });
    expect(m.excepciones).toEqual([]);
  });

  it('abierto le gana a entregado', () => {
    const m = monitorRenovacion(ren({ entregas: [fila({ read_at: '2026-10-07T15:00:00Z' })] }), lima('2026-10-08T12:00:00'));
    expect(m.avisos[0].correo).toEqual({ texto: 'abierto', tono: 'ok' });
  });

  it('el aviso salió solo por WhatsApp teniendo correo: es excepción', () => {
    const m = monitorRenovacion(
      ren({ entregas: [fila({ canal: 'whatsapp', failed_at: '2026-10-07T13:05:01Z', delivered_at: null, fail_code: 131047 })] }),
      lima('2026-10-07T12:00:00'),
    );
    expect(m.excepciones).toEqual(['El aviso de 3 días (07/10) salió sin correo.']);
  });

  it('sin correo probado: una sola excepción de persona, no una por aviso', () => {
    const m = monitorRenovacion(
      ren({ email_web: null, entregas: [fila({ canal: 'whatsapp', delivered_at: null, failed_at: '2026-10-07T13:05:01Z', fail_code: 131047 })] }),
      lima('2026-10-07T12:00:00'),
    );
    expect(m.excepciones).toEqual([SIN_CORREO]);
  });

  it('sin correo probado se avisa ANTES de que le toque el primer aviso', () => {
    const m = monitorRenovacion(ren({ email_web: null }), lima('2026-10-01T12:00:00'));
    expect(m.avisos.map((a) => a.estado)).toEqual(['futuro', 'futuro', 'futuro']);
    expect(m.excepciones).toEqual([SIN_CORREO]);
  });

  it('sin correo probado y además un aviso que no salió: las dos', () => {
    const m = monitorRenovacion(ren({ email_web: null }), lima('2026-10-08T12:00:00'));
    expect(m.excepciones).toEqual([SIN_CORREO, 'No salió el aviso de 3 días (07/10).']);
  });

  it('con los recordatorios apagados no se espera correo', () => {
    const m = monitorRenovacion(
      ren({ recordatorios_activos: false, entregas: [fila({ canal: 'whatsapp', delivered_at: null })] }),
      lima('2026-10-07T12:00:00'),
    );
    expect(m.excepciones).toEqual(['Apagó los recordatorios: los avisos no le llegan por correo.']);
  });
});

describe('monitorRenovacion: historia', () => {
  it('lo anterior al monitor se muestra y no se juzga', () => {
    // Venció el 01-sep: los tres avisos son de antes de que existiera el correo.
    const m = monitorRenovacion(ren({ premium_vence: '2026-09-01', email_web: null }), lima('2026-10-02T12:00:00'));
    expect(m.avisos.every((a) => a.historia)).toBe(true);
    expect(m.avisos.map((a) => a.estado)).toEqual(['no_salio', 'no_salio', 'no_salio']);
    expect(m.excepciones).toEqual([]);
  });

  it('en el borde: el aviso de 3 días es historia y los otros dos se juzgan', () => {
    // Jose: vence el 01-oct. El de 3 días salió el 28-sep, solo por WhatsApp (el correo no existía).
    const m = monitorRenovacion(
      ren({
        premium_vence: '2026-10-01',
        entregas: [fila({ canal: 'whatsapp', created_at: '2026-09-28T13:26:55Z', delivered_at: null, failed_at: '2026-09-28T13:26:55Z', fail_code: 131047 })],
      }),
      lima('2026-10-02T10:00:00'),
    );
    expect(MONITOR_DESDE).toBe('2026-10-01');
    expect(m.avisos.map((a) => a.historia)).toEqual([true, false, false]);
    expect(m.avisos[0].estado).toBe('salio');
    expect(m.avisos[2].estado).toBe('pendiente');
    expect(m.excepciones).toEqual(['No salió el aviso del día que vence (01/10).']);
  });
});

describe('adjuntarEntregas', () => {
  const base = { usuario_id: 'u1', premium_vence: '2026-10-10' };
  const e = (usuario_id: string, created_at: string) => ({ ...fila({ created_at }), usuario_id });

  it('la ventana empieza a las 00:00 de LIMA del día del aviso de 3 días, no a las 00:00 UTC', () => {
    const [r] = adjuntarEntregas(
      [base],
      [e('u1', '2026-10-07T04:59:59Z'), e('u1', '2026-10-07T05:00:00Z')],
      new Map([['u1', true]]),
    );
    expect(r.entregas.map((x) => x.created_at)).toEqual(['2026-10-07T05:00:00.000Z']);
  });

  it('cada persona se queda solo con sus filas, completas y sin usuario_id', () => {
    const propia = {
      ...fila({ canal: 'whatsapp', read_at: '2026-10-07T13:10:00Z', fail_code: 131047, error: 'Re-engagement message' }),
      usuario_id: 'u1',
    };
    const [r] = adjuntarEntregas([base], [e('u2', '2026-10-07T13:00:00Z'), propia], new Map());
    const sinId = fila({ canal: 'whatsapp', read_at: '2026-10-07T13:10:00Z', fail_code: 131047, error: 'Re-engagement message' });
    expect(r.entregas).toEqual([{ ...sinId, created_at: '2026-10-07T13:05:00.000Z', delivered_at: '2026-10-07T13:05:02.000Z', read_at: '2026-10-07T13:10:00.000Z' }]);
  });

  it('normaliza los timestamps de PostgREST (6 decimales, +00:00) a ISO con Z', () => {
    const [r] = adjuntarEntregas([base], [{ ...fila({ created_at: '2026-10-07T13:05:00.311540+00:00', delivered_at: null }), usuario_id: 'u1' }], new Map());
    expect(r.entregas[0].created_at).toBe('2026-10-07T13:05:00.311Z');
    expect(r.entregas[0].delivered_at).toBeNull();
  });

  it('recordatorios_activos sale de la lectura de usuarios, y sin fila se espera el correo', () => {
    expect(adjuntarEntregas([base], [], new Map([['u1', false]]))[0].recordatorios_activos).toBe(false);
    expect(adjuntarEntregas([base], [], new Map())[0].recordatorios_activos).toBe(true);
  });
});

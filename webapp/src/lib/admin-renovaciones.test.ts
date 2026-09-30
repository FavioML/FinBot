import { describe, it, expect } from 'vitest';
import {
  primerNombre,
  etiquetaPlazo,
  mensajeRenovacion,
  linkWhatsapp,
  linkCorreo,
} from './admin-renovaciones';
import type { AdminRenovacion } from './types-admin';

function ren(parcial: Partial<AdminRenovacion> = {}): AdminRenovacion {
  return {
    usuario_id: 'u1',
    estado: 'por_vencer',
    dias: 4,
    premium_vence: '2026-10-04',
    tipo_plan: 'mensual',
    nombre: 'giancarlo ramos',
    whatsapp: '51900000000',
    email_web: 'g@example.com',
    tiene_cuenta_web: true,
    n_pagos: 1,
    ultimo_pago_at: '2026-09-04T15:00:00Z',
    ultimo_monto: 10,
    pago_pendiente: false,
    ...parcial,
  };
}

describe('primerNombre', () => {
  it('toma la primera palabra y la capitaliza; sin nombre, null', () => {
    expect(primerNombre('giancarlo ramos')).toBe('Giancarlo');
    expect(primerNombre('  Luis  Enrique ')).toBe('Luis');
    expect(primerNombre(null)).toBeNull();
    expect(primerNombre('   ')).toBeNull();
  });
});

describe('etiquetaPlazo', () => {
  it('habla en días desde hoy, en las dos direcciones', () => {
    expect(etiquetaPlazo({ dias: 0 })).toBe('vence hoy');
    expect(etiquetaPlazo({ dias: 1 })).toBe('vence mañana');
    expect(etiquetaPlazo({ dias: 4 })).toBe('vence en 4 días');
    expect(etiquetaPlazo({ dias: -1 })).toBe('venció ayer');
    expect(etiquetaPlazo({ dias: -40 })).toBe('venció hace 40 días');
  });
});

describe('mensajeRenovacion', () => {
  it('por vencer: fecha, y el camino web a quien tiene cuenta web', () => {
    const m = mensajeRenovacion(ren());
    expect(m).toContain('Hola Giancarlo, soy Favio, de Neto.');
    expect(m).toContain('vence el 04/10');
    expect(m).toContain('app.neto.pe/dashboard/pro');
  });

  it('mañana y hoy se dicen así, no con fecha', () => {
    expect(mensajeRenovacion(ren({ dias: 1 }))).toContain('vence mañana');
    expect(mensajeRenovacion(ren({ dias: 0 }))).toContain('vence hoy');
  });

  it('a quien solo usa WhatsApp NO se le manda al panel (le crearía una cuenta huérfana)', () => {
    const m = mensajeRenovacion(ren({ tiene_cuenta_web: false }));
    expect(m).not.toContain('app.neto.pe');
    // El camino que existe: yapear y mandar la captura, que el webhook reconoce por contenido.
    expect(m).toContain('yapea S/10 (un mes) o S/99 (un año) al 970398192');
    // Con el chat de Neto: el mensaje sale del WhatsApp de Favio, que es el mismo número del
    // Yape, y una captura respondida ahí no llega al webhook.
    expect(m).toContain('mándale la captura a Neto, en este chat: wa.me/51933014505');
  });

  it('NO le dice "escríbele que quieres renovar": a un Pro pagado ver_premium no da cómo pagar', () => {
    for (const r of [ren({ tiene_cuenta_web: false }), ren({ estado: 'vencido', dias: -3, tiene_cuenta_web: false })]) {
      expect(mensajeRenovacion(r)).not.toMatch(/quiero renovar|te dice cómo pagar/);
    }
  });

  it('al anual se le da el precio anual', () => {
    const m = mensajeRenovacion(ren({ tiene_cuenta_web: false, tipo_plan: 'anual' }));
    expect(m).toContain('yapea S/99 (un año)');
    expect(m).not.toContain('S/10');
  });

  it('vencido: pregunta qué faltó y ofrece volver', () => {
    const m = mensajeRenovacion(ren({ estado: 'vencido', dias: -40, premium_vence: '2026-08-21', tiene_cuenta_web: false }));
    expect(m).toContain('venció el 21/08');
    expect(m).toContain('qué te faltó');
    expect(m).toContain('wa.me/51933014505');
  });

  it('con comprobante pendiente no dice "no lo renovaste" ni le pide pagar otra vez', () => {
    for (const estado of ['por_vencer', 'vencido'] as const) {
      const m = mensajeRenovacion(ren({ estado, dias: estado === 'vencido' ? -3 : 3, pago_pendiente: true }));
      expect(m).toContain('Ya vi el comprobante');
      expect(m).not.toMatch(/no lo renovaste|yapea|dashboard\/pro/);
    }
  });

  it('sin nombre no dice "Hola null"', () => {
    expect(mensajeRenovacion(ren({ nombre: null }))).toMatch(/^Hola, soy Favio/);
  });

  it('sin rayas largas (regla de estilo del proyecto)', () => {
    for (const r of [ren(), ren({ estado: 'vencido', dias: -5 }), ren({ tiene_cuenta_web: false })]) {
      expect(mensajeRenovacion(r)).not.toContain('—');
    }
  });
});

describe('linkWhatsapp', () => {
  it('arma wa.me con el texto codificado', () => {
    expect(linkWhatsapp('51900000000', 'Hola ¿qué tal?')).toBe(
      'https://wa.me/51900000000?text=Hola%20%C2%BFqu%C3%A9%20tal%3F',
    );
  });

  it('no arma un link con algo que no es un número (BSUID, vacío)', () => {
    expect(linkWhatsapp(null, 'x')).toBeNull();
    expect(linkWhatsapp('PE.1049206861029395', 'x')).toBeNull();
    expect(linkWhatsapp('+51 900', 'x')).toBeNull();
  });
});

describe('linkCorreo', () => {
  it('solo con correo probado', () => {
    expect(linkCorreo(ren({ email_web: null }), 'x')).toBeNull();
    expect(linkCorreo(ren(), 'Hola')).toBe('mailto:g@example.com?subject=Tu%20plan%20Pro%20de%20Neto&body=Hola');
  });
});

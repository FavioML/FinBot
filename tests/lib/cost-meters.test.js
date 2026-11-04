import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');
const { periodoMedido, montoPen, medirCosto, medirMetaWhatsapp, medirOpenAI } = require(path.join(APP, 'lib', 'cost-meters.js'));

/** Respuesta de fetch con el cuerpo dado. */
const resp = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe('periodoMedido', () => {
  it('el cobro del 01-nov mide octubre, de medianoche a medianoche en Lima', () => {
    const p = periodoMedido('2026-11-01');
    expect(p.desde).toBe('2026-10-01');
    expect(p.hasta).toBe('2026-11-01');
    // 05:00Z = 00:00 Lima. Los dos son los que se le pasaron a Meta el 03-nov y cuadraron.
    expect(p.desdeUnix).toBe(Date.parse('2026-10-01T05:00:00Z') / 1000);
    expect(p.hastaUnix).toBe(Date.parse('2026-11-01T05:00:00Z') / 1000);
  });

  it('cruza el año', () => {
    expect(periodoMedido('2027-01-01').desde).toBe('2026-12-01');
  });
});

describe('montoPen', () => {
  it('suma el impuesto antes de convertir: octubre de Meta', () => {
    // US$13.1517 + 18% = US$15.52 (el comprobante dice 15.53 porque Meta redondea el IGV aparte)
    expect(montoPen(13.1517, 0.18, 3.5)).toBe(54.32);
  });
  it('sin consumo es cero, no NaN', () => {
    expect(montoPen(0, 0.18, 3.4)).toBe(0);
  });
});

describe('medirMetaWhatsapp', () => {
  const periodo = periodoMedido('2026-11-01');
  const dia = (iso) => Date.parse(iso + 'T05:00:00Z') / 1000;
  const cuerpo = {
    pricing_analytics: {
      data: [{
        data_points: [
          { start: dia('2026-10-01'), pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 1001, cost: 0 },
          { start: dia('2026-10-23'), pricing_type: 'REGULAR', volume: 78, cost: 2.34 },
          { start: dia('2026-10-31'), pricing_type: 'REGULAR', volume: 35, cost: 0.9565 },
          // Fuera de la ventana: Meta puede devolver el día del borde, y no es de octubre.
          { start: dia('2026-11-01'), pricing_type: 'REGULAR', volume: 999, cost: 99 },
        ],
      }],
    },
  };

  it('suma el costo del mes y separa gratis de cobrados', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(cuerpo));
    const r = await medirMetaWhatsapp(periodo, { env: { META_ACCESS_TOKEN: 't' }, fetchImpl });
    expect(r.usd).toBeCloseTo(3.2965, 4);
    expect(r.detalle).toBe('1114 mensajes, 113 cobrados');
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('/2080787612777795?');
    expect(url).toContain('.start(' + periodo.desdeUnix + ').end(' + periodo.hastaUnix + ')');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
  });

  it('una respuesta sin pricing_analytics lanza: no es consumo cero', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ id: '2080787612777795' }));
    await expect(medirMetaWhatsapp(periodo, { env: { META_ACCESS_TOKEN: 't' }, fetchImpl })).rejects.toThrow(/no trae pricing_analytics/);
  });

  it('un mes sin un solo punto lanza: el bot nunca manda cero mensajes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ pricing_analytics: { data: [{ data_points: [] }] } }));
    await expect(medirMetaWhatsapp(periodo, { env: { META_ACCESS_TOKEN: 't' }, fetchImpl })).rejects.toThrow(/sin datos/);
  });

  it('sin token lanza en vez de medir cero', async () => {
    await expect(medirMetaWhatsapp(periodo, { env: {}, fetchImpl: vi.fn() })).rejects.toThrow(/META_ACCESS_TOKEN/);
  });

  it('un error de la API lanza con el mensaje de Meta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ error: { message: 'Invalid OAuth access token' } }, false, 401));
    await expect(medirMetaWhatsapp(periodo, { env: { META_ACCESS_TOKEN: 't' }, fetchImpl })).rejects.toThrow(/Invalid OAuth/);
  });
});

describe('medirOpenAI', () => {
  const periodo = periodoMedido('2026-11-01');
  const bucket = (results) => ({ object: 'bucket', results });
  const r = (project_id, value) => ({ amount: { value, currency: 'usd' }, project_id });

  it('pagina, suma todos los proyectos y nombra cada uno', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resp({ data: [bucket([r('p1', 1.5), r('p2', 0.25)])], has_more: true, next_page: 'pg2' }))
      .mockResolvedValueOnce(resp({ data: [bucket([r('p1', 2)])], has_more: false, next_page: null }))
      .mockResolvedValueOnce(resp({ data: [{ id: 'p1', name: 'Neto' }, { id: 'p2', name: 'Neto Pruebas' }] }));
    const res = await medirOpenAI(periodo, { env: { OPENAI_ADMIN_KEY: 'k' }, fetchImpl });
    expect(res.usd).toBeCloseTo(3.75, 6);
    expect(res.detalle).toBe('Neto $3.50, Neto Pruebas $0.25');
    const segunda = new URL(fetchImpl.mock.calls[1][0]);
    expect(segunda.searchParams.get('page')).toBe('pg2');
    expect(segunda.searchParams.get('start_time')).toBe(String(periodo.desdeUnix));
    expect(segunda.searchParams.get('end_time')).toBe(String(periodo.hastaUnix));
  });

  it('si la llave no puede listar proyectos, mide igual con los ids', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resp({ data: [bucket([r('p1', 1)])], has_more: false }))
      .mockResolvedValueOnce(resp({ error: { message: 'insufficient permissions' } }, false, 403));
    const res = await medirOpenAI(periodo, { env: { OPENAI_ADMIN_KEY: 'k' }, fetchImpl });
    expect(res.usd).toBe(1);
    expect(res.detalle).toBe('p1 $1.00');
  });

  it('has_more sin next_page lanza en vez de devolver un total parcial', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ data: [bucket([r('p1', 1)])], has_more: true, next_page: null }));
    await expect(medirOpenAI(periodo, { env: { OPENAI_ADMIN_KEY: 'k' }, fetchImpl })).rejects.toThrow(/a medias/);
  });

  it('una respuesta sin data lanza', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ object: 'page' }));
    await expect(medirOpenAI(periodo, { env: { OPENAI_ADMIN_KEY: 'k' }, fetchImpl })).rejects.toThrow(/no trae data/);
  });

  it('sin Admin key lanza: la llave del bot no lee costos', async () => {
    await expect(medirOpenAI(periodo, { env: { OPENAI_API_KEY: 'sk-bot' }, fetchImpl: vi.fn() })).rejects.toThrow(/OPENAI_ADMIN_KEY/);
  });

  it('un 401 de costos lanza, no devuelve cero', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp({ error: { message: 'Invalid admin key' } }, false, 401));
    await expect(medirOpenAI(periodo, { env: { OPENAI_ADMIN_KEY: 'k' }, fetchImpl })).rejects.toThrow(/Invalid admin key/);
  });
});

describe('medirCosto', () => {
  it('rechaza un medidor que no existe', async () => {
    await expect(medirCosto({ meter: 'stripe', next_due_date: '2026-11-01' })).rejects.toThrow(/desconocido/);
  });

  it('una fecha que no es día 1 es un fallo, no un mes corrido', async () => {
    await expect(medirCosto({ meter: 'meta_whatsapp', next_due_date: '2026-11-30' })).rejects.toThrow(/día 1/);
  });

  it('devuelve el impuesto del medidor junto con la lectura', async () => {
    const punto = { start: Date.parse('2026-10-01T05:00:00Z') / 1000, pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 40, cost: 0 };
    const fetchImpl = vi.fn().mockResolvedValue(resp({ pricing_analytics: { data: [{ data_points: [punto] }] } }));
    const res = await medirCosto(
      { meter: 'meta_whatsapp', next_due_date: '2026-11-01' },
      { env: { META_ACCESS_TOKEN: 't' }, fetchImpl },
    );
    expect(res).toMatchObject({ usd: 0, impuesto: 0.18, desde: '2026-10-01', etiqueta: 'Meta WhatsApp' });
  });
});

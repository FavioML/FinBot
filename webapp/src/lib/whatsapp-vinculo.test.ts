import { describe, it, expect } from 'vitest';
import { tieneWhatsapp, etiquetaWhatsapp } from './whatsapp-vinculo';

describe('tieneWhatsapp', () => {
  it('cuenta el número', () => {
    expect(tieneWhatsapp({ whatsapp: '51999888777', bsuid: null })).toBe(true);
  });

  it('cuenta el BSUID: quien oculta su número ya está vinculado', () => {
    expect(tieneWhatsapp({ whatsapp: null, bsuid: 'PE.1049206861029395' })).toBe(true);
  });

  it('en el navegador llega el booleano derivado, no el BSUID (D9)', () => {
    expect(tieneWhatsapp({ whatsapp: null, tiene_whatsapp: true })).toBe(true);
    expect(tieneWhatsapp({ whatsapp: null, tiene_whatsapp: false })).toBe(false);
  });

  it('sin ninguno de los dos no hay vínculo', () => {
    expect(tieneWhatsapp({ whatsapp: null, bsuid: null })).toBe(false);
    expect(tieneWhatsapp(null)).toBe(false);
    expect(tieneWhatsapp(undefined)).toBe(false);
  });
});

describe('etiquetaWhatsapp', () => {
  it('muestra el número cuando lo hay', () => {
    expect(etiquetaWhatsapp({ whatsapp: '51999888777', bsuid: 'PE.1' })).toBe('51999888777');
  });

  it('nunca pinta el BSUID: nombra lo que la persona reconoce', () => {
    const e = etiquetaWhatsapp({ whatsapp: null, bsuid: 'PE.1049206861029395' });
    expect(e).toBe('Tu usuario de WhatsApp');
    expect(e).not.toContain('PE.');
  });

  it('sin vínculo no hay etiqueta', () => {
    expect(etiquetaWhatsapp({ whatsapp: null, bsuid: null })).toBeNull();
  });
});

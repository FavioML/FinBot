import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import config from '../../next.config';

/**
 * El bot mandó `https://app.neto.pe/dashboard/metas` hasta el 11-oct-2026 y esa ruta nunca
 * existió. Los mensajes ya entregados siguen en el chat de cada persona con el link viejo, así que
 * el redirect no se puede quitar aunque el backend ya mande `/dashboard/planes` (eso lo vigila
 * `tests/rutas-dashboard-existen.test.js` del backend).
 */
describe('redirect de /dashboard/metas', () => {
  it('es permanente y apunta a una página que existe', async () => {
    const reglas = await config.redirects!();
    const regla = reglas.find((r) => r.source === '/dashboard/metas');
    expect(regla).toMatchObject({ destination: '/dashboard/planes', permanent: true });
    expect(fs.existsSync(path.resolve(__dirname, '../app/dashboard/planes/page.tsx'))).toBe(true);
  });
});

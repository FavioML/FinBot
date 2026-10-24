// Renderiza los fixtures de Yape (.html → .png) de los E2E de foto.
// Se corre UNA vez y los PNG se commitean; los harness E2E solo leen el PNG.
//   node qa-e2e/fixtures/render-yape.mjs   (desde app/)
//
//   yape-gasto    → qa-e2e-registro-gasto-foto.mjs
//   yape-titular  → qa-e2e-yape-titular-ingreso.mjs (el "¡Yapeaste!" hacia el propio usuario)
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2 });
for (const nombre of ['yape-gasto', 'yape-titular']) {
  await page.goto('file://' + path.join(dir, nombre + '.html'));
  await page.screenshot({ path: path.join(dir, nombre + '.png') });
  console.log('OK → ' + nombre + '.png');
}
await browser.close();

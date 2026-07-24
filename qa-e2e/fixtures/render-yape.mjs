// Renderiza yape-gasto.html → yape-gasto.png (fixture del E2E de foto).
// Se corre UNA vez y el PNG se commitea; el harness E2E solo lee el PNG.
//   node qa-e2e/fixtures/render-yape.mjs   (desde app/)
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(dir, 'yape-gasto.html'));
await page.screenshot({ path: path.join(dir, 'yape-gasto.png') });
await browser.close();
console.log('OK → yape-gasto.png');

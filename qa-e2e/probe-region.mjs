#!/usr/bin/env node
/**
 * ¿Las funciones de la webapp siguen corriendo en la region que declara
 * `webapp/vercel.json`?
 *
 * Existe porque esto se rompe SIN un commit. La region efectiva la decide Vercel
 * combinando el archivo con la config del PROYECTO, asi que un override puesto desde
 * el dashboard —o un cambio de plan que deje de permitir elegir— devuelve las funciones
 * a `iad1` con el repo intacto. El sintoma seria el dashboard 4x mas lento para todos y
 * ningun test rojo: medido el 30-ago-2026, `/api/dashboard` cuesta ~1100 ms desde `iad1`
 * y ~275 ms desde `gru1`. Ver la seccion de region en `webapp/CLAUDE.md`.
 *
 * La comprobacion es el header y no el archivo a proposito: leer `vercel.json` solo
 * afirmaria lo que el repo DICE, que es justo la mitad que no puede fallar sola.
 *
 * `x-vercel-id` viene `<borde>::<region>::<id>`. El primer campo es el PoP que recibio
 * el request (varia con quien mide) y el segundo es donde corrio la funcion, que es lo
 * unico que decide.
 *
 * exit 0 = la funcion corre donde debe
 * exit 1 = corre en otra region (regresion)
 * exit 2 = no se pudo saber (sin header, sin red): NO es un PASS
 *
 * env: NETO_APP_URL (default https://app.neto.pe), NETO_REGION_ESPERADA (default gru1)
 */
const APP = (process.env.NETO_APP_URL || 'https://app.neto.pe').replace(/\/$/, '');
const ESPERADA = process.env.NETO_REGION_ESPERADA || 'gru1';

// /api/version no consulta la base: si esto tarda o falla, es red o deploy, no la DB.
const URL_SONDA = `${APP}/api/version`;

function regionDelHeader(valor) {
  if (!valor) return null;
  const partes = valor.split('::');
  // Formatos vistos: `<borde>::<region>::<id>` y `<borde>::<region>::<id>::<sufijo>`.
  // Menos de tres campos = formato que no conocemos; no adivinamos.
  if (partes.length < 3) return null;
  return { borde: partes[0], region: partes[1] };
}

async function main() {
  let res;
  try {
    res = await fetch(URL_SONDA, { cache: 'no-store' });
  } catch (e) {
    console.error(`INDETERMINADO: no se pudo consultar ${URL_SONDA} — ${e.message}`);
    return 2;
  }
  await res.arrayBuffer().catch(() => {});

  const header = res.headers.get('x-vercel-id');
  const parsed = regionDelHeader(header);

  if (!parsed) {
    console.error(
      `INDETERMINADO: ${URL_SONDA} respondio ${res.status} sin un x-vercel-id legible ` +
        `(valor: ${JSON.stringify(header)}). Sin ese header no se sabe donde corrio la funcion.`,
    );
    return 2;
  }

  if (parsed.region !== ESPERADA) {
    console.error(
      `REGRESION DE REGION: la funcion corrio en '${parsed.region}' y se esperaba '${ESPERADA}'.\n` +
        `  header: ${header}  (borde ${parsed.borde})\n` +
        `  Revisar el override de region en el proyecto de Vercel y el campo "regions" de webapp/vercel.json.\n` +
        `  Costo medido de volver a iad1: /api/dashboard de ~275 ms a ~1100 ms desde Lima.`,
    );
    return 1;
  }

  console.log(
    JSON.stringify({ ok: true, url: URL_SONDA, region: parsed.region, borde: parsed.borde, header }),
  );
  return 0;
}

/**
 * `process.exit()` con un socket keep-alive de `fetch` todavia abierto aborta node en
 * Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) y devuelve **127**.
 * El guard fallaba igual, pero con un codigo que el canary lee como "el script no
 * existe" en vez de "la region cambio" — justo el fallo que este archivo viene a
 * delatar. Con `exitCode` node termina solo cuando el agente cierra su socket.
 */
process.exitCode = await main();

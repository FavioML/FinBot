// El convenio de salida de los harness, en un solo lugar.
//
// POR QUÉ EXISTE. Hasta el 09-ago-2026 nueve `.mjs` de `qa-e2e/` calculaban un veredicto
// (`noDuplicates`, `montoSortedAsc`, `pastRowVisible`, listas de 4xx/5xx) y lo volcaban a
// stdout **sin exit code**, así que salían 0 pase lo que pase. Cablear uno de esos a
// cualquier automatismo da verde por vacuidad, que es la forma exacta en que un check
// muerto le miente a la próxima auditoría.
//
// Lo que NO resuelve, y es a propósito: qué cuenta como afirmación en cada harness. Eso lo
// declara cada archivo, porque genuinamente difiere — un barrido de UI mide cosas distintas
// que un round-trip de API — y esconderlo detrás de una abstracción común lo volvería
// irrevisable. Acá vive solo la parte que, copiada nueve veces, iba a derivar: el orden de
// precedencia, la antivacuidad, y el `exitCode`.
//
// `process.exitCode` y NO `process.exit()`: en Windows, salir con sockets keep-alive de
// fetch abiertos devuelve **127**, y un exit 2 que llega como 127 se lee como fallo
// desconocido. Ya se pagó una vez hoy en qa-activacion-link. Misma nota que
// `qa-score-parity.mjs` y `qa-gating-score.mjs`.

/**
 * @param {object}   o
 * @param {string}   o.nombre       cómo se llama este barrido en la salida
 * @param {string[]} o.fallas       afirmaciones que salieron mal (vacío = ninguna)
 * @param {number}   o.medidos      cuántas afirmaciones se llegaron a evaluar
 * @param {string}   [o.inconcluso] motivo por el que no se pudo opinar (login, red, sin datos)
 * @param {object}   [o.R]          el objeto de observaciones, se imprime como JSON
 */
export function cerrar({ nombre, fallas = [], medidos = 0, inconcluso = null, R = null }) {
  if (R) console.log(JSON.stringify(R, null, 2));

  // El orden importa y es el mismo que usan los harness del canary: una falla MEDIDA gana
  // sobre el inconcluso. Lo ya observado es un veredicto y no se degrada a "no pude opinar"
  // porque después se cayera la red. La incertidumbre solo empuja hacia el lado ruidoso.
  if (fallas.length) {
    console.log(`\n==> ${nombre}: REGRESIÓN (exit 1) — ${fallas.length} de ${medidos} afirmaciones rojas`);
    for (const f of fallas) console.log('    · ' + f);
    process.exitCode = 1;
    return;
  }
  if (inconcluso) {
    console.log(`\n==> ${nombre}: INCONCLUSO (exit 2) — ${inconcluso}`);
    process.exitCode = 2;
    return;
  }
  // Antivacuidad. Cero afirmaciones evaluadas NO es "todo bien": es que el barrido no llegó
  // a mirar nada (la página no cargó, la tabla vino vacía, el selector cambió de nombre).
  // Sin esta rama, romper el barrido lo deja MÁS verde, que es la peor propiedad posible.
  if (!medidos) {
    console.log(`\n==> ${nombre}: INCONCLUSO (exit 2) — no se evaluó una sola afirmación; ` +
      'el barrido no llegó a mirar nada (¿cargó la página? ¿la tabla trajo filas? ¿cambió un selector?)');
    process.exitCode = 2;
    return;
  }
  console.log(`\n==> ${nombre}: OK (${medidos} afirmaciones verdes)`);
  process.exitCode = 0;
}

/**
 * Tasa de ahorro del mes: qué parte de lo que entró se quedó.
 *
 * El cálculo y su etiqueta viven juntos a propósito. Hasta el 12-oct-2026 el hero
 * móvil del dashboard pintaba este mismo número como "+24.6% vs mes anterior":
 * la cuenta era `ahorro / ingresos` del MISMO mes y la etiqueta prometía una
 * comparación con el mes pasado que nadie calculaba. Con ahorro que casi se
 * triplicó, la pantalla decía +24.6%. `tasa-ahorro.test.ts` falla si la etiqueta
 * vuelve a hablar de otro mes o si alguien la pinta sin pasar por acá.
 */

export function tasaDeAhorro(totalIngresos: number, totalGastos: number): number {
  if (totalIngresos <= 0) return 0;
  return ((totalIngresos - totalGastos) / totalIngresos) * 100;
}

/** "24.6% de tus ingresos". Negativa cuando se gastó más de lo que entró. */
export function etiquetaTasaDeAhorro(porcentaje: number): string {
  return `${porcentaje.toFixed(1)}% de tus ingresos`;
}

/** Capitalize first letter of each word, handle underscores. Safe with accented chars. */
export function capitalizeDisplay(text: string): string {
  if (!text) return '';
  return text
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => {
      if (!word) return '';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Normalize metodo_pago: add tildes and enrich generic methods with banco name */
export function normalizeMetodoPago(metodo: string | null | undefined, banco?: string | null): string {
  if (!metodo) return 'Sin especificar';
  let m = metodo.trim();
  m = m.replace(/\bCredito\b/gi, 'Crédito').replace(/\bDebito\b/gi, 'Débito');
  const isGeneric = /^(Crédito|Débito|Yape|Transferencia|Efectivo)$/i.test(m);
  if (isGeneric && banco) {
    const b = banco.trim();
    if (b && !m.toLowerCase().startsWith(b.toLowerCase())) {
      m = `${b} ${m}`;
    }
  }
  return m;
}

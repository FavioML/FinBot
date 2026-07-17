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

/**
 * Normalize metodo_pago: fix tildes, unify variations, enrich with banco.
 * E.g. "Credito BCP" / "BCP Crédito" / "VISA BCP" → "BCP Crédito"
 */
export function normalizeMetodoPago(metodo: string | null | undefined, banco?: string | null): string {
  if (!metodo) return 'Sin especificar';
  let m = metodo.trim();

  // Fix tildes
  m = m.replace(/\bCredito\b/gi, 'Crédito').replace(/\bDebito\b/gi, 'Débito');

  // Known bank names for extraction
  const BANCOS = ['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'Falabella', 'Ripley', 'BanBif', 'Mibanco', 'CMAC'];

  // Extract bank name from the method string itself (e.g. "Crédito BCP" → bank="BCP")
  let extractedBank = banco?.trim() || '';
  if (!extractedBank) {
    for (const b of BANCOS) {
      if (m.toLowerCase().includes(b.toLowerCase())) {
        extractedBank = b;
        break;
      }
    }
  }

  // VISA/Mastercard → Crédito
  if (/^visa\b/i.test(m)) m = m.replace(/^visa\b/i, 'Crédito');
  if (/^mastercard\b/i.test(m)) m = m.replace(/^mastercard\b/i, 'Crédito');

  // Strip bank name from method to get the base type, then re-prepend consistently
  let baseType = m;
  for (const b of BANCOS) {
    baseType = baseType.replace(new RegExp(`\\b${b}\\b`, 'gi'), '').trim();
  }

  // Normalize known base types
  const BASE_MAP: Record<string, string> = {
    'crédito': 'Crédito', 'credito': 'Crédito', 'tc': 'Crédito',
    'débito': 'Débito', 'debito': 'Débito', 'td': 'Débito',
    'yape': 'Yape', 'plin': 'Plin',
    'transferencia': 'Transferencia', 'transf': 'Transferencia',
    'efectivo': 'Efectivo', 'cash': 'Efectivo',
  };
  const normalized = BASE_MAP[baseType.toLowerCase()];
  if (normalized) baseType = normalized;

  // Re-compose: "BCP Crédito" format (bank first)
  // Yape/Plin are wallets — never prefix with bank name
  const isWallet = /^(Yape|Plin)$/i.test(baseType);
  const isGenericBase = /^(Crédito|Débito|Yape|Plin|Transferencia|Efectivo)$/i.test(baseType);

  if (isWallet) {
    return baseType;
  }

  if (isGenericBase && extractedBank) {
    return `${extractedBank} ${baseType}`;
  }

  if (isGenericBase && !extractedBank) {
    return baseType;
  }

  // Fallback: return cleaned version
  return m || 'Sin especificar';
}

/** Sufijo visual de tarjeta: "1234" → " ·· 1234". Vacío si no hay last4 válido. */
export function formatLast4(last4: string | null | undefined): string {
  if (!last4 || !/^\d{4}$/.test(last4)) return '';
  return ` ·· ${last4}`;
}

/** Extract the base payment type (e.g. "BCP Crédito" → "Crédito", "Yape" → "Yape") */
export function getMetodoBase(metodo: string): string {
  const bases = ['Crédito', 'Débito', 'Yape', 'Plin', 'Transferencia', 'Efectivo'];
  for (const base of bases) {
    if (metodo.includes(base)) return base;
  }
  return metodo;
}

/** Emoji icon for payment method type */
export function getMetodoIcon(metodo: string): string {
  const base = getMetodoBase(metodo);
  const icons: Record<string, string> = {
    'Crédito': '💳',
    'Débito': '🏧',
    'Yape': '📱',
    'Plin': '📲',
    'Transferencia': '🔄',
    'Efectivo': '💵',
    'Sin especificar': '❓',
  };
  return icons[base] || '💳';
}

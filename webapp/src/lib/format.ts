/** Capitalize first letter of each word, handle underscores */
export function capitalizeDisplay(text: string): string {
  if (!text) return '';
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

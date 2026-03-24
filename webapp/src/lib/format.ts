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

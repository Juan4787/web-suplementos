/**
 * Sanitiza términos de búsqueda para evitar comillas literales, comillas escapadas,
 * entidades codificadas en URL o caracteres no deseados en inputs y URLs.
 */
export function cleanSearchTerm(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();

  // Decodificar si vino con URL-encoding (%22, %27, etc.)
  while (str.includes('%22') || str.includes('%27')) {
    try {
      const decoded = decodeURIComponent(str);
      if (decoded === str) break;
      str = decoded;
    } catch {
      break;
    }
  }

  // Eliminar comillas iniciales y finales (dobles, simples, tipográficas, backticks, backslashes)
  return str.replace(/^[\s"'“”`\\]+|[\s"'“”`\\]+$/g, '').trim();
}

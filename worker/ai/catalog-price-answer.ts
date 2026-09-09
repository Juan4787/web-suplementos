import { addToolFacts, renderGroundedAnswer, sanitizeToolResult, type FactCatalog } from './facts';
import { validateToolCall } from './tools/registry';
import type { OrchestratorDependencies } from './orchestrator';
import type { Deadline } from './deadline';
import type { OrchestratorResult } from './types';

const normalize = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Only a standalone price question uses this shortcut. Comparisons, advice,
// pronouns and follow-ups keep the conversational tool-selection path.
export function directPriceQuery(message: string): string | null {
  const text = normalize(message);
  const match = /^(?:que precio tiene|cual es el precio de|cuanto (?:cuesta|sale|vale)|precio de|precio) (.+)$/.exec(text);
  const query = match?.[1]?.replace(/^(?:el|la|los|las|un|una) /, '');
  if (!query || query.length < 3 || query.length > 70 || /\b(?:y|o|si|con|sin|para|mas|menos|eso|esto|ese|esa|anterior|hoy|ayer|mercado|en|segun|cual|que)\b/.test(query)) return null;
  return query;
}

export async function answerCatalogPrice(query: string, dependencies: OrchestratorDependencies, deadline: Deadline): Promise<OrchestratorResult> {
  const call = validateToolCall({ id: 'direct_catalog_price', name: 'get_product_catalog', argumentsJson: '{}' });
  const result = sanitizeToolResult(await dependencies.executeTool(call, deadline), call.call.name);
  const tokens = query.split(' ');
  const matches = (result.products ?? []).filter(product => {
    const words = normalize(product.label).split(' ');
    return tokens.every(token => words.includes(token));
  });
  const catalog: FactCatalog = new Map();
  addToolFacts(catalog, { ...result, products: matches });
  const template = matches.length > 8
    ? 'Hay varias presentaciones que coinciden. Indicá el nombre completo o la presentación para consultar su precio.'
    : matches.length === 0
      ? 'No encontré un producto con ese nombre en el catálogo activo. Revisá cómo figura en Productos e indicame su nombre o presentación.'
      : matches.map(product => {
        const id = `${product.ref}.catalog.price_cents`;
        return `{{fact:${product.ref}.label}}: ${catalog.has(id) ? `{{fact:${id}}}` : 'precio no disponible'}.`;
      }).join('\n');
  const grounded = renderGroundedAnswer(template, catalog);
  return { ...grounded, modelKey: null, modelLabel: 'Consulta del catálogo', provider: null,
    providerLabel: 'Datos de la tienda', usedTools: ['get_product_catalog'], providerTransitions: 0, fallbackUsed: false };
}

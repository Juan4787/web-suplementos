import { describe, expect, it } from 'vitest';
import { directPriceQuery } from './catalog-price-answer';

describe('Consulta directa de precios', () => {
  it.each(['¿Qué precio tiene la creatina?', '¿Cuánto cuesta la creatina?', 'precio creatina'])('reconoce %s', message => {
    expect(directPriceQuery(message)).toBe('creatina');
  });
  it.each(['¿Cuánto cuesta la creatina en Argentina?', '¿Qué precio tiene la creatina y qué me recomendás?', '¿Cuánto cuesta eso?', '¿Cuál es el producto más caro?', '¿Qué precio tiene el omega y la creatina?'])('conserva la conversación contextual en %s', message => {
    expect(directPriceQuery(message)).toBeNull();
  });
});

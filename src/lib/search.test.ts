import { describe, expect, it } from 'vitest';
import { cleanSearchTerm } from './search';

describe('cleanSearchTerm', () => {
  it('handles null and undefined', () => {
    expect(cleanSearchTerm(null)).toBe('');
    expect(cleanSearchTerm(undefined)).toBe('');
    expect(cleanSearchTerm('')).toBe('');
  });

  it('handles numbers without throwing errors', () => {
    expect(cleanSearchTerm(1778)).toBe('1778');
    expect(cleanSearchTerm(0)).toBe('0');
  });

  it('removes surrounding standard quotes', () => {
    expect(cleanSearchTerm('"1778"')).toBe('1778');
    expect(cleanSearchTerm("'1778'")).toBe('1778');
  });

  it('removes multiple and nested quotes', () => {
    expect(cleanSearchTerm('""1778""')).toBe('1778');
    expect(cleanSearchTerm('"""1778"""')).toBe('1778');
  });

  it('removes escaped quotes and backslashes', () => {
    expect(cleanSearchTerm('\\"1778\\"')).toBe('1778');
    expect(cleanSearchTerm('\\"\\"1778\\"\\"')).toBe('1778');
  });

  it('removes url-encoded quotes (%22, %27)', () => {
    expect(cleanSearchTerm('%221778%22')).toBe('1778');
    expect(cleanSearchTerm('%22%221778%22%22')).toBe('1778');
    expect(cleanSearchTerm('%271778%27')).toBe('1778');
  });

  it('removes smart and typographic quotes', () => {
    expect(cleanSearchTerm('“1778”')).toBe('1778');
    expect(cleanSearchTerm('`1778`')).toBe('1778');
  });

  it('cleans customer names and handles internal quotes', () => {
    expect(cleanSearchTerm('  "Santiago Gómez"  ')).toBe('Santiago Gómez');
    expect(cleanSearchTerm('"Proteína "Whey" 1kg"')).toBe('Proteína "Whey" 1kg');
  });
});

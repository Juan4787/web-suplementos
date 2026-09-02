import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAssistantContent } from './AiPage';

describe('renderAssistantContent', () => {
  afterEach(cleanup);

  it('renderiza tablas markdown en elementos semánticos table, thead, tbody, th y td', () => {
    const markdown = `
### Producto con mayor venta (enero–sept 2026)

| Posición | Producto | Unidades vendidas | Pedidos | Ingresos (ARS) | Margen estimado (ARS) |
|---|---|---|---|---|---|
| 1 | CREATINA · 300 GRS | 11 | 5 | $330 000 | $12 507 |
| 2 | OMEGA 3 · 120 CAPS | 4 | 4 | $408 000 | $10 800 |

Lo que está ocurriendo:
- La creatina es, con diferencia, el producto más vendido.
`;

    const { container } = render(<div>{renderAssistantContent(markdown)}</div>);

    const heading = container.querySelector('h4');
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe('Producto con mayor venta (enero–sept 2026)');

    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    const headers = container.querySelectorAll('th');
    expect(headers).toHaveLength(6);
    expect(headers[0]?.textContent).toBe('Posición');
    expect(headers[1]?.textContent).toBe('Producto');

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);

    const firstRowCells = rows[0]?.querySelectorAll('td');
    expect(firstRowCells).toHaveLength(6);
    expect(firstRowCells?.[0]?.textContent).toBe('1');
    expect(firstRowCells?.[1]?.textContent).toBe('CREATINA · 300 GRS');
    expect(firstRowCells?.[4]?.textContent).toBe('$330 000');

    // Verifica que los bullets se rendericen
    expect(container.textContent).toContain('La creatina es, con diferencia, el producto más vendido.');
  });

  it('formatea texto en negrita, cursiva y código sin exponer asteriscos ni comillas', () => {
    const text = 'Tenés **6 unidades** en *stock* de `OMEGA 3`.';
    const { container } = render(<div>{renderAssistantContent(text)}</div>);

    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('6 unidades');

    const em = container.querySelector('em');
    expect(em?.textContent).toBe('stock');

    const code = container.querySelector('code');
    expect(code?.textContent).toBe('OMEGA 3');

    // No deben quedar asteriscos ni backticks sueltos en el texto visible
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
  });

  it('renderiza listas numeradas con formato limpio', () => {
    const text = `1. Primer paso importante
2. Segundo paso importante`;
    const { container } = render(<div>{renderAssistantContent(text)}</div>);

    expect(container.textContent).toContain('Primer paso importante');
    expect(container.textContent).toContain('Segundo paso importante');
    expect(container.textContent).toContain('1.');
    expect(container.textContent).toContain('2.');
  });

  it('garantiza seguridad contra inyección de scripts o HTML malicioso (escapado seguro)', () => {
    const malicious = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const { container } = render(<div>{renderAssistantContent(malicious)}</div>);

    // No debe crear elementos <script> ni <img>
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    // El contenido debe figurar como texto plano escapado
    expect(container.textContent).toContain('<script>alert("xss")</script>');
  });
});

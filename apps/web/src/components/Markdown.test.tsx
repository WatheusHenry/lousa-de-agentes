import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';

const html = (md: string, baseUrl?: string) =>
  renderToStaticMarkup(<Markdown {...(baseUrl ? { baseUrl } : {})}>{md}</Markdown>);

describe('Markdown', () => {
  it('formata títulos, listas, código, tabelas e checklists', () => {
    const out = html(
      '## Passos\n\n- **um**\n- `dois`\n\n- [x] feito\n- [ ] falta\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(out).toContain('<h2>Passos</h2>');
    expect(out).toContain('<strong>um</strong>');
    expect(out).toContain('<code>dois</code>');
    expect(out).toContain('<table>');
    expect(out).toMatch(/<input[^>]*checked[^>]*disabled|<input[^>]*disabled[^>]*checked/);
  });

  it('não renderiza HTML cru nem links javascript:', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))');
    // o HTML vira texto escapado, nunca tag
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('href="javascript:');
  });

  it('links abrem em outra aba; uploads relativos apontam para o projeto; imagens viram link', () => {
    const out = html(
      '[log](/uploads/abc/log.txt) ![print](/uploads/def/a.png)',
      'https://gitlab.com/acme/api',
    );
    expect(out).toContain('href="https://gitlab.com/acme/api/uploads/abc/log.txt"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('<img');
    expect(out).toContain('🖼 print');
  });
});

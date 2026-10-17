import { describe, expect, it } from 'vitest';
import { parseNaming, quickTitle } from './namer.ts';

describe('quickTitle', () => {
  it('tira os rodeios do começo e fica com a primeira oração', () => {
    expect(
      quickTitle(
        'Quero que seja possivel alterar o nome do agente, e quero que melhore tambem o ponto onde o agente se auto nomeia',
      ),
    ).toBe('Alterar o nome do agente');
    expect(quickTitle('Você pode, por favor, corrigir o login com SSO?')).toBe('Corrigir o login com SSO');
    expect(quickTitle('Olá! Preciso que adicione testes ao checkout.\nDetalhes abaixo.')).toBe(
      'Adicione testes ao checkout',
    );
  });

  it('não corta orações curtas demais nem quebra palavras', () => {
    expect(quickTitle('Crie X, e depois Y')).toBe('Crie X, e depois Y');
    const t = quickTitle(`Atualize ${'a documentação '.repeat(10)}`);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/ …$/);
  });

  it('ignora blocos de código e marcadores de lista', () => {
    expect(quickTitle('```ts\nconst x = 1\n```\n- Remova o código morto do parser')).toBe(
      'Remova o código morto do parser',
    );
  });
});

describe('parseNaming', () => {
  it('lê o JSON, mesmo com texto em volta', () => {
    expect(parseNaming('Aqui: {"nome": "Renomear agentes", "titulo": "permitir renomear agentes."}')).toEqual(
      {
        name: 'Renomear agentes',
        title: 'Permitir renomear agentes',
      },
    );
  });

  it('recusa resposta incompleta ou inválida', () => {
    expect(parseNaming('sem json')).toBeNull();
    expect(parseNaming('{"nome": "X"}')).toBeNull();
    expect(parseNaming('{nome: X}')).toBeNull();
  });
});

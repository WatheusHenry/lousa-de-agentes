import { describe, expect, it } from 'vitest';
import { conciseName, uniqueName } from './names.ts';

describe('conciseName', () => {
  it('tira enchimento e não corta palavras', () => {
    expect(conciseName('Quero que implemente uma tela de login com SSO')).toBe('tela login SSO');
    expect(conciseName('Webhook duplica cobrança quando o pagamento é reenviado')).toBe(
      'Webhook duplica cobrança',
    );
  });
  it('respeita o limite', () => {
    expect(
      conciseName('internacionalização extraordinariamente complicada demais', 20).length,
    ).toBeLessThanOrEqual(20);
  });
  it('vazio fica vazio', () => expect(conciseName('')).toBe(''));
});

describe('uniqueName', () => {
  it('numera repetidos', () => {
    expect(uniqueName('login', ['Login', 'x'])).toBe('login 2');
    expect(uniqueName('login', ['login', 'login 2'])).toBe('login 3');
    expect(uniqueName('novo', ['x'])).toBe('novo');
  });
});

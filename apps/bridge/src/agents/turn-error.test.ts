import { describe, expect, it } from 'vitest';
import { turnErrorMessage } from './turn-error.ts';

describe('mensagem de erro do turno', () => {
  it('login expirado vira instrução de /login', () => {
    expect(
      turnErrorMessage('success', 'Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toContain('/login');
  });
  it('limite de uso e falta de crédito', () => {
    expect(turnErrorMessage('success', "You've hit your limit · resets 3pm")).toContain('limite de uso');
    expect(turnErrorMessage('error_during_execution', 'Credit balance is too low')).toContain('sem crédito');
  });
  it('outros erros mostram o motivo; sem texto, o subtype', () => {
    expect(turnErrorMessage('success', 'Algo deu errado\ndetalhes')).toBe(
      'O turno terminou com erro: Algo deu errado',
    );
    expect(turnErrorMessage('error_max_turns', null)).toBe('O turno terminou com erro (error_max_turns).');
  });
});

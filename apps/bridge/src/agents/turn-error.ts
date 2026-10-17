import { needsClaudeLogin } from '@agent-canvas/shared';

/**
 * Mensagem de erro de um turno para o usuário. O `claude` às vezes encerra com subtype
 * "success" e is_error (ex.: login expirado), então o texto do resultado é o que explica.
 */
export function turnErrorMessage(subtype: string, text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (needsClaudeLogin(t))
    return 'O Claude Code desta máquina não está logado (o login expirou). Rode `claude` num terminal, use /login e mande a mensagem de novo.';
  if (/usage limit|rate limit|limit reached|limit will reset|hit your limit/i.test(t))
    return `O limite de uso da sua conta do Claude acabou. Espere renovar e mande a mensagem de novo.${t ? ` (${firstLine(t)})` : ''}`;
  if (/credit balance|billing/i.test(t)) return `A conta do Claude está sem crédito. (${firstLine(t)})`;
  return t ? `O turno terminou com erro: ${firstLine(t)}` : `O turno terminou com erro (${subtype}).`;
}

const firstLine = (t: string) => {
  const l = t.split('\n').find((x) => x.trim()) ?? t;
  return l.length > 300 ? `${l.slice(0, 300)}…` : l;
};

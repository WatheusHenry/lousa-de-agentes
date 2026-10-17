import { z } from 'zod';

/**
 * O `claude` desta máquina perdeu o login (OAuth expirado, sem login, chave inválida)? Vale
 * para o texto cru do erro e para a mensagem que o bridge mostra no lugar dele.
 */
export const needsClaudeLogin = (text: string | null | undefined): boolean =>
  /oauth|failed to authenticate|not logged in|please run \/login|invalid api key|não está logado/i.test(
    text ?? '',
  );

/** Login do Claude Code feito pelo canvas (`claude auth login` rodando no bridge). */
export const ClaudeLoginState = z.object({
  state: z.enum(['idle', 'waiting', 'done', 'failed']),
  /** Página de login, se o `claude` mostrou (ele também tenta abrir o navegador sozinho). */
  url: z.string().nullable(),
  message: z.string().nullable(),
});
export type ClaudeLoginState = z.infer<typeof ClaudeLoginState>;

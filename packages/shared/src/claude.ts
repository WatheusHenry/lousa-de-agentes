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

/** Uma janela de limite do plano: quanto já foi usado (0–100) e quando zera. */
export const ClaudeUsageWindow = z.object({
  percent: z.number(),
  resetsAt: z.string().nullable(),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** Uso do plano do Claude desta máquina: sessão de 5 horas e semana. */
export const ClaudeUsage = z.object({
  fiveHour: ClaudeUsageWindow.nullable(),
  sevenDay: ClaudeUsageWindow.nullable(),
  /** Plano do login (`pro`, `max`…), quando o arquivo de credenciais diz. */
  plan: z.string().nullable(),
  /** Por que não há números (sem login, login por chave de API, falha na consulta). */
  error: z.string().nullable(),
  fetchedAt: z.string(),
});
export type ClaudeUsage = z.infer<typeof ClaudeUsage>;

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeUsage, ClaudeUsageWindow } from '@agent-canvas/shared';

/** A mesma consulta que o `/usage` do Claude Code faz (não é API pública: pode mudar). */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Consultar mais que isso não muda nada: o número anda devagar e a Anthropic limita. */
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface ClaudeOAuth {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

/**
 * Lê o login OAuth do Claude Code desta máquina: `~/.claude/.credentials.json` (ou
 * `$CLAUDE_CONFIG_DIR`) em Linux e Windows; no macOS ele fica no Keychain.
 */
export async function readClaudeOAuth(env = process.env): Promise<ClaudeOAuth | null> {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let raw = await readFile(join(dir, '.credentials.json'), 'utf8').catch(() => null);
  if (raw === null && process.platform === 'darwin')
    raw = await new Promise<string | null>((done) =>
      execFile(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000 },
        (err, out) => done(err ? null : out),
      ),
    );
  if (!raw) return null;
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: ClaudeOAuth }).claudeAiOauth;
    return o && typeof o.accessToken === 'string' ? o : null;
  } catch {
    return null;
  }
}

const windowOf = (w: unknown): ClaudeUsageWindow | null => {
  const x = w as { utilization?: unknown; resets_at?: unknown } | null;
  if (!x || typeof x.utilization !== 'number') return null;
  return {
    percent: Math.max(0, Math.min(100, x.utilization)),
    resetsAt: typeof x.resets_at === 'string' ? x.resets_at : null,
  };
};

/**
 * Uso do plano do Claude (sessão de 5 h e semana), consultado com o login do Claude Code
 * desta máquina. O token fica no bridge: o navegador só recebe as porcentagens. Nunca renova
 * o token por conta própria (isso trocaria o refresh token do Claude Code); se expirou, espera
 * o próximo `claude` renovar.
 */
export class ClaudeUsageService {
  private last: ClaudeUsage | null = null;
  private pending: Promise<ClaudeUsage> | null = null;

  constructor(
    private readonly creds: () => Promise<ClaudeOAuth | null> = readClaudeOAuth,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get(force = false): Promise<ClaudeUsage> {
    if (!force && this.last && this.now() - Date.parse(this.last.fetchedAt) < CACHE_MS)
      return Promise.resolve(this.last);
    this.pending ??= this.load().finally(() => (this.pending = null));
    return this.pending;
  }

  private async load(): Promise<ClaudeUsage> {
    const oauth = await this.creds();
    const base = {
      fiveHour: null,
      sevenDay: null,
      plan: oauth?.subscriptionType ?? null,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    const fail = (error: string): ClaudeUsage => {
      // mantém os últimos números conhecidos: um erro passageiro não apaga o anel
      this.last = {
        ...base,
        fiveHour: this.last?.fiveHour ?? null,
        sevenDay: this.last?.sevenDay ?? null,
        error,
      };
      return this.last;
    };
    if (!oauth)
      return fail(
        'Sem login do Claude Code por assinatura nesta máquina (login por chave de API não tem limite de sessão).',
      );
    if (oauth.expiresAt && oauth.expiresAt < this.now())
      return fail(
        'O login do Claude Code expirou. O uso volta a aparecer quando um agente rodar ou você logar de novo.',
      );
    try {
      const res = await this.fetcher(USAGE_URL, {
        headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) return fail('O login do Claude Code não vale mais. Faça login de novo.');
      if (!res.ok) return fail(`A Anthropic respondeu ${res.status} ao consultar o uso.`);
      const body = (await res.json()) as { five_hour?: unknown; seven_day?: unknown };
      this.last = {
        ...base,
        fiveHour: windowOf(body.five_hour),
        sevenDay: windowOf(body.seven_day),
        error: null,
      };
      return this.last;
    } catch {
      return fail('Não consegui consultar o uso na Anthropic.');
    }
  }
}

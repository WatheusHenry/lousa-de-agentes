import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeLoginState } from '@agent-canvas/shared';
import { cleanClaudeEnv } from './env.ts';

/** Quanto tempo o login pode ficar esperando o usuário terminar no navegador. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Refaz o login do Claude Code desta máquina pelo canvas: roda `claude auth login`, que abre o
 * navegador na página da Anthropic, e acompanha até terminar. O bridge roda na máquina do
 * usuário, então o navegador abre ali mesmo. Se a página mostrar um código para colar, ele
 * chega pelo `code()`. A saída do processo nunca vai para o log.
 */
export class ClaudeLogin {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: ClaudeLoginState = { state: 'idle', url: null, message: null };

  constructor(
    private readonly onChange: (s: ClaudeLoginState) => void,
    private readonly bin = process.env.AGENT_CANVAS_CLAUDE_BIN || 'claude',
    private readonly timeoutMs = LOGIN_TIMEOUT_MS,
  ) {}

  state(): ClaudeLoginState {
    return this.current;
  }

  private set(s: ClaudeLoginState): void {
    this.current = s;
    this.onChange(s);
  }

  start(): ClaudeLoginState {
    if (this.proc) return this.current;
    let out = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.bin, ['auth', 'login'], { env: cleanClaudeEnv(process.env), stdio: 'pipe' });
    } catch (err) {
      this.set({
        state: 'failed',
        url: null,
        message: `Não consegui rodar o claude: ${(err as Error).message}`,
      });
      return this.current;
    }
    this.proc = child;
    this.set({ state: 'waiting', url: null, message: 'Abrindo a página de login no navegador…' });
    const read = (d: Buffer) => {
      out += d.toString();
      const url = /https:\/\/[^\s"'<>]+/.exec(out)?.[0] ?? null;
      if (url && url !== this.current.url)
        this.set({ state: 'waiting', url, message: 'Termine o login na página que abriu.' });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => {
      this.finish({
        state: 'failed',
        url: null,
        message:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Não encontrei o comando "${this.bin}". Instale o Claude Code.`
            : `O login falhou: ${err.message}`,
      });
    });
    child.on('exit', (code) => {
      if (this.proc !== child) return;
      const last = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/https:\/\//.test(l))
        .at(-1);
      this.finish(
        code === 0
          ? { state: 'done', url: null, message: 'Login feito. O Claude Code já pode rodar os agentes.' }
          : {
              state: 'failed',
              url: null,
              message: `O login não terminou${last ? `: ${last.slice(0, 200)}` : ''}. Tente de novo ou rode \`claude\` e /login num terminal.`,
            },
      );
    });
    this.timer = setTimeout(() => {
      this.finish({
        state: 'failed',
        url: null,
        message: 'O login ficou 10 minutos esperando e foi cancelado. Tente de novo.',
      });
    }, this.timeoutMs);
    this.timer.unref();
    return this.current;
  }

  /** Código que a página de login mostra para colar no terminal (fluxo sem retorno automático). */
  code(code: string): void {
    if (!this.proc?.stdin.writable) throw new Error('Nenhum login em andamento.');
    this.proc.stdin.write(`${code.trim()}\n`);
    this.set({ ...this.current, message: 'Código enviado. Conferindo…' });
  }

  cancel(): void {
    this.finish({ state: 'idle', url: null, message: null });
  }

  private finish(s: ClaudeLoginState): void {
    const p = this.proc;
    this.proc = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (p && p.exitCode === null) p.kill();
    this.set(s);
  }
}

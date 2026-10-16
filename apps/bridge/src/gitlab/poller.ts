/**
 * Polling do GitLab (seção 9 do plano): MRs dos agentes a cada 30 s (pipeline, estado e
 * comentários novos) e issues a cada 60 s (label agent-ready). Webhooks ficam fora: o app é local.
 */
export class Poller {
  private timers: ReturnType<typeof setInterval>[] = [];
  private busy = new Set<string>();

  constructor(
    private readonly tasks: {
      mrs: () => Promise<void>;
      issues: () => Promise<void>;
    },
  ) {}

  start(opts: { mrsEveryMs?: number; issuesEveryMs?: number }): void {
    this.stop();
    if (opts.mrsEveryMs) this.every('mrs', opts.mrsEveryMs);
    if (opts.issuesEveryMs) this.every('issues', opts.issuesEveryMs);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Uma rodada de cada tarefa (os testes chamam direto). */
  async tick(which: 'mrs' | 'issues'): Promise<void> {
    // uma rodada lenta (GitLab demorando) não se sobrepõe à próxima
    if (this.busy.has(which)) return;
    this.busy.add(which);
    try {
      await this.tasks[which]();
    } catch {
      // erro de rede ou do GitLab: a próxima rodada tenta de novo
    } finally {
      this.busy.delete(which);
    }
  }

  private every(which: 'mrs' | 'issues', ms: number): void {
    const t = setInterval(() => void this.tick(which), ms);
    t.unref();
    this.timers.push(t);
  }
}

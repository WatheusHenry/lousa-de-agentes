import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Approval, Policy } from '@agent-canvas/shared';
import { summarizeTool } from '../agents/stream-parser.ts';
import type { Db } from '../db/index.ts';
import { approval, policy } from '../db/schema.ts';
import type { Hub } from '../hub.ts';
import { defaultDeny, matchesRule, suggestRule } from './rules.ts';

export type Decision =
  { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface PermissionRequest {
  agentId: string;
  /** Projeto do GitLab do agente, para regras por repositório. */
  repoId: number | null;
  worktree: string | null;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

type Row = typeof approval.$inferSelect;
const toApproval = (r: Row): Approval => ({
  id: r.id,
  agentId: r.agentId,
  toolName: r.toolName,
  input: r.input,
  summary: r.summary,
  suggestedRule: r.suggestedRule,
  status: r.status,
  decidedBy: r.decidedBy,
  createdAt: r.createdAt,
});

/**
 * Fila de permissões. A ferramenta `approve` do MCP chama `request()` e espera: a resposta
 * vem de uma negação padrão, de uma regra salva, ou da decisão do usuário na aba Ações.
 */
export class ApprovalService {
  private waiting = new Map<string, { req: PermissionRequest; resolve: (d: Decision) => void }>();
  /** Avisado quando um pedido fica pendente ou é decidido (o agente muda de status). */
  onChange: (agentId: string, a: Approval) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {
    // pedidos pendentes de uma execução anterior não têm mais quem espere por eles
    this.db
      .update(approval)
      .set({ status: 'denied', decidedBy: 'reinício do bridge' })
      .where(eq(approval.status, 'pending'))
      .run();
  }

  policies(): Policy[] {
    return this.db.select().from(policy).orderBy(desc(policy.createdAt)).all();
  }

  pending(): Approval[] {
    return this.db.select().from(approval).where(eq(approval.status, 'pending')).all().map(toApproval);
  }

  private rulesFor(repoId: number | null): string[] {
    return this.policies()
      .filter((p) => p.scope === 'global' || p.scope === String(repoId))
      .map((p) => p.pattern);
  }

  /** Regras salvas, para passar em --allowedTools ao iniciar o agente. */
  allowedTools(repoId: number | null): string[] {
    return this.rulesFor(repoId);
  }

  async request(req: PermissionRequest): Promise<Decision> {
    const rules = this.rulesFor(req.repoId);
    const matched = rules.find((r) => matchesRule(r, req.toolName, req.input));
    const denied = defaultDeny(req.toolName, req.input, req.worktree, !!matched && req.toolName === 'Bash');
    if (denied) {
      this.record(req, 'denied', 'regra padrão');
      return { behavior: 'deny', message: denied };
    }
    if (matched) {
      this.record(req, 'allowed', `regra ${matched}`);
      return { behavior: 'allow', updatedInput: req.input };
    }
    const row = this.record(req, 'pending', null);
    return new Promise<Decision>((resolve) => this.waiting.set(row.id, { req, resolve }));
  }

  /** Decisão do usuário. Com `remember`, grava a regra e libera os pedidos iguais que estão esperando. */
  decide(approvalId: string, decision: 'allow' | 'deny', remember = false): void {
    const w = this.waiting.get(approvalId);
    const row = this.db.select().from(approval).where(eq(approval.id, approvalId)).get();
    if (!row || row.status !== 'pending') return;
    if (decision === 'allow' && remember) this.addPolicy(row.suggestedRule, 'global');
    this.finish(approvalId, decision, 'usuário');
    if (w) {
      w.resolve(
        decision === 'allow'
          ? { behavior: 'allow', updatedInput: w.req.input }
          : {
              behavior: 'deny',
              message: 'O usuário negou este pedido no canvas. Não tente de novo; pergunte o que fazer.',
            },
      );
    }
    if (decision === 'allow' && remember) this.releaseMatching();
  }

  addPolicy(pattern: string, scope: string): Policy {
    const existing = this.policies().find((p) => p.pattern === pattern && p.scope === scope);
    if (existing) return existing;
    const p: Policy = { id: randomUUID(), pattern, scope, createdAt: new Date().toISOString() };
    this.db.insert(policy).values(p).run();
    this.hub.broadcast({ type: 'policy.upsert', policy: p });
    return p;
  }

  removePolicy(id: string): void {
    this.db.delete(policy).where(eq(policy.id, id)).run();
    this.hub.broadcast({ type: 'policy.remove', policyId: id });
  }

  /** Libera os pedidos pendentes que uma regra nova cobre. */
  private releaseMatching(): void {
    for (const [id, w] of [...this.waiting]) {
      const rule = this.rulesFor(w.req.repoId).find((r) => matchesRule(r, w.req.toolName, w.req.input));
      if (!rule) continue;
      this.finish(id, 'allow', `regra ${rule}`);
      w.resolve({ behavior: 'allow', updatedInput: w.req.input });
    }
  }

  /** O agente parou: nega o que ele ainda esperava. */
  cancelForAgent(agentId: string, reason: string): void {
    for (const [id, w] of [...this.waiting]) {
      if (w.req.agentId !== agentId) continue;
      this.finish(id, 'deny', reason);
      w.resolve({ behavior: 'deny', message: reason });
    }
  }

  hasPending(agentId: string): boolean {
    return [...this.waiting.values()].some((w) => w.req.agentId === agentId);
  }

  private finish(id: string, decision: 'allow' | 'deny', by: string): void {
    this.waiting.delete(id);
    const row = this.db
      .update(approval)
      .set({ status: decision === 'allow' ? 'allowed' : 'denied', decidedBy: by })
      .where(eq(approval.id, id))
      .returning()
      .get();
    if (row) this.emit(row);
  }

  private record(req: PermissionRequest, status: Row['status'], decidedBy: string | null): Row {
    const row = this.db
      .insert(approval)
      .values({
        id: randomUUID(),
        agentId: req.agentId,
        toolName: req.toolName,
        input: req.input,
        toolUseId: req.toolUseId ?? null,
        summary: summarizeTool(req.toolName, req.input) || req.toolName,
        suggestedRule: suggestRule(req.toolName, req.input),
        status,
        decidedBy,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    this.emit(row);
    return row;
  }

  private emit(row: Row): void {
    const a = toApproval(row);
    this.hub.broadcast({ type: 'approval.upsert', approval: a });
    this.onChange(a.agentId, a);
  }
}

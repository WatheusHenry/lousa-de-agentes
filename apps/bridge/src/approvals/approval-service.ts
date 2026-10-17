import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Approval, Policy } from '@agent-canvas/shared';
import { summarizeTool } from '../agents/stream-parser.ts';
import type { Db } from '../db/index.ts';
import { approval, policy } from '../db/schema.ts';
import type { Hub } from '../hub.ts';
import { defaultDeny, matchingRules, splitRules, suggestRule } from './rules.ts';
import { trustedAllows } from './trust.ts';

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
  /**
   * Pedidos que estavam pendentes quando o bridge parou. Ficam na caixa de Ações: quando o
   * agente retomado pede a mesma coisa, o pedido antigo (e a decisão, se já houver) é reaproveitado.
   */
  private orphans = new Set<string>();
  /** Projeto em modo confiança (configurado pelo servidor). */
  trusted: (repoId: number) => boolean = () => false;
  /** Avisado quando um pedido fica pendente ou é decidido (o agente muda de status). */
  onChange: (agentId: string, a: Approval) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {
    for (const r of this.db.select().from(approval).where(eq(approval.status, 'pending')).all())
      this.orphans.add(r.id);
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
    const matched = matchingRules(rules, req.toolName, req.input);
    const denied = defaultDeny(req.toolName, req.input, req.worktree, !!matched && req.toolName === 'Bash');
    if (denied) {
      this.record(req, 'denied', 'regra padrão');
      return { behavior: 'deny', message: denied };
    }
    if (matched) {
      this.record(req, 'allowed', `regra ${matched.join(', ')}`);
      return { behavior: 'allow', updatedInput: req.input };
    }
    // modo confiança: depois das negações padrão, o trabalho comum no worktree passa direto
    if (
      req.repoId !== null &&
      this.trusted(req.repoId) &&
      trustedAllows(req.toolName, req.input, req.worktree)
    ) {
      this.record(req, 'allowed', 'modo confiança');
      return { behavior: 'allow', updatedInput: req.input };
    }
    const orphan = this.adoptOrphan(req);
    if (orphan) return orphan;
    const row = this.record(req, 'pending', null);
    return new Promise<Decision>((resolve) => this.waiting.set(row.id, { req, resolve }));
  }

  /** O agente retomado pediu de novo o que pedia antes do reinício: usa o mesmo pedido. */
  private adoptOrphan(req: PermissionRequest): Promise<Decision> | null {
    const key = stableJson(req.input);
    const rows = this.orphans.size
      ? this.db
          .select()
          .from(approval)
          .where(and(inArray(approval.id, [...this.orphans]), eq(approval.agentId, req.agentId)))
          .all()
      : [];
    const row = rows.find((r) => r.toolName === req.toolName && stableJson(r.input) === key);
    if (!row) return null;
    this.orphans.delete(row.id);
    if (row.status === 'allowed') return Promise.resolve({ behavior: 'allow', updatedInput: req.input });
    if (row.status === 'denied')
      return Promise.resolve({
        behavior: 'deny',
        message: 'O usuário negou este pedido no canvas. Não tente de novo; pergunte o que fazer.',
      });
    // ainda pendente: o agente volta a aguardar o mesmo pedido
    this.emit(row);
    return new Promise<Decision>((resolve) => this.waiting.set(row.id, { req, resolve }));
  }

  /** Decisão do usuário. Com `remember`, grava a regra e libera os pedidos iguais que estão esperando. */
  decide(approvalId: string, decision: 'allow' | 'deny', remember = false): void {
    const w = this.waiting.get(approvalId);
    const row = this.db.select().from(approval).where(eq(approval.id, approvalId)).get();
    if (!row || row.status !== 'pending') return;
    // pedido de antes do reinício: a decisão fica guardada até o agente pedir de novo
    if (decision === 'allow' && remember)
      for (const r of splitRules(row.suggestedRule)) this.addPolicy(r, 'global');
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
      const used = matchingRules(this.rulesFor(w.req.repoId), w.req.toolName, w.req.input);
      if (!used) continue;
      this.finish(id, 'allow', `regra ${used.join(', ')}`);
      w.resolve({ behavior: 'allow', updatedInput: w.req.input });
    }
  }

  /** O agente parou: nega o que ele ainda esperava, inclusive pedidos de antes do reinício. */
  cancelForAgent(agentId: string, reason: string): void {
    for (const [id, w] of [...this.waiting]) {
      if (w.req.agentId !== agentId) continue;
      this.finish(id, 'deny', reason);
      w.resolve({ behavior: 'deny', message: reason });
    }
    for (const id of [...this.orphans]) {
      const r = this.db.select().from(approval).where(eq(approval.id, id)).get();
      if (r?.agentId !== agentId) continue;
      this.orphans.delete(id);
      if (r.status === 'pending') this.finish(id, 'deny', reason);
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

/** JSON com as chaves em ordem, para comparar a entrada de dois pedidos. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

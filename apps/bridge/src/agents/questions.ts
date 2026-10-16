import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Question } from '@agent-canvas/shared';
import type { Db } from '../db/index.ts';
import { question as qT } from '../db/schema.ts';
import type { Hub } from '../hub.ts';

const toQuestion = (r: typeof qT.$inferSelect): Question => ({ ...r });

/**
 * Perguntas dos agentes ao usuário (ferramenta ask_human): a pergunta entra na aba Ações e a
 * ferramenta fica esperando a resposta, como a de permissão.
 */
export class QuestionService {
  private waiting = new Map<string, (answer: string | null) => void>();
  /** O supervisor marca o agente como aguardando e registra a linha no terminal. */
  onChange: (q: Question) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {}

  pending(): Question[] {
    return this.db.select().from(qT).where(eq(qT.status, 'pending')).all().map(toQuestion);
  }

  hasPending(agentId: string): boolean {
    return !!this.db
      .select()
      .from(qT)
      .where(and(eq(qT.agentId, agentId), eq(qT.status, 'pending')))
      .get();
  }

  /** Cria a pergunta e espera. Devolve a resposta, ou null se for cancelada. */
  ask(agentId: string, text: string, options: string[]): Promise<string | null> {
    const q: Question = {
      id: `q_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      agentId,
      text,
      options: options.slice(0, 6),
      answer: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.db.insert(qT).values(q).run();
    this.publish(q);
    return new Promise((resolve) => this.waiting.set(q.id, resolve));
  }

  answer(questionId: string, answer: string): void {
    const r = this.db
      .update(qT)
      .set({ answer, status: 'answered' })
      .where(and(eq(qT.id, questionId), eq(qT.status, 'pending')))
      .returning()
      .get();
    if (!r) return;
    this.publish(toQuestion(r));
    this.waiting.get(questionId)?.(answer);
    this.waiting.delete(questionId);
  }

  /** Agente pausado, parado ou removido: as perguntas dele saem da caixa de Ações. */
  cancelForAgent(agentId: string): void {
    const rows = this.db
      .update(qT)
      .set({ status: 'cancelled' })
      .where(and(eq(qT.agentId, agentId), eq(qT.status, 'pending')))
      .returning()
      .all();
    for (const r of rows) {
      this.publish(toQuestion(r));
      this.waiting.get(r.id)?.(null);
      this.waiting.delete(r.id);
    }
  }

  private publish(q: Question): void {
    this.hub.broadcast({ type: 'question.upsert', question: q });
    this.onChange(q);
  }
}

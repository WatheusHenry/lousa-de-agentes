import { useEffect, useState } from 'react';
import type { AgentEvent } from '@agent-canvas/shared';
import { useStore } from '../state/store.ts';

const EMPTY: AgentEvent[] = [];
const cut = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Ferramentas do canvas que contam como marco na linha do tempo. */
const TOOL_LABEL: Record<string, string> = {
  open_merge_request: 'Enviou o merge request',
  comment_mr: 'Comentou no MR',
  comment_issue: 'Comentou na issue',
  write_note: 'Escreveu uma nota no canvas',
};

type Mark = { id: number; ts: string; k: string; label: string };

/** Os marcos do agente, sem o detalhe do terminal: tarefa, permissões, MR, filhos, fim e erros. */
export function timeline(events: AgentEvent[]): Mark[] {
  const out: Mark[] = [];
  const push = (e: AgentEvent, k: string, label: string) => out.push({ id: e.id, ts: e.ts, k, label });
  for (const e of events) {
    const b = e.body;
    switch (b.kind) {
      case 'user_message':
        push(e, 'msg', `Mensagem: ${cut(b.text)}`);
        break;
      case 'permission':
        if (b.status === 'pending') push(e, 'ask', `Pediu permissão: ${b.toolName}(${cut(b.summary, 50)})`);
        else push(e, '', `${b.status === 'allowed' ? 'Permitido' : 'Negado'}: ${cut(b.summary, 60)}`);
        break;
      case 'question':
        push(
          e,
          b.answer === null ? 'ask' : '',
          b.answer === null ? `Perguntou: ${cut(b.text)}` : `Resposta: ${cut(b.answer)}`,
        );
        break;
      case 'tool_use': {
        const name = Object.keys(TOOL_LABEL).find((t) => b.name === t || b.name.endsWith(`__${t}`));
        if (name) push(e, '', TOOL_LABEL[name]!);
        else if (b.name === 'Bash' && /^git commit\b/.test(b.summary)) push(e, '', 'Fez commit');
        break;
      }
      case 'spawn':
        push(e, '', `Criou ${b.childName} para ${b.repo}`);
        break;
      case 'wait':
        push(
          e,
          '',
          b.state === 'start' ? `Esperando ${b.names.join(', ')}` : `${b.names.join(', ')} terminaram`,
        );
        break;
      case 'plan':
        push(e, '', `Publicou o plano (${b.items.filter((i) => i.done).length}/${b.items.length} feitos)`);
        break;
      case 'context':
        if (b.notified) push(e, '', `Contexto atualizado: ${cut(b.labels.join('; '), 60)}`);
        break;
      case 'result':
        push(e, b.isError ? 'bad' : 'done', b.isError ? 'O turno terminou com erro' : 'Concluiu o turno');
        break;
      case 'error':
        push(e, 'bad', cut(b.message));
        break;
      case 'status':
        if (b.status === 'queued') push(e, '', 'Entrou na fila');
        else if (b.status === 'paused') push(e, '', b.note ? `Pausado: ${cut(b.note, 60)}` : 'Pausado');
        else if (b.status === 'stopped') push(e, '', 'Parado');
        break;
    }
  }
  return out;
}

const ago = (ts: string, now: number) => {
  const s = Math.max(1, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('pt-BR');
};

/** Linha do tempo do painel do agente (os 8 marcos mais recentes, como no protótipo). */
export function AgentTimeline({ agentId }: { agentId: string }) {
  const events = useStore((s) => s.agentEvents[agentId] ?? EMPTY);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const marks = timeline(events).slice(-8).reverse();
  if (!marks.length) return null;
  return (
    <div className="grp">
      <h4>Linha do tempo</h4>
      <ol className="tl tl-ag">
        {marks.map((m) => (
          <li key={m.id}>
            <span className={`tl-dot${m.k ? ` k-${m.k}` : ''}`} />
            <div>
              <p>{m.label}</p>
              <time dateTime={m.ts} title={new Date(m.ts).toLocaleString('pt-BR')}>
                {ago(m.ts, now)}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

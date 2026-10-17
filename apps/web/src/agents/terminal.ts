import type { AgentEvent } from '@agent-canvas/shared';

/**
 * Partes de um comando encadeado (`&&`, `||`, `;`, `|`), cada uma com o separador que a liga à
 * anterior. Aspas e heredocs ficam inteiros: só separa fora deles.
 */
export function splitShell(cmd: string): { sep: string; part: string }[] {
  const out: { sep: string; part: string }[] = [];
  let quote: string | null = null;
  let cur = '';
  let sep = '';
  const push = (next: string) => {
    if (cur.trim()) out.push({ sep, part: cur.trim() });
    cur = '';
    sep = next;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    // heredoc: o resto é conteúdo, não comando
    if (c === '<' && cmd[i + 1] === '<') {
      cur += cmd.slice(i);
      break;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two);
      i++;
    } else if (c === ';' || c === '\n') push(';');
    else if (c === '|') push('|');
    else cur += c;
  }
  push('');
  return out;
}

/** Comandos que só leem (não mudam nada): entram no grupo "leu/buscou". */
const READ_CMDS =
  /^(cat|ls|head|tail|wc|pwd|tree|file|stat|grep|rg|find|which|echo|sed -n|git (status|log|diff|show|branch|rev-parse|ls-files|grep|blame))\b/;

export type ReadKind = 'read' | 'search' | 'list';

/** Ferramenta só de leitura? Devolve o tipo para o resumo do grupo; null para o resto. */
export function readKind(e: AgentEvent): ReadKind | null {
  const b = e.body;
  if (b.kind !== 'tool_use') return null;
  if (b.name === 'Read' || b.name === 'NotebookRead') return 'read';
  if (b.name === 'Grep' || b.name === 'Glob' || b.name === 'WebSearch') return 'search';
  if (b.name === 'LS') return 'list';
  if (b.name !== 'Bash') return null;
  const parts = splitShell(String((b.input as { command?: unknown })?.command ?? b.summary));
  if (!parts.length || !parts.every((p) => READ_CMDS.test(p.part) && !/>/.test(p.part))) return null;
  if (parts.some((p) => /^(grep|rg|find|git grep)\b/.test(p.part))) return 'search';
  if (parts.every((p) => /^(ls|tree|pwd)\b/.test(p.part))) return 'list';
  return 'read';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Leu 3 arquivos · 2 buscas" para um grupo de ferramentas de leitura. */
export function groupLabel(kinds: ReadKind[]): string {
  const n = (k: ReadKind) => kinds.filter((x) => x === k).length;
  const parts = [
    n('read') ? `leu ${plural(n('read'), 'arquivo', 'arquivos')}` : null,
    n('search') ? plural(n('search'), 'busca', 'buscas') : null,
    n('list') ? `listou ${plural(n('list'), 'pasta', 'pastas')}` : null,
  ].filter(Boolean);
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type Segment =
  { type: 'event'; e: AgentEvent } | { type: 'reads'; events: AgentEvent[]; kinds: ReadKind[] };

/**
 * Junta leituras seguidas (ferramenta de leitura + o resultado dela, sem erro) num segmento só;
 * com uma leitura só, fica como está.
 */
export function segments(events: AgentEvent[]): Segment[] {
  const out: Segment[] = [];
  let run: AgentEvent[] = [];
  let kinds: ReadKind[] = [];
  const flush = () => {
    if (kinds.length >= 2) out.push({ type: 'reads', events: run, kinds });
    else for (const e of run) out.push({ type: 'event', e });
    run = [];
    kinds = [];
  };
  for (const e of events) {
    const k = readKind(e);
    const b = e.body;
    if (k) {
      run.push(e);
      kinds.push(k);
      continue;
    }
    // o resultado de uma leitura do grupo fica no grupo (erro quebra o grupo, para aparecer)
    const last = run.at(-1)?.body;
    if (
      b.kind === 'tool_result' &&
      !b.isError &&
      last?.kind === 'tool_use' &&
      last.toolUseId === b.toolUseId
    ) {
      run.push(e);
      continue;
    }
    flush();
    out.push({ type: 'event', e });
  }
  flush();
  return out;
}

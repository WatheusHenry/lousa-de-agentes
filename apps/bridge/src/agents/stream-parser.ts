import { z } from 'zod';
import type { AgentEventBody } from '@agent-canvas/shared';

/**
 * Parser do `claude -p --output-format stream-json --verbose`, modelado a partir das saídas
 * reais em __fixtures__ (regravar com scripts/record-fixtures.ts). Os schemas são tolerantes:
 * campos desconhecidos passam, tipos de linha desconhecidos são ignorados, e uma linha que não
 * casa com o schema não derruba o agente.
 */

const Usage = z
  .object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
  })
  .loose();

const ContentBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).loose(),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }).loose(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      content: z.unknown(),
      is_error: z.boolean().nullish(),
    })
    .loose(),
  z.object({ type: z.string() }).loose(),
]);

const Init = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string(),
    model: z.string().default(''),
    cwd: z.string().default(''),
  })
  .loose();

const Assistant = z
  .object({
    type: z.literal('assistant'),
    parent_tool_use_id: z.string().nullish(),
    message: z.object({ content: z.array(ContentBlock), usage: Usage.nullish() }).loose(),
  })
  .loose();

const User = z
  .object({
    type: z.literal('user'),
    parent_tool_use_id: z.string().nullish(),
    message: z.object({ content: z.union([z.string(), z.array(ContentBlock)]) }).loose(),
  })
  .loose();

const Result = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().default(false),
    result: z.string().nullish(),
    total_cost_usd: z.number().default(0),
    num_turns: z.number().default(0),
    terminal_reason: z.string().nullish(),
    session_id: z.string().optional(),
    usage: Usage.nullish(),
  })
  .loose();

const ControlResponse = z
  .object({
    type: z.literal('control_response'),
    response: z.object({ subtype: z.string(), request_id: z.string().optional() }).loose(),
  })
  .loose();

export interface ParsedLine {
  events: AgentEventBody[];
  sessionId?: string;
  /** Tamanho do contexto no último pedido ao modelo (entrada + cache). */
  contextTokens?: number;
  /** Totais do turno, vindos do evento result. */
  turn?: { inputTokens: number; outputTokens: number; costUsd: number; isError: boolean; subtype: string };
  controlResponse?: { requestId?: string; ok: boolean };
}

const MAX_RESULT = 4000;

export function parseLine(line: string): ParsedLine {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  const type = (json as { type?: unknown })?.type;

  if (type === 'system') {
    const init = Init.safeParse(json);
    if (init.success)
      return {
        sessionId: init.data.session_id,
        events: [
          { kind: 'init', sessionId: init.data.session_id, model: init.data.model, cwd: init.data.cwd },
        ],
      };
    return { events: [] };
  }

  if (type === 'assistant') {
    const a = Assistant.safeParse(json);
    // mensagens de sub-agentes internos do Claude Code não entram no terminal do canvas
    if (!a.success || a.data.parent_tool_use_id) return { events: [] };
    const events: AgentEventBody[] = [];
    for (const b of a.data.message.content) {
      if (b.type === 'text' && 'text' in b && typeof b.text === 'string' && b.text.trim())
        events.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use' && 'id' in b && 'name' in b)
        events.push({
          kind: 'tool_use',
          toolUseId: String(b.id),
          name: String(b.name),
          summary: summarizeTool(String(b.name), (b as { input?: unknown }).input),
          input: (b as { input?: unknown }).input ?? {},
        });
    }
    const u = a.data.message.usage;
    return {
      events,
      ...(u
        ? {
            contextTokens:
              u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          }
        : {}),
    };
  }

  if (type === 'user') {
    const u = User.safeParse(json);
    if (!u.success || u.data.parent_tool_use_id) return { events: [] };
    const content = u.data.message.content;
    if (typeof content === 'string') return { events: [] }; // eco da mensagem do usuário: o bridge já registrou
    const events: AgentEventBody[] = [];
    for (const b of content) {
      if (b.type === 'tool_result' && 'tool_use_id' in b) {
        const text = resultText((b as { content?: unknown }).content);
        events.push({
          kind: 'tool_result',
          toolUseId: String(b.tool_use_id),
          content: text.slice(0, MAX_RESULT),
          isError: !!(b as { is_error?: boolean | null }).is_error,
          truncated: text.length > MAX_RESULT,
        });
      }
    }
    return { events };
  }

  if (type === 'result') {
    const r = Result.safeParse(json);
    if (!r.success) return { events: [] };
    const d = r.data;
    const u = d.usage;
    return {
      ...(d.session_id ? { sessionId: d.session_id } : {}),
      turn: {
        inputTokens: u
          ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
          : 0,
        outputTokens: u?.output_tokens ?? 0,
        costUsd: d.total_cost_usd,
        isError: d.is_error,
        subtype: d.subtype,
      },
      events: [
        {
          kind: 'result',
          isError: d.is_error,
          subtype: d.subtype,
          text: d.result ?? null,
          costUsd: d.total_cost_usd,
          numTurns: d.num_turns,
          terminalReason: d.terminal_reason ?? null,
        },
      ],
    };
  }

  if (type === 'control_response') {
    const c = ControlResponse.safeParse(json);
    if (!c.success) return { events: [] };
    return {
      events: [],
      controlResponse: {
        ...(c.data.response.request_id ? { requestId: c.data.response.request_id } : {}),
        ok: c.data.response.subtype === 'success',
      },
    };
  }

  return { events: [] };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  return content == null ? '' : JSON.stringify(content);
}

/** Resumo de uma chamada de ferramenta, como na linha `● Bash(npm test)` do protótipo. */
export function summarizeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const short = (v: string, n = 120) => (v.length > n ? v.slice(0, n - 1) + '…' : v);
  const path = (p: string) => p.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, '');
  switch (name) {
    case 'Bash':
      return short(s(i.command).split('\n')[0] ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return path(s(i.file_path) || s(i.notebook_path));
    case 'Glob':
    case 'Grep':
      return short(s(i.pattern));
    case 'WebFetch':
      return short(s(i.url));
    case 'WebSearch':
      return short(s(i.query));
    case 'Task':
    case 'Agent':
      return short(s(i.description));
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return short(typeof first === 'string' ? first : '');
    }
  }
}

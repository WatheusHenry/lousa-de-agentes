import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContextKind } from '@agent-canvas/shared';
import type { ApprovalService } from '../approvals/approval-service.ts';

export const MCP_SERVER_NAME = 'canvas';
/** Nome que o `claude` usa para a ferramenta: mcp__<servidor>__<ferramenta>. */
export const APPROVE_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
/** Ferramentas do canvas que o agente usa sem pedir permissão (merge não existe aqui). */
export const CANVAS_TOOLS = [
  'open_merge_request',
  'comment_issue',
  'comment_mr',
  'write_note',
  'spawn_agent',
  'wait_for_agents',
  'report_plan',
  'ask_human',
].map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

/** O que o MCP precisa saber do agente que chamou. */
export interface McpAgentContext {
  agentId: string;
  repoId: number | null;
  worktree: string | null;
}

export interface McpDeps {
  /** Resolve o token Bearer da config MCP do agente. */
  agentByToken(token: string): McpAgentContext | null;
  approvals: ApprovalService;
  /** Ações do agente no GitLab; devolvem o texto da resposta da ferramenta. */
  gitlab: {
    openMergeRequest(agentId: string, opts: { title: string; description?: string }): Promise<string>;
    commentIssue(agentId: string, body: string): Promise<string>;
    commentMr(agentId: string, body: string): Promise<string>;
  };
  /** Orquestração: sub-agentes, espera, plano e perguntas ao usuário. */
  orchestration: {
    spawn(
      agentId: string,
      input: { repo: string; task: string; context?: { kind: ContextKind; ref: string }[] },
    ): Promise<string>;
    wait(agentId: string, ids?: string[]): Promise<string>;
    plan(agentId: string, items: { text: string; done: boolean }[]): Promise<string>;
    ask(agentId: string, question: string, options: string[]): Promise<string>;
  };
  /** Notas no canvas escritas pelo agente (a de passagem, principalmente). */
  notes: {
    write(agentId: string, input: { title?: string; body: string; handoff: boolean }): Promise<string>;
  };
}

/** Erros viram resposta da ferramenta (isError), para o agente ler e reagir. */
async function asTool(fn: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
  }
}

function buildServer(ctx: McpAgentContext, deps: McpDeps): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.3.0' });

  // usada pelo --permission-prompt-tool; a resposta segue o formato do Claude Code:
  // {"behavior":"allow","updatedInput":{...}} ou {"behavior":"deny","message":"..."}
  server.registerTool(
    'approve',
    {
      description:
        'Uso interno do Agent Canvas: decide os pedidos de permissão do agente. Não chame diretamente.',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ tool_name, input, tool_use_id }) => {
      const decision = await deps.approvals.request({
        agentId: ctx.agentId,
        repoId: ctx.repoId,
        worktree: ctx.worktree,
        toolName: tool_name,
        input,
        ...(tool_use_id ? { toolUseId: tool_use_id } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
    },
  );

  server.registerTool(
    'open_merge_request',
    {
      description:
        'Envia o seu branch para o GitLab e abre o merge request para a branch padrão, com "Closes #<issue>" ' +
        'quando houver issue. Faça commit de tudo antes. Se você já tem um MR aberto, envia os commits novos ' +
        'para ele. Num repositório local (sem GitLab), entrega o branch para o usuário revisar no canvas. ' +
        'Nunca faça git push nem merge por conta própria.',
      inputSchema: {
        title: z.string().min(1).max(250).describe('Título do MR, curto e no imperativo'),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe('O que mudou, por quê e como testar (Markdown)'),
      },
    },
    async ({ title, description }) =>
      asTool(() =>
        deps.gitlab.openMergeRequest(ctx.agentId, { title, ...(description ? { description } : {}) }),
      ),
  );

  server.registerTool(
    'comment_issue',
    {
      description:
        'Comenta na issue do GitLab ligada a você (perguntas ao autor, resumo do que foi feito). ' +
        'O comentário sai identificado como seu.',
      inputSchema: { body: z.string().min(1).max(20_000).describe('Texto em Markdown') },
    },
    async ({ body }) => asTool(() => deps.gitlab.commentIssue(ctx.agentId, body)),
  );

  server.registerTool(
    'comment_mr',
    {
      description: 'Comenta no merge request que você abriu (respostas à revisão, notas sobre o pipeline).',
      inputSchema: { body: z.string().min(1).max(20_000).describe('Texto em Markdown') },
    },
    async ({ body }) => asTool(() => deps.gitlab.commentMr(ctx.agentId, body)),
  );

  server.registerTool(
    'write_note',
    {
      description:
        'Escreve uma nota no canvas. Use ao concluir a tarefa para a nota de passagem (handoff, o padrão): ' +
        'decisões, arquivos tocados, MRs, testes e pendências, em Markdown curto. Ela fica ligada à sua issue ' +
        'e entra no contexto dos próximos agentes. Chamar de novo atualiza a mesma nota de passagem.',
      inputSchema: {
        body: z.string().min(1).max(20_000).describe('Texto da nota em Markdown'),
        title: z.string().min(1).max(120).optional().describe('Título; o padrão é "Passagem · <seu nome>"'),
        handoff: z.boolean().optional().describe('false para uma nota comum em vez da nota de passagem'),
      },
    },
    async ({ body, title, handoff }) =>
      asTool(() =>
        deps.notes.write(ctx.agentId, { body, handoff: handoff ?? true, ...(title ? { title } : {}) }),
      ),
  );
  server.registerTool(
    'spawn_agent',
    {
      description:
        'Cria um agente filho num repositório, com uma tarefa autocontida, e o põe para trabalhar. ' +
        'Ele herda a issue, as notas e o seu plano. Recusado além da profundidade que o usuário liberou. ' +
        'Num repositório diferente do seu, o filho abre o próprio MR; no mesmo, trabalha num branch criado a partir do seu.',
      inputSchema: {
        repo: z.string().min(1).describe('Nome do projeto (ex.: payments-api) ou caminho grupo/projeto'),
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe('A tarefa completa: o que mudar, onde, como testar, o que combinar'),
        context: z
          .array(z.object({ kind: ContextKind, ref: z.string() }))
          .max(20)
          .optional()
          .describe('Itens extras de contexto, ex.: [{"kind":"file","ref":"src/api/types.ts"}]'),
      },
    },
    async ({ repo, task, context }) =>
      asTool(() => deps.orchestration.spawn(ctx.agentId, { repo, task, ...(context ? { context } : {}) })),
  );

  server.registerTool(
    'wait_for_agents',
    {
      description:
        'Espera os seus agentes filhos (todos, ou os nomes/ids pedidos) pararem de trabalhar e devolve um resumo ' +
        'de cada um: estado, branch, MR e a resposta final. Pode demorar: os filhos podem pedir permissões ao usuário.',
      inputSchema: {
        agent_ids: z.array(z.string()).optional().describe('Nomes (agente-3) ou ids; vazio espera todos'),
      },
    },
    async ({ agent_ids }) => asTool(() => deps.orchestration.wait(ctx.agentId, agent_ids)),
  );

  server.registerTool(
    'report_plan',
    {
      description:
        'Publica (ou atualiza) o seu plano em checklist: aparece no canvas para o usuário e no contexto dos seus filhos. ' +
        'Chame de novo marcando done quando um passo terminar.',
      inputSchema: {
        items: z
          .array(z.object({ text: z.string().min(1).max(300), done: z.boolean().optional() }))
          .min(1)
          .max(20),
      },
    },
    async ({ items }) =>
      asTool(() =>
        deps.orchestration.plan(
          ctx.agentId,
          items.map((i) => ({ text: i.text, done: !!i.done })),
        ),
      ),
  );

  server.registerTool(
    'ask_human',
    {
      description:
        'Faz uma pergunta ao usuário (aparece na aba Ações) e espera a resposta. Use só para decisões que só ele ' +
        'pode tomar; ofereça opções curtas quando der.',
      inputSchema: {
        question: z.string().min(1).max(2000),
        options: z.array(z.string().min(1).max(120)).max(6).optional(),
      },
    },
    async ({ question, options }) =>
      asTool(() => deps.orchestration.ask(ctx.agentId, question, options ?? [])),
  );
  return server;
}

/** Monta o endpoint MCP (Streamable HTTP, sem estado) em POST/GET/DELETE /mcp. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const handler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    const ctx = auth.startsWith('Bearer ') ? deps.agentByToken(auth.slice(7)) : null;
    if (!ctx) return reply.code(401).send({ error: 'Agente desconhecido.' });
    if (req.method !== 'POST') return reply.code(405).send({ error: 'Use POST.' });
    const server = buildServer(ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler });
}

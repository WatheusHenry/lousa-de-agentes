import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../approvals/approval-service.ts';

export const MCP_SERVER_NAME = 'canvas';
/** Nome que o `claude` usa para a ferramenta: mcp__<servidor>__<ferramenta>. */
export const APPROVE_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
/** Ferramentas do canvas que o agente usa sem pedir permissão (merge não existe aqui). */
export const CANVAS_TOOLS = ['open_merge_request', 'comment_issue', 'comment_mr'].map(
  (t) => `mcp__${MCP_SERVER_NAME}__${t}`,
);

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
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.2.0' });

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
        'para ele. Nunca faça git push nem merge por conta própria.',
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

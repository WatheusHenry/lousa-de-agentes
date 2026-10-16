import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../approvals/approval-service.ts';

export const MCP_SERVER_NAME = 'canvas';
/** Nome que o `claude` usa para a ferramenta: mcp__<servidor>__<ferramenta>. */
export const APPROVE_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;

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

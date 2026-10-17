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
  'list_agents',
  'message_agent',
  'stop_agent',
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
      input: {
        repo?: string;
        task: string;
        kind?: 'code' | 'explore';
        model?: string;
        context?: { kind: ContextKind; ref: string }[];
      },
    ): Promise<string>;
    wait(agentId: string, ids?: string[], mode?: 'all' | 'any'): Promise<string>;
    list(agentId: string): Promise<string>;
    message(agentId: string, child: string, text: string): Promise<string>;
    stop(agentId: string, child: string, reason?: string): Promise<string>;
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
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.4.0' });

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
        'Cria um agente filho com uma tarefa autocontida e o põe para trabalhar em paralelo com você. ' +
        'kind "code" (padrão): implementa num worktree próprio; no seu repositório, num branch criado a partir do ' +
        'seu (junte com git merge quando ele terminar); em outro repositório, abre o próprio MR. kind "explore": só ' +
        'lê o código (o seu worktree, com o que você já commitou) e responde: use para mapear o código, achar ' +
        'causas e responder perguntas sem gastar o seu contexto. O filho herda a issue, as notas e o seu plano. ' +
        'Recusado além da profundidade que o usuário liberou ou do limite de filhos trabalhando ao mesmo tempo.',
      inputSchema: {
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            'A tarefa completa e autocontida: objetivo, arquivos e lugares relevantes, o que não mexer, como testar, ' +
              'o que combinar com os outros e o que responder no fim',
          ),
        repo: z
          .string()
          .min(1)
          .optional()
          .describe('Nome do projeto (ex.: payments-api) ou grupo/projeto; vazio = o seu repositório'),
        kind: z
          .enum(['code', 'explore'])
          .optional()
          .describe('"code" implementa (padrão); "explore" só lê e responde'),
        model: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Modelo do filho: "haiku" para buscas e tarefas mecânicas, "sonnet", "opus"; vazio = o seu',
          ),
        context: z
          .array(z.object({ kind: ContextKind, ref: z.string() }))
          .max(20)
          .optional()
          .describe('Itens extras de contexto, ex.: [{"kind":"file","ref":"src/api/types.ts"}]'),
      },
    },
    async ({ repo, task, kind, model, context }) =>
      asTool(() =>
        deps.orchestration.spawn(ctx.agentId, {
          task,
          ...(repo ? { repo } : {}),
          ...(kind ? { kind } : {}),
          ...(model ? { model } : {}),
          ...(context ? { context } : {}),
        }),
      ),
  );

  server.registerTool(
    'wait_for_agents',
    {
      description:
        'Espera os seus agentes filhos pararem de trabalhar e devolve um resumo de cada um: estado, branch, MR, a ' +
        'resposta final e o diff. mode "all" (padrão) espera todos os pedidos; mode "any" volta quando o primeiro ' +
        'filho com resultado novo parar, para você juntar e mandar mais trabalho enquanto os outros seguem. Pode ' +
        'demorar: os filhos podem pedir permissões ao usuário. Se você terminar o turno sem esperar, o resumo chega ' +
        'sozinho como mensagem quando todos pararem.',
      inputSchema: {
        agent_ids: z.array(z.string()).optional().describe('Nomes (agente-3) ou ids; vazio = os seus filhos'),
        mode: z.enum(['all', 'any']).optional().describe('"all" (padrão) ou "any"'),
      },
    },
    async ({ agent_ids, mode }) => asTool(() => deps.orchestration.wait(ctx.agentId, agent_ids, mode)),
  );

  server.registerTool(
    'list_agents',
    {
      description:
        'Lista os seus agentes filhos sem esperar: tipo, repositório, estado, branch e tarefa, mais quantos filhos ' +
        'você ainda pode ter trabalhando ao mesmo tempo e as vagas de execução do app.',
      inputSchema: {},
    },
    async () => asTool(() => deps.orchestration.list(ctx.agentId)),
  );

  server.registerTool(
    'message_agent',
    {
      description:
        'Manda uma mensagem a um agente filho seu: correção do que ele entregou, uma resposta, a próxima etapa. ' +
        'Ele continua na mesma sessão (com tudo o que já sabe), em vez de você criar outro. Depois, espere com ' +
        'wait_for_agents.',
      inputSchema: {
        agent: z.string().min(1).describe('Nome (agente-3) ou id do filho'),
        text: z.string().min(1).max(20_000).describe('A mensagem, em Markdown'),
      },
    },
    async ({ agent, text }) => asTool(() => deps.orchestration.message(ctx.agentId, agent, text)),
  );

  server.registerTool(
    'stop_agent',
    {
      description:
        'Para um agente filho seu (e os filhos dele) quando o trabalho dele não serve mais: caminho errado, tarefa ' +
        'repetida ou já resolvida. O branch dele fica como está.',
      inputSchema: {
        agent: z.string().min(1).describe('Nome (agente-3) ou id do filho'),
        reason: z.string().max(500).optional().describe('Motivo, para o usuário'),
      },
    },
    async ({ agent, reason }) => asTool(() => deps.orchestration.stop(ctx.agentId, agent, reason)),
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

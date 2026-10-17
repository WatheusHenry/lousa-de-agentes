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
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_screenshot',
  'browser_console',
  'browser_evaluate',
  'browser_wait',
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
  /** Navegador do agente no canvas (o usuário vê a mesma tela no cartão). */
  browser: {
    open(agentId: string, url: string): Promise<string>;
    navigate(agentId: string, action: 'back' | 'forward' | 'reload'): Promise<string>;
    snapshot(agentId: string): Promise<string>;
    click(agentId: string, ref: number, double: boolean): Promise<string>;
    type(
      agentId: string,
      ref: number | null,
      text: string,
      opts: { clear: boolean; submit: boolean },
    ): Promise<string>;
    press(agentId: string, key: string): Promise<string>;
    scroll(agentId: string, dy: number): Promise<string>;
    /** JPEG em base64. */
    screenshot(agentId: string, full: boolean): Promise<string>;
    console(agentId: string, clear: boolean): Promise<string>;
    evaluate(agentId: string, expression: string): Promise<string>;
    wait(agentId: string, o: { text?: string; ms?: number }): Promise<string>;
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
  registerBrowserTools(server, ctx, deps);
  return server;
}

function registerBrowserTools(server: McpServer, ctx: McpAgentContext, deps: McpDeps): void {
  const b = deps.browser;
  const id = ctx.agentId;
  server.registerTool(
    'browser_open',
    {
      description:
        'Abre uma URL no seu navegador do canvas (cria o navegador ao seu lado na primeira vez; depois, navega nele). ' +
        'O usuário vê a mesma tela ao vivo e pode interagir junto. Use para testar a interface que você está mexendo ' +
        '(ex.: http://localhost:5173 depois de subir o dev server), ver componentes, ler documentação ou usar apps web. ' +
        'É um Chrome com perfil próprio, sem os logins do usuário.',
      inputSchema: { url: z.string().min(1).max(4_000).describe('Ex.: http://localhost:3000/login ou docs.exemplo.com') },
    },
    async ({ url }) => asTool(() => b.open(id, url)),
  );
  server.registerTool(
    'browser_navigate',
    {
      description: 'Volta, avança ou recarrega a página do seu navegador.',
      inputSchema: { action: z.enum(['back', 'forward', 'reload']) },
    },
    async ({ action }) => asTool(() => b.navigate(id, action)),
  );
  server.registerTool(
    'browser_snapshot',
    {
      description:
        'Lê a página do seu navegador em texto: títulos, textos e elementos interativos com referências [n] ' +
        'para browser_click e browser_type. Tire um novo depois de cada mudança na página (as referências mudam).',
      inputSchema: {},
    },
    async () => asTool(() => b.snapshot(id)),
  );
  server.registerTool(
    'browser_click',
    {
      description: 'Clica no elemento [ref] do último browser_snapshot (como um clique de mouse de verdade).',
      inputSchema: {
        ref: z.number().int().min(1).describe('Número entre colchetes no snapshot'),
        double: z.boolean().optional().describe('Duplo clique'),
      },
    },
    async ({ ref, double }) => asTool(() => b.click(id, ref, !!double)),
  );
  server.registerTool(
    'browser_type',
    {
      description:
        'Digita num campo [ref] do último snapshot (substitui o conteúdo, a não ser com clear=false). ' +
        'Sem ref, digita onde o foco estiver. submit=true aperta Enter no fim.',
      inputSchema: {
        ref: z.number().int().min(1).optional(),
        text: z.string().max(20_000),
        clear: z.boolean().optional(),
        submit: z.boolean().optional(),
      },
    },
    async ({ ref, text, clear, submit }) =>
      asTool(() => b.type(id, ref ?? null, text, { clear: clear ?? true, submit: !!submit })),
  );
  server.registerTool(
    'browser_press',
    {
      description:
        'Aperta uma tecla na página: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, ' +
        'PageUp, PageDown, Space ou um caractere.',
      inputSchema: { key: z.string().min(1).max(20) },
    },
    async ({ key }) => asTool(() => b.press(id, key)),
  );
  server.registerTool(
    'browser_scroll',
    {
      description: 'Rola a página (positivo desce, negativo sobe), em pixels.',
      inputSchema: { dy: z.number().int().min(-20_000).max(20_000) },
    },
    async ({ dy }) => asTool(() => b.scroll(id, dy)),
  );
  server.registerTool(
    'browser_screenshot',
    {
      description:
        'Imagem da tela do seu navegador, para conferir visual, layout e estilos. full=true pega a página inteira.',
      inputSchema: { full: z.boolean().optional() },
    },
    async ({ full }) => {
      try {
        const data = await b.screenshot(id, !!full);
        return { content: [{ type: 'image' as const, data, mimeType: 'image/jpeg' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
      }
    },
  );
  server.registerTool(
    'browser_console',
    {
      description: 'Mensagens do console e erros JavaScript da página (as últimas 200). clear=true limpa depois de ler.',
      inputSchema: { clear: z.boolean().optional() },
    },
    async ({ clear }) => asTool(() => b.console(id, !!clear)),
  );
  server.registerTool(
    'browser_evaluate',
    {
      description:
        'Roda uma expressão JavaScript na página e devolve o resultado em JSON (promises são esperadas). ' +
        'Ex.: document.querySelectorAll("li").length',
      inputSchema: { expression: z.string().min(1).max(20_000) },
    },
    async ({ expression }) => asTool(() => b.evaluate(id, expression)),
  );
  server.registerTool(
    'browser_wait',
    {
      description: 'Espera um texto aparecer na página (até ms, padrão 15 s) ou só espera ms milissegundos.',
      inputSchema: {
        text: z.string().min(1).max(500).optional(),
        ms: z.number().int().min(0).max(60_000).optional(),
      },
    },
    async ({ text, ms }) =>
      asTool(() => b.wait(id, { ...(text ? { text } : {}), ...(ms !== undefined ? { ms } : {}) })),
  );
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

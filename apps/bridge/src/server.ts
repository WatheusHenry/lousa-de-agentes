import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ClientMessage,
  ProjectSelectionInput,
  SESSION_HEADER,
  SESSION_META,
  SESSION_QUERY,
  type Issue,
  type ServerMessage,
  type StateSnapshot,
} from '@agent-canvas/shared';
import { AgentError, Supervisor } from './agents/supervisor.ts';
import type { AgentRunner } from './agents/runner.ts';
import { ApprovalService } from './approvals/approval-service.ts';
import { CanvasError, CanvasStore } from './canvas/canvas-store.ts';
import type { BridgeConfig } from './config.ts';
import type { Db } from './db/index.ts';
import { GitLabError } from './gitlab/client.ts';
import { Hub } from './hub.ts';
import { registerMcp } from './mcp/canvas-server.ts';
import { MrError, MrService } from './mrs/mr-service.ts';
import type { Session } from './session.ts';
import { SettingsError, type SettingsService } from './settings.ts';

export const SERVER_VERSION = '0.3.0';

export interface ServerDeps {
  config: Pick<BridgeConfig, 'port' | 'allowedOrigins' | 'webDist'>;
  db: Db;
  session: Session;
  settings: SettingsService;
  runner: AgentRunner;
  /** Pasta de dados do app: worktrees e configs MCP dos agentes. */
  home: string;
  /** Modelo dos agentes (padrão do Claude Code quando ausente). */
  model?: string;
  /** Intervalo do polling de pipelines (desligado quando ausente, como nos testes). */
  pollMrsEveryMs?: number;
  logger?: boolean;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db, session, settings } = deps;
  const store = new CanvasStore(db);
  const hub = new Hub();
  const approvals = new ApprovalService(db, hub);
  const mrs = new MrService(db, hub, store, settings);
  const supervisor = new Supervisor({
    db,
    hub,
    store,
    settings,
    approvals,
    runner: deps.runner,
    home: deps.home,
    bridgePort: config.port,
    ...(deps.model ? { model: deps.model } : {}),
    mrOfAgent: (id) => mrs.mrOfAgent(id),
  });

  const app = Fastify({
    // a URL do WebSocket leva o token de sessão: o log grava só o caminho
    logger: deps.logger
      ? {
          level: 'info',
          serializers: {
            req: (req: { method: string; url: string }) => ({
              method: req.method,
              url: req.url.split('?')[0],
            }),
          },
        }
      : false,
    bodyLimit: 1_000_000,
    forceCloseConnections: true,
  });

  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  /** Proteções contra outras páginas abertas no navegador (CSRF e DNS rebinding). */
  function guard(req: FastifyRequest, reply: FastifyReply, token: string | undefined): boolean {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    if (!allowedHosts.has(host)) {
      reply.code(403).send({ error: 'Host não permitido.' });
      return false;
    }
    if (origin && !config.allowedOrigins.includes(origin)) {
      reply.code(403).send({ error: 'Origem não permitida.' });
      return false;
    }
    if (!session.check(token)) {
      reply.code(401).send({ error: 'Token de sessão ausente ou inválido. Recarregue a página.' });
      return false;
    }
    return true;
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/ws') {
      const q = new URL(req.url, 'http://x').searchParams.get(SESSION_QUERY) ?? undefined;
      if (!guard(req, reply, q)) {
        // a conexão recusada não vira WebSocket; fecha o socket para não ficar pendurado
        setImmediate(() => req.raw.socket.destroy());
        return reply;
      }
    } else if (path === '/mcp') {
      // o claude dos agentes: só Host local; o token do agente é conferido no handler
      if (!allowedHosts.has(req.headers.host ?? ''))
        return reply.code(403).send({ error: 'Host não permitido.' });
    } else if (path.startsWith('/api/')) {
      const h = req.headers[SESSION_HEADER];
      if (!guard(req, reply, Array.isArray(h) ? h[0] : h)) return reply;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SettingsError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof GitLabError) return reply.code(502).send({ error: err.message });
    if (err instanceof CanvasError || err instanceof AgentError || err instanceof MrError)
      return reply.code(409).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500).send({ error: 'Erro interno no bridge.' });
  });

  const broadcast = hub.broadcast.bind(hub);

  const snapshot = (): StateSnapshot => ({
    settings: settings.view(),
    nodes: store.liveNodes(),
    edges: store.liveEdges(),
    notes: store.liveNotes(),
    noteLinks: store.liveNoteLinks(),
    issues: store.canvasIssues(),
    activity: store.recentActivity(),
    agents: supervisor.agents(),
    agentEvents: supervisor.recentEvents(),
    approvals: approvals.pending(),
    policies: approvals.policies(),
    mergeRequests: mrs.canvasMrs(),
  });

  // ---------- HTTP ----------

  app.get('/api/health', async () => ({ ok: true, version: SERVER_VERSION }));

  app.get('/api/state', async () => snapshot());

  app.get('/api/settings', async () => settings.view());

  app.post('/api/settings/gitlab', async (req) => {
    const view = await settings.save(req.body as never);
    broadcast([
      { type: 'settings.updated', settings: view },
      store.logActivity('Configurações do GitLab salvas'),
    ]);
    return view;
  });

  app.get('/api/gitlab/projects', async (req) => {
    const search = (req.query as { search?: string }).search;
    return settings.client().searchProjects(search?.slice(0, 100));
  });

  app.put('/api/settings/projects', async (req) => {
    const parsed = ProjectSelectionInput.safeParse(req.body);
    if (!parsed.success) throw new SettingsError('Lista de projetos inválida.');
    const view = await settings.selectProjects(parsed.data.projectIds);
    broadcast([{ type: 'settings.updated', settings: view }]);
    return view;
  });

  app.get('/api/repos', async () => settings.repos());

  /** Issues abertas dos projetos escolhidos. Atualiza o cache local a cada chamada. */
  app.get('/api/gitlab/issues', async () => {
    const client = settings.client();
    const projects = settings.projects();
    const results = await Promise.allSettled(projects.map((p) => client.listOpenIssues(p)));
    const issues: Issue[] = [];
    const errors: { project: string; error: string }[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') issues.push(...r.value);
      else
        errors.push({
          project: projects[i]!.pathWithNamespace,
          error: r.reason instanceof GitLabError ? r.reason.message : 'Falha ao buscar issues.',
        });
    });
    store.cacheIssues(issues);
    issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { issues, errors };
  });

  app.get('/api/gitlab/issues/:projectId/:iid/comments', async (req) => {
    const { projectId, iid } = req.params as { projectId: string; iid: string };
    const p = Number(projectId);
    if (!settings.projects().some((x) => x.id === p)) throw new SettingsError('Projeto não escolhido.', 404);
    return settings.client().listIssueComments(p, Number(iid));
  });

  app.get('/api/agents/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const before = Number((req.query as { before?: string }).before) || undefined;
    return supervisor.events(id, before).reverse();
  });

  /** Modo "saída bruta": as linhas do stream-json como vieram do claude. */
  app.get('/api/agents/:id/raw', async (req) => supervisor.rawEvents((req.params as { id: string }).id));

  app.get('/api/mrs/:ref/diff', async (req) => mrs.diff((req.params as { ref: string }).ref));
  app.get('/api/mrs/:ref/comments', async (req) => mrs.comments((req.params as { ref: string }).ref));

  registerMcp(app, {
    agentByToken: (t) => supervisor.mcpContext(t),
    approvals,
    gitlab: {
      async openMergeRequest(agentId, opts) {
        const mr = await mrs.openForAgent(agentId, opts);
        return `MR !${mr.iid} aberto: ${mr.webUrl} (${mr.sourceBranch} → ${mr.targetBranch}). O pipeline é acompanhado pelo canvas; o merge é do usuário.`;
      },
      async commentIssue(agentId, body) {
        const a = supervisor.get(agentId);
        if (!a?.issueRef) throw new MrError('Você não está ligado a nenhuma issue.');
        await mrs.commentIssue(a.issueRef, body, a.name);
        return 'Comentário publicado na issue.';
      },
      async commentMr(agentId, body) {
        const a = supervisor.get(agentId);
        const mr = mrs.mrOfAgent(agentId);
        if (!a || !mr) throw new MrError('Você ainda não abriu um MR. Use open_merge_request primeiro.');
        await mrs.comment(mr.ref, body, a.name);
        return `Comentário publicado no MR !${mr.iid}.`;
      },
    },
  });

  // ---------- WebSocket ----------

  await app.register(fastifyWebsocket, { options: { maxPayload: 1_000_000 } });

  app.get('/ws', { websocket: true }, (socket) => {
    hub.clients.add(socket);
    const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
    send({ type: 'hello', serverVersion: SERVER_VERSION });
    socket.on('close', () => hub.clients.delete(socket));
    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        const parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) return send({ type: 'error', message: 'Mensagem inválida.' });
        msg = parsed.data;
      } catch {
        return send({ type: 'error', message: 'Mensagem inválida.' });
      }
      if (
        msg.type.startsWith('agent.') ||
        msg.type.startsWith('mr.') ||
        msg.type === 'issue.comment' ||
        msg.type === 'approval.decide' ||
        msg.type === 'policy.remove'
      ) {
        void handleAgentMessage(msg).catch((err) => {
          const known =
            err instanceof AgentError ||
            err instanceof SettingsError ||
            err instanceof GitLabError ||
            err instanceof MrError;
          if (!known) app.log.error(err);
          send({ type: 'error', message: known ? (err as Error).message : 'Erro ao falar com o agente.' });
        });
        return;
      }
      try {
        const out = store.apply(msg);
        if (msg.type === 'node.remove') {
          const n = store.anyNode(msg.nodeId);
          if (n?.type === 'agent') supervisor.onNodeRemoved(n.refId);
        }
        if (msg.type === 'node.restore') {
          broadcast(out);
          if (out.length) broadcast([{ type: 'state.snapshot', state: snapshot() }]);
        } else {
          // quem enviou já aplicou a mudança; a atividade vai para todos
          broadcast(
            out.filter((m) => m.type !== 'activity'),
            socket,
          );
          broadcast(out.filter((m) => m.type === 'activity'));
          // issue.place pode devolver o nó já existente: o remetente precisa saber
          if (msg.type === 'issue.place') out.filter((m) => m.type === 'node.upsert').forEach(send);
        }
      } catch (err) {
        const message = err instanceof CanvasError ? err.message : 'Erro ao aplicar a mudança.';
        if (!(err instanceof CanvasError)) app.log.error(err);
        // devolve o estado real para o cliente desfazer a mudança otimista
        send({ type: 'error', message });
        send({ type: 'state.snapshot', state: snapshot() });
      }
    });
  });

  async function handleAgentMessage(msg: ClientMessage): Promise<void> {
    if (msg.type === 'approval.decide') return approvals.decide(msg.approvalId, msg.decision, msg.remember);
    if (msg.type === 'policy.remove') return approvals.removePolicy(msg.policyId);
    if (msg.type === 'mr.merge') return void (await mrs.merge(msg.mrRef));
    if (msg.type === 'mr.refresh') return void (await mrs.refresh(msg.mrRef, true));
    if (msg.type === 'mr.comment') return mrs.comment(msg.mrRef, msg.body);
    if (msg.type === 'issue.comment') return mrs.commentIssue(msg.issueRef, msg.body);
    if (msg.type.startsWith('agent.')) return supervisor.handle(msg as Parameters<Supervisor['handle']>[0]);
  }

  // ---------- front-end em produção ----------

  if (config.webDist) {
    const indexHtml = readFileSync(join(config.webDist, 'index.html'), 'utf8');
    const page = indexHtml.replace(
      '</head>',
      `<meta name="${SESSION_META}" content="${session.token}"></head>`,
    );
    await app.register(fastifyStatic, { root: config.webDist, index: false, wildcard: false });
    const serveIndex = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send('Host não permitido.');
      return reply.type('text/html').header('cache-control', 'no-store').send(page);
    };
    app.get('/', serveIndex);
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Não encontrado.' })
        : serveIndex(req, reply),
    );
  }

  if (deps.pollMrsEveryMs) mrs.startPolling(deps.pollMrsEveryMs);

  app.addHook('preClose', async () => {
    mrs.stopPolling();
    supervisor.shutdown();
    for (const ws of hub.clients) ws.terminate();
  });

  store.purgeRemoved();
  return app;
}

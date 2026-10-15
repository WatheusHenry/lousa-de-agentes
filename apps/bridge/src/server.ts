import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
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
import { CanvasError, CanvasStore } from './canvas/canvas-store.ts';
import type { BridgeConfig } from './config.ts';
import type { Db } from './db/index.ts';
import { GitLabError } from './gitlab/client.ts';
import type { Session } from './session.ts';
import { SettingsError, type SettingsService } from './settings.ts';

export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  config: Pick<BridgeConfig, 'port' | 'allowedOrigins' | 'webDist'>;
  db: Db;
  session: Session;
  settings: SettingsService;
  logger?: boolean;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db, session, settings } = deps;
  const store = new CanvasStore(db);
  const clients = new Set<WebSocket>();

  const app = Fastify({
    // nada de log de requisição: a URL do WebSocket leva o token de sessão
    logger: deps.logger ? { level: 'info' } : false,
    disableRequestLogging: true,
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
    } else if (path.startsWith('/api/')) {
      const h = req.headers[SESSION_HEADER];
      if (!guard(req, reply, Array.isArray(h) ? h[0] : h)) return reply;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SettingsError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof GitLabError) return reply.code(502).send({ error: err.message });
    if (err instanceof CanvasError) return reply.code(409).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500).send({ error: 'Erro interno no bridge.' });
  });

  function broadcast(msgs: ServerMessage[], except?: WebSocket): void {
    for (const msg of msgs) {
      const data = JSON.stringify(msg);
      for (const ws of clients) if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  const snapshot = (): StateSnapshot => ({
    settings: settings.view(),
    nodes: store.liveNodes(),
    edges: store.liveEdges(),
    notes: store.liveNotes(),
    noteLinks: store.liveNoteLinks(),
    issues: store.canvasIssues(),
    activity: store.recentActivity(),
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

  // ---------- WebSocket ----------

  await app.register(fastifyWebsocket, { options: { maxPayload: 1_000_000 } });

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
    send({ type: 'hello', serverVersion: SERVER_VERSION });
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        const parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) return send({ type: 'error', message: 'Mensagem inválida.' });
        msg = parsed.data;
      } catch {
        return send({ type: 'error', message: 'Mensagem inválida.' });
      }
      try {
        const out = store.apply(msg);
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

  app.addHook('preClose', async () => {
    for (const ws of clients) ws.terminate();
  });

  store.purgeRemoved();
  return app;
}

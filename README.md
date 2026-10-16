# Agent Canvas

Canvas para orquestrar agentes do Claude Code a partir de issues e repositórios do GitLab. Roda na sua máquina: um servidor Node local (o **bridge**) e o front-end no navegador.

- Plano completo: [`docs/PLANO-IMPLEMENTACAO.md`](docs/PLANO-IMPLEMENTACAO.md)
- Protótipo de referência (visual e comportamento): [`docs/prototype/agent-canvas.html`](docs/prototype/agent-canvas.html). Abra direto no navegador.

## Estado atual

| Fase        | O que entrega                                                        | Estado       |
| ----------- | -------------------------------------------------------------------- | ------------ |
| 0 · Base    | Monorepo, bridge com token de sessão, tela de configuração do GitLab | pronta       |
| 1 · Canvas  | Issues reais no canvas, notas, vínculos, desfazer, persistência      | em andamento |
| 2 em diante | Agentes, MRs, contexto, orquestração, automações                     | ainda não    |

## Requisitos

- Node 22 ou mais novo
- pnpm 10 (`corepack enable` instala a versão do `packageManager`)
- Claude Code instalado e logado (`claude --version`). Só é usado a partir da Fase 2.
- `glab` é opcional.
- Ferramentas de compilação para o `better-sqlite3` (normalmente já vem um binário pronto; se não, `python3`, `make` e um compilador C++).

## Instalação e uso

```bash
pnpm install
pnpm dev
```

`pnpm dev` sobe o bridge em `http://127.0.0.1:4317` e o front-end em `http://127.0.0.1:5173`. Abra o segundo.

Na primeira vez aparece a tela de configuração:

1. **URL da instância** do GitLab (ex.: `https://gitlab.com` ou a URL da sua empresa).
2. **Token de acesso pessoal** com escopo `api` (GitLab → Preferências → Access tokens). O bridge valida com `GET /user` antes de salvar e recusa token inválido.
3. **Pasta dos repositórios locais**: onde ficam seus clones. Os agentes vão trabalhar em worktrees a partir deles (Fase 2).
4. Escolha os **projetos** cujas issues abertas aparecem no canvas.

Sem token à mão, use **Usar dados de exemplo**: o canvas funciona com os mesmos dados fictícios do protótipo.

Para abrir a configuração de novo, clique em "GitLab conectado" no rodapé da barra lateral.

### Onde ficam os dados

Tudo em `~/.agent-canvas` (mude com `AGENT_CANVAS_HOME`):

| Arquivo           | Conteúdo                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `agent-canvas.db` | SQLite: canvas, notas, cache de issues, configurações não secretas                       |
| `secrets.json`    | Token do GitLab, permissão `0600`. Nunca vai para o banco, para logs ou para o navegador |
| `session.json`    | Token de sessão do bridge da execução atual (`0600`), lido pelo Vite em dev              |

Em vez de salvar o token pela tela, você pode criar um `.env` na raiz do repositório com `AGENT_CANVAS_GITLAB_TOKEN=glpat-…`. A variável tem prioridade e nunca é gravada em disco pelo app.

### Variáveis de ambiente

| Variável                       | Padrão            | Uso                                                       |
| ------------------------------ | ----------------- | --------------------------------------------------------- |
| `AGENT_CANVAS_HOME`            | `~/.agent-canvas` | Pasta de dados                                            |
| `AGENT_CANVAS_PORT`            | `4317`            | Porta do bridge                                           |
| `AGENT_CANVAS_WEB_PORT`        | `5173`            | Porta do Vite                                             |
| `AGENT_CANVAS_GITLAB_TOKEN`    | —                 | Token do GitLab (alternativa ao arquivo de segredos)      |
| `AGENT_CANVAS_ALLOWED_ORIGINS` | —                 | Origens extras aceitas pelo bridge, separadas por vírgula |

## Usando o canvas (Fase 1)

- **Issues**: a aba Issues lista as issues abertas dos projetos escolhidos (atualiza a cada minuto). Arraste uma para o canvas ou use o **+** da linha. Se ela já estiver no canvas, o botão vira **mostrar**.
- **Notas**: botão **Nota** na toolbar, **duplo clique** no fundo ou **botão direito → Nova nota aqui**. Escreva direto no cartão; salva sozinho.
- **Vincular**: arraste o **+** amarelo da nota até uma issue, ou use **Vincular a…** no painel da nota.
- **Mover**: arraste pelo cartão (a nota arrasta pelo cabeçalho). A posição fica no SQLite.
- **Foco**: duplo clique num item (ou o ícone ↗) abre a issue como documento, com critérios de aceite e discussão do GitLab, e a nota como editor. **Esc** fecha.
- **Remover**: **Delete** ou botão direito. O aviso tem **Desfazer** (ou **Ctrl/⌘ + Z**).
- **Câmera**: arraste o fundo ou role para mover, **Ctrl/⌘ + scroll** para zoom, **Ajustar** enquadra tudo na área livre entre os painéis. **Ctrl/⌘ + B** mostra ou esconde a barra lateral.

Recarregar a página mantém tudo: nós, posições, notas e vínculos vêm do bridge.

## Scripts

| Comando                                          | O que faz                                                       |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `pnpm dev`                                       | Bridge + front-end com recarga automática                       |
| `pnpm test`                                      | Vitest em todos os pacotes                                      |
| `pnpm lint`                                      | ESLint                                                          |
| `pnpm format` / `pnpm format:check`              | Prettier                                                        |
| `pnpm typecheck`                                 | `tsc` em todos os pacotes                                       |
| `pnpm build`                                     | Build do front-end em `apps/web/dist`                           |
| `pnpm start`                                     | Bridge servindo o build do front-end em `http://127.0.0.1:4317` |
| `pnpm --filter @agent-canvas/bridge db:generate` | Gera migração do Drizzle depois de mudar `src/db/schema.ts`     |

## Estrutura

```
apps/
  bridge/     servidor local (Fastify + WebSocket + SQLite/Drizzle + GitLab)
  web/        front-end (React + Vite + React Flow + Zustand)
packages/
  shared/     schemas zod e tipos do contrato entre bridge e front-end
docs/         plano e protótipo
```

## Segurança

- O bridge escuta só em `127.0.0.1`.
- Cada execução gera um token de sessão aleatório. A API (`/api/*`) exige o token no cabeçalho `x-agent-canvas-token` e o WebSocket no parâmetro `token`. O token chega ao front-end numa meta tag do `index.html`, que outras origens não conseguem ler.
- O bridge recusa `Host` diferente de `127.0.0.1`/`localhost` na porta dele (proteção contra DNS rebinding) e `Origin` fora da lista permitida.
- O token do GitLab nunca sai do bridge: o front-end só vê `hasToken`.

## Desvios do plano

| Plano                                                               | Implementado                                                                                                            | Motivo                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estrutura com pasta raiz `agent-canvas/`                            | Monorepo direto na raiz do repositório                                                                                  | O repositório já é o projeto; uma pasta a mais não acrescenta nada.                                                                                                                                                                         |
| Segredos no chaveiro do sistema (`keytar`) ou `.env`                | Arquivo `secrets.json` com permissão `0600` na pasta de dados, ou `AGENT_CANVAS_GITLAB_TOKEN` (inclusive via `.env`)    | O `keytar` está arquivado e sem manutenção, e depende de módulo nativo e de libsecret no Linux. O plano permite a alternativa local; o token continua fora do banco. Dá para trocar por chaveiro depois sem mexer no resto (`SecretStore`). |
| Rotas HTTP `/state`, `/repos`, `/gitlab/issues`, `/settings/gitlab` | Mesmas rotas com prefixo `/api`                                                                                         | Separa a API das páginas do front-end no proxy do Vite e quando o bridge serve o build.                                                                                                                                                     |
| `node.move` como única mensagem de nó                               | Mensagens extras `issue.place`, `node.remove` e `node.restore`                                                          | O canvas precisa criar o nó da issue e fazer remoção suave com desfazer, que o contrato da seção 5 não cobria. `agent.remove`/`agent.restore` continuam reservados para a Fase 2.                                                           |
| Contrato servidor → cliente                                         | Mensagens extras `note.upsert`, `noteLink.upsert/remove`, `issue.upsert`, `settings.updated`, `state.snapshot`, `error` | Para outros clientes abertos acompanharem notas e configurações, e para o desfazer restaurar tudo de uma vez.                                                                                                                               |
| Tabelas da seção 4                                                  | Mais `setting` (configurações não secretas) e `activity` (feed); `note` ganhou `createdAt`/`updatedAt`                  | Guardar a configuração validada e manter o feed de atividade depois de reiniciar. As tabelas de agentes, aprovações e MRs entram nas fases em que são usadas.                                                                               |
| TypeScript                                                          | Fixado em `~6.0`                                                                                                        | O TypeScript 7 (versão nativa) ainda não é suportado pelo `typescript-eslint`.                                                                                                                                                              |

## Diferenças em relação ao protótipo

O visual (tokens, cartões, painéis, menu, aviso, foco) foi portado do protótipo. O que difere, por enquanto:

- Agentes, MRs, aba Ações, contexto e automações ainda não existem: os botões **+ Novo agente**, **Iniciar** e **Iniciar agentes** aparecem desativados, a aba Ações mostra o estado vazio e o painel de Automações mostra as regras desligadas. Isso chega nas Fases 2 a 6.
- O painel da issue não tem as opções de contexto e autonomia, que só fazem sentido ao iniciar agentes.
- Uma issue real pertence a um projeto só; o cartão mostra esse projeto em vez da lista de repositórios afetados que o protótipo inventava.
- Os critérios de aceite vêm dos itens de checklist (`- [ ]`) da descrição. Sem checklist, a seção não aparece.
- A discussão da issue é a do GitLab (sem notas de sistema). Comentar pelo canvas chega na Fase 3.
- A barra lateral não aceita soltar um repositório no canvas (cria agente na Fase 2).
- O canvas usa o React Flow: pan, zoom e arrasto vêm dele, e o crédito "React Flow" fica visível no canto, como pede a licença para quem não assina o plano Pro.
- O texto da nota cresce com o conteúdo (até 320 px) em vez de rolar.

## Limitações conhecidas

- Se o bridge reiniciar (por exemplo, com o `tsx watch` em dev), o token de sessão muda e é preciso recarregar a página. O aviso "Sem conexão com o bridge" tem o botão para isso.
- A lista de issues traz até 300 issues abertas por projeto.
- Descrições e comentários aparecem como texto, sem renderizar Markdown.

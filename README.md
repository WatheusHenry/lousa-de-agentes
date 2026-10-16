# Agent Canvas

Canvas para orquestrar agentes do Claude Code a partir de issues e repositórios do GitLab. Roda na sua máquina: um servidor Node local (o **bridge**) e o front-end no navegador.

- Plano completo: [`docs/PLANO-IMPLEMENTACAO.md`](docs/PLANO-IMPLEMENTACAO.md)
- Protótipo de referência (visual e comportamento): [`docs/prototype/agent-canvas.html`](docs/prototype/agent-canvas.html). Abra direto no navegador.

## Estado atual

| Fase               | O que entrega                                                                    | Estado    |
| ------------------ | -------------------------------------------------------------------------------- | --------- |
| 0 · Base           | Monorepo, bridge com token de sessão, tela de configuração do GitLab             | pronta    |
| 1 · Canvas         | Issues reais no canvas, notas, vínculos, desfazer, persistência                  | pronta    |
| 2 · Um agente real | Agente `claude` num worktree, saída ao vivo, conversa, permissões pela aba Ações | pronta    |
| 3 em diante        | MRs e pipelines, qualidade do contexto, orquestração, automações, robustez       | ainda não |

## Requisitos

- Node 22 ou mais novo
- pnpm 10 (`corepack enable` instala a versão do `packageManager`)
- Claude Code instalado e logado (`claude --version`; testado com a 2.1.301). Os agentes usam a sua instalação e o seu login.
- `git` 2.5 ou mais novo (worktrees) e os repositórios clonados na pasta configurada.
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
3. **Pasta dos repositórios locais**: onde ficam seus clones (`<pasta>/<nome-do-projeto>` ou `<pasta>/<grupo>/<projeto>`). Cada agente trabalha num worktree criado a partir deles.
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
| `worktrees/<id>`  | Um git worktree por agente, num branch `agent/<iid>-<slug>`                              |
| `agents/<id>/`    | Config MCP do agente (`0600`), com o token que identifica o agente no bridge             |

Em vez de salvar o token pela tela, você pode criar um `.env` na raiz do repositório com `AGENT_CANVAS_GITLAB_TOKEN=glpat-…`. A variável tem prioridade e nunca é gravada em disco pelo app.

### Variáveis de ambiente

| Variável                       | Padrão            | Uso                                                       |
| ------------------------------ | ----------------- | --------------------------------------------------------- |
| `AGENT_CANVAS_HOME`            | `~/.agent-canvas` | Pasta de dados                                            |
| `AGENT_CANVAS_PORT`            | `4317`            | Porta do bridge                                           |
| `AGENT_CANVAS_WEB_PORT`        | `5173`            | Porta do Vite                                             |
| `AGENT_CANVAS_GITLAB_TOKEN`    | —                 | Token do GitLab (alternativa ao arquivo de segredos)      |
| `AGENT_CANVAS_ALLOWED_ORIGINS` | —                 | Origens extras aceitas pelo bridge, separadas por vírgula |
| `AGENT_CANVAS_MODEL`           | padrão do Claude  | Modelo dos agentes (`sonnet`, `opus`, `haiku`…)           |
| `AGENT_CANVAS_CLAUDE_BIN`      | `claude`          | Caminho do executável do Claude Code                      |

## Usando o canvas (Fase 1)

- **Issues**: a aba Issues lista as issues abertas dos projetos escolhidos (atualiza a cada minuto). Arraste uma para o canvas ou use o **+** da linha. Se ela já estiver no canvas, o botão vira **mostrar**.
- **Notas**: botão **Nota** na toolbar, **duplo clique** no fundo ou **botão direito → Nova nota aqui**. Escreva direto no cartão; salva sozinho.
- **Vincular**: arraste o **+** amarelo da nota até uma issue, ou use **Vincular a…** no painel da nota.
- **Mover**: arraste pelo cartão (a nota arrasta pelo cabeçalho). A posição fica no SQLite.
- **Foco**: duplo clique num item (ou o ícone ↗) abre a issue como documento, com critérios de aceite e discussão do GitLab, e a nota como editor. **Esc** fecha.
- **Remover**: **Delete** ou botão direito. O aviso tem **Desfazer** (ou **Ctrl/⌘ + Z**).
- **Câmera**: arraste o fundo ou role para mover, **Ctrl/⌘ + scroll** para zoom, **Ajustar** enquadra tudo na área livre entre os painéis. **Ctrl/⌘ + B** mostra ou esconde a barra lateral.

Recarregar a página mantém tudo: nós, posições, notas e vínculos vêm do bridge.

## Agentes (Fase 2)

- **A partir de uma issue**: **Iniciar** no cartão (ou **Iniciar agente** no painel, com instruções extras). O agente nasce abaixo da issue, ligado a ela, trabalha no projeto da issue e começa na hora.
- **Agente em branco**: **+ Novo agente**, **botão direito → Novo agente aqui**, ou arraste um repositório da aba Repos para o canvas. Dê contexto arrastando um repositório ou uma issue para cima da janela dele (ou escolhendo o repositório no painel) e escreva a primeira instrução.
- **Conversa**: pelo campo da janela ou pelo **modo foco** (ícone ↗ ou duplo clique). A saída é estruturada como no protótipo (texto, ferramenta, resultado, pedido de permissão); **Saída bruta** no foco mostra as linhas do stream-json, para depuração.
- **Permissões**: quando o agente quer rodar algo que não está liberado, a janela mostra o pedido e ele aparece na aba **Ações** (com contador). **Permitir**, **Negar**, **Sempre permitir** (grava a regra no formato do Claude Code, por exemplo `Bash(npm test:*)`, e libera na hora os pedidos iguais) e **Permitir todos**. As regras ficam em **Sempre permitidos**, na mesma aba.
- **Pausar, Retomar, Parar**: no painel do agente ou no botão direito. Pausar interrompe o turno; Retomar continua a mesma sessão (`--resume`). Remover o agente do canvas para o processo.
- **Onde ficam as mudanças**: cada agente trabalha em `~/.agent-canvas/worktrees/<id>`, num branch `agent/<iid>-<slug>` do seu clone. Os commits aparecem nesse branch (`git log agent/…` no clone). O agente não faz push nem merge.

### Como um agente roda

O bridge cria o worktree, grava `.agent-canvas/context.md` (issue, comentários e notas ligadas, com o aviso de que conteúdo do GitLab é dado e não instrução) e inicia:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --session-id <uuid> | --resume <uuid> \
  --mcp-config ~/.agent-canvas/agents/<id>/mcp.json --strict-mcp-config \
  --permission-prompt-tool mcp__canvas__approve --permission-mode default \
  --append-system-prompt <apps/bridge/src/agents/roles/main.md> \
  --allowedTools <regras salvas> --disallowedTools "Bash(git push --force:*)" …
```

O servidor MCP do canvas roda dentro do bridge (`POST /mcp`, Streamable HTTP), identificado por um token por agente. A ferramenta `approve` responde no formato que o Claude Code exige: `{"behavior":"allow","updatedInput":…}` ou `{"behavior":"deny","message":…}`. Antes de qualquer regra, o bridge nega push forçado, `rm -r` fora do worktree, arquivos fora do worktree e comandos de rede (`curl`, `wget`, `ssh`…) sem regra explícita.

Para regravar as saídas reais usadas nos testes do parser (por exemplo, depois de atualizar o Claude Code): `pnpm --filter @agent-canvas/bridge exec tsx scripts/record-fixtures.ts`.

## Scripts

| Comando                                          | O que faz                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm dev`                                       | Bridge + front-end com recarga automática                                                 |
| `pnpm test`                                      | Vitest em todos os pacotes                                                                |
| `pnpm lint`                                      | ESLint                                                                                    |
| `pnpm format` / `pnpm format:check`              | Prettier                                                                                  |
| `pnpm typecheck`                                 | `tsc` em todos os pacotes                                                                 |
| `pnpm build`                                     | Build do front-end em `apps/web/dist`                                                     |
| `pnpm start`                                     | Bridge servindo o build do front-end em `http://127.0.0.1:4317` (rode `pnpm build` antes) |
| `pnpm --filter @agent-canvas/bridge db:generate` | Gera migração do Drizzle depois de mudar `src/db/schema.ts`                               |

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
- O token do GitLab nunca sai do bridge: o front-end só vê `hasToken`, e os processos dos agentes não recebem nenhuma variável `AGENT_CANVAS_*`.
- O endpoint MCP aceita só o token do próprio agente, gerado a cada execução do bridge e guardado num arquivo `0600`.
- O bridge tira do ambiente dos agentes as variáveis de sessão do Claude Code (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`…), para um `pnpm dev` rodado dentro de um terminal do Claude Code não emprestar a sessão dele aos agentes.

## Desvios do plano

| Plano                                                               | Implementado                                                                                                                                                                               | Motivo                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estrutura com pasta raiz `agent-canvas/`                            | Monorepo direto na raiz do repositório                                                                                                                                                     | O repositório já é o projeto; uma pasta a mais não acrescenta nada.                                                                                                                                                                                          |
| Segredos no chaveiro do sistema (`keytar`) ou `.env`                | Arquivo `secrets.json` com permissão `0600` na pasta de dados, ou `AGENT_CANVAS_GITLAB_TOKEN` (inclusive via `.env`)                                                                       | O `keytar` está arquivado e sem manutenção, e depende de módulo nativo e de libsecret no Linux. O plano permite a alternativa local; o token continua fora do banco. Dá para trocar por chaveiro depois sem mexer no resto (`SecretStore`).                  |
| Rotas HTTP `/state`, `/repos`, `/gitlab/issues`, `/settings/gitlab` | Mesmas rotas com prefixo `/api`                                                                                                                                                            | Separa a API das páginas do front-end no proxy do Vite e quando o bridge serve o build.                                                                                                                                                                      |
| `node.move` como única mensagem de nó                               | Mensagens extras `issue.place`, `node.remove` e `node.restore`                                                                                                                             | O canvas precisa criar o nó da issue e fazer remoção suave com desfazer, que o contrato da seção 5 não cobria. Remover e restaurar um agente usa as mesmas `node.remove`/`node.restore` (remover para o processo), em vez de `agent.remove`/`agent.restore`. |
| `agent.status` e `agent.usage` separados                            | Um só `agent.upsert` com o agente inteiro (status, tokens, custo, branch, erro)                                                                                                            | Menos mensagens para manter em sincronia; o front-end sempre tem o agente completo.                                                                                                                                                                          |
| `agent.create { …, context[] }`                                     | `agent.create` sem `context[]`; mais `agent.update { repos, issueRef }` para o agente em branco                                                                                            | Os itens de contexto escolhidos à mão e o seletor chegam na Fase 4. Na Fase 2 o contexto é a issue, os comentários e as notas ligadas.                                                                                                                       |
| `--permission-prompt-tool` (listada no plano)                       | Usada como está, mais `--session-id`, `--strict-mcp-config`, `--permission-mode default` e `--disallowedTools`                                                                             | A flag existe na 2.1.301, mas não aparece no `claude --help` (só na documentação). `--session-id` deixa o bridge escolher o id da sessão antes de começar, o que simplifica o `--resume`.                                                                    |
| Pausar = interromper depois do turno atual                          | Pausar interrompe o turno na hora (`control_request` de interrupt) e o processo termina; Retomar usa `--resume`                                                                            | Esperar o turno acabar pode levar minutos. A retomada avisa o modelo que foi uma pausa, porque o Claude Code descreve a interrupção como recusa.                                                                                                             |
| Processo do agente vivo entre mensagens                             | O processo termina quando o turno acaba sem mensagens na fila; a próxima mensagem retoma a sessão com `--resume`                                                                           | Evita processos parados ocupando memória; mensagens enviadas durante o turno ainda vão direto pelo stdin.                                                                                                                                                    |
| Regras por repositório                                              | Regras globais por enquanto (a coluna `scope` já existe)                                                                                                                                   | A tela para escolher o escopo chega junto com as regras padrão afrouxáveis por repositório.                                                                                                                                                                  |
| Contrato servidor → cliente                                         | Mensagens extras `note.upsert`, `noteLink.upsert/remove`, `issue.upsert`, `settings.updated`, `state.snapshot`, `error`                                                                    | Para outros clientes abertos acompanharem notas e configurações, e para o desfazer restaurar tudo de uma vez.                                                                                                                                                |
| Tabelas da seção 4                                                  | Mais `setting` (configurações não secretas) e `activity` (feed); `note` ganhou `createdAt`/`updatedAt`; `agent` guarda instrução, erro, tokens e custo; `agent_event` guarda a linha bruta | Guardar a configuração validada, o feed e o modo "saída bruta". As tabelas de contexto, MRs, automações e discussões entram nas fases em que são usadas.                                                                                                     |
| TypeScript                                                          | Fixado em `~6.0`                                                                                                                                                                           | O TypeScript 7 (versão nativa) ainda não é suportado pelo `typescript-eslint`.                                                                                                                                                                               |

## Diferenças em relação ao protótipo

O visual (tokens, cartões, janelas de agente, painéis, menu, aviso, foco) foi portado do protótipo. O que difere, por enquanto:

- MRs, contexto escolhido à mão, orquestrador, sub-agentes e automações chegam nas Fases 3 a 6: o painel de Automações mostra as regras desligadas e o contador de MRs fica em zero.
- O painel do agente não tem barra de progresso em etapas (o protótipo tinha um roteiro fixo); mostra o que o agente está fazendo agora, tokens, custo e turnos. Equipe, contexto com medidor e linha do tempo chegam com as Fases 4 a 6.
- O painel da issue não tem as opções de contexto e autonomia (profundidade): tem só instruções extras. Um agente trabalha no projeto da issue; issues com vários repositórios ganham orquestrador na Fase 5.
- Uma issue real pertence a um projeto só; o cartão mostra esse projeto em vez da lista de repositórios afetados que o protótipo inventava.
- Os critérios de aceite vêm dos itens de checklist (`- [ ]`) da descrição. Sem checklist, a seção não aparece.
- A discussão da issue é a do GitLab (sem notas de sistema). Comentar pelo canvas chega na Fase 3.
- Soltar uma issue ou um repositório em cima de um agente que já começou não acrescenta contexto ainda (Fase 4); só funciona no agente em branco.
- O canvas usa o React Flow: pan, zoom e arrasto vêm dele, e o crédito "React Flow" fica visível no canto, como pede a licença para quem não assina o plano Pro.
- O texto da nota cresce com o conteúdo (até 320 px) em vez de rolar.

Prints: [`docs/screenshots/fase-1`](docs/screenshots/fase-1) e [`docs/screenshots/fase-2`](docs/screenshots/fase-2).

## Limitações conhecidas

- Se o bridge reiniciar (por exemplo, com o `tsx watch` em dev), o token de sessão muda e é preciso recarregar a página. O aviso "Sem conexão com o bridge" tem o botão para isso.
- A lista de issues traz até 300 issues abertas por projeto.
- Descrições, comentários e respostas dos agentes aparecem como texto, sem renderizar Markdown.
- Se o bridge cair no meio de um turno, os agentes que estavam trabalhando voltam como **Pausado**; **Retomar** continua a sessão. A recuperação automática é da Fase 7.
- Ainda não há limite de agentes simultâneos nem orçamento de tokens (supervisor da Fase 5).
- Worktrees de agentes removidos não são apagados (a limpeza com confirmação é da Fase 7). Para apagar à mão: `git worktree remove ~/.agent-canvas/worktrees/<id>` no clone.

# Agent Canvas

Canvas para orquestrar agentes do Claude Code a partir de issues e repositórios do GitLab. Roda na sua máquina: um servidor Node local (o **bridge**) e o front-end no navegador.

- Plano completo: [`docs/PLANO-IMPLEMENTACAO.md`](docs/PLANO-IMPLEMENTACAO.md)
- Protótipo de referência (visual e comportamento): [`docs/prototype/agent-canvas.html`](docs/prototype/agent-canvas.html). Abra direto no navegador.

## Estado atual

| Fase                | O que entrega                                                                        | Estado    |
| ------------------- | ------------------------------------------------------------------------------------ | --------- |
| 0 · Base            | Monorepo, bridge com token de sessão, tela de configuração do GitLab                 | pronta    |
| 1 · Canvas          | Issues reais no canvas, notas, vínculos, desfazer, persistência                      | pronta    |
| 2 · Um agente real  | Agente `claude` num worktree, saída ao vivo, conversa, permissões pela aba Ações     | pronta    |
| 3 · MRs e pipelines | Agente abre o MR, nó no canvas com pipeline ao vivo, diff, discussão, merge humano   | pronta    |
| 4 · Contexto        | Itens de contexto, medidor de tokens, resumo, sugestões, releitura ao vivo, passagem | pronta    |
| 5 em diante         | Orquestração, automações, robustez                                                   | ainda não |

## Requisitos

- Node 22 ou mais novo
- pnpm 10 (`corepack enable` instala a versão do `packageManager`)
- Claude Code instalado e logado (`claude --version`; testado com a 2.1.301). Os agentes usam a sua instalação e o seu login.
- `git` 2.5 ou mais novo (worktrees) e os repositórios clonados na pasta configurada.
- `glab` é opcional.
- Nada para compilar: o `better-sqlite3` traz binários prontos para Linux (glibc e musl), macOS e Windows, em x64 e arm64, e o `pnpm install` não roda o `node-gyp`.

## Instalação e uso

```bash
pnpm install
pnpm dev
```

`pnpm dev` sobe o bridge em `http://127.0.0.1:4317` e o front-end em `http://127.0.0.1:5173`. Abra o segundo.

Na primeira vez aparece a tela de configuração:

1. **URL da instância** do GitLab (ex.: `https://gitlab.com` ou a URL da sua empresa).
2. **Token de acesso pessoal** com escopo `api` (GitLab → Preferências → Access tokens). O bridge valida com `GET /user` antes de salvar e recusa token inválido.
3. **Pasta dos repositórios locais**: onde ficam seus clones. Não precisa seguir nenhum padrão de nomes: o bridge procura em até 4 níveis de subpastas e reconhece cada projeto pelo remoto do git (`git@…:grupo/projeto.git` ou `https://…/grupo/projeto.git`). Deixe vazio para procurar na sua pasta pessoal (3 níveis). Em vez de digitar, use **Escolher…**: um navegador de pastas que mostra quais já são clones git e, quando a máquina tem um (`zenity` ou `kdialog` no Linux, Finder no macOS), oferece também o seletor de pastas do sistema. O navegador não deixa uma página ler o caminho real de uma pasta, por isso quem lista as pastas é o bridge. Cada agente trabalha num worktree criado a partir do clone.
4. Escolha os **projetos** cujas issues abertas aparecem no canvas.

Sem token à mão, use **Usar dados de exemplo**: o canvas funciona com os mesmos dados fictícios do protótipo.

Para abrir a configuração de novo, clique em "GitLab conectado" no rodapé da barra lateral.

A aba **Repos** mostra onde está o clone de cada projeto. Para o que faltar:

- **Clonar**: `git clone` na pasta dos repositórios (ou em `~/projetos`), com a sua chave SSH ou o credential helper do git. O token do GitLab nunca é usado para clonar, porque ficaria gravado no `.git/config`.
- **Escolher pasta…**: aponta, pelo mesmo navegador de pastas, um clone que está em outro lugar. Se o remoto dele for de outro projeto, o bridge recusa.
- **Procurar de novo**: depois de clonar ou mover uma pasta pelo terminal. Ao iniciar um agente num projeto sem clone, o bridge também procura de novo sozinho.

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
| `AGENT_CANVAS_SUMMARY_MODEL`   | `haiku`           | Modelo do botão Resumir                                   |
| `AGENT_CANVAS_CONTEXT_BUDGET`  | `60000`           | Tokens recomendados no contexto de um agente              |
| `AGENT_CANVAS_CLAUDE_BIN`      | `claude`          | Caminho do executável do Claude Code                      |

## Usando o canvas (Fase 1)

- **Issues**: a aba Issues lista as issues abertas dos projetos escolhidos (até 300 por projeto, atualizadas a cada minuto; **↻** busca na hora). Com mais de um projeto, o seletor no topo da aba mostra só as de um projeto, com a contagem de cada um, e lembra a escolha. Arraste uma issue para o canvas ou use o **+** da linha. Se ela já estiver no canvas, o botão vira **mostrar**.
- **Markdown**: descrições de issues e MRs, comentários, notas no painel e respostas dos agentes aparecem formatados.
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
- **Onde ficam as mudanças**: cada agente trabalha em `~/.agent-canvas/worktrees/<id>`, num branch `agent/<iid>-<slug>` do seu clone. Os commits aparecem nesse branch (`git log agent/…` no clone). O agente não faz push por conta própria e nunca faz merge.

## Merge requests e pipelines (Fase 3)

- **O agente abre o MR**: ao terminar, com tudo commitado e os testes passando, o agente chama a ferramenta `open_merge_request` do canvas. O bridge envia o branch para o `origin` do seu clone (com as suas credenciais git), abre o MR para o branch padrão com `Closes #<iid>` e cria o nó do MR ao lado do agente, ligado a ele. Chamar de novo envia os commits novos para o mesmo MR. No painel do agente, **Abrir MR agora** pede isso a qualquer momento.
- **Pipeline ao vivo**: o bridge consulta os MRs abertos do canvas a cada 30 segundos e atualiza o cartão (rodando, passou, falhou) e o feed sozinho. **Atualizar status** no foco do MR consulta na hora.
- **Foco do MR**: etapas do pipeline, diff por arquivo, discussão do GitLab e um campo para comentar. O foco da issue também ganhou o campo de comentário e a lista dos MRs dela.
- **Aba Ações**: **Merge requests prontos** (pipeline verde) com **Aprovar e mergear** e **Ver diff**, e **Pipelines com falha** com **Pedir correção** ao agente que abriu o MR. O merge é sempre seu: os agentes não têm ferramenta de merge.
- **Comentários de agentes**: as ferramentas `comment_issue` e `comment_mr` comentam com o seu token, com o cabeçalho `🤖 **agente-N** · Agent Canvas`. O canvas usa esse cabeçalho para marcar o comentário como "agente" na discussão.
- **Modo demonstração**: o GitLab é simulado e o push é pulado; o pipeline simulado passa em 20 segundos.

![MR aberto pelo agente](docs/screenshots/fase-3/mr-no-canvas.png)

### Como um agente roda

O bridge cria o worktree, grava `.agent-canvas/context.md` (os itens de contexto, com o aviso de que o que vem do GitLab e do repositório é dado e não instrução) e inicia:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --session-id <uuid> | --resume <uuid> \
  --mcp-config ~/.agent-canvas/agents/<id>/mcp.json --strict-mcp-config \
  --permission-prompt-tool mcp__canvas__approve --permission-mode default \
  --append-system-prompt <apps/bridge/src/agents/roles/main.md> \
  --allowedTools mcp__canvas__open_merge_request,mcp__canvas__comment_issue,mcp__canvas__comment_mr,mcp__canvas__write_note,<regras salvas> \
  --disallowedTools "Bash(git push --force:*)" …
```

O servidor MCP do canvas roda dentro do bridge (`POST /mcp`, Streamable HTTP), identificado por um token por agente. Ele expõe `approve`, as ferramentas do GitLab (`open_merge_request`, `comment_issue`, `comment_mr`) e `write_note`, que agem só sobre o branch, a issue e o MR do próprio agente. A ferramenta `approve` responde no formato que o Claude Code exige: `{"behavior":"allow","updatedInput":…}` ou `{"behavior":"deny","message":…}`. Antes de qualquer regra, o bridge nega push forçado, `rm -r` fora do worktree, arquivos fora do worktree e comandos de rede (`curl`, `wget`, `ssh`…) sem regra explícita.

Para regravar as saídas reais usadas nos testes do parser (por exemplo, depois de atualizar o Claude Code): `pnpm --filter @agent-canvas/bridge exec tsx scripts/record-fixtures.ts`.

## Contexto dos agentes (Fase 4)

- **O que o agente recebe**: o `.agent-canvas/context.md` é montado com os itens da seção **Contexto** do painel do agente. Os vínculos do canvas entram sozinhos: a issue do agente, o repositório (um índice, não o código: árvore até 3 níveis, README, CLAUDE.md e package.json) e as notas ligadas ao agente ou à issue. Pelo **Adicionar** (paleta com busca, ↑↓, Enter e Esc) entram arquivos do repositório, outras issues e repositórios, o diff de um MR e o log do pipeline que falhou (trecho do erro e as últimas 200 linhas do job). **Nova nota**, na paleta, cria a nota já ligada ao agente. Soltar uma issue ou um repositório em cima de um agente que já começou também acrescenta contexto.
- **Medidor**: antes de rodar, mostra a estimativa (caracteres ÷ 3,5) contra o recomendado de 60 mil tokens (`AGENT_CANVAS_CONTEXT_BUDGET`), com a fatia de cada item. Depois do primeiro turno, mostra também o uso real que o `claude` informou.
- **Resumir**: itens com 8 mil tokens ou mais ganham **Resumir**. Um `claude -p` curto com um modelo pequeno (haiku, ou `AGENT_CANVAS_SUMMARY_MODEL`) e sem ferramentas resume preservando arquivos, erros e decisões; o resumo vai para o context.md no lugar do original. **Completo** desfaz. Se o conteúdo mudar, o resumo deixa de valer.
- **Sugestões**: arquivos citados na issue que existem no repositório, o log do pipeline do MR do agente quando falha, notas da issue tiradas deste agente e issues abertas com label em comum.
- **Ao vivo**: mudar o contexto ou editar uma nota ligada regrava o context.md e, com o agente rodando, manda "O contexto foi atualizado: … Releia .agent-canvas/context.md". A janela do agente mostra a linha `↻ contexto atualizado`. Com o agente parado, o aviso vai junto da próxima mensagem.
- **Nota de passagem**: com a automação ligada (painel **Automações**), o context.md pede ao agente que chame `write_note` antes da resposta final. A nota (Passagem · agente-N) fica ao lado dele, ligada à issue, e entra no contexto dos próximos agentes da issue (não no do autor).

![Nota editada e o agente relendo o contexto](docs/screenshots/fase-4/nota-editada-agente-rele.png)

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
- O seletor de pastas (`/api/fs/dirs`) lista só nomes de subpastas, nunca conteúdo de arquivos, e exige o token de sessão como o resto da API.
- O endpoint MCP aceita só o token do próprio agente, gerado a cada execução do bridge e guardado num arquivo `0600`.
- Os agentes nunca recebem o token do GitLab: abrir MR e comentar passam pelo bridge, e não existe ferramenta de merge. O merge só acontece por **Aprovar e mergear**.
- O bridge tira do ambiente dos agentes as variáveis de sessão do Claude Code (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`…), para um `pnpm dev` rodado dentro de um terminal do Claude Code não emprestar a sessão dele aos agentes.

## Desvios do plano

| Plano                                                               | Implementado                                                                                                                                                                               | Motivo                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estrutura com pasta raiz `agent-canvas/`                            | Monorepo direto na raiz do repositório                                                                                                                                                     | O repositório já é o projeto; uma pasta a mais não acrescenta nada.                                                                                                                                                                                          |
| Segredos no chaveiro do sistema (`keytar`) ou `.env`                | Arquivo `secrets.json` com permissão `0600` na pasta de dados, ou `AGENT_CANVAS_GITLAB_TOKEN` (inclusive via `.env`)                                                                       | O `keytar` está arquivado e sem manutenção, e depende de módulo nativo e de libsecret no Linux. O plano permite a alternativa local; o token continua fora do banco. Dá para trocar por chaveiro depois sem mexer no resto (`SecretStore`).                  |
| Rotas HTTP `/state`, `/repos`, `/gitlab/issues`, `/settings/gitlab` | Mesmas rotas com prefixo `/api`                                                                                                                                                            | Separa a API das páginas do front-end no proxy do Vite e quando o bridge serve o build.                                                                                                                                                                      |
| `node.move` como única mensagem de nó                               | Mensagens extras `issue.place`, `node.remove` e `node.restore`                                                                                                                             | O canvas precisa criar o nó da issue e fazer remoção suave com desfazer, que o contrato da seção 5 não cobria. Remover e restaurar um agente usa as mesmas `node.remove`/`node.restore` (remover para o processo), em vez de `agent.remove`/`agent.restore`. |
| `agent.status` e `agent.usage` separados                            | Um só `agent.upsert` com o agente inteiro (status, tokens, custo, branch, erro)                                                                                                            | Menos mensagens para manter em sincronia; o front-end sempre tem o agente completo.                                                                                                                                                                          |
| `--permission-prompt-tool` (listada no plano)                       | Usada como está, mais `--session-id`, `--strict-mcp-config`, `--permission-mode default` e `--disallowedTools`                                                                             | A flag existe na 2.1.301, mas não aparece no `claude --help` (só na documentação). `--session-id` deixa o bridge escolher o id da sessão antes de começar, o que simplifica o `--resume`.                                                                    |
| Pausar = interromper depois do turno atual                          | Pausar interrompe o turno na hora (`control_request` de interrupt) e o processo termina; Retomar usa `--resume`                                                                            | Esperar o turno acabar pode levar minutos. A retomada avisa o modelo que foi uma pausa, porque o Claude Code descreve a interrupção como recusa.                                                                                                             |
| Processo do agente vivo entre mensagens                             | O processo termina quando o turno acaba sem mensagens na fila; a próxima mensagem retoma a sessão com `--resume`                                                                           | Evita processos parados ocupando memória; mensagens enviadas durante o turno ainda vão direto pelo stdin.                                                                                                                                                    |
| Regras por repositório                                              | Regras globais por enquanto (a coluna `scope` já existe)                                                                                                                                   | A tela para escolher o escopo chega junto com as regras padrão afrouxáveis por repositório.                                                                                                                                                                  |
| Contrato servidor → cliente                                         | Mensagens extras `note.upsert`, `noteLink.upsert/remove`, `issue.upsert`, `settings.updated`, `state.snapshot`, `error`                                                                    | Para outros clientes abertos acompanharem notas e configurações, e para o desfazer restaurar tudo de uma vez.                                                                                                                                                |
| Tabelas da seção 4                                                  | Mais `setting` (configurações não secretas) e `activity` (feed); `note` ganhou `createdAt`/`updatedAt`; `agent` guarda instrução, erro, tokens e custo; `agent_event` guarda a linha bruta | Guardar a configuração validada, o feed e o modo "saída bruta". As tabelas de contexto, MRs, automações e discussões entram nas fases em que são usadas.                                                                                                     |
| `mr.updated` (servidor → cliente)                                   | `mr.upsert` com o MR inteiro, mais `thread.changed { target, ref }`                                                                                                                        | Mesmo padrão de `agent.upsert`. `thread.changed` avisa o foco aberto para recarregar a discussão depois de um comentário.                                                                                                                                    |
| Mensagens de MR do cliente                                          | `mr.merge`, `mr.refresh`, `mr.comment`, `issue.comment`                                                                                                                                    | O plano não detalhava o contrato da Fase 3.                                                                                                                                                                                                                  |
| Diff do MR pelo GitLab                                              | Diff da API do GitLab; se ela vier vazia (MR recém-criado ou modo demonstração), diff local `git diff <alvo>...HEAD` do worktree do agente                                                 | O GitLab calcula o diff de forma assíncrona; logo depois de abrir o MR a lista pode vir vazia.                                                                                                                                                               |
| Pipeline em etapas (Build, Testes, Lint)                            | O desenho das etapas é aproximado a partir do status geral do pipeline                                                                                                                     | Ler os jobs de cada pipeline é mais uma chamada por MR a cada 30 s; o status geral basta para o aceite. Dá para trocar pelos jobs reais depois.                                                                                                              |
| Comentário identificado como do agente                              | Cabeçalho `🤖 **agente-N** · Agent Canvas` no começo do comentário                                                                                                                         | O comentário sai com o token do usuário; o cabeçalho deixa claro no GitLab quem escreveu e permite marcar como "agente" na leitura.                                                                                                                          |
| "Criar agente para corrigir" o pipeline                             | **Pedir correção** manda a mensagem ao agente que abriu o MR                                                                                                                               | Agentes de correção com papel próprio chegam com a orquestração (Fase 5).                                                                                                                                                                                    |
| `agent.create { …, context[] }`, `context.add/remove/summarize`     | `context.add`, `context.remove`, `context.summarize` e `context.unsummarize` por agente; os itens dos vínculos do canvas entram sem mensagem                                               | O contexto da issue, do repositório e das notas ligadas já vem dos vínculos que o canvas tem; só o que é escolhido à mão precisa de mensagem. "Completo" desfaz o resumo, como o plano pede.                                                                 |
| `context_item` com `label` e `tokens` gravados                      | `context_item` guarda só o que não se deduz (item escolhido à mão, exclusão, resumo e o hash do conteúdo resumido); rótulo e tokens são calculados na hora                                 | O conteúdo muda (issue comentada, nota editada, arquivo alterado) e o número gravado ficaria velho.                                                                                                                                                          |
| Nota de passagem pedida ao concluir                                 | O context.md pede ao agente que chame `write_note` antes da resposta final, no mesmo turno                                                                                                 | Pedir depois do turno custaria outro turno inteiro, com o contexto todo de novo.                                                                                                                                                                             |
| Ferramenta `write_note` (Fase 5)                                    | Adiantada para a Fase 4                                                                                                                                                                    | É o caminho da nota de passagem.                                                                                                                                                                                                                             |
| Orçamento de tokens configurável                                    | Variável `AGENT_CANVAS_CONTEXT_BUDGET` (padrão 60 mil)                                                                                                                                     | A tela de configurações ganha o campo junto com os limites do supervisor (Fase 5).                                                                                                                                                                           |
| TypeScript                                                          | Fixado em `~6.0`                                                                                                                                                                           | O TypeScript 7 (versão nativa) ainda não é suportado pelo `typescript-eslint`.                                                                                                                                                                               |

## Diferenças em relação ao protótipo

O visual (tokens, cartões, janelas de agente, painéis, menu, aviso, foco) foi portado do protótipo. O que difere, por enquanto:

- Orquestrador, sub-agentes, revisão por agente e as automações além da nota de passagem chegam nas Fases 5 e 6: o painel de Automações mostra essas regras desligadas e o foco do MR não tem a seção "Revisão".
- O painel do agente não tem barra de progresso em etapas (o protótipo tinha um roteiro fixo); mostra o que o agente está fazendo agora, tokens, custo e turnos. Equipe e linha do tempo chegam com as Fases 5 e 6.
- O medidor de contexto ganhou uma fatia cinza para o cabeçalho do context.md (avisos, repositório, MR) e a linha com o uso real do último turno, que inclui o system prompt e a conversa.
- O painel da issue não tem as opções de contexto e autonomia (profundidade): tem só instruções extras. Um agente trabalha no projeto da issue; issues com vários repositórios ganham orquestrador na Fase 5.
- Uma issue real pertence a um projeto só; o cartão mostra esse projeto em vez da lista de repositórios afetados que o protótipo inventava.
- Os critérios de aceite vêm dos itens de checklist (`- [ ]`) da descrição. Sem checklist, a seção não aparece.
- A discussão da issue e do MR é a do GitLab (sem notas de sistema).
- O painel do agente mostra o MR nos detalhes em vez de um terceiro número no topo (tokens, custo e turnos ficam).
- O canvas usa o React Flow: pan, zoom e arrasto vêm dele, e o crédito "React Flow" fica visível no canto, como pede a licença para quem não assina o plano Pro.
- O texto da nota cresce com o conteúdo (até 320 px) em vez de rolar.

Prints: [`docs/screenshots/fase-1`](docs/screenshots/fase-1), [`docs/screenshots/fase-2`](docs/screenshots/fase-2), [`docs/screenshots/fase-3`](docs/screenshots/fase-3) e [`docs/screenshots/fase-4`](docs/screenshots/fase-4).

## Limitações conhecidas

- Se o bridge reiniciar (por exemplo, com o `tsx watch` em dev), o token de sessão muda e é preciso recarregar a página. O aviso "Sem conexão com o bridge" tem o botão para isso.
- A lista de issues traz até 300 issues abertas por projeto.
- O Markdown segue o GFM (títulos, listas, checklists, tabelas, código). HTML dentro do texto aparece escapado, e imagens viram links: o conteúdo vem do GitLab e não é confiável. Referências do GitLab como `#123`, `!45` e `@usuario` ficam como texto.
- Se o bridge cair no meio de um turno, os agentes que estavam trabalhando voltam como **Pausado**; **Retomar** continua a sessão. A recuperação automática é da Fase 7.
- Ainda não há limite de agentes simultâneos nem orçamento de tokens (supervisor da Fase 5).
- O polling de pipelines é de 30 segundos (webhooks não alcançam um app local).
- O merge usa as opções padrão do projeto no GitLab (sem squash forçado); o branch de origem é apagado no merge.
- A estimativa de tokens é aproximada (caracteres ÷ 3,5); o número real só existe depois do turno.
- Resumir usa a sua instalação do `claude` (e a sua cota) com um modelo pequeno.
- Worktrees de agentes removidos não são apagados (a limpeza com confirmação é da Fase 7). Para apagar à mão: `git worktree remove ~/.agent-canvas/worktrees/<id>` no clone.

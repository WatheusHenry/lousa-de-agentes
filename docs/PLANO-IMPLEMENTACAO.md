# Agent Canvas — plano de implementação

Este documento é o briefing para implementar o Agent Canvas: um canvas para orquestrar agentes do Claude Code a partir de issues e repositórios do GitLab. Ele acompanha o protótipo `agent-canvas.html`, que é a referência visual e de comportamento. Quando este plano e o protótipo divergirem em algo visual, vale o protótipo. Quando divergirem em arquitetura, vale este plano.

Abra o protótipo num navegador antes de começar. Ele roda sozinho, com dados de exemplo e agentes simulados.

## 1. O que o produto faz

- Mostra um canvas infinito com issues do GitLab, terminais de agentes, merge requests e notas, ligados por setas.
- A partir de uma issue (ou de um agente em branco), o usuário inicia agentes do Claude Code que trabalham em worktrees isolados dos repositórios.
- Uma issue que toca vários repositórios ganha um orquestrador, que cria um agente por repositório. Agentes podem criar sub-agentes até uma profundidade definida pelo usuário.
- O usuário controla o contexto de cada agente (repositórios, issues, notas, arquivos, logs), com medidor de tokens, resumo de itens pesados e sugestões.
- Pedidos de permissão, MRs prontos e pipelines com falha ficam numa caixa de Ações para aprovação.
- Automações reagem a eventos do GitLab (pipeline falhou, comentário de revisão, label) e colocam agentes para trabalhar.
- Agentes abrem MRs, deixam notas de passagem e comentam nas issues.

## 2. Decisões já tomadas

- Formato: app web local. Um servidor Node ("bridge") na máquina do usuário e o front-end no navegador, porque é preciso rodar `claude`, `git` e ler arquivos locais.
- Execução dos agentes: processo `claude` em modo headless com stream-json (`claude -p --output-format stream-json --input-format stream-json --verbose`). Usa a instalação e o login do Claude Code do próprio usuário e entrega eventos estruturados (texto, ferramentas, uso de tokens).
- Alternativa futura: `@anthropic-ai/claude-agent-sdk` atrás da mesma interface `AgentRunner`. Permite trocar o motor sem mexer no resto, mas exige API key.
- Isolamento: um `git worktree` por agente, num diretório gerenciado pelo app, para agentes em paralelo não pisarem um no outro.
- Ferramentas do canvas: um servidor MCP próprio ("canvas") exposto a cada agente. É assim que o agente cria sub-agentes, abre MR, pede ajuda e escreve notas, e o canvas fica sabendo.
- Permissões: `--permission-prompt-tool` apontando para uma ferramenta do MCP do canvas. A decisão de permitir ou negar passa pela caixa de Ações.
- GitLab: API REST v4 com token pessoal (escopo `api`), via `@gitbeaker/rest`. Cobre issues, MRs, pipelines, jobs e notas.
- Eventos do GitLab: polling (30 a 60 s) na primeira versão; webhooks depois, porque o app é local e não tem URL pública.
- Front-end: React + TypeScript + Vite, canvas com @xyflow/react (React Flow), que já traz pan, zoom, nós e arestas.
- Tempo real: WebSocket entre bridge e front-end, para o streaming da saída dos agentes.
- Persistência: SQLite (`better-sqlite3`) com Drizzle ORM. Simples, local, sem servidor.
- Segredos: token do GitLab no chaveiro do sistema (`keytar`) ou `.env` local, nunca no banco.
- Monorepo: pnpm workspaces, com tipos compartilhados entre front e bridge.

Confirme os nomes exatos das flags do CLI com `claude --help` e na documentação do Claude Code antes de escrever o runner. Se alguma flag citada aqui não existir na versão instalada, adapte e registre a mudança no README.

## 3. Estrutura do repositório

```
agent-canvas/
  apps/
    web/                    # React + Vite
      src/
        canvas/             # React Flow: nós, arestas, menu do botão direito, toolbar
        nodes/              # IssueNode, AgentNode, MrNode, NoteNode
        panels/             # Sidebar (Issues, Ações, Repos, Atividade), Inspector, Focus
        context/            # seletor de contexto, medidor, sugestões
        state/              # store (Zustand) espelhando o estado do bridge
        ws/                 # cliente WebSocket tipado
        styles/             # tokens do design (copiados do protótipo)
    bridge/                 # Node + TypeScript
      src/
        server.ts           # HTTP + WebSocket, só em 127.0.0.1
        db/                 # schema Drizzle, migrações
        gitlab/             # cliente, polling, cache
        git/                # worktrees, branches
        agents/
          runner.ts         # interface AgentRunner
          cli-runner.ts     # implementação com o processo `claude`
          stream-parser.ts  # parse do stream-json (zod, tolerante)
          supervisor.ts     # ciclo de vida, profundidade, orçamento
          roles/            # prompts de sistema: main, orchestrator, reviewer, fix
        mcp/
          canvas-server.ts  # ferramentas expostas aos agentes
        context/
          builder.ts        # monta o bundle de contexto
          tokens.ts         # contagem e estimativa
          summarize.ts      # resumo de itens pesados
          suggest.ts        # sugestões
        approvals/          # fila de permissões e regras
        automations/        # regras e gatilhos
  packages/
    shared/                 # tipos, schemas zod, contrato do WebSocket
```

## 4. Modelo de dados (SQLite)

- repo: id, gitlabProjectId, pathWithNamespace, localPath, defaultBranch, description
- issue_cache: projectId, iid, title, description, labels[], author, state, updatedAt
- node: id, type (issue | agent | mr | note), refId, x, y, createdAt, removedAt (remoção suave para o desfazer)
- edge: id, fromNodeId, toNodeId, kind (issue | spawn | mr | note)
- note: id, title, body, isHandoff, createdBy (user | id do agente)
- note_link: noteId, targetNodeId
- agent: id, name, role (main | orchestrator | sub | reviewer | fix), parentId, issueRef, repos[], branch, worktreePath, sessionId, status (idle | running | waiting | coordinating | paused | done | stopped | error), depth, maxDepth, openMr, title
- context_item: id, agentId, kind (repo | issue | note | file | doc | pipeline_log | mr_diff | plan), ref, label, tokens, summary (texto, quando resumido), contentHash
- agent_event: id, agentId, ts, type (text | tool_use | tool_result | permission | status | usage | user_message), payload (JSON), inputTokens, outputTokens
- approval: id, agentId, toolName, input (JSON), status (pending | allowed | denied), decidedBy (user | id da regra), createdAt
- policy: id, pattern (ex.: Bash(npm test:*)), scope (global | id do repo), createdAt
- merge_request_cache: projectId, iid, agentId, sourceBranch, pipelineStatus, merged, updatedAt
- automation: id, enabled, config (JSON)
- thread_comment (cache das discussões de issue e MR): targetType, targetRef, author, body, isAgent, createdAt

## 5. Contrato bridge ↔ front-end

Tudo tipado com zod em packages/shared. O front-end nunca chama o GitLab nem o `claude` direto.

HTTP (dados iniciais e ações simples): GET /state (snapshot completo), GET /gitlab/issues, GET /repos, POST /settings/gitlab.

WebSocket servidor → cliente:
- agent.event { agentId, event }: cada linha nova do terminal
- agent.status { agentId, status }
- agent.usage { agentId, inputTokens, outputTokens, costUsd? }
- node.upsert / node.remove / edge.upsert / edge.remove
- approval.created / approval.resolved
- mr.updated { pipelineStatus, merged }
- context.updated { agentId, items, totalTokens }
- activity { text, ts }

WebSocket cliente → servidor:
- agent.create { issueRef?, repos[], context[], instruction?, maxDepth, openMr }
- agent.message { agentId, text }
- agent.pause / agent.resume / agent.stop / agent.remove / agent.restore
- approval.decide { approvalId, decision: 'allow' | 'deny', remember?: boolean }
- context.add / context.remove / context.summarize { agentId, item }
- note.create / note.update / note.link / note.unlink
- node.move { nodeId, x, y }
- mr.merge / mr.comment / mr.requestReview
- automation.toggle { id, enabled }

## 6. Como um agente roda (núcleo do sistema)

1. Preparar o worktree: `git worktree add <dir>/<agentId> -b agent/<issue>-<slug> origin/<defaultBranch>`. Sub-agentes reaproveitam o worktree do pai.
2. Montar o contexto (seção 7) e gravar em `<worktree>/.agent-canvas/context.md`. Adicionar `.agent-canvas/` ao `.git/info/exclude` do worktree para não entrar em commits.
3. Gerar a config MCP do agente apontando para o servidor do canvas, com o agentId como identificação.
4. Iniciar o processo no diretório do worktree: `claude -p --input-format stream-json --output-format stream-json --verbose --mcp-config <arquivo> --permission-prompt-tool mcp__canvas__approve --append-system-prompt <prompt do papel> --allowedTools <regras salvas>`
5. Enviar a primeira mensagem pelo stdin: a instrução do usuário mais "leia .agent-canvas/context.md antes de começar".
6. Ler o stdout linha a linha (stream-parser.ts):
   - o evento system/init traz o session_id, que fica gravado no agente;
   - mensagens assistant trazem blocos de texto e tool_use;
   - mensagens user trazem tool_result;
   - o evento result traz uso de tokens e custo.
   Cada evento vira um agent_event e um agent.event no WebSocket.
7. Mensagens do usuário durante a execução são escritas no stdin no formato stream-json.
8. Pausar = interromper o processo depois do turno atual e marcar paused. Retomar = novo processo com `--resume <sessionId>` e a mensagem "continue de onde parou".
9. Fim: status done quando chega o result sem erro, ou error com a mensagem quando falha. Se a automação "nota de passagem" estiver ligada e o agente for raiz ou orquestrador, pedir a nota (seção 9).

Escreva o parser com schemas zod tolerantes (passthrough) e testes com saídas reais gravadas em __fixtures__. Rode o `claude` uma vez e salve a saída antes de modelar os tipos.

## 7. Sistema de contexto (prioridade alta)

Resolvedores (context/builder.ts), um por tipo de item:
- issue: título, descrição, critérios e comentários (API do GitLab)
- repo: índice, não o código inteiro: árvore de diretórios até 3 níveis, README, CLAUDE.md e package.json. O agente lê o resto sozinho
- file: conteúdo do arquivo no worktree
- note: título e corpo
- pipeline_log: trace do job que falhou (GET /projects/:id/jobs/:job_id/trace), cortado no trecho do erro e nas últimas 200 linhas
- mr_diff: GET /projects/:id/merge_requests/:iid/diffs
- plan: o plano do agente pai

Tokens (context/tokens.ts): estimar com ceil(caracteres / 3.5) para o medidor ao vivo. Depois do primeiro turno, usar o uso real que vem no evento result. Orçamento recomendado configurável, padrão de 60 mil tokens, com alerta acima disso, como no protótipo.

Resumo (context/summarize.ts): para itens acima de 8 mil tokens, rodar um `claude -p` curto com um modelo pequeno e o prompt "resuma para um agente de código, preserve nomes de arquivos, erros e decisões". Guardar em context_item.summary e usar o resumo no bundle. O usuário pode desfazer.

Sugestões (context/suggest.ts), sem IA na primeira versão:
- arquivos citados na descrição da issue (regex de caminhos) que existem no repositório;
- notas ligadas à issue;
- CLAUDE.md, se ainda não estiver no contexto;
- issues abertas com label em comum ou que tocam o mesmo repositório;
- para orquestrador, docs/arquitetura.md ou equivalente, se existir.

Atualização ao vivo: quando o usuário adiciona contexto, ou edita uma nota ligada, a um agente que está rodando, regravar context.md e mandar a mensagem "o contexto foi atualizado: <item>. Releia .agent-canvas/context.md".

## 8. Servidor MCP do canvas (orquestração)

Ferramentas expostas a todo agente. O bridge identifica quem chamou pelo agentId da config.
- approve: usada pelo --permission-prompt-tool. Cria um approval e espera a decisão do usuário ou de uma regra. Se uma policy casar, responde na hora. Siga o formato de resposta que a documentação do Claude Code exige para essa ferramenta (permitir com o input, ou negar com mensagem).
- spawn_agent: cria um sub-agente com {repo, task, context[]}. Recusa se depth >= maxDepth. Herda notas e plano do pai.
- wait_for_agents: bloqueia até os filhos terminarem e devolve um resumo de cada um. O status do chamador fica coordinating.
- report_plan: publica o plano em checklist, que aparece no terminal e no painel.
- open_merge_request: faz push do branch e cria o MR via API, com "Closes #<iid>" na descrição. Liga o MR ao agente e à issue no canvas.
- write_note: cria uma nota (usada na nota de passagem) e liga a nota à issue do agente.
- comment_issue / comment_mr: comenta como agente e marca isAgent.
- ask_human: faz uma pergunta, espera a resposta e entra na caixa de Ações.

Prompts por papel em agents/roles/:
- orchestrator.md:
  1. analisar a issue e mapear os repositórios;
  2. chamar report_plan;
  3. criar um agente por repositório com spawn_agent, contratos compartilhados primeiro;
  4. esperar com wait_for_agents e conferir a consistência entre os MRs;
  5. comentar o resumo e a ordem de merge na issue;
  6. escrever a nota de passagem.
- main.md: entender, implementar, rodar testes, abrir o MR com open_merge_request e, se o trabalho de testes for grande e houver profundidade, delegar com spawn_agent.
- reviewer.md: ler o diff, comentar riscos com comment_mr, sem alterar código.
- fix.md: ler o log do pipeline, corrigir no mesmo branch e fazer push.

O supervisor aplica limites globais: máximo de agentes simultâneos (padrão 4, o resto fica na fila), orçamento de tokens por árvore e tempo máximo por agente.

## 9. Ações, regras e automações

Caixa de Ações (aba na barra lateral, com contador):
- permissões pendentes, com Permitir, Negar, Sempre permitir e Permitir todos;
- MRs com pipeline verde, com Aprovar e mergear e Ver diff;
- pipelines com falha sem agente corrigindo;
- agentes parados esperando instrução.

"Sempre permitir" grava uma policy no formato de regra do Claude Code (ex.: Bash(npm test:*)) e libera na hora os pedidos iguais.

Polling do GitLab (gitlab/poller.ts), a cada 30 s para MRs de agentes e a cada 60 s para issues:
- mudança de status do pipeline → mr.updated;
- comentário novo de humano em MR de agente;
- label agent-ready nova numa issue.

Automações (cada uma liga e desliga no painel):
- pipeline falhou → criar agente fix com o log do job no contexto;
- comentário de revisão → mandar o comentário para a sessão do agente autor (--resume);
- MR aberto por agente → criar agente reviewer;
- agente concluiu → nota de passagem com decisões, arquivos tocados, MRs e pendências;
- label agent-ready → trazer a issue para o canvas e iniciar agentes.

## 10. Front-end

Porte o protótipo para React mantendo o visual:
- Tokens de design: copie o :root do protótipo (cores, raios, sombras, curvas --ease-out, --ease-in-out, --ease-drawer) para styles/tokens.css. Mantenha Geist e Geist Mono com espaçamento de −0.04em e o corner-shape: squircle progressivo.
- Canvas com React Flow:
  - um tipo de nó por item (Issue, Agent, Mr, Note);
  - arestas customizadas: tracejada para spawn, pontilhada amarela para nota, animada em azul enquanto o agente trabalha;
  - pan com arrastar, zoom com Ctrl + scroll;
  - "Ajustar" considerando os painéis abertos.
- Barra lateral flutuante: abas Issues, Ações, Repos e Atividade, busca, filtros, e arrastar issue ou repositório para o canvas ou para cima de um agente.
- Painel da direita: detalhes do item selecionado. O painel do agente tem aviso de aprovação, progresso, números, equipe, contexto (medidor, chips com tokens, Resumir, sugeridos), linha do tempo e detalhes.
- Modo foco: qualquer item abre grande, com o fundo do canvas borrado. Agente vira conversa, issue vira documento com discussão, MR mostra pipeline e diff, nota vira editor.
- Seletor de contexto: estilo paleta de comandos, com busca, marcação múltipla, teclado e criação de nota.
- Menu do botão direito no fundo e nos itens, toolbar no topo em grupos, aviso com desfazer e remoção suave.
- Movimento: siga as regras do protótipo (skill de animação do Emil Kowalski): só transform e opacity, nada de animação em atalhos de teclado, prefers-reduced-motion respeitado.

Para manter o terminal leve, renderize os eventos estruturados (texto, ferramenta, resultado, diff, pedido de permissão) como no protótipo, não como um terminal ANSI. Deixe um modo "saída bruta" para depuração.

## 11. Fases

Cada fase termina com o app rodando e os critérios de aceite verificados. Não comece a próxima sem fechar a anterior.

Fase 0: base
- Monorepo pnpm, TypeScript estrito, ESLint, Prettier, Vitest, packages/shared com os tipos.
- Bridge sobe em 127.0.0.1 com um token aleatório por sessão, exigido no WebSocket.
- Tela de configuração: token do GitLab, URL da instância e pasta dos repositórios locais. Validar o token com GET /user.
- Aceite: pnpm dev sobe bridge e web; o token é validado e guardado fora do banco.

Fase 1: canvas com dados reais do GitLab, sem agentes
- Porte do visual do protótipo (seção 10) com React Flow e store.
- Listar projetos escolhidos e issues abertas, arrastar issue para o canvas, posições persistidas no SQLite.
- Notas: criar, editar, ligar por arrasto, remover com desfazer.
- Aceite: recarregar a página mantém o canvas; issues são reais; visual igual ao protótipo nas telas principais.

Fase 2: um agente real
- AgentRunner com o claude em stream-json, worktree por agente, parser com fixtures reais.
- Nó de agente mostra a saída ao vivo; conversa pelo campo da janela e pelo modo foco; Pausar, Retomar, Parar.
- Agente em branco ("+ Novo agente") recebe contexto e começa na primeira instrução.
- Permissões pela ferramenta approve, caixa de Ações e regras "Sempre permitir".
- Aceite: um agente resolve uma issue simples num repositório de teste, pede permissão para rodar os testes, o usuário aprova pela aba Ações e os commits aparecem no branch do worktree.

Fase 3: MRs e pipelines
- Ferramenta open_merge_request, nó de MR com status do pipeline por polling e visão de foco com diff e discussão.
- Aprovar e mergear pela caixa de Ações; comentar no MR e na issue.
- Aceite: o MR aberto pelo agente aparece no canvas e no GitLab, ligado à issue, e o status do pipeline atualiza sozinho.

Fase 4: qualidade do contexto
- Resolvedores, context.md, medidor de tokens, resumo, sugestões, seletor de contexto e atualização ao vivo.
- Nota de passagem ao concluir.
- Aceite: o medidor mostra a estimativa antes de rodar e o uso real depois; resumir o log reduz os tokens; editar uma nota ligada faz o agente reler.

Fase 5: orquestração
- Servidor MCP completo (spawn_agent, wait_for_agents, report_plan, write_note, ask_human), papéis, profundidade, árvore de agentes e limites do supervisor.
- Issue com vários repositórios cria orquestrador; plano em checklist; resumo e ordem de merge na issue.
- Aceite: uma issue que toca dois repositórios gera um orquestrador, dois agentes e dois MRs, e o orquestrador comenta o resumo na issue.

Fase 6: automações e visibilidade
- Poller, regras com interruptor, agentes fix e reviewer, comentários de revisão enviados ao autor e label agent-ready.
- Linha do tempo por agente, tokens e custo por agente e por árvore, avisos de "aguardando você".
- Aceite: forçar um teste quebrado num MR de agente cria um agente de correção que deixa o pipeline verde sem intervenção, a não ser a permissão.

Fase 7: robustez
- Retomar o estado depois de reiniciar o bridge: reconectar sessões com --resume e marcar como error o que não puder voltar.
- Limpeza de worktrees de agentes removidos, com confirmação.
- Testes de integração do parser, das regras de permissão e do supervisor; teste ponta a ponta com um repositório GitLab de sandbox.
- Aceite: matar o bridge no meio de uma execução e subir de novo não perde canvas, notas, aprovações nem histórico.

## 12. Segurança

- Bridge escuta só em 127.0.0.1 e exige token no WebSocket.
- O token do GitLab não vai para o banco, para logs nem para o contexto dos agentes. Os agentes usam a API via ferramentas do canvas, não com o token direto.
- Regras padrão negam git push --force, rm -rf fora do worktree e comandos de rede não listados. O usuário pode afrouxar por repositório.
- Agentes nunca mergeiam. Merge é sempre ação humana na caixa de Ações.
- Conteúdo vindo do GitLab (issues, comentários, logs) entra no contexto como dado, com o aviso no context.md de que não são instruções do usuário. Isso reduz o risco de injeção de prompt por issue ou comentário maliciosos.

## 13. Fora do escopo da primeira versão

- Webhooks do GitLab (fica o polling).
- Vários usuários no mesmo canvas.
- Modo escuro (o design é só claro, por decisão).
- Rodar agentes em nuvem.
- Sugestões de contexto com embeddings.

## 14. Como entregar

- Um PR por fase, com descrição do que foi feito, como testar e prints comparando com o protótipo.
- README com a instalação (pnpm i, claude instalado e logado, glab opcional), configuração e limitações conhecidas.
- Registrar no README qualquer desvio deste plano e o motivo.

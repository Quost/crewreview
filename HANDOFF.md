# HANDOFF: tornar o Crewreview confiável a ponto de "subir o que ele revisou"

Escrito em 2026-11-23, a partir de uma auditoria feita por fora (outro agente, sem tocar neste repo).
Leia `AGENTS.md` e `CONTRIBUTING.md` antes de codar: as regras valem aqui (decisão em `packages/core` como
função pura com teste, `fence()` para texto não confiável, strings de UI em `@crewreview/i18n` nos 5 locales,
sem copiar prompt de outro projeto, `bun run check` antes de dizer "pronto", commits convencionais com `-s`).

## 1. Objetivo

Hoje o Crewreview é um bom segundo par de olhos barato. O dono (Matheus) quer que ele seja uma **review de
verdade**, a ponto de a equipe confiar em subir um PR que ele revisou. Isso tem dois lados:

1. **Qualidade**: pegar o bug de comportamento que hoje escapa, sem encher o PR de nit.
2. **Honestidade operacional**: saber, e dizer, quando NÃO tem confiança (cobertura parcial, arquivo não lido,
   CI vermelho), e só dar o selo "confiável" quando tudo isso estiver limpo.

E tudo isso **configurável** por repo (`repos.toml`) e por perfil, porque o custo (tokens, tempo) sobe junto
com a confiança.

## 2. Evidência: a auditoria (10 de 23 reviews postados)

Método: para cada PR/MR, um revisor independente fez a própria review nos padrões da tupi-ai (severidades
⛔ crítico / ⚠ warning / 💅 nit; só COMMENT, nunca REQUEST_CHANGES; foco em bug, segurança, performance, teste,
docs) e só depois comparou com o que o Crewreview postou. Nota média **6,7/10**. 82 achados: 2 falsos
positivos claros (~2%), ~5 com defeito (mecanismo errado, conclusão invertida, premissa fraca). Ou seja, **o que
ele diz quase sempre é verdade; o problema é o que ele não diz**.

Itens auditados (GitHub `tupinamba-energia/tupi_system_health` e GitLab `gitlab.weg.net`):
#622, #623, #625, #627, #632, tupi_wsh !33 e !35, wemob-backend !1947, wemob-360-corporate !49 e !53.
Relatórios completos, com evidência por arquivo:linha, em `/tmp/audit/report_A.md` … `report_E.md`
(podem ter sumido; peça ao Matheus, ou refaça a auditoria com o banco em
`~/Library/Application Support/Crewreview/state/crewreview.db`, tabela `reviews`, `status='posted'`).

### O que ele acerta (preservar)
- Teste faltando, duplicação, contrato quebrado, segurança em arquivo que leu (no !1947 achou `isActive`
  invertido, SSRF, `RestTemplate` sem timeout).
- Só COMMENT, pt-BR claro, sem puffery. Humanos aplicaram quase tudo (#622: todos menos 2; #625: 11 de 12).
- Avisa cobertura incompleta e o verificador interno descarta achados (isso funciona, manter).

### O que falha (alvo deste trabalho)

**F-A. Bug de comportamento que exige seguir chamadores e estado entre arquivos. É o maior buraco.**
- #622: `Iems.Devices.update_fields` chamado direto de `handle_event` na LiveView, com `sleep` de até 3×2,5 s
  na releitura (trava 7,5 s). O novo desfecho `:unconfirmed` não é tratado fora das propostas
  (`station_live.ex:2054`, `wegnology_import_worker.ex:156`, `device_provisioning.ex:909`). Se o 2º POST do
  `rewrite` leva `rate_limited`, o device fica sem as tags.
- #623: `reverted` é terminal e pode ser falso (outra proposta ou edição manual dentro de 7 dias marca a
  proposta antiga como revertida) e chega ao agente MCP como fato. É o centro do PR.
- !33: `model_type/1` devolve `"AC"` para qualquer nome não vazio, então SCS/EASY/HPC com nome fora do padrão
  ganham grupo WEMOB-AC e PSK padrão, em silêncio. O comentário "melhor abortar do que associar ao grupo
  errado" é falso na prática.
- Padrão comum: **o contrato de retorno de uma função mudou** (novo `{:error, _}`/estado) e ninguém foi
  conferir todos os chamadores.

**F-B. Afirma sobre arquivo que declarou "não revisado".** #622 F1 (falso positivo: o `apply_worker.ex:210`
já faz `Map.put(entry, "id", ...)`, o próprio post admitia não ter lido o worker), !33 (F3/F5/F7/F11 sobre
testes que disse não ter lido), !49 (resumo diz "não revisado" para arquivos que ele mesmo comentou).

**F-C. Cobertura parcial normalizada.** `docs/STATUS.md` ficou de fora ("grande demais") nas 3 rodadas do #625.
No #622 e #623 vários arquivos "não revisado" (no #623: `resolver.ex`, `telemetry.ex`, `station.ex`,
`overview.ex`, a migration). No #625 o head final (`45c5c36`) nunca foi revisado. No #625 R1 a lente
correctness não terminou. O post avisa, mas segue emitindo review com a mesma cara.

**F-D. Regra de docs do AGENTS.md do repo alvo ignorada.** Env nova sem `DEPLOY.md`/`.env.example` (!33),
doc defasado (!53: `docs/integracao-rdstation.md:81,113` diz "idempotente" mas o pré-check agora aborta),
linha "Docs:" do PR. Nenhuma lente cobra isso.

**F-E. Ruído de nit.** #625: 10 de 13 achados menores, 7 de teste. Volume de ⚪ supera o valor.

**F-F. Conclusão torta em achado verdadeiro.** #632 F6 inverteu o efeito (segurar 6 h uma estação que já tem
comando agendado é o comportamento certo; o dano real era a request virar `error` em vez de
`awaiting_upload`). #632 resumo "graves demais para aprovar" para um achado de teste. !33 F1 apontou o
mecanismo errado.

**F-G. Severidade só desce.** `applyVerifier` nunca sobe severidade (`packages/core/src/schema.ts` ~l.83:
"it can never raise a severity"). Vários achados que o auditor classificou como ⚠ saíram 🟡. Nenhum achado
passou de "minor" nas 5 PRs do GitHub.

**F-H. Vocabulário fora do padrão tupi-ai.** Posta 🟡 menor / ⚪ detalhe; o padrão da casa é ⛔ / ⚠ / 💅 / ⭐
(skill `code-review-guidelines`, `tupi-ai/plugins/engineering/skills/code-review-guidelines/SKILL.md`).
Nunca emite elogio.

**F-I. Rodadas incrementais perdem o todo.** "Focou no que mudou desde X": o head final pode ficar sem
revisão integral, e o selo de confiança não diz isso.

## 3. Onde mexer (mapa do código, lido nesta sessão)

- `packages/engine/src/review.ts`: pipeline `contexto → lentes em paralelo → evidência → dedupe → verificador →
  veredito` (~346 linhas). `PROMPT_VERSION = "4"` está em `prompts.ts`: suba ao mudar prompt.
- `packages/engine/src/prompts.ts`: `lensPrompt` / `verifierPrompt`. A regra 1 já exige arquivo+linha aberto em
  `./head/`; a regra 4 ("problemas que ESTA mudança introduz") é onde bugs sobre chamadores morrem, porque
  o chamador não mudou e fica fora do diff.
- `packages/engine/src/lenses.ts` + `packages/engine/lenses/{correctness,security,architecture,tests,ui}.md`:
  lentes; o repo alvo pode sobrescrever em `.crewreview/lenses/<id>.md` (lidas da base branch, de propósito).
- `packages/engine/src/context.ts` + `packages/core/src/diff.ts`: o que o agente recebe e o que é cortado
  ("minified" / "too large"). Prompt diz "skip it, don't list it in uncovered", o que esconde a lacuna.
- `packages/core/src/verdict.ts`: `decideVerdict` + `VerdictPolicy` (função pura, é o lugar certo para o novo
  selo de confiança). Razões atuais: `partial-review`, `lens-failed`, `ci-not-green`, `diff-too-large`,
  `verifier-missing`, `approve-disabled`, `clean`.
- `packages/core/src/schema.ts`: severidades `blocker|major|minor|nit`, `applyVerifier`.
- Config do usuário: `~/.config/crewreview/config.toml` e `repos.toml` (`[repo.review]`: `mode`, `authors`,
  `allowApprove`, `skipLabels`…; `[limits] maxDiffLines`). Estado em
  `~/Library/Application Support/Crewreview/state/`.
- `docs/plans/crew-mode.md`: roteamento de "seats" por papel (lente/verificador em harnesses diferentes).

## 4. O que construir (ordem sugerida, cada item entregável e testável sozinho)

### Passo 0. Rede de segurança antes de mexer em prompt: um conjunto de calibração
Sem isso você muda prompt às cegas. Crie `packages/engine/eval/` (ou `tests/golden/`) com PRs reais **fixados
por sha**, cada um com o gabarito do que DEVE ser achado e do que NÃO deve (falsos positivos conhecidos):
- #622 @`27d3bcf`: DEVE achar (a) `update_fields` bloqueando LiveView; (b) `:unconfirmed` não tratado em
  `station_live.ex`/import worker/provisioning. NÃO deve postar "DOM id vazio" (falso positivo).
- #623 @`9d9cfe6`: DEVE achar `reverted` falso/terminal. 
- !33 @`9683f495`: DEVE achar fallback `"AC"` silencioso; texto de UI `new.ex:218` ("PSK gerada automaticamente")
  desatualizado; envs novas sem `DEPLOY.md`/`.env.example`. NÃO deve atribuir ao ADR a tese do grupo.
- !1947 @`471877a`: DEVE achar `isActive` invertido e SSRF. NÃO deve postar `LazyInitializationException`
  (associações são EAGER). Config de dev (`application.yaml` filas `-dev`, `ws://192.168.31.110`) e swagger
  divergente do controller são ⚠ perdidos.
- !53 @`7838d8c`: DEVE achar `catch` genérico, `process.exit(0)` e doc `integracao-rdstation.md` defasado.
- #632 @`b80983c6`: F6 não pode concluir "efeito oposto".
Métrica: **recall** dos "DEVE", **0 dos "NÃO DEVE"**, e contagem de nit por review. Rode a eval a cada mudança
de prompt (`PROMPT_VERSION`). Pode ser opt-in (`bun run eval`) por custo; o gate de CI roda só a parte pura.
Gabaritos completos saem dos relatórios `/tmp/audit/report_*.md`.

### Passo 1. Lente nova "callers/contract" (ataca F-A)
Nova lente builtin `contracts` (`lenses/contracts.md` + entrada em `BUILTIN`): para cada função pública cujo
tipo de retorno, erro, estado ou efeito colateral mudou, **o agente deve enumerar os chamadores** (grep no
`./head/`) e dizer se cada um trata o novo caso. Requisitos:
- Preparação determinística no orquestrador (não pedir ao modelo para "lembrar"): extrair do diff os símbolos
  alterados e gerar `./ctx/callers.md` com os chamadores (grep/ripgrep por nome), para o agente só julgar.
  Heurística por linguagem pode ser simples (nome da função definida/alterada no diff).
- Regra de prompt: "o chamador não mudou, mas o contrato sim" é achado válido (relaxa a regra 4 só aqui).
- Também cobrir: estado terminal/irreversível derivado de heurística (#623 `reverted`), fallback silencioso
  (`true -> "AC"`), bloqueio de processo interativo (`sleep`/IO síncrono em handler de LiveView/request).

### Passo 2. Lente "docs-and-config" (ataca F-D)
Lente que lê `./ctx/guidelines.md` (AGENTS.md/CLAUDE.md do repo alvo) e confere **regras mecânicas
checáveis**: env nova → doc de deploy e `.env.example`; moduledoc/doc/texto de UI que cita comportamento
removido (grep do nome antigo); descrição do PR vazia; checklist do MR desmarcado. Sempre emitir, ao fim,
"regras de docs do repo verificadas: X; não verificadas: Y". Em diff gigante de doc (`STATUS.md`), ler por
trechos em vez de pular (ver passo 4).

### Passo 3. Verificador bidirecional + calibração de severidade (F-F, F-G)
- O verificador hoje só derruba/rebaixa. Permitir `upgrade` com regra dura: só sobe se a evidência
  (arquivo:linha) mostrar impacto de produção (dado perdido, trava, falha silenciosa), e registrar o motivo em
  `finding.verification`. Mudar `applyVerifier` em `packages/core/src/schema.ts` e a função de severidade com
  teste.
- Verificador deve **refazer a conclusão causal** de cada achado (não só "o trecho existe"): #632 F6 e !33 F1
  tinham o trecho certo e a causa/efeito errados. Pedir `claim` / `mechanism` / `observed_effect` separados no
  schema e conferir cada um.
- **Proibir achado sobre arquivo fora de `reviewedFiles`**: se o achado cita um arquivo cujo diff/conteúdo foi
  cortado ou que o próprio agente listou em `uncovered`, o orquestrador (código, não modelo) descarta ou marca
  `confidence: low` e o move para a seção "não confirmado". Isso mata F-B por construção.

### Passo 4. Cobertura honesta e completa (F-C, F-I)
- Parar de esconder lacuna: remover do prompt a instrução "don't list it in uncovered" para arquivo cortado;
  o orquestrador deve **contabilizar** `skipped`/`uncovered` por motivo.
- Antes de dar "too large" em arquivo de **doc/config** (`STATUS.md`, `DEPLOY.md`, `application.yaml`), fatiar:
  ler só os hunks do diff com contexto. Cortar só gerado/minificado de verdade (lockfile, bundle).
- Rodada incremental: manter o modo "desde X" para acelerar, mas **antes do selo final** exigir uma passada
  cobrindo o head inteiro (ou provar que `delta` + review anterior cobrem 100% dos arquivos). O #625 acabou
  sem review do head final.
- Retry de lente que não terminou (`correctness` no #625 R1): re-executar a lente falha (já há seats/retry por
  cota; estender para timeout/incompleta) antes de postar.

### Passo 5. Selo de confiança e perfis configuráveis (o pedido central)
Em `packages/core` (função pura, com testes de tabela), derive um **trust level** do resultado, e mostre-o no
topo do post em vez do texto solto de "Por quê":

| Nível | Quando |
|-|-|
| `confiável` | todas as lentes aplicáveis rodaram, 100% dos arquivos de código e de doc/config lidos, verificador rodou, head final revisado, sem ⛔/⚠ abertos, CI verde |
| `parcial` | alguma lente falhou/incompleta, arquivo não lido, head final sem revisão integral, verificador ausente |
| `não confiar` | ⛔ aberto, ou CI vermelho com falha relacionada, ou diff acima do limite |

Perfis em `config.toml` (global) e sobrescritos em `repos.toml` `[repo.review]`; sugestão de superfície:

```toml
[repo.review]
profile = "standard"          # "fast" | "standard" | "thorough" | "gate"

[repo.review.trust]            # só para "gate"/quando quiser selo
requireFullCoverage = true     # nenhum arquivo de código/doc fora da review
requireHeadFullyReviewed = true
requireVerifier = true
verifierCanRaise = true
requireLenses = ["correctness", "security", "contracts", "docs"]
```

- `fast`: como hoje (barato).
- `standard`: + lente `contracts` e `docs`, verificador bidirecional, sem nit acima do teto.
- `thorough`: + 2ª passada independente (outro `seat`/harness, ver `crew-mode.md`) só nos achados
  ⚠/⛔ e em arquivos de maior risco; achado só sobe com concordância das duas.
- `gate`: tudo de `thorough` + exige `trust = confiável` para emitir "aprovável". Respeita
  `allowApprove` (hoje default `false`; manter).

Knobs úteis e baratos (todos em `repos.toml`, defaults conservadores):
`severityStyle = "tupi" | "crewreview"` (⛔⚠💅⭐ vs 🟡⚪; F-H), `maxNitsPerReview` (F-E, default 5, o excedente
vira uma linha "+N detalhes menores"), `minConfidenceToPost`, `postPraise` (⭐, máx 2), `guidelinesRule`
(caminho dos AGENTS.md a tratar como regra mecânica), `alwaysReviewFullHead`, `docsMaxLines` (limite de
"grande demais" separado para doc/config).

Atenção: o veredito continua só COMMENT por padrão (regra da tupi-ai: nunca REQUEST_CHANGES). Se o modo
`request_changes` existir no core, deixe desligado por padrão no preset `tupi`.

### Passo 6. Formato do post (F-H, F-F)
- Cabeçalho: `Confiança: confiável | parcial | não confiar` + 1 linha de motivo em linguagem simples, e a lista
  de **o que ficou sem ser lido** (com motivo). Sem exagero ("graves demais para aprovar" só com ⛔).
- Achado: `Problema → Mecanismo → Efeito observado → O que fazer` + `arquivo:linha` + evidência literal.
- Seção final "Não confirmado" (confiança baixa, nunca no corpo principal como fato).
- Strings novas em `@crewreview/i18n` nos 5 locales; `bun run check` valida.

### Passo 7. Telemetria de qualidade (fecha o ciclo)
Hoje o único sinal de acerto é o humano ter aplicado ou não. Registrar no `crewreview.db`, por achado, o
desfecho (resolvido pelo autor com commit, "Não procede", ignorado) e expor em `crewreview stats` /
dashboard: **taxa de aceite por lente e por severidade**. Use isso para revisar prompt/lente com dados, e como
critério para promover o perfil `gate` num repo.

## 5. O que funcionou / o que não funcionou (para não repetir)

- Funcionou: auditar com revisor independente que revisa **antes** de ler o post do Crewreview; sem isso o
  revisor ancora nos achados. Funcionou também comparar contra o código no **sha revisado** (`ref=` no marcador
  `crewreview:kind=...;ref=<sha>`), não no head final.
- Não funcionou / cuidado: confiar no texto do próprio post como "evidência"; avaliar achado contra o head
  em vez do sha revisado; grupo E da auditoria leu as discussões do !53 antes de fechar a análise (independência
  parcial). Não rodamos `mix test`/`mix quality.full` nos PRs auditados.
- Os posts saem sob o login do Matheus (`Quost`). Para separar o que é do Crewreview use a marca HTML
  `crewreview:kind=` no corpo (GitHub: `gh api repos/<o>/<r>/pulls/<n>/reviews` e `/comments`; GitLab:
  `glab api --hostname gitlab.weg.net projects/<id>/merge_requests/<iid>/discussions`).

## 6. Critério de aceite (como saberemos que ficou confiável)

1. A eval (Passo 0) roda e dá recall ≥ 80% nos "DEVE" e **0** nos "NÃO DEVE", com `PROMPT_VERSION` novo.
2. Reauditoria dos mesmos 10 itens: nota média ≥ 8/10 e nenhum falso positivo claro.
3. Nenhum post contém achado sobre arquivo que a própria review marcou como não lido (teste de unidade no core).
4. `trust` é função pura com teste de tabela cobrindo cada razão; `partial-review`, `lens-failed` e
   head-final-não-revisado nunca produzem `confiável`.
5. Perfis e knobs documentados (README/docs) e cobertos por teste de config.
6. `bun run check` verde; i18n completo; deny-list de flags inseguras intacta (`packages/harness/src/forbidden.ts`).

## 7. Dúvidas abertas (decidir com o Matheus antes de codar o que depender)

- Custo aceitável por review no perfil `thorough`/`gate` (a lente `contracts` e a 2ª passada somam tokens).
- `gate` deve ser opt-in por repo (sugerido) ou haver um repo-piloto? Sugestão: `tupi_system_health`.
- Aceitar `upgrade` de severidade pelo verificador, ou só sinalizar "talvez ⚠" para humano decidir?
- Vocabulário ⛔/⚠/💅/⭐ vira o default global ou só preset `tupi`?
- Para GitLab sem estado de aprovação, como representar o selo (label? comentário fixo?).

## 8. Próximo passo imediato

Comece pelo **Passo 0** (eval com os 6 casos acima) e rode-o contra o `main` atual para registrar a linha de
base. Depois Passo 1 e 3 (maior ganho de recall e precisão), então 4, 5 e 6. Faça um commit por passo.

---

# 9. Aprendizados das reviews do `lewalmeida` (2ª auditoria, mesmo repo)

Auditoria de 8 PRs recentes do `tupi_system_health` revisados pelo usuário `lewalmeida`: #565, #567, #569, #578,
#582, #599, #630, #631 (relatórios em `/tmp/audit/lew_A.md` … `lew_D.md`). Mesmo método da seção 2: revisão
independente primeiro, comparação depois, achados checados no sha revisado.

**Resultado: nota média ~8,5/10 (crewreview: 6,7). Zero falso positivo nos achados classificados.** Todos os
"resolvido em <sha>" conferem no código. Os APPROVED foram merecidos. É o alvo de qualidade a bater.
Os posts parecem gerados por agente (inglês uniforme, template fixo, review ~3-4 min após cada push, sem
assinatura); o autor responde com prefixo 🤖. Use isso como referência de saída, não como verdade absoluta.

## 9.1 O que ele pega e o crewreview perdeu (casos para a eval do Passo 0)

- #599 @`0afe2c3`: kill switch `AUTH_CONFIG_LOOKUP_ENABLED` só valia na UI. Um `handle_event` forjado com
  `path: "lookup:AuthenticationMethod"` fazia WRITE+EXECUTE no device com a feature "off".
  Seguiu `handle_event` → `start_config_read` → `read_config_key` (`commands.ex:346`). Também: `parse_lookup/2`
  aceitava JSON com várias chaves e o corpo ia para `raw_response`, visível a super_admin; TOCTOU e janela de
  60 s < poll de 160 s; lock bloqueante estourando o timeout de 15 s (rodada 2).
- #565: `scs?/1` ignorava `deviceClass` (falha aberta e fechada); `:unsupported_station` sem cláusula caía no
  toast genérico (`station_live.ex:506-532`); msgid do `.po/.pot` diferente da string do template (`default.pot:4242`).
- #569: tick só atualizava `live_now`, então o banner "Dados podem estar atrasados" nunca aparecia com o IEMS
  fora; a pílula do cabeçalho não era atualizada pelo tick; o `refute` do teste passava mesmo sem o fix.
- #578 (plano/spec): 4 "já existe" que não se sustentam (falta RLS e merge em `station_placements`;
  `plant_id` orfana layout em rename/merge; `triage_card` só mostra críticos e os 3 códigos de hotspot são
  `critical: false`; `Telemetry.Limits` não tem faixa de tensão).
- #631 (ADR): origem das descrições de PR indefinida + token do GitHub no pod contra o ADR-0118; replay/idempotência
  em `workflow_dispatch`/rollback; nome exato do workflow para `workflow_run` (nome errado = recurso falha em silêncio).

## 9.2 Técnicas dele, e como virar pipeline (priorize por ganho/custo)

1. **Fase de verificação de alegações (claims) com fonte.** Extrair do diff e da descrição do PR toda afirmação
   verificável ("já existe", "bloqueado no servidor", "só X chama Y", citação de ADR com linha) e conferir cada
   uma contra o repo com `git show <sha>:<path>`. Resultado (confere / não confere / não achei) entra no post.
   Achei `authentication_config.ex:112`: "AuthorizationKey bloqueada no servidor" era falso com path `nil`.
   Isso é o que mais faltava no crewreview para ADR/plano/doc, onde ele hoje aprova sem achados
   (a auditoria viu o crewreview v0.2.0 aprovar o #582 sem achado nenhum).
2. **Entrada forjada e ponto de entrada.** Para cada gate/flag/permissão nova: o gate está no contexto/serviço ou
   só na UI? Seguir do evento do cliente até a função protegida. Para cada assign novo de LiveView, quem o
   atualiza? (liga com a lente `contracts` do Passo 1; gerar `./ctx/entrypoints.md` por grep.)
3. **Cenário obrigatório, achado sem cenário é descartado.** Formato fixo: pré-condição → passos → resultado
   errado → fix em código. Adicionar ao `LENS_SCHEMA` os campos `scenario` e `fix`; o orquestrador descarta ou
   rebaixa a `nit` achado sem `scenario`.
4. **Irreversibilidade como critério de severidade.** ADR aceito não se reescreve (`docs/adr/README.md:24`),
   migration aplicada, contrato público, escrita em device: lacuna nesses artefatos sobe de severidade.
   Implementar como regra em `core` por tipo/caminho de arquivo (configurável por repo), não só no prompt.
5. **Severidade em duas dimensões:** `medium|low` de risco + `blocking|non-blocking`. Mapear isso para
   ⛔/⚠/💅 do padrão tupi-ai (ele usa só ⚠ para tudo que bloqueia e nunca ⛔: evite repetir a ambiguidade).
6. **Estado entre rodadas, verificação de fix no sha novo.** Para cada thread aberta, diff do path nas linhas
   da thread entre `<sha_anterior>..HEAD`; resolver só com evidência, senão reabrir dizendo o que faltou. Ele
   também reconhece quando um fix anterior dele estava errado e reverte (#582, releitura do `Key`).
7. **Escopo explícito do approve** ("Reviewed up to `<sha>`"; "Approval covers the code; ADR acceptance is
   still the gate"). Entra no selo de confiança do Passo 5: dizer o que a aprovação NÃO cobre.
8. **Docs-only tratado como docs-only:** `diff` entre shas só em `@doc`/markdown → "No code changes since the
   previous approval". Barato e evita re-review inútil.
9. **Qualidade do teste:** "o que este teste afirmaria sem o fix?" (#569 r3) e "por que o teste existente não
   pegou isso" (#565). Pedir isso na lente `tests`.
10. **Artefatos de i18n/env/deploy como código:** `.po/.pot` com msgid divergente, `.env.example`, `DEPLOY.md`.
11. **Não repetir thread existente** e **âncora explícita para lacuna fora do diff** ("around line 3964, outside
    the diff"). O crewreview já dedupe; formalizar a âncora.
12. **Hedge honesto quando não verificou** ("If so…", "if it was verified, ignore"): afirmação não verificada
    vira pergunta. Casa com a regra do Passo 3 (nada de afirmar sobre arquivo não lido).
13. **Cruzar com documentos vizinhos:** abrir os ADRs citados, extrair as proibições/decisões numeradas e testar
    o diff contra elas ("para cada decisão, ache o código que a cumpre ou viola"); checar PRs abertos por
    numeração de ADR (`gh pr list`); executar os blocos de código do runbook (ele reproduziu o JSON inválido
    de um heredoc).
14. **Estado externo:** `gh pr checks`, `mergeStateStatus`, conflito com PR irmão (#563).

## 9.3 Fraquezas dele (NÃO copiar, e oportunidades de ficar melhor que ele)

- **Usa CHANGES_REQUESTED** (#565, #567, #569, #578, #582, #599, #631) com itens rotulados ⚠. O padrão tupi-ai
  proíbe; o bloqueio deveria ser ⛔ + COMMENT. Manter o crewreview em COMMENT e expressar bloqueio via selo
  `não confiar` (Passo 5).
- **Rodadas redundantes sem head novo:** #565 r4, #567 r3 e r4 (a r4 repete a r3 quatro minutos depois). Regra:
  se `head_sha` não mudou e nenhuma thread mudou, não postar (o crewreview já tem `heads`; garantir).
- **Bloqueio por item não-código sem dono** (#567: ADR "proposto" que o autor disse não ser dele decidir).
- **Contagem errada** no texto ("two remaining points" com três; "one warning, two nits" com quatro): gerar o
  cabeçalho por código a partir dos achados, nunca pelo modelo.
- **Citação imprecisa** (#569 "freshness guarantee in ADR-0109": a promessa está no runbook, não no ADR).
  Reforça a fase de claims (item 1): citação com `arquivo:linha` conferida por código.
- **Inconsistência entre PRs:** cobrou serialização com índice único no #599 e deixou passar o mesmo padrão
  (cooldown do `/514`, `finish_live_refresh`) no #569. Oportunidade: lente que consulta achados aceitos em PRs
  anteriores do mesmo repo (memória por repo no `crewreview.db`) e cobra consistência.
- **Aprovou com contradição entre ADRs** (#582: ADR-0110 exige "Key contém o nome pedido", ADR-0113 diz que o
  `Key` não é legível) e **não questionou ADR autoproclamado "aceito" por uma pessoa** (#631; `AGENTS.md` pede
  discussão com o time). Oportunidade: checagem de consistência entre ADRs tocados/citados e de status/ritual
  do ADR (`proposto` apoiado em ADR `proposto`).
- **Não viu** prompt injection/sanitização quando conteúdo de PR vai para GenAI e é renderizado (#631), nem o
  que acontece se o POST de ingestão falhar (nota some em silêncio).
- Review não é independente do humano: o bug central do #565 nasceu de uma sugestão do `craudinmoreira`.
  Bom lembrete para a eval: incluir casos em que a "solução sugerida" na thread está errada.

## 9.4 Mudanças no plano (seção 4) por causa disso

- **Passo 1** (`contracts`): acrescentar `./ctx/entrypoints.md` (handlers/rotas/eventos que alcançam as funções
  alteradas) e a pergunta "o gate está no contexto ou só na UI?".
- **Passo 2** (`docs-and-config`): acrescentar a **fase de claims** (item 1), consistência entre ADRs,
  `.po/.pot`/`.env.example`/`DEPLOY.md`, status/ritual de ADR e numeração em PRs abertos.
- **Passo 3** (verificador): incluir `scenario`/`fix` obrigatórios no schema e descarte de achado sem cenário;
  regra de severidade por irreversibilidade em `core`.
- **Passo 4/6**: rodadas só com delta de sha + checagem de thread por thread; cabeçalho e contagens gerados por
  código; "Reviewed up to `<sha>`" e "o que esta aprovação não cobre" no topo do post.
- **Passo 0** (eval): adicionar os casos de 9.1 e os "NÃO DEVE" de 9.3 (ex.: não bloquear por item não-código;
  não repetir post sem head novo; não citar ADR/linha sem conferir).
- Critério de aceite novo: reauditar os mesmos 8 PRs do lewalmeida com o crewreview e igualar ou superar a nota
  (~8,5), com **COMMENT-only** e sem rodada redundante.

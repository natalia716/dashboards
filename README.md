# ATO · Dashboards

Dashboards de Meta Ads, um por cliente, publicados em **dash.atodigital.com.br/&lt;cliente&gt;**
como páginas estáticas no GitHub Pages e atualizados a cada 15 minutos pelo GitHub Actions.
Quatro tipos: **leads** (Meta + planilha de leads), **lançamento** (Meta em nível de anúncio + vendas da Hubla),
**captação** (Meta em nível de anúncio + planilha de leads de um lançamento: orgânico/quente/frio, país, origem e criativos)
e **criativos** (Meta por anúncio e por dia + vendas da Hotmart ou da Payt).

| Cliente | Tipo | Endereço |
|---|---|---|
| O Mundo Clínico | leads | https://dash.atodigital.com.br/omundoclinico |
| Paulo Cobra | lançamento | https://dash.atodigital.com.br/paulo-cobra |
| Glau Borges | criativos | https://dash.atodigital.com.br/glauborges |
| Chef Bernadete | criativos (Payt) | https://dash.atodigital.com.br/chefbernadete |
| Emilia (Black OUT-26) | captação | https://dash.atodigital.com.br/emilia |

## Como funciona

```
clientes/<cliente>/config.json   ← conta do Meta, planilha, filtro de campanha, etapas, perguntas
        ↓ node refresh.js <cliente>
clientes/<cliente>/out/*.json    ← dados coletados (Meta: só as campanhas do filtro; planilha: todos os leads)
        ↓ node build.js
public/<cliente>/index.html      ← shared/template.html + dados, SEM colunas de contato
        ↓ GitHub Actions
dash.atodigital.com.br/<cliente>
```

O token do Meta **não está no código**: vem da variável `META_TOKEN` — no GitHub como *Secret*,
localmente pelo arquivo `.env` (ignorado pelo git).

## Adicionar um cliente de criativos (Meta + vendas da Hotmart)

Um card por criativo (nome do anúncio) com prévia, link "Ver criativo", bolinha de status (verde = algum anúncio com esse
nome veiculando, cinza = pausado), vendas, investimento, CPA, faturamento, lucro, ROAS, ticket médio, CPM, CTR, CPC, CPI,
hook rate (views de 3s ÷ impressões) e hold rate (ThruPlays ÷ views de 3s), filtrável por período (padrão: este mês)
e por status (todos / somente ativos / somente desativados). Abre na tabela; cards ficam como opção. "Dia a dia" abre as
métricas diárias do criativo, do primeiro dia com gasto ou venda até o último (ou até hoje, se ativo). Com
`"upsell": { "nome": "…", "produtos": ["…"] }` no config, aparece também a taxa de upsell (vendas de upsell desses
produtos ÷ vendas). **Vendas e faturamento vêm só da Hotmart**, ligados ao anúncio pelo ID
que vem no código SCK — nunca das conversões do Meta. Investimento, impressões, cliques no link e finalizações de
compra iniciadas (CPI) vêm do Meta. Tudo se atualiza sozinho a cada 15 min.

1. Crie `clientes/<slug>/config.json` com `"tipo": "criativos"`, `nome`, `conta` (act_…) e `desde` (AAAA-MM-DD, início
   do painel) — veja o de `glauborges`.
2. Na conta Hotmart do cliente: *Ferramentas → Credenciais Developers → Criar Credencial* (sem marcar Sandbox). Os três
   valores gerados viram Secrets no GitHub e linhas no `.env` local, com o slug em maiúsculas:
   `HOTMART_CLIENT_ID_<SLUG>`, `HOTMART_CLIENT_SECRET_<SLUG>`, `HOTMART_BASIC_<SLUG>` — e entram no `env:` do workflow.
3. `git push`. A primeira execução busca as vendas desde `desde`; as seguintes, só os últimos 35 dias (garantia da
   Hotmart: venda reembolsada ou com chargeback some do painel) sobre o cache. Conta como venda o status Aprovado ou
   Completo, na data do pedido, pela **comissão do produtor** (o "faturamento líquido" do export; compra no exterior
   é convertida para reais pelas taxas da própria venda).

A API também devolve nome e e-mail do comprador: nada disso é guardado (ver `hotmart.js`).

**Plano B, sem API** — exporte o histórico de vendas da Hotmart (`sales_history_*.xls`) e importe:
```bash
node importar-hotmart.js <slug> "C:\Users\...\Downloads\sales_history_....xls"
```
Grava `clientes/<slug>/vendas/hotmart.json` **sem dado do comprador** (o export tem nome, e-mail, telefone e CPF;
o `.gitignore` bloqueia `.xls`/`.xlsx`/`.csv` nessa pasta). Exports se somam pelo código da transação. O refresh só
usa esse arquivo quando não há credencial nem cache, e o painel avisa até que dia vão as vendas importadas.

O SCK que a Hotmart grava hoje (parâmetros de URL do Meta, com `hQwK21wXxR` como separador) é
`FB␟{{campaign.name}}|{{campaign.id}}␟{{adset.name}}|{{adset.id}}␟{{ad.name}}|{{ad.id}}␟{{placement}}` — o ID do
anúncio é o trecho antes do último separador. Venda sem SCK, com macro não substituída
(`{{ad.id}}`) ou do link na bio fica fora dos cards. Entre anúncios com o mesmo nome, a prévia vem do que tem post
no Instagram e mais gastou; a miniatura é baixada uma vez (a URL do Meta expira) e fica no cache.

## Cliente de criativos com vendas da Payt (ex.: chefbernadete)

A Payt não tem API de vendas: cada evento chega por **postback** num Cloudflare Worker do cliente
(`payt/worker.js`, conta Cloudflare da ATO), que guarda o último estado de cada transação **sem dado do comprador**
num banco D1. O refresh busca as vendas lá a cada execução.

- `config.json`: `"vendas": "payt"`, `"payt": { "url": "https://payt-<slug>.natalia-337.workers.dev", "produtos": [] }`
  (`produtos` opcional: códigos de produto da Payt que contam; vazio = todos).
- Venda = `payment_status` "paid" e `test` falso, na data do pagamento; valor = **comissão da produtora**
  (`commission[type=producer]`). Upsell soma no faturamento do anúncio mas não conta como venda nova.
- Anúncio pelo `utm_content` (`{{ad.name}}|{{ad.id}}` nos parâmetros de URL do Meta).
- Segredos: `PAYT_READ_KEY_<SLUG>` (.env e Secrets do GitHub) = `READ_KEY` do Worker. A URL do postback (com o
  `POSTBACK_TOKEN`) fica só no `.env` (`PAYT_POSTBACK_URL_<SLUG>`) e na Payt (*Ferramentas → Postbacks*, tipo PayT V1).
- Novo cliente: copie `payt/wrangler.toml` trocando `name`/banco (`npx wrangler d1 create payt-<slug>`), publique com
  `npx wrangler deploy --config <arquivo>` e grave os dois segredos com `npx wrangler secret put`.
- Sem chave ou com o Worker fora do ar, o painel sai só com o Meta e um aviso (não derruba os outros clientes).
- **Histórico** (vendas de antes do postback): exporte *Relatórios → Origem de vendas* da Payt (é o único export com as
  UTMs; o relatório de vendas comum não tem UTM e traz dado pessoal) e rode
  `node importar-payt.js <slug> origem_de_vendas_….xlsx` → `clientes/<slug>/vendas/payt.json` (sem dado do comprador).
  Só conta como anúncio do Meta a venda com `utm_source` do Facebook/Instagram (o Google também manda ID no `utm_content`).

**Várias contas de anúncio** (`"contas": ["act_…", …]` no lugar de `conta`): as métricas se somam e os criativos de
mesmo nome viram um card só. Conta em outro Business Manager: token próprio em `META_TOKEN_ACT_<número da conta>`
(.env + Secret + `env:` do workflow). Conta que falhar sai do painel naquela rodada, com aviso.

**Conta em dólar (ou outra moeda)**: o gasto é convertido para reais pela **PTAX de venda do dia** (Banco Central;
fim de semana/feriado usa o último dia útil). Cotações ficam em `out/cache/ptax-USD.json`. Cada conta separa os dias
no próprio fuso horário.

## Adicionar um cliente de lançamento (vendas via Hubla)

1. Crie `clientes/<slug>/config.json` copiando o de `paulo-cobra`: `"tipo": "lancamento"`, `nome`, `conta` (act_…),
   `filtroCampanha` (palavra que identifica as campanhas do lançamento no nome) e, se quiser, `temperatura`
   (regex de público quente/frio sobre o nome do conjunto e da campanha; as tags `[F]`/`[Q]` sempre valem).
2. **Vendas da Hubla** chegam por webhook numa planilha do Google — o código do receptor está em
   `hubla/webhook-planilha.gs` com o passo a passo no topo do arquivo. Depois, no config:
   `"hubla": { "planilha": { "id": "<id da planilha>" }, "produtos": ["<id do produto na Hubla>"] }`
   (`produtos` é opcional: sem ele, toda fatura paga da planilha conta como venda). `"orderBump": ["<id do produto da gravação>"]`
   marca as faturas com order bump — sem a lista, conta qualquer fatura paga com 2+ produtos.
3. Nas URLs dos anúncios do Meta use `utm_source=meta&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`
   — a venda é ligada ao anúncio pelo `utm_content` (aceita também o nome do anúncio).
4. Enquanto `hubla` for `null`, o painel mostra o aviso "Hubla pendente" e vendas zeradas; gasto e funil já ficam certos.
5. `git push` — o Actions publica em `dash.atodigital.com.br/<slug>`.

### Aba de debriefing (cruzar o workshop com o produto final)

Coloque os exports de vendas da Hubla (.xlsx) em `clientes/<slug>/entrada/`:

| Arquivo | O que é |
|---|---|
| `mba.xlsx` | vendas do produto final (o que fecha o lançamento) |
| `workshop.xlsx` | vendas do ingresso — é o que carrega as UTMs do anúncio junto do e-mail |

`node refresh.js <slug>` cruza os dois pelo e-mail do comprador e escreve **só agregados** em
`clientes/<slug>/debrief.json` (esse sim versionado), respondendo de qual criativo e público
veio cada comprador do produto final. A pasta `entrada/` tem nome, e-mail e telefone e **fica
fora do git** — o Actions republica a aba a partir do `debrief.json` já gerado, então basta
rodar o refresh localmente e commitar quando chegarem exports novos.

Funil, taxas e temperatura vêm de `shared/template-lancamento.html`; o build injeta os JSONs de `clientes/<slug>/out/`.
Vendas com `utm_content` que não bate com nenhum anúncio aparecem como "Não atribuído" (contam no total, não na temperatura).

## Adicionar um cliente de captação (leads de lançamento)

`clientes/<slug>/config.json` com `"tipo": "captacao"`, `nome`, `lancamento` (aparece no título), `conta`,
`filtroCampanha` (regex sobre o nome; ex.: `"\\[BLACK\\]\\[OUT-26\\]"`), `desde` e `planilha` (`id`, `gid`) — veja o de `emilia`.
A planilha precisa estar como "qualquer pessoa com o link pode ver" e ter `Date`, `Email`, `pais`, `utm_source`,
`utm_medium`, `utm_campaign` e `utm_content`.

- **Tráfego × orgânico**: é do tráfego o lead com cara de anúncio do Meta — campanha/conjunto com `[TAGS]` no
  `utm_campaign`/`utm_medium`, placement do Meta no `utm_source` (`Instagram_Stories`…) ou macro não substituída.
  O resto é orgânico, com a origem em `utm_source · utm_medium` (ex.: Instagram · Stories, WhatsApp · Grupos antigos).
- **Quente/frio**: tags `[QUENTE]`/`[Q]` e `[FRIO]`/`[F]` do conjunto (`utm_medium`) e, sem elas, da campanha.
  Tag explícita ganha das palavras de `temperatura` (`[FRIO][ENVOL-30D]` é frio).
- **Criativo** = `utm_content` com o nome do anúncio; a tabela agrupa anúncios de mesmo nome, com miniatura (baixada
  uma vez para `out/cache/thumbs`) e link para o post no Instagram — do anúncio que mais gastou no filtro escolhido.
- E-mail repetido conta uma vez (vale o primeiro cadastro). Nome, e-mail e telefone não saem do `refresh.js`.
- Investimento na moeda da conta (ex.: pesos uruguaios), sem conversão.

## Adicionar um cliente de leads

1. Crie `clientes/<slug>/config.json` copiando o de `omundoclinico` e ajuste: `nome`, `subtitulo`,
   `conta` (act_…), `filtroCampanha` (palavra que identifica as campanhas do projeto no nome),
   `planilha.id`, `etapas` e `perguntas` (as colunas da planilha que viram gráfico).
2. A planilha precisa estar como "qualquer pessoa com o link pode **ver**" e ter as colunas
   `Data/Hora`, `Status`, `MQL`, `Estado`, `utm_medium`, `utm_campaign`, `utm_content` (mais as perguntas).
3. Se o cliente estiver em outro Business Manager, cadastre o Secret `META_TOKEN_<SLUG>` (maiúsculas)
   e adicione a linha correspondente no `env:` do workflow.
4. `git push` — o Actions publica em `dash.atodigital.com.br/<slug>`.

## Se o agendamento do GitHub não disparar

O `schedule` do GitHub Actions é conhecido por atrasar ou pular execuções, e em repositório novo
pode levar horas para a primeira. Para garantir os 15 minutos, um cron externo chama o
`workflow_dispatch` do workflow:

1. **Token no GitHub**: foto de perfil → *Settings* → *Developer settings* → *Personal access tokens*
   → *Fine-grained tokens* → *Generate new token*. Nome `cron-dashboards`; *Repository access*: só
   `dashboards`; *Permissions → Repository → Actions: Read and write*. Copie o token (`github_pat_…`).
2. **cron-job.org** (grátis): *Create cronjob* → URL
   `https://api.github.com/repos/natalia716/dashboards/actions/workflows/atualizar.yml/dispatches`,
   *Schedule*: every 15 minutes. Na aba *Advanced*: *Request method* **POST**; *Headers*:
   `Authorization: Bearer github_pat_…` e `Accept: application/vnd.github+json`;
   *Request body*: `{"ref":"main"}`. Salve e use *Run now* — a resposta esperada é **HTTP 204**.

Os dois gatilhos podem coexistir: o `concurrency` do workflow impede execuções sobrepostas.

## Rodar localmente

```bash
node refresh.js omundoclinico && node build.js
```

Para o lançamento: `node refresh.js paulo-cobra && node build.js paulo-cobra` → `public/paulo-cobra/index.html`.

Abre `public/omundoclinico/index.html`. `node build.js omundoclinico --full` gera
`clientes/omundoclinico/dashboard-completo.html` com nome/e-mail/telefone (**nunca publicar**).

## Mudar o visual ou as métricas

Edita `shared/template.html` (clientes de leads) ou `shared/template-lancamento.html` (lançamentos) e roda `node build.js`.
Um `git push` na `main` republica na hora.

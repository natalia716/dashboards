# ATO · Dashboards

Dashboards de Meta Ads, um por cliente, publicados em **dash.atodigital.com.br/&lt;cliente&gt;**
como páginas estáticas no GitHub Pages e atualizados a cada 15 minutos pelo GitHub Actions.
Três tipos: **leads** (Meta + planilha de leads), **lançamento** (Meta em nível de anúncio + vendas da Hubla)
e **criativos** (Meta por anúncio e por dia + vendas da Hotmart).

| Cliente | Tipo | Endereço |
|---|---|---|
| O Mundo Clínico | leads | https://dash.atodigital.com.br/omundoclinico |
| Paulo Cobra | lançamento | https://dash.atodigital.com.br/paulo-cobra |
| Glau Borges | criativos | https://dash.atodigital.com.br/glauborges |

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

Um card por criativo (nome do anúncio) com prévia, link "Ver criativo", vendas, investimento, CPA, faturamento, lucro,
ROAS, CPM, CTR, CPC e CPI, filtrável por dia. **Vendas e faturamento vêm só da Hotmart**, ligados ao anúncio pelo ID
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

Funil, taxas e temperatura vêm de `shared/template-lancamento.html`; o build injeta os JSONs de `clientes/<slug>/out/`.
Vendas com `utm_content` que não bate com nenhum anúncio aparecem como "Não atribuído" (contam no total, não na temperatura).

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

# ATO · Dashboards

Dashboards de Meta Ads + leads, um por cliente, publicados em **dash.atodigital.com.br/&lt;cliente&gt;**
como páginas estáticas no GitHub Pages e atualizados a cada 15 minutos pelo GitHub Actions.

| Cliente | Endereço |
|---|---|
| O Mundo Clínico | https://dash.atodigital.com.br/omundoclinico |

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

## Adicionar um cliente

1. Crie `clientes/<slug>/config.json` copiando o de `omundoclinico` e ajuste: `nome`, `subtitulo`,
   `conta` (act_…), `filtroCampanha` (palavra que identifica as campanhas do projeto no nome),
   `planilha.id`, `etapas` e `perguntas` (as colunas da planilha que viram gráfico).
2. A planilha precisa estar como "qualquer pessoa com o link pode **ver**" e ter as colunas
   `Data/Hora`, `Status`, `MQL`, `Estado`, `utm_medium`, `utm_campaign`, `utm_content` (mais as perguntas).
3. Se o cliente estiver em outro Business Manager, cadastre o Secret `META_TOKEN_<SLUG>` (maiúsculas)
   e adicione a linha correspondente no `env:` do workflow.
4. `git push` — o Actions publica em `dash.atodigital.com.br/<slug>`.

## Rodar localmente

```bash
node refresh.js omundoclinico && node build.js
```

Abre `public/omundoclinico/index.html`. `node build.js omundoclinico --full` gera
`clientes/omundoclinico/dashboard-completo.html` com nome/e-mail/telefone (**nunca publicar**).

## Mudar o visual ou as métricas

Edita `shared/template.html` (vale para todos os clientes) e roda `node build.js`.
Um `git push` na `main` republica na hora.

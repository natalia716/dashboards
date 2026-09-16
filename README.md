# Dashboard · O Mundo Clínico (IVC)

Dashboard de Meta Ads + leads da planilha, publicado como página estática no GitHub Pages
e atualizado automaticamente a cada 15 minutos pelo GitHub Actions.

## Como funciona

```
refresh.js  →  out/*.json   (Meta Ads: só campanhas "IVC"; planilha: todos os leads)
build.js    →  dashboard.html   (template.html + out/*.json + brazil.svg, SEM colunas de contato)
Actions     →  publica dashboard.html como index.html no GitHub Pages
```

O token do Meta **não está no código**: vem da variável `META_TOKEN` — no GitHub como *Secret*,
localmente pelo arquivo `.env` (ignorado pelo git).

## Rodar localmente

```bash
node refresh.js && node build.js
```

Abre `dashboard.html` no navegador. `node build.js --full` gera `dashboard-completo.html`
com nome/e-mail/telefone (nunca publicar essa versão).

## Mudar o visual ou as métricas

Edita `template.html` e roda `node build.js`. Um `git push` na branch `main` republica na hora.

Detalhes em [atualizar.md](atualizar.md).

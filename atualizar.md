# Atualizar o dashboard

Rodar, nesta pasta:

```bash
node refresh.js && node build.js
```

Depois republicar `dashboard.html` no mesmo endereço:
https://claude.ai/artifact/3tDGKcAv6amZJidtuLJZfr

## O que cada arquivo faz

- `refresh.js` — baixa insights do Meta Ads (só campanhas com "IVC" no nome, desde a primeira delas)
  e os leads da planilha; grava em `out/*.json`.
- `build.js` — junta `template.html` + `out/*.json` + `brazil.svg`:
  - `node build.js` → `dashboard.html` **sem** nome/e-mail/telefone/Instagram (é o que vai publicado)
  - `node build.js --full` → `dashboard-completo.html` **com** tudo (só para uso local)
- `template.html` — o dashboard em si (layout, gráficos, mapa, tabelas).

## Etapas do funil

O filtro "Etapa" reconhece PRE-VENDA e LOTE01/02/03 pelo nome da campanha (aceita "LOTE 01",
"LOTE-1", "lote1"…). Etapas sem campanha ainda aparecem desabilitadas e ligam sozinhas quando
a campanha subir. Os leads entram na etapa pelo `utm_campaign`.

Para mudar aparência ou métricas, editar `template.html` e rodar só `node build.js`.

## Notas da API do Meta

- Os insights com `actions` (necessário para page views) estouram o limite do Graph em janelas
  longas — por isso `refresh.js` consulta em blocos de 30 dias.
- `date_preset=last_30d` e similares **não incluem o dia atual**; o script usa intervalos explícitos.
- O erro "Service temporarily unavailable" (code 2) aparece de forma intermitente mesmo marcado
  como `is_transient: false`; o script repete a chamada até 5 vezes com espera crescente.

## Origem dos números

- **Gasto, impressões, cliques, page views** → Meta Ads.
- **Leads, MQLs, status** → planilha (nunca o Gerenciador), casados por UTM com campanha/público/anúncio.
- Leads cuja UTM não bate com nenhuma campanha aparecem como "Não atribuído".

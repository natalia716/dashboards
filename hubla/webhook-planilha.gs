// Receptor do webhook da Hubla → Google Planilhas (Apps Script).
//
// Cada evento de fatura vira UMA linha na aba "vendas". O refresh.js lê a planilha (export CSV)
// e considera venda a fatura cuja última linha está com status "paid" — reembolso/chargeback
// posterior tira a venda sozinho. Não guarda nome, e-mail nem telefone: só o que o painel usa.
//
// Como instalar (uma vez):
//   1. Crie uma planilha nova no Google Drive. Extensões → Apps Script. Apague o conteúdo e cole este arquivo.
//   2. Troque SEGREDO abaixo por uma senha longa qualquer (ex.: 32 letras e números).
//   3. Implantar → Nova implantação → tipo "App da Web" → "Executar como: eu" → "Quem pode acessar: Qualquer pessoa" → Implantar.
//      Copie a URL (termina em /exec).
//   4. Na Hubla: Integrações → Webhook → nova integração → URL = <URL do passo 3>?token=<SEGREDO>
//      Eventos: marque todos os de Fatura (invoice.created, invoice.status_updated, invoice.payment_succeeded,
//      invoice.payment_failed, invoice.expired, invoice.refunded). Use "Enviar evento de teste" para conferir.
//   5. Compartilhe a planilha como "Qualquer pessoa com o link → Leitor" e coloque o ID dela (o trecho entre /d/ e /edit)
//      em clientes/<cliente>/config.json → "hubla": { "planilha": { "id": "..." } }.
//
// Para atualizar o código depois de já implantado: cole o arquivo novo, salve e vá em
// Implantar → Gerenciar implantações → (lápis) → Versão: "Nova versão" → Implantar. A URL continua a mesma.
//
// Nas URLs dos anúncios no Meta, use utm_content={{ad.id}} — é assim que a venda é ligada ao anúncio.
// (o Apps Script não lê cabeçalhos HTTP, por isso o x-hubla-token não pode ser conferido aqui; o ?token= na URL faz esse papel)

var SEGREDO = 'TROQUE-POR-UMA-SENHA-LONGA';
var ABA = 'vendas';
var COLUNAS = ['recebido_em', 'evento', 'invoice_id', 'status', 'sale_date', 'total_cents', 'product_id', 'product_name',
               'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck',
               'products_ids', 'products_names']; // todos os produtos da fatura (produto principal + order bumps), separados por " | "

function doPost(e) {
  try {
    var token = e && e.parameter && e.parameter.token;
    if (SEGREDO && token !== SEGREDO) return json_({ ok: false, error: 'token inválido' }, 401);

    var body = JSON.parse(e.postData && e.postData.contents || '{}');
    var tipo = body.type || body.event_type || '';
    if (tipo.indexOf('invoice.') !== 0) return json_({ ok: true, ignorado: tipo }); // só faturas interessam

    var ev = body.event || body;
    var inv = ev.invoice || {};
    var prod = ev.product || (ev.products && ev.products[0]) || {};
    var ps = inv.paymentSession || {};
    var utm = ps.utm || {};
    var params = ps.params || {};
    var amount = inv.amount || {};
    var prods = Array.isArray(ev.products) && ev.products.length ? ev.products : (prod.id ? [prod] : []);

    var linha = [
      new Date(),
      tipo,
      inv.id || '',
      inv.status || '',
      inv.saleDate || inv.createdAt || '',
      amount.totalCents != null ? amount.totalCents : '',
      prod.id || '',
      prod.name || '',
      utm.source || '', utm.medium || '', utm.campaign || '', utm.content || '', utm.term || '',
      params.src || '', params.sck || '',
      prods.map(function (x) { return x.id || ''; }).join(' | '),
      prods.map(function (x) { return x.name || ''; }).join(' | ')
    ];

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var aba = aba_();
      aba.appendRow(linha);
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) }, 500);
  }
}

// GET só para conferir que a implantação está no ar
function doGet(e) {
  return json_({ ok: true, servico: 'webhook hubla → planilha', linhas: aba_().getLastRow() - 1 });
}

function aba_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var aba = ss.getSheetByName(ABA);
  if (!aba) {
    aba = ss.insertSheet(ABA);
    aba.appendRow(COLUNAS);
    aba.setFrozenRows(1);
  } else if (aba.getLastColumn() < COLUNAS.length) {
    // versão nova do script com colunas a mais: completa o cabeçalho sem mexer nas linhas existentes
    aba.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]);
  }
  return aba;
}

function json_(obj, status) {
  // o Apps Script não permite definir o status HTTP; a Hubla trata qualquer 200 como entregue
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

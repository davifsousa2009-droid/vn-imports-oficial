'use strict';
// Teste de INTEGRAÇÃO, não unitário: sobe o app de verdade (numa porta livre
// do SO, nunca a 3000) e bate nele via HTTP real, escreve e apaga documentos
// de verdade no banco de MONGODB_URI ativo (o mesmo do .env usado em dev).
// Roda só contra banco de desenvolvimento — nunca aponte MONGODB_URI de
// produção pra rodar `npm test`. Todo produto/pedido criado aqui usa o nome
// __TESTE_AUTOMATIZADO_PEDIDOS__ e é removido no final (before() já limpa
// qualquer resquício de uma execução anterior interrompida, por segurança).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { app } = require('./setup.js');

const MARCADOR = '__TESTE_AUTOMATIZADO_PEDIDOS__';

let httpServer;
let baseUrl;
let Produto;
let Order;

before(async () => {
  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const statusRes = await fetch(`${baseUrl}/api/status`);
  const status = await statusRes.json();
  if (!status.isConnected) {
    throw new Error(
      'MONGODB_URI indisponível — os testes de integração de pedidos precisam de um banco de ' +
      'desenvolvimento acessível (mesma variável do .env). Os testes de pix/webhook/frete não ' +
      'dependem disso e podem rodar sozinhos.'
    );
  }

  Produto = mongoose.model('Produto');
  Order = mongoose.model('Order');

  // limpa resquício de uma execução anterior que não tenha terminado de limpar
  await Produto.deleteMany({ nome: MARCADOR });
  await Order.deleteMany({ customerName: MARCADOR });
});

after(async () => {
  if (Produto) await Produto.deleteMany({ nome: MARCADOR }).catch(() => {});
  if (Order) await Order.deleteMany({ customerName: MARCADOR }).catch(() => {});
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  // Mongoose não é exportado por server.js pra ser desconectado de lá — mas é
  // o mesmo singleton (mesmo módulo, mesmo processo), então desconecta daqui
  // mesmo. NÃO usar process.exit(): mata o processo-filho do `node --test`
  // antes dele reportar os testes individuais (todo o arquivo apareceria
  // como "1 teste" só, escondendo falha real de qualquer um deles).
  await mongoose.disconnect().catch(() => {});
});

function criarProdutoTeste(overrides = {}) {
  return Produto.create({
    nome: MARCADOR,
    preco: 100,
    estoque: 5,
    pesoKg: 1,
    larguraCm: 10,
    alturaCm: 10,
    comprimentoCm: 10,
    ...overrides
  });
}

function payloadPedido(items) {
  return {
    customerName: MARCADOR,
    items,
    cep: '01310100',
    payerEmail: 'teste@teste.com',
    payerTelefone: '11999999999',
    payerCpf: '11111111111',
    rua: 'Rua Teste',
    numero: '1',
    bairro: 'Centro',
    cidade: 'SAO PAULO',
    estado: 'SP'
  };
}

async function postPedido(items) {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadPedido(items))
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('pedido com estoque suficiente: cria o pedido e decrementa o estoque na quantidade certa', async () => {
  const produto = await criarProdutoTeste({ estoque: 5 });
  const { status, body } = await postPedido([{ productId: String(produto._id), qty: 2 }]);
  assert.equal(status, 201, JSON.stringify(body));

  const atualizado = await Produto.findById(produto._id).lean();
  assert.equal(atualizado.estoque, 3);
});

test('produto com estoque=null (controle desativado): pedido passa e o estoque continua null, nunca decrementa', async () => {
  const produto = await criarProdutoTeste({ estoque: null });
  const { status, body } = await postPedido([{ productId: String(produto._id), qty: 3 }]);
  assert.equal(status, 201, JSON.stringify(body));

  const atualizado = await Produto.findById(produto._id).lean();
  assert.equal(atualizado.estoque, null);
});

test('estoque insuficiente: pedido rejeitado com 409 e o estoque não é tocado', async () => {
  const produto = await criarProdutoTeste({ estoque: 1 });
  const { status } = await postPedido([{ productId: String(produto._id), qty: 5 }]);
  assert.equal(status, 409);

  const atualizado = await Produto.findById(produto._id).lean();
  assert.equal(atualizado.estoque, 1);
});

test('pedido com 2 itens, o 2º sem estoque: reverte (rollbackStock) o decremento já aplicado no 1º', async () => {
  const produtoOk = await criarProdutoTeste({ estoque: 5 });
  const produtoSemEstoque = await criarProdutoTeste({ estoque: 1 });

  const { status } = await postPedido([
    { productId: String(produtoOk._id), qty: 2 },
    { productId: String(produtoSemEstoque._id), qty: 5 }
  ]);
  assert.equal(status, 409);

  const okDepois = await Produto.findById(produtoOk._id).lean();
  assert.equal(okDepois.estoque, 5, 'rollbackStock deveria ter devolvido o estoque do 1º item após o 2º falhar');
});

test('produto sem peso/dimensão cadastrados nem padrão da loja: pedido rejeitado (409), não vende com dado inventado', async () => {
  const produto = await criarProdutoTeste({ pesoKg: null, larguraCm: null, alturaCm: null, comprimentoCm: null });
  const { status, body } = await postPedido([{ productId: String(produto._id), qty: 1 }]);
  assert.equal(status, 409);
  assert.equal(body.motivo, 'SEM_DADOS_ENVIO');

  // não pode ter decrementado estoque de um pedido que nunca deveria ter sido aceito
  const atualizado = await Produto.findById(produto._id).lean();
  assert.equal(atualizado.estoque, 5);
});

test('total do pedido é recalculado no servidor a partir do preço real do produto, nunca aceita o total enviado pelo cliente', async () => {
  const produto = await criarProdutoTeste({ preco: 77.5, estoque: 5 });
  const subtotalReal = 77.5 * 2; // 2 unidades — o servidor recalcula isso a partir do Produto salvo, nunca confia no preço vindo do corpo da requisição
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payloadPedido([{ productId: String(produto._id), qty: 2 }]),
      total: 1 // tentativa de manipular o preço — deve ser ignorada
    })
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  // Frete real varia por ambiente (depende de me_token configurado e da
  // cotação ao vivo do Melhor Envio) — por isso não assumimos frete=0 aqui.
  // O que importa provar é que o total ignora o valor manipulado (1) e nunca
  // fica abaixo do subtotal real dos itens (frete só soma, nunca subtrai).
  assert.notEqual(body.order.total, 1);
  assert.ok(
    body.order.total >= subtotalReal,
    `total (${body.order.total}) deveria ser >= subtotal real dos itens (${subtotalReal})`
  );
  assert.equal(body.order.items[0].price, 77.5, 'preço do item também deve vir do Produto salvo, não do corpo da requisição');
});

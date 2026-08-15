/**
 * Levantamento SOMENTE-LEITURA de pedidos com item de um produto QUE TEM
 * tamanhos cadastrados, mas foi comprado sem nenhum tamanho selecionado
 * (tamanhoSelecionado vazio) — sintoma do bug de adicionar-rápido sem
 * validação de tamanho (carrosséis secundários / busca).
 *
 * Não escreve nada no banco. Só lê Order e Produto e imprime um relatório.
 *
 * Uso: node scripts/relatorio-pedidos-sem-tamanho.js
 * Requer MONGODB_URI no .env (mesma variável que o server.js usa).
 */

if (!process.env.VERCEL) {
  require('dotenv').config();
}

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  customerName: String,
  items: [
    {
      name: String,
      qty: Number,
      price: Number,
      tamanhoSelecionado: String,
      productId: String
    }
  ],
  status: String,
  createdAt: Date
});
const ProdutoSchema = new mongoose.Schema({
  nome: String,
  sizes: { type: [String], default: [] }
});

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI não definido no .env — não é possível conectar.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const Order = mongoose.model('Order', OrderSchema);
  const Produto = mongoose.model('Produto', ProdutoSchema);

  const produtos = await Produto.find().lean();
  const produtoPorId = new Map(produtos.map((p) => [String(p._id), p]));

  const orders = await Order.find().lean();

  let pedidosAfetados = 0;
  let itensAfetados = 0;
  const detalhes = [];

  for (const o of orders) {
    let algumItemAfetado = false;
    for (const item of o.items || []) {
      const produto = item.productId ? produtoPorId.get(String(item.productId)) : null;
      const produtoTemTamanhos = produto && Array.isArray(produto.sizes) && produto.sizes.length > 0;
      const semTamanhoNoItem = !item.tamanhoSelecionado || !String(item.tamanhoSelecionado).trim();

      if (produtoTemTamanhos && semTamanhoNoItem) {
        itensAfetados++;
        algumItemAfetado = true;
        detalhes.push({
          pedidoId: String(o._id),
          status: o.status,
          data: o.createdAt ? new Date(o.createdAt).toLocaleDateString('pt-BR') : '—',
          item: item.name,
          tamanhosDisponiveis: produto.sizes.join(', ')
        });
      }
    }
    if (algumItemAfetado) pedidosAfetados++;
  }

  console.log(`Total de pedidos no banco: ${orders.length}`);
  console.log(`Pedidos com pelo menos um item sem tamanho (produto que TEM tamanhos): ${pedidosAfetados}`);
  console.log(`Itens afetados no total: ${itensAfetados}`);

  if (detalhes.length) {
    console.log('\n--- Detalhes ---');
    detalhes.forEach((d) => {
      console.log(`  Pedido ${d.pedidoId} (${d.status}, ${d.data}) — "${d.item}" sem tamanho (opções: ${d.tamanhosDisponiveis})`);
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});

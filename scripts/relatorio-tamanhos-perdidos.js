/**
 * Levantamento SOMENTE-LEITURA dos tamanhos possivelmente perdidos pelo bug
 * de PUT /api/produtos/:id (sizes:[] do formulário de edição sem campo de
 * tamanho sobrescrevendo os tamanhos reais do produto).
 *
 * Não escreve nada no banco. Só lê Produto e Order e imprime um relatório.
 *
 * IMPORTANTE — isto é um PISO, não uma restauração: um tamanho que existia
 * mas nunca foi comprado não deixa nenhum rastro em Order, e não vai
 * aparecer aqui. Um produto sem nenhum pedido encontrado não significa
 * necessariamente "nunca teve tamanho" — só significa "não sobrou rastro
 * pra reconstruir automaticamente". Trate os resultados como sugestão de
 * revisão manual, não como valor pronto para salvar de volta.
 *
 * Uso: node scripts/relatorio-tamanhos-perdidos.js
 * Requer MONGODB_URI no .env (mesma variável que o server.js usa).
 */

if (!process.env.VERCEL) {
  require('dotenv').config();
}

const mongoose = require('mongoose');

const ProdutoSchema = new mongoose.Schema(
  {
    nome: String,
    preco: Number,
    sizes: { type: [String], default: [] }
  },
  { timestamps: true }
);
const OrderSchema = new mongoose.Schema(
  {
    items: {
      type: [
        {
          name: String,
          productId: String,
          tamanhoSelecionado: String
        }
      ],
      default: []
    }
  },
  { timestamps: true }
);

const Produto = mongoose.model('Produto', ProdutoSchema, 'produtos');
const Order = mongoose.model('Order', OrderSchema, 'orders');

function normalizarNome(n) {
  return String(n || '').trim().toLowerCase();
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI não definido no ambiente (.env). Abortando — nada foi lido.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado. Gerando relatório (somente leitura)...\n');

  const produtosSemTamanho = await Produto.find({
    $or: [{ sizes: { $size: 0 } }, { sizes: { $exists: false } }]
  }).lean();

  if (!produtosSemTamanho.length) {
    console.log('Nenhum produto com sizes:[] encontrado. Nada a levantar.');
    await mongoose.disconnect();
    return;
  }

  // Carrega todos os pedidos uma única vez — mais barato que uma query por produto.
  const todosPedidos = await Order.find({}).select('items createdAt').lean();

  const comRastro = [];
  const semRastro = [];

  for (const produto of produtosSemTamanho) {
    const produtoId = String(produto._id);
    const nomeNormalizado = normalizarNome(produto.nome);

    // tamanho -> { porProductId: Set(orderId), porNome: Set(orderId) }
    const achados = new Map();

    for (const pedido of todosPedidos) {
      for (const item of pedido.items || []) {
        const tam = String(item.tamanhoSelecionado || '').trim();
        if (!tam) continue;

        const bateuPorId = item.productId && String(item.productId) === produtoId;
        const bateuPorNome = !bateuPorId && normalizarNome(item.name) === nomeNormalizado && nomeNormalizado;

        if (!bateuPorId && !bateuPorNome) continue;

        if (!achados.has(tam)) achados.set(tam, { porProductId: new Set(), porNome: new Set() });
        const registro = achados.get(tam);
        if (bateuPorId) registro.porProductId.add(String(pedido._id));
        else registro.porNome.add(String(pedido._id));
      }
    }

    if (achados.size === 0) {
      semRastro.push(produto);
      continue;
    }

    const tamanhos = [...achados.entries()]
      .map(([tam, r]) => ({
        tamanho: tam,
        pedidosPorId: r.porProductId.size,
        pedidosPorNome: r.porNome.size,
        totalPedidos: r.porProductId.size + r.porNome.size,
        confiavel: r.porProductId.size > 0 // teve pelo menos 1 pedido casado por productId
      }))
      .sort((a, b) => b.totalPedidos - a.totalPedidos);

    comRastro.push({ produto, tamanhos });
  }

  console.log('='.repeat(72));
  console.log('RELATÓRIO — TAMANHOS RECONSTRUÍVEIS A PARTIR DO HISTÓRICO DE PEDIDOS');
  console.log('='.repeat(72));
  console.log(
    'Isto é um PISO, não uma restauração completa: tamanhos que existiam mas\n' +
    'nunca foram comprados não deixam rastro em Order e não aparecem aqui.\n' +
    'Revise manualmente antes de salvar qualquer coisa de volta no produto.'
  );
  console.log('='.repeat(72) + '\n');

  console.log(`Produtos com sizes:[] hoje: ${produtosSemTamanho.length}`);
  console.log(`  Com algum rastro em pedidos: ${comRastro.length}`);
  console.log(`  SEM nenhum rastro (recadastro 100% manual): ${semRastro.length}\n`);

  if (comRastro.length) {
    console.log('-'.repeat(72));
    console.log('PRODUTOS COM RASTRO — revisar e completar pelo formulário de edição');
    console.log('-'.repeat(72));
    for (const { produto, tamanhos } of comRastro) {
      console.log(`\n• ${produto.nome}  (id: ${produto._id})`);
      for (const t of tamanhos) {
        const fonte = t.confiavel
          ? `${t.totalPedidos} pedido(s) — ${t.pedidosPorId} por productId, ${t.pedidosPorNome} por nome`
          : `${t.totalPedidos} pedido(s) — TODOS por nome (fallback, produto pode ter sido renomeado)`;
        const alerta = t.totalPedidos === 1 ? '  ⚠ sustentado por 1 único pedido — confirme antes de assumir' : '';
        console.log(`    - ${t.tamanho}: ${fonte}${alerta}`);
      }
    }
    console.log('');
  }

  if (semRastro.length) {
    console.log('-'.repeat(72));
    console.log('SEM NENHUM RASTRO — recadastro 100% manual (maior risco de esquecer)');
    console.log('-'.repeat(72));
    for (const produto of semRastro) {
      console.log(`  • ${produto.nome}  (id: ${produto._id})`);
    }
    console.log('');
  }

  console.log('='.repeat(72));
  console.log('Fim do relatório. Nada foi alterado no banco.');
  console.log('='.repeat(72));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Erro ao gerar relatório:', e.message);
  process.exit(1);
});
const quebradoDePropositoParaTestarCI = ;

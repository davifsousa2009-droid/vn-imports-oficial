/**
 * Levantamento SOMENTE-LEITURA de quantos produtos hoje ficam bloqueados pra
 * venda por falta de peso/dimensão — nem cadastrado no próprio produto, nem
 * coberto pelo padrão da loja (Config.pesoKgPadrao etc.). Ver
 * resolverDadosEnvioProduto em server.js pra a mesma lógica usada de verdade
 * na hora de cotar frete e criar pedido.
 *
 * Não escreve nada no banco. Só lê Produto e Config e imprime um relatório.
 *
 * Uso: node scripts/relatorio-produtos-sem-envio.js
 * Requer MONGODB_URI no .env (mesma variável que o server.js usa).
 */

if (!process.env.VERCEL) {
  require('dotenv').config();
}

const mongoose = require('mongoose');

const ProdutoSchema = new mongoose.Schema({
  nome: String,
  pesoKg: Number,
  larguraCm: Number,
  alturaCm: Number,
  comprimentoCm: Number
});
const ConfigSchema = new mongoose.Schema({
  pesoKgPadrao: Number,
  larguraCmPadrao: Number,
  alturaCmPadrao: Number,
  comprimentoCmPadrao: Number
});

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI não definido no .env — não é possível conectar.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const Produto = mongoose.model('Produto', ProdutoSchema);
  const Config = mongoose.model('Config', ConfigSchema);

  const cfg = await Config.findOne().lean();
  const padrao = {
    pesoKg: cfg?.pesoKgPadrao,
    larguraCm: cfg?.larguraCmPadrao,
    alturaCm: cfg?.alturaCmPadrao,
    comprimentoCm: cfg?.comprimentoCmPadrao
  };
  const campos = ['pesoKg', 'larguraCm', 'alturaCm', 'comprimentoCm'];
  const temPadraoCompleto = campos.every((k) => Number(padrao[k]) > 0);

  console.log('--- Padrão da loja (Config) ---');
  console.log(
    temPadraoCompleto
      ? `Configurado: ${padrao.pesoKg}kg, ${padrao.larguraCm}x${padrao.alturaCm}x${padrao.comprimentoCm}cm`
      : 'Não configurado (ou incompleto) — nenhum produto sem dado próprio será coberto por um padrão.'
  );
  console.log('');

  const produtos = await Produto.find().lean();
  const resolverCampo = (valorProduto, valorPadrao) => {
    const p = Number(valorProduto);
    if (Number.isFinite(p) && p > 0) return true;
    const d = Number(valorPadrao);
    return Number.isFinite(d) && d > 0;
  };

  const bloqueados = [];
  const usandoPadrao = [];
  let completos = 0;

  for (const p of produtos) {
    const temProprioCompleto = campos.every((k) => Number(p[k]) > 0);
    const podeVender = campos.every((k) => resolverCampo(p[k], padrao[k]));
    if (!podeVender) bloqueados.push(p.nome);
    else if (!temProprioCompleto) usandoPadrao.push(p.nome);
    else completos++;
  }

  console.log(`Total de produtos: ${produtos.length}`);
  console.log(`Com peso/dimensão próprios completos: ${completos}`);
  console.log(`Sem dado próprio, mas cobertos pelo padrão da loja: ${usandoPadrao.length}`);
  console.log(`BLOQUEADOS para venda (sem dado próprio nem padrão que cubra): ${bloqueados.length}`);

  if (usandoPadrao.length) {
    console.log('\n--- Usando padrão da loja ---');
    usandoPadrao.forEach((nome) => console.log('  - ' + nome));
  }
  if (bloqueados.length) {
    console.log('\n--- BLOQUEADOS ---');
    bloqueados.forEach((nome) => console.log('  - ' + nome));
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});

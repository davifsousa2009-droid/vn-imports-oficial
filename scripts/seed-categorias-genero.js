// Cria a estrutura Masculino/Feminino > Roupas/Joias aprovada na Fase 1/2
// do levantamento de categorias (ver histórico da conversa). Roda uma vez,
// manualmente — não faz parte do boot do servidor.
//
// NÃO mexe em Camisetas/Moletons nem nos produtos existentes (decisão do
// cliente: reorganização desses fica manual, depois). Idempotente: rodar
// de novo não duplica — pula qualquer categoria cujo slug já exista.
//
// Uso:
//   node scripts/seed-categorias-genero.js
// Requer MONGODB_URI no .env (mesma variável que o server.js usa).
if (!process.env.VERCEL) {
  require('dotenv').config();
}
const mongoose = require('mongoose');
const Category = require('../models/Category');

const ESTRUTURA = [
  {
    nome: 'Masculino', slug: 'masculino', tipo: 'outro', filhos: [
      { nome: 'Roupas', slug: 'roupas-masculino', tipo: 'roupa' },
      { nome: 'Joias', slug: 'joias-masculino', tipo: 'joia' },
    ]
  },
  {
    nome: 'Feminino', slug: 'feminino', tipo: 'outro', filhos: [
      { nome: 'Roupas', slug: 'roupas-feminino', tipo: 'roupa' },
      { nome: 'Joias', slug: 'joias-feminino', tipo: 'joia' },
    ]
  },
];

async function criarSePreciso(dados) {
  const existente = await Category.findOne({ slug: dados.slug });
  if (existente) {
    console.log(`  já existe, pulando: "${dados.nome}" (slug: ${dados.slug})`);
    return existente;
  }
  const criada = await Category.create(dados);
  console.log(`  criada: "${dados.nome}" (slug: ${dados.slug}, parent: ${dados.parent || 'null (topo)'})`);
  return criada;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado ao MongoDB.\n');

  for (const raiz of ESTRUTURA) {
    const paiDoc = await criarSePreciso({ nome: raiz.nome, slug: raiz.slug, tipo: raiz.tipo, parent: null });
    for (const filho of raiz.filhos) {
      await criarSePreciso({ nome: filho.nome, slug: filho.slug, tipo: filho.tipo, parent: paiDoc._id });
    }
  }

  console.log('\nConcluído. Árvore final:');
  const todas = await Category.find().sort({ nome: 1 }).lean();
  todas.forEach(c => {
    console.log(`  ${c.parent ? '  └─ ' : ''}${c.nome} (slug: ${c.slug}, tipo: ${c.tipo}, parent: ${c.parent || '—'})`);
  });

  await mongoose.disconnect();
})().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});

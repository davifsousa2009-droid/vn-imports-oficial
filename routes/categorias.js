const express = require('express');
const router = express.Router();

const Category = require('../models/Category');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected } = require('../utils/db');
const { slugifyNome } = require('../utils/slug');

router.get('/categories', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    let list = await Category.find().sort({ nome: 1 }).lean();
    if (!list.length) {
      await Category.create({ nome: 'Geral', slug: 'geral' });
      list = await Category.find().sort({ nome: 1 }).lean();
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar categorias', detalhe: err.message });
  }
});

// Árvore de categorias (consumida pelo Mega Menu do site e do produto).
// O schema de Category hoje é flat (sem campo "parent" — não existe UI de
// subcategoria no admin), então cada categoria vira uma raiz sem filhos;
// o front já trata "sem children" tornando o próprio título clicável.
router.get('/categories/tree', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Category.find().sort({ nome: 1 }).lean();
    const tree = list.map(c => ({ ...c, children: [] }));
    res.json(tree);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao montar árvore de categorias', detalhe: err.message });
  }
});

router.post('/categories', verificarJWT, async (req, res) => {

  if (!(await ensureDbConnected(res))) return;
  try {
    const nome = req.body.nome?.trim();
    if (!nome) return res.status(400).json({ erro: 'Nome da categoria é obrigatório' });
    const slug = req.body.slug?.trim() ? slugifyNome(req.body.slug) : slugifyNome(nome);
    const exists = await Category.findOne({ slug });
    if (exists) return res.status(409).json({ erro: 'Já existe uma categoria com este nome/slug.' });
    // tipo só é gravado quando é uma das 3 chaves conhecidas — um valor
    // arbitrário vindo direto da API (fora da UI do admin) é ignorado
    // silenciosamente e cai no default do schema ('outro'), em vez de
    // rejeitar a criação da categoria inteira por causa de um campo
    // secundário.
    const tiposValidos = ['roupa', 'joia', 'outro'];
    const dadosCategoria = { nome, slug };
    if (tiposValidos.includes(req.body.tipo)) dadosCategoria.tipo = req.body.tipo;
    const cat = await Category.create(dadosCategoria);
    res.status(201).json({ mensagem: 'Categoria criada!', categoria: cat });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ erro: 'Slug já cadastrado.' });
    res.status(500).json({ erro: 'Erro ao criar categoria', detalhe: err.message });
  }
});

// Só o campo `tipo` é editável por aqui, de propósito — nome/slug ficam de
// fora porque o slug é o que liga produto<->categoria (Produto.categoria
// guarda o slug, não um id), então editar o slug de uma categoria já usada
// silenciosamente "descolaria" todo produto que já a referencia. `tipo` não
// tem esse problema (não é referenciado em nenhum outro lugar do banco),
// então é seguro deixar editável sem essa restrição. Rota nova, motivada
// pelo rebrand navy: categorias criadas antes do campo `tipo` existir não
// ganham o default do schema retroativamente (Mongoose só aplica default na
// criação do documento) — sem esta rota, uma categoria antiga como "Joias"
// ficaria pra sempre com tipo ausente (cai em 'outro' no client), sem
// nenhuma forma de corrigir isso pelo painel.
router.put('/categories/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const tiposValidos = ['roupa', 'joia', 'outro'];
    if (!tiposValidos.includes(req.body.tipo)) {
      return res.status(400).json({ erro: 'Tipo inválido — use roupa, joia ou outro.' });
    }
    const atualizado = await Category.findByIdAndUpdate(
      req.params.id,
      { $set: { tipo: req.body.tipo } },
      { new: true, runValidators: true }
    );
    if (!atualizado) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ mensagem: 'Categoria atualizada!', categoria: atualizado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar categoria', detalhe: err.message });
  }
});

router.delete('/categories/:id', verificarJWT, async (req, res) => {

  if (!(await ensureDbConnected(res))) return;
  try {
    const removido = await Category.findByIdAndDelete(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ mensagem: 'Categoria removida!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover categoria', detalhe: err.message });
  }
});

module.exports = router;

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
// Monta a árvore de verdade a partir de `parent` agora — categoria sem
// parent (ou com parent apontando pra algo que não existe mais, ex:
// categoria-pai apagada) vira raiz; o resto entra em `children` da sua
// categoria-pai. O front (montarColunasMegaMenu em vn-nav.js,
// flattenCategoryTree em vn-filters-sort.js) só anda um nível dentro de
// children — profundidade maior que isso é bloqueada na escrita (POST/PUT
// abaixo), não aqui, mas a montagem em si suporta qualquer profundidade
// sem quebrar (só o que passar de 1 nível fica "invisível" pro front até
// a validação de escrita ser revista).
router.get('/categories/tree', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Category.find().sort({ nome: 1 }).lean();
    const byId = new Map(list.map((c) => [String(c._id), { ...c, children: [] }]));
    const roots = [];
    byId.forEach((cat) => {
      const paiId = cat.parent ? String(cat.parent) : null;
      if (paiId && byId.has(paiId)) {
        byId.get(paiId).children.push(cat);
      } else {
        roots.push(cat);
      }
    });
    res.json(roots);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao montar árvore de categorias', detalhe: err.message });
  }
});

// Valida um `parent` recebido em POST/PUT: undefined/null é sempre válido
// (categoria de topo). Quando informado, precisa apontar pra uma categoria
// que EXISTE e que ELA MESMA seja de topo (parent:null) — isso impede um
// 3º nível "por cima" (não dá pra pendurar em algo que já é filha de
// outra coisa). Um pai pode ter QUANTOS filhos quiser (Masculino com
// Roupas E Joias é o caso de uso normal) — não há limite de quantidade
// aqui, só de profundidade.
// Falta o lado inverso: se a categoria sendo editada (idProprioIgnorar) já
// tem filhos DELA MESMA, dar um pai a ela criaria um 3º nível "por baixo"
// (pai -> ela -> filhos dela) mesmo com o pai escolhido sendo válido — daí
// a checagem abaixo, só quando idProprioIgnorar existe (não se aplica em
// POST: categoria nova nunca tem filhos ainda). As duas condições juntas
// garantem que a árvore nunca passa de 2 níveis, o limite que o front hoje
// sabe desenhar (ver comentário em /categories/tree). `idProprioIgnorar`
// também evita que uma categoria seja pai dela mesma (relevante só no PUT).
async function validarParent(parentId, idProprioIgnorar) {
  if (parentId === undefined || parentId === null || parentId === '') return { ok: true, valor: null };
  if (idProprioIgnorar && String(parentId) === String(idProprioIgnorar)) {
    return { ok: false, erro: 'Uma categoria não pode ser pai dela mesma.' };
  }
  const pai = await Category.findById(parentId).lean();
  if (!pai) return { ok: false, erro: 'Categoria-pai não encontrada.' };
  if (pai.parent) return { ok: false, erro: 'A categoria-pai escolhida já é uma subcategoria — só categorias de topo podem ser escolhidas como pai.' };
  if (idProprioIgnorar) {
    const estaEditandoTemFilhos = await Category.exists({ parent: idProprioIgnorar });
    if (estaEditandoTemFilhos) {
      return { ok: false, erro: 'Esta categoria já tem subcategorias — uma categoria com subcategorias não pode virar filha de outra (limite de 2 níveis).' };
    }
  }
  return { ok: true, valor: pai._id };
}

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
    // parent, ao contrário de tipo, É rejeitado (não ignorado silenciosamente)
    // quando inválido — um parent errado quebraria a árvore/menu pro
    // visitante, diferente de um tipo errado (que só afeta o filtro de
    // medida daquela categoria). Ver validarParent acima.
    const parentCheck = await validarParent(req.body.parent);
    if (!parentCheck.ok) return res.status(400).json({ erro: parentCheck.erro });
    dadosCategoria.parent = parentCheck.valor;
    const cat = await Category.create(dadosCategoria);
    res.status(201).json({ mensagem: 'Categoria criada!', categoria: cat });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ erro: 'Slug já cadastrado.' });
    res.status(500).json({ erro: 'Erro ao criar categoria', detalhe: err.message });
  }
});

// Só `tipo` e `parent` são editáveis por aqui, de propósito — nome/slug
// ficam de fora porque o slug é o que liga produto<->categoria
// (Produto.categoria guarda o slug, não um id), então editar o slug de uma
// categoria já usada silenciosamente "descolaria" todo produto que já a
// referencia. Nem `tipo` nem `parent` têm esse problema (nenhum dos dois é
// referenciado fora de Category), então é seguro deixar os dois editáveis
// sem essa restrição.
// Os dois campos são INDEPENDENTES — o caller manda só o(s) que quer mudar
// (`tipo` in req.body / `parent` in req.body decide o que entra no $set),
// não precisa reenviar o outro. Isso é o que permite o seletor de "Tamanho
// de medida" (já existente) e o novo seletor de "Categoria pai" no admin
// funcionarem cada um no seu próprio <select>, sem um pisar no outro.
router.put('/categories/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const setar = {};
    if ('tipo' in req.body) {
      const tiposValidos = ['roupa', 'joia', 'outro'];
      if (!tiposValidos.includes(req.body.tipo)) {
        return res.status(400).json({ erro: 'Tipo inválido — use roupa, joia ou outro.' });
      }
      setar.tipo = req.body.tipo;
    }
    if ('parent' in req.body) {
      const parentCheck = await validarParent(req.body.parent, req.params.id);
      if (!parentCheck.ok) return res.status(400).json({ erro: parentCheck.erro });
      setar.parent = parentCheck.valor;
    }
    if (!Object.keys(setar).length) {
      return res.status(400).json({ erro: 'Nada para atualizar — envie tipo e/ou parent.' });
    }
    const atualizado = await Category.findByIdAndUpdate(
      req.params.id,
      { $set: setar },
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

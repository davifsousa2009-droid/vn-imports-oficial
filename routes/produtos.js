const express = require('express');
const router = express.Router();

const Produto = require('../models/Produto');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected } = require('../utils/db');
const { regexBuscaSemAcento, buscarPorSimilaridade } = require('../utils/busca');
const { deleteCloudinaryAssetIfApplicable } = require('../utils/cloudinary');

router.get('/produtos', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    // String(...) é essencial: sem isso, uma query string tipo
    // ?categoria[$ne]=null chega aqui como OBJETO ({$ne:'null'}), não texto —
    // um operador Mongo injetado direto no filtro (achado de auditoria).
    const categoriaQuery = req.query.categoria != null ? String(req.query.categoria) : '';
    const filtro = categoriaQuery ? { categoria: categoriaQuery } : {};
    const produtos = await Produto.find(filtro).sort({ createdAt: -1 });
    res.json(produtos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos', detalhe: err.message });
  }
});

// Precisa vir antes de '/produtos/:id' — senão o Express casa "search" como
// se fosse o :id, e o findById("search") quebra com CastError (500).
router.get('/produtos/search', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const q = String(req.query.q || '').trim();

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;

    let skip = parseInt(req.query.skip, 10);
    if (!Number.isFinite(skip) || skip < 0) {
      let page = parseInt(req.query.page, 10);
      if (!Number.isFinite(page) || page <= 0) page = 1;
      skip = (page - 1) * limit;
    }

    // $regex simples em vez de $text — evita depender de um índice de texto
    // que pode não existir na collection. "categoria" é o campo real do
    // schema de Produto (não existe "titulo") — buscar por categoria no
    // texto da busca só funciona se o filtro apontar pro campo certo.
    const termoBusca = q ? regexBuscaSemAcento(q) : '';
    const filtro = q
      ? {
          $or: [
            { nome: { $regex: termoBusca, $options: 'i' } },
            { categoria: { $regex: termoBusca, $options: 'i' } },
            { descricao: { $regex: termoBusca, $options: 'i' } },
            { palavrasChave: { $regex: termoBusca, $options: 'i' } }
          ]
        }
      : {};

    let produtos = await Produto.find(filtro).sort({ createdAt: -1 }).skip(skip).limit(limit);

    // Nada encontrado por trecho: tenta por similaridade (erro de digitação,
    // ex: "camsa"→"camisa") antes de devolver vazio. Só entra aqui quando a
    // busca por trecho já falhou — nunca mistura com resultado que já existe.
    if (q && produtos.length === 0) {
      produtos = await buscarPorSimilaridade(q, limit, skip);
    }

    res.json(produtos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/produtos/:id', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(produto);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produto', detalhe: err.message });
  }
});

// Lê peso/dimensão do corpo da requisição: vazio/ausente é válido (não
// bloqueia cadastro nem edição — ver decisão registrada no schema de
// Produto), null é o valor salvo pra "não preenchido"; só rejeita algo que
// não é número válido e positivo, pra não salvar NaN por engano.
function lerCampoEnvioOpcional(valor, rotulo) {
  if (valor === '' || valor == null) return { ok: true, valor: null };
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, erro: `${rotulo} inválido — use um número maior que zero, ou deixe em branco.` };
  return { ok: true, valor: n };
}

router.post('/produtos', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { nome, preco, precoOriginal, sizes, palavrasChave, pesoKg, larguraCm, alturaCm, comprimentoCm } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!preco || isNaN(preco)) return res.status(400).json({ erro: 'Preço inválido' });

    // precoOriginal vazio/null é válido (sem promoção); quando preenchido,
    // precisa ser um número positivo maior que `preco` — menor ou igual não
    // é desconto, é um valor sem sentido pro "de/por" da vitrine.
    let precoOriginalNormalizado = null;
    if (precoOriginal !== undefined && precoOriginal !== '' && precoOriginal !== null) {
      const po = Number(precoOriginal);
      if (!Number.isFinite(po) || po <= Number(preco)) {
        return res.status(400).json({ erro: 'Preço original inválido — deve ser maior que o preço atual, ou deixado em branco.' });
      }
      precoOriginalNormalizado = po;
    }

    // Garante que sizes/palavrasChave cheguem como array
    const normalizedSizes = Array.isArray(sizes)
      ? sizes.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const normalizedPalavrasChave = Array.isArray(palavrasChave)
      ? palavrasChave.map((s) => String(s).trim()).filter(Boolean)
      : [];

    const campos = {};
    for (const [chave, valor, rotulo] of [
      ['pesoKg', pesoKg, 'Peso'],
      ['larguraCm', larguraCm, 'Largura'],
      ['alturaCm', alturaCm, 'Altura'],
      ['comprimentoCm', comprimentoCm, 'Comprimento']
    ]) {
      const lido = lerCampoEnvioOpcional(valor, rotulo);
      if (!lido.ok) return res.status(400).json({ erro: lido.erro });
      campos[chave] = lido.valor;
    }

    const novo = new Produto({
      ...req.body,
      sizes: normalizedSizes,
      palavrasChave: normalizedPalavrasChave,
      precoOriginal: precoOriginalNormalizado,
      ...campos
    });

    await novo.save();
    res.status(201).json({ mensagem: 'Produto salvo!', produto: novo });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar', detalhe: err.message });
  }
});

router.put('/produtos/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { nome, preco, precoOriginal, imagem, imagens, descricao, categoria, estoque, sizes, palavrasChave, pesoKg, larguraCm, alturaCm, comprimentoCm } = req.body;

    // nome/preco são obrigatórios no schema, mas findByIdAndUpdate não roda
    // validators do Mongoose por padrão (só runValidators:true abaixo cobre o
    // resto) — sem checar isso explicitamente aqui, um nome/preço vazio no
    // corpo passaria direto e corrompia o produto sem erro nenhum.
    if (nome !== undefined && !String(nome).trim()) {
      return res.status(400).json({ erro: 'Nome é obrigatório' });
    }
    if (preco !== undefined && (preco === '' || preco == null || isNaN(preco))) {
      return res.status(400).json({ erro: 'Preço inválido' });
    }
    // precoOriginal:'' ou null é válido (apaga a promoção). Quando preenchido,
    // precisa ser número positivo. Só compara com `preco` quando os dois vêm
    // juntos no mesmo corpo (é o que o formulário do admin sempre faz) — sem
    // isso, validar contra o `preco` já salvo exigiria uma leitura extra no
    // banco antes do update; documentado aqui pra não ser "corrigido" à toa.
    let precoOriginalNormalizado;
    if (precoOriginal !== undefined) {
      if (precoOriginal === '' || precoOriginal == null) {
        precoOriginalNormalizado = null;
      } else {
        const po = Number(precoOriginal);
        if (!Number.isFinite(po) || po <= 0) {
          return res.status(400).json({ erro: 'Preço original inválido' });
        }
        if (preco !== undefined && po <= Number(preco)) {
          return res.status(400).json({ erro: 'Preço original inválido — deve ser maior que o preço atual, ou deixado em branco.' });
        }
        precoOriginalNormalizado = po;
      }
    }
    // estoque:'' e estoque:null são valores válidos (viram "sem controle de
    // estoque" abaixo) — só rejeita algo que não é número e também não é um
    // desses dois jeitos de dizer "sem controle". Sem isso, um chamador da API
    // fora do form (que sempre manda número ou null) podia mandar estoque:"abc"
    // e o Number(...) mais abaixo silenciosamente viraria NaN salvo no banco.
    if (estoque !== undefined && estoque !== '' && estoque !== null && isNaN(estoque)) {
      return res.status(400).json({ erro: 'Estoque inválido' });
    }
    // Peso/dimensão: vazio/null é válido de propósito (apaga o valor próprio
    // do produto e volta a depender do padrão da loja, ou fica bloqueado pra
    // venda se não houver padrão — ver resolverDadosEnvioProduto). Só rejeita
    // algo que não é um número positivo válido.
    const camposEnvio = {};
    for (const [chave, valor, rotulo] of [
      ['pesoKg', pesoKg, 'Peso'],
      ['larguraCm', larguraCm, 'Largura'],
      ['alturaCm', alturaCm, 'Altura'],
      ['comprimentoCm', comprimentoCm, 'Comprimento']
    ]) {
      if (valor === undefined) continue;
      const lido = lerCampoEnvioOpcional(valor, rotulo);
      if (!lido.ok) return res.status(400).json({ erro: lido.erro });
      camposEnvio[chave] = lido.valor;
    }

    // Allowlist explícita: só estes campos podem ser alterados por aqui — o
    // corpo da requisição nunca é repassado cru pro $set (era isso que deixava
    // QUALQUER chave arbitrária, incluindo campos que o formulário não conhecia,
    // sobrescrever o documento sem filtro nenhum).
    const dados = {};
    if (nome !== undefined) dados.nome = String(nome).trim();
    if (preco !== undefined) dados.preco = Number(preco);
    if (precoOriginal !== undefined) dados.precoOriginal = precoOriginalNormalizado;
    if (imagem !== undefined) dados.imagem = String(imagem || '').trim();
    if (descricao !== undefined) dados.descricao = String(descricao || '').trim();
    if (categoria !== undefined) dados.categoria = String(categoria || '').trim() || 'geral';
    // estoque:null é um valor válido e proposital (controle de estoque
    // desativado) — não tem ambiguidade aqui, então aplica direto.
    if (estoque !== undefined) dados.estoque = estoque === '' || estoque == null ? null : Number(estoque);

    // sizes/imagens: um array vazio aqui é ambíguo entre "quero apagar tudo" e
    // "quem mandou esse corpo nem sabia que este campo existe" — foi
    // exatamente essa ambiguidade que apagou os tamanhos de produtos editados
    // pelo painel (o formulário de edição não tinha campo de tamanho nenhum,
    // então sempre mandava sizes: []). Por segurança, um array vazio nunca
    // sobrescreve o que já está salvo — só um array com conteúdo de fato
    // substitui. Não existe hoje uma forma de esvaziar esses campos por esta
    // rota; se isso vier a ser necessário, use um sinal explícito e
    // inequívoco (não um array vazio) pra pedir a limpeza.
    if (Array.isArray(sizes) && sizes.length) {
      dados.sizes = sizes.map((s) => String(s).trim()).filter(Boolean);
    }
    if (Array.isArray(imagens) && imagens.length) {
      dados.imagens = imagens.map((s) => String(s).trim()).filter(Boolean);
    }
    // Mesmo cuidado de sizes/imagens acima.
    if (Array.isArray(palavrasChave) && palavrasChave.length) {
      dados.palavrasChave = palavrasChave.map((s) => String(s).trim()).filter(Boolean);
    }
    Object.assign(dados, camposEnvio);

    const atualizado = await Produto.findByIdAndUpdate(req.params.id, { $set: dados }, {
      new: true,
      runValidators: true
    });
    if (!atualizado) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ mensagem: 'Produto atualizado!', produto: atualizado });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: 'Dados inválidos', detalhe: err.message });
    }
    res.status(500).json({ erro: 'Erro ao atualizar', detalhe: err.message });
  }
});

router.delete('/produtos/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const removido = await Produto.findById(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Produto não encontrado' });
    await deleteCloudinaryAssetIfApplicable(removido.imagem);
    if (Array.isArray(removido.imagens)) {
      for (const url of removido.imagens) {
        await deleteCloudinaryAssetIfApplicable(url);
      }
    }
    await Produto.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Produto removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover', detalhe: err.message });
  }
});

module.exports = router;

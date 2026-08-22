const express = require('express');
const router = express.Router();

const Banner = require('../models/Banner');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected } = require('../utils/db');
const { deleteCloudinaryAssetIfApplicable } = require('../utils/cloudinary');

router.get('/banners', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Banner.find().sort({ ordem: 1, createdAt: 1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar banners', detalhe: err.message });
  }
});

router.post('/banners', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const imagem = req.body.imagem?.trim();
    if (!imagem) return res.status(400).json({ erro: 'Imagem é obrigatória (faça upload no admin).' });
    const ordem = Number.parseInt(req.body.ordem, 10);
    const banner = await Banner.create({
      imagem,
      ordem: Number.isFinite(ordem) ? ordem : 0,
      eyebrow: String(req.body.eyebrow || '').trim(),
      titulo: String(req.body.titulo || '').trim(),
      subtitulo: String(req.body.subtitulo || '').trim(),
      textoBotao: String(req.body.textoBotao || '').trim(),
      linkBotao: String(req.body.linkBotao || '').trim()
    });
    res.status(201).json({ mensagem: 'Banner salvo!', banner });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar banner', detalhe: err.message });
  }
});

// Allowlist explícita (mesmo padrão de routes/produtos.js): só os campos
// abaixo podem ser alterados por aqui, e cada um só é tocado se vier
// explicitamente no corpo — permite editar só a ordem (usado pra reordenar
// na próxima parte) sem precisar reenviar imagem/textos, e vice-versa.
router.put('/banners/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { imagem, ordem, eyebrow, titulo, subtitulo, textoBotao, linkBotao } = req.body;

    const dados = {};
    if (imagem !== undefined) {
      const img = String(imagem || '').trim();
      if (!img) return res.status(400).json({ erro: 'Imagem não pode ficar vazia.' });
      dados.imagem = img;
    }
    if (ordem !== undefined) {
      const o = Number.parseInt(ordem, 10);
      if (!Number.isFinite(o)) return res.status(400).json({ erro: 'Ordem inválida' });
      dados.ordem = o;
    }
    if (eyebrow !== undefined) dados.eyebrow = String(eyebrow || '').trim();
    if (titulo !== undefined) dados.titulo = String(titulo || '').trim();
    if (subtitulo !== undefined) dados.subtitulo = String(subtitulo || '').trim();
    if (textoBotao !== undefined) dados.textoBotao = String(textoBotao || '').trim();
    if (linkBotao !== undefined) dados.linkBotao = String(linkBotao || '').trim();

    const atualizado = await Banner.findByIdAndUpdate(req.params.id, { $set: dados }, {
      new: true,
      runValidators: true
    });
    if (!atualizado) return res.status(404).json({ erro: 'Banner não encontrado' });
    res.json({ mensagem: 'Banner atualizado!', banner: atualizado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar banner', detalhe: err.message });
  }
});

router.delete('/banners/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const removido = await Banner.findById(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Banner não encontrado' });
    await deleteCloudinaryAssetIfApplicable(removido.imagem);
    await Banner.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Banner removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover banner', detalhe: err.message });
  }
});

module.exports = router;

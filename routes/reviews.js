const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const Review = require('../models/Review');
const Order = require('../models/Order');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected } = require('../utils/db');

const reviewsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas avaliações em pouco tempo. Aguarde alguns minutos.' }
});

router.post('/reviews', reviewsLimiter, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const nome = req.body?.nome?.trim ? req.body.nome.trim() : '';
    const comentario = req.body?.comentario?.trim ? req.body.comentario.trim() : '';
    const estrelasRaw = req.body?.estrelas;
    const estrelas = typeof estrelasRaw === 'number' ? estrelasRaw : Number(estrelasRaw);

    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório.' });
    if (!comentario) return res.status(400).json({ erro: 'Comentário é obrigatório.' });
    if (!Number.isFinite(estrelas) || estrelas < 1 || estrelas > 5) {
      return res.status(400).json({ erro: 'Estrelas devem ser um número entre 1 e 5.' });
    }

    const review = await Review.create({ nome, comentario, estrelas, aprovado: false });
    res.status(201).json({ mensagem: 'Avaliação recebida! Aguardando aprovação.', review });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar avaliação', detalhe: err.message });
  }
});

router.get('/reviews/public', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Review.find({ aprovado: true })
      .sort({ data: -1, createdAt: -1 })
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar avaliações', detalhe: err.message });
  }
});

// Estatística pública e real de clientes (conta pedidos com pagamento confirmado —
// não é fórmula inventada, é dado de verdade do banco).
router.get('/stats/clientes', async (req, res) => {
  if (!(await ensureDbConnected(res))) return res.json({ clientes: 0 });
  try {
    const distintos = await Order.distinct('customerName', { status: 'Pago' });
    const clientes = distintos.filter((n) => n && String(n).trim()).length;
    res.json({ clientes });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao calcular estatística', detalhe: err.message });
  }
});

router.get('/admin/reviews', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Review.find().sort({ data: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar avaliações (admin)', detalhe: err.message });
  }
});

router.put('/admin/reviews/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const updated = await Review.findByIdAndUpdate(req.params.id, { aprovado: true }, { new: true });
    if (!updated) return res.status(404).json({ erro: 'Avaliação não encontrada' });
    res.json({ mensagem: 'Avaliação aprovada!', review: updated });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar avaliação', detalhe: err.message });
  }
});

router.delete('/admin/reviews/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const removed = await Review.findById(req.params.id);
    if (!removed) return res.status(404).json({ erro: 'Avaliação não encontrada' });
    await Review.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Avaliação removida!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover avaliação', detalhe: err.message });
  }
});

module.exports = router;

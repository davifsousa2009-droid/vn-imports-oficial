// ═══════════════════════════════════════════════════════
//   VN IMPORTS — server.js
//   ✅ Compatível com Vercel (Serverless) e localhost
// ═══════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');

const app = express();

// ── MIDDLEWARES ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve arquivos estáticos apenas fora da Vercel
// (na Vercel os HTMLs ficam na raiz e são servidos automaticamente)
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}

// ── CONEXÃO COM MONGODB ────────────────────────────────
// Reutiliza a conexão entre chamadas serverless (importante na Vercel)
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
  console.log('✅ MongoDB conectado!');
}

// Conecta ao iniciar (funciona tanto local quanto Vercel)
connectDB().catch(err => {
  console.error('❌ Erro MongoDB:', err.message);
});

// ── MIDDLEWARE DE SEGURANÇA ────────────────────────────
const verificarSenha = (req, res, next) => {
  const senhaRecebida = req.headers['x-admin-password'];
  // Lê do .env — sem fallback hardcoded para evitar conflito de senhas
  const senhaMestra   = process.env.ADMIN_PASSWORD;

  if (!senhaMestra) {
    // .env não carregou corretamente
    console.error('❌ ADMIN_PASSWORD não encontrada no .env');
    return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
  }

  // .trim() remove espaços invisíveis que surgem ao copiar/colar senhas
  if (senhaRecebida?.trim() === senhaMestra.trim()) {
    next();
  } else {
    console.warn(`⚠️ Acesso negado — recebida: "${senhaRecebida}" | esperada: "${senhaMestra}"`);
    res.status(401).json({ erro: 'Senha incorreta ou não fornecida.' });
  }
};

// ── MODEL DO PRODUTO ───────────────────────────────────
const produtoSchema = new mongoose.Schema({
  nome:      { type: String, required: true },
  preco:     { type: Number, required: true },
  imagem:    { type: String, default: '' },
  descricao: { type: String, default: '' },
  categoria: { type: String, default: 'geral' },
  estoque:   { type: Number, default: 0 }
}, { timestamps: true });

// Evita erro "Cannot overwrite model" em ambiente serverless
const Produto = mongoose.models.Produto || mongoose.model('Produto', produtoSchema);

// ══════════════════════════════════════════════════════
//   ROTAS DA API
// ══════════════════════════════════════════════════════

// GET /api/status — painel admin usa para checar conexão
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    banco: mongoose.connection.readyState === 1 ? 'conectado' : 'desconectado',
    hora: new Date().toLocaleString('pt-BR')
  });
});

// GET /api/produtos — pública (vitrine usa)
app.get('/api/produtos', async (req, res) => {
  try {
    await connectDB();
    const filtro = req.query.categoria ? { categoria: req.query.categoria } : {};
    const produtos = await Produto.find(filtro).sort({ createdAt: -1 });
    res.json(produtos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos', detalhe: err.message });
  }
});

// GET /api/produtos/:id — pública
app.get('/api/produtos/:id', async (req, res) => {
  try {
    await connectDB();
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(produto);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produto', detalhe: err.message });
  }
});

// POST /api/produtos — protegida
app.post('/api/produtos', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const { nome, preco } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!preco || isNaN(preco)) return res.status(400).json({ erro: 'Preço inválido' });
    const novo = new Produto(req.body);
    await novo.save();
    res.status(201).json({ mensagem: 'Produto salvo!', produto: novo });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar', detalhe: err.message });
  }
});

// PUT /api/produtos/:id — protegida
app.put('/api/produtos/:id', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const atualizado = await Produto.findByIdAndUpdate(
      req.params.id, req.body, { new: true }
    );
    if (!atualizado) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ mensagem: 'Produto atualizado!', produto: atualizado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar', detalhe: err.message });
  }
});

// DELETE /api/produtos/:id — protegida
app.delete('/api/produtos/:id', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const removido = await Produto.findByIdAndDelete(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ mensagem: 'Produto removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover', detalhe: err.message });
  }
});

// ── INICIAR SERVIDOR (apenas localmente) ──────────────
// Na Vercel o app.listen() é ignorado — quem controla é o module.exports
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor em http://localhost:${PORT}`);
    console.log(`🛍️  Loja:   http://localhost:${PORT}/VN_IMPORTS.html`);
    console.log(`📦 Admin:  http://localhost:${PORT}/admin.html`);
    console.log(`🔌 API:    http://localhost:${PORT}/api/produtos`);
  });
}

// ✅ OBRIGATÓRIO para a Vercel funcionar
module.exports = app;

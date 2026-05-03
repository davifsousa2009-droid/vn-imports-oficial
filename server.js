require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');

const app = express();

// ── MIDDLEWARES ────────────────────────────────────────
app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}

// ── CONEXÃO COM MONGODB (CORRIGIDA) ────────────────────
let isConnected = false;

async function connectDB() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,  // ✅ Falha rápido se DNS falhar
      socketTimeoutMS: 45000,           // ✅ Mais tempo que Vercel (30s)
      connectTimeoutMS: 10000,          // ✅ Timeout de handshake
      retryWrites: true,
      w: 'majority',
      maxPoolSize: 1,                   // ✅ Serverless precisa de pool pequeno
      minPoolSize: 0,
    });

    isConnected = true;
    console.log('✅ MongoDB conectado');
  } catch (err) {
    isConnected = false;
    console.error('❌ MongoDB erro:', err.message);
    throw err;
  }
}

// ✅ Conecta ANTES de qualquer requisição na Vercel
if (process.env.NODE_ENV === 'production') {
  connectDB().catch(console.error);
} else {
  connectDB().catch(err => {
    console.error('❌ Erro initial MongoDB:', err.message);
  });
}

// ── MIDDLEWARE DE SEGURANÇA ────────────────────────────
const verificarSenha = (req, res, next) => {
  const senhaRecebida = req.headers['x-admin-password'];
  const senhaMestra   = process.env.ADMIN_PASSWORD;

  if (!senhaMestra) {
    console.error('❌ ADMIN_PASSWORD não configurada');
    return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
  }

  if (senhaRecebida?.trim() === senhaMestra.trim()) {
    next();
  } else {
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

const Produto = mongoose.models.Produto || mongoose.model('Produto', produtoSchema);

// ══════════════════════════════════════════════════════
//   ROTAS DA API
// ══════════════════════════════════════════════════════

// GET /api/status
app.get('/api/status', async (req, res) => {
  try {
    await connectDB();
    const estado = mongoose.connection.readyState;
    res.json({
      status: 'online',
      banco: estado === 1 ? 'conectado' : `desconectado (${estado})`,
      isConnected,
      hora: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    res.json({
      status: 'online',
      banco: 'erro',
      erro: err.message
    });
  }
});

// GET /api/produtos
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

// GET /api/produtos/:id
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

// POST /api/produtos
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

// PUT /api/produtos/:id
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

// DELETE /api/produtos/:id
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

// --- CONFIGURAÇÃO DA LOJA ---
const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: 'VN IMPORTS' }
});

// Corrigido para "mongoose" com N e verificação de modelo existente (Vercel)
const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

// Rota pública para o site ler o nome
app.get('/api/config', async (req, res) => {
  try {
    await connectDB();
    let cfg = await Config.findOne();
    if (!cfg) cfg = await Config.create({ nomeLoja: 'VN IMPORTS' });
    res.json(cfg);
  } catch (err) { 
    res.status(500).json({ erro: err.message }); 
  }
});

// Rota protegida para o admin salvar o nome
app.post('/api/config', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const { nomeLoja } = req.body;
    // Salva ou cria se não existir
    const atualizado = await Config.findOneAndUpdate({}, { nomeLoja }, { upsert: true, new: true });
    res.json({ mensagem: 'Nome da loja atualizado!', config: atualizado });
  } catch (err) { 
    res.status(500).json({ erro: err.message }); 
  }
});

// ── INICIAR SERVIDOR (LOCAL)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
  });
}

module.exports = app;

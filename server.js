// ═══════════════════════════════════════════════════════
//   VN IMPORTS — server.js (SEGURANÇA TURBINADA 🛡️)
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── CONEXÃO COM MONGODB ───────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado com sucesso!'))
  .catch(err => {
    console.error('❌ Erro ao conectar no MongoDB:', err.message);
    process.exit(1);
  });

// --- BLOCO DE SEGURANÇA (AUTENTICAÇÃO) ---
const verificarSenha = (req, res, next) => {
  const senhaRecebida = req.headers['x-admin-password'];
  // Sem aspas, para ele usar o valor que vem do .env ou o padrão
  const senhaMestra = process.env.ADMIN_PASSWORD || "DaviVNI2024";

  console.log(`--- Tentativa de Acesso ---`);
  console.log(`Recebida: ${senhaRecebida}`);
  console.log(`Esperada: ${senhaMestra}`);

  if (senhaRecebida === senhaMestra) {
    console.log("✅ Senha correta!");
    next();
  } else {
    console.log("❌ Senha incorreta!");
    res.status(401).json({ erro: 'Senha incorreta ou não fornecida.' });
  }
};

// ── MODEL DO PRODUTO ──────────────────────────────────
const Produto = mongoose.model('Produto', new mongoose.Schema({
  nome:      { type: String, required: true },
  preco:     { type: Number, required: true },
  imagem:    { type: String, default: '' },
  descricao: { type: String, default: '' },
  categoria: { type: String, default: 'geral' },
  estoque:   { type: Number, default: 0 }
}, { timestamps: true }));

// ══════════════════════════════════════════════════════
//   ROTAS DA API
// ══════════════════════════════════════════════════════

app.get('/api/produtos', async (req, res) => {
  try {
    const produtos = await Produto.find().sort({ createdAt: -1 });
    res.json(produtos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos' });
  }
});

// 🔒 ROTAS PROTEGIDAS (Só funcionam com a senha)
app.post('/api/produtos', verificarSenha, async (req, res) => {
  try {
    const novo = new Produto(req.body);
    await novo.save();
    res.status(201).json({ mensagem: 'Produto salvo!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar' });
  }
});

app.put('/api/produtos/:id', verificarSenha, async (req, res) => {
  try {
    await Produto.findByIdAndUpdate(req.params.id, req.body);
    res.json({ mensagem: 'Produto atualizado!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar' });
  }
});

app.delete('/api/produtos/:id', verificarSenha, async (req, res) => {
  try {
    await Produto.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Produto removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover' });
  }
});

// ── GET /api/status — verifica saúde do servidor (usado pelo painel admin)
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    banco: mongoose.connection.readyState === 1 ? 'conectado' : 'desconectado',
    hora: new Date().toLocaleString('pt-BR')
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor voando em http://localhost:${PORT}`);
});
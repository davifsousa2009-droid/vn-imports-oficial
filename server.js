require('dotenv').config();
// Upload de imagens: Cloudinary (defina CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET na Vercel e no .env local).

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && /^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas arquivos de imagem são permitidos.'));
  }
});

/** Extrai public_id a partir da secure_url padrão do Cloudinary (upload sem transformações). */
function cloudinaryPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || !url.includes(`res.cloudinary.com/${cloud}/`)) return null;
  const m = url.match(/\/(?:image|raw)\/upload\/(?:v\d+\/)?(.+)$/i);
  if (!m) return null;
  let rest = m[1];
  const dot = rest.lastIndexOf('.');
  if (dot > 0) rest = rest.slice(0, dot);
  return rest || null;
}

async function deleteCloudinaryAssetIfApplicable(url) {
  const publicId = cloudinaryPublicIdFromUrl(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, undefined, { resource_type: 'image' });
  } catch (e) {
    console.warn('Cloudinary destroy:', e.message);
  }
}

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
    console.log('MongoDB conectado');
  } catch (err) {
    isConnected = false;
    console.error('MongoDB erro:', err.message);
    throw err;
  }
}

// ✅ Conecta ANTES de qualquer requisição na Vercel
if (process.env.NODE_ENV === 'production') {
  connectDB().catch(console.error);
} else {
  connectDB().catch(err => {
    console.error('Erro initial MongoDB:', err.message);
  });
}

// ── MIDDLEWARE DE SEGURANÇA ────────────────────────────
const verificarSenha = (req, res, next) => {
  const senhaRecebida = req.headers['x-admin-password'];
  const senhaMestra   = process.env.ADMIN_PASSWORD;

  if (!senhaMestra) {
    console.error('ADMIN_PASSWORD não configurada');
    return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
  }

  if (senhaRecebida?.trim() === senhaMestra.trim()) {
    next();
  } else {
    res.status(401).json({ erro: 'Senha incorreta ou não fornecida.' });
  }
};

// POST /api/upload — admin envia imagem; sobe para Cloudinary e retorna secure_url (campo path para compatibilidade com o admin)
app.post('/api/upload', verificarSenha, (req, res) => {
  const missing =
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET;
  if (missing) {
    return res.status(503).json({
      erro: 'Cloudinary não configurado. Defina CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET no ambiente.'
    });
  }

  uploadMem.single('arquivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ erro: err.message || 'Erro no upload.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    }
    try {
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      const result = await cloudinary.uploader.upload(dataUri, undefined, {
        folder: 'vn-imports',
        resource_type: 'image',
        unique_filename: true
      });
      const secureUrl = result.secure_url;
      res.status(201).json({ path: secureUrl, mensagem: 'Upload concluído.' });
    } catch (e) {
      console.error('Cloudinary upload:', e.message);
      res.status(500).json({ erro: e.message || 'Erro ao enviar imagem para o Cloudinary.' });
    }
  });
});

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

// ── MODEL CATEGORIA ───────────────────────────────────
function slugifyNome(nome) {
  const s = String(nome)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'categoria';
}

const CategorySchema = new mongoose.Schema({
  nome: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true }
}, { timestamps: true });

const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);

// ── MODEL BANNER (carousel vitrine) ───────────────────
const BannerSchema = new mongoose.Schema({
  imagem: { type: String, required: true, trim: true },
  ordem:  { type: Number, default: 0 }
}, { timestamps: true });

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);

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
    const removido = await Produto.findById(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Produto não encontrado' });
    await deleteCloudinaryAssetIfApplicable(removido.imagem);
    await Produto.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Produto removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover', detalhe: err.message });
  }
});

// GET /api/categories — lista (público; garante ao menos "Geral" se vazio)
app.get('/api/categories', async (req, res) => {
  try {
    await connectDB();
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

// POST /api/categories — criar (admin)
app.post('/api/categories', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const nome = req.body.nome?.trim();
    if (!nome) return res.status(400).json({ erro: 'Nome da categoria é obrigatório' });
    const slug = req.body.slug?.trim()
      ? slugifyNome(req.body.slug)
      : slugifyNome(nome);
    const exists = await Category.findOne({ slug });
    if (exists) return res.status(409).json({ erro: 'Já existe uma categoria com este nome/slug.' });
    const cat = await Category.create({ nome, slug });
    res.status(201).json({ mensagem: 'Categoria criada!', categoria: cat });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ erro: 'Slug já cadastrado.' });
    }
    res.status(500).json({ erro: 'Erro ao criar categoria', detalhe: err.message });
  }
});

// DELETE /api/categories/:id — remover (admin)
app.delete('/api/categories/:id', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const removido = await Category.findByIdAndDelete(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ mensagem: 'Categoria removida!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover categoria', detalhe: err.message });
  }
});

// GET /api/banners — listar (público), ordenado por ordem
app.get('/api/banners', async (req, res) => {
  try {
    await connectDB();
    const list = await Banner.find().sort({ ordem: 1, createdAt: 1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar banners', detalhe: err.message });
  }
});

// POST /api/banners — criar (admin)
app.post('/api/banners', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const imagem = req.body.imagem?.trim();
    if (!imagem) return res.status(400).json({ erro: 'Imagem é obrigatória (faça upload no admin).' });
    const ordem = Number.parseInt(req.body.ordem, 10);
    const banner = await Banner.create({
      imagem,
      ordem: Number.isFinite(ordem) ? ordem : 0
    });
    res.status(201).json({ mensagem: 'Banner salvo!', banner });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar banner', detalhe: err.message });
  }
});

// DELETE /api/banners/:id — remover (admin)
app.delete('/api/banners/:id', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const removido = await Banner.findById(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Banner não encontrado' });
    await deleteCloudinaryAssetIfApplicable(removido.imagem);
    await Banner.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Banner removido!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover banner', detalhe: err.message });
  }
});

// --- CONFIGURAÇÃO DA LOJA ---
const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: 'VN IMPORTS' },
  chavePix: { type: String, default: '' }
});

const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

// Rota pública para o site ler nome da loja e chave PIX (vitrine / checkout)
app.get('/api/config', async (req, res) => {
  try {
    await connectDB();
    let cfg = await Config.findOne();
    if (!cfg) {
      cfg = await Config.create({ nomeLoja: 'VN IMPORTS', chavePix: '' });
    }
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Rota protegida para o admin salvar configurações
app.post('/api/config', verificarSenha, async (req, res) => {
  try {
    await connectDB();
    const { nomeLoja, chavePix } = req.body;
    const dados = { nomeLoja: nomeLoja?.trim() || 'VN IMPORTS' };
    if (chavePix !== undefined) {
      dados.chavePix = String(chavePix).trim();
    }
    const atualizado = await Config.findOneAndUpdate(
      {},
      dados,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ mensagem: 'Configuração atualizada!', config: atualizado });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── INICIAR SERVIDOR (LOCAL)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
}

// ── SERVIR OS HTMLS (obrigatório na Vercel) ────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'VN_IMPORTS.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/VN_IMPORTS.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'VN_IMPORTS.html'));
});

// ── INICIAR SERVIDOR (LOCAL) ───────────────────────────

module.exports = app;

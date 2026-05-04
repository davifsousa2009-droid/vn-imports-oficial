require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const shopConfig = require('./shopConfig');

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

try {
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
  }
} catch (e) {
  console.error('Cloudinary config:', e.message);
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

// ── CONEXÃO COM MONGODB ────────────────────────────────
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
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      maxPoolSize: 1,
      minPoolSize: 0
    });

    isConnected = true;
    console.log('MongoDB conectado');
  } catch (err) {
    isConnected = false;
    console.error('MongoDB erro:', err.message);
    throw err;
  }
}

/** Tenta conectar sem enviar resposta HTTP (útil para GET públicos como /api/config). */
async function tryConnectDb() {
  try {
    await connectDB();
    return mongoose.connection.readyState === 1;
  } catch (err) {
    console.warn('MongoDB:', err.message);
    return false;
  }
}

/** Evita 500 genérico: responde 503 se URI/chave estiver incorreta ou rede falhar. */
async function ensureDbConnected(res) {
  try {
    await connectDB();
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return false;
    }
    return true;
  } catch (err) {
    console.error('MongoDB:', err.message);
    res.status(503).json({
      erro: 'Não foi possível conectar ao banco de dados.',
      detalhe: err.message
    });
    return false;
  }
}

if (process.env.NODE_ENV === 'production') {
  connectDB().catch((e) => console.error('MongoDB (startup):', e.message));
} else {
  connectDB().catch((err) => {
    console.error('Erro initial MongoDB:', err.message);
  });
}

// ── LOGIN (rate limit: contagem por IP só em falhas) ───
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde alguns minutos.' }
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const senhaMestra = process.env.ADMIN_PASSWORD;
  if (!senhaMestra) {
    console.error('ADMIN_PASSWORD não configurada');
    return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('JWT_SECRET não configurada');
    return res.status(500).json({ erro: 'JWT_SECRET não configurada no servidor.' });
  }

  const senha = String(req.body?.senha ?? '').trim();
  if (senha !== senhaMestra.trim()) {
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }

  const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: '8h' });
  res.json({ token, expiresIn: '8h' });
});

function verificarJWT(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ erro: 'JWT_SECRET não configurada no servidor.' });
  }
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido. Faça login no painel.' });
  }
  try {
    jwt.verify(token, secret);
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

const verificarSenha = (req, res, next) => {
  const senhaRecebida = req.headers['x-admin-password'];
  const senhaMestra = process.env.ADMIN_PASSWORD;

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
      res.status(503).json({ erro: e.message || 'Erro ao enviar imagem para o Cloudinary.' });
    }
  });
});

// ── MODEL DO PRODUTO ───────────────────────────────────
const produtoSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true },
    preco: { type: Number, required: true },
    imagem: { type: String, default: '' },
    descricao: { type: String, default: '' },
    categoria: { type: String, default: 'geral' },
    estoque: { type: Number, default: 0 }
  },
  { timestamps: true }
);

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

const CategorySchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true }
  },
  { timestamps: true }
);

const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);

// ── MODEL BANNER (carousel vitrine) ───────────────────
const BannerSchema = new mongoose.Schema(
  {
    imagem: { type: String, required: true, trim: true },
    ordem: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);

// ══════════════════════════════════════════════════════
//   ROTAS DA API
// ══════════════════════════════════════════════════════

// GET /api/status
app.get('/api/status', async (req, res) => {
  const ok = await tryConnectDb();
  const estado = mongoose.connection.readyState;
  res.json({
    status: 'online',
    banco: ok && estado === 1 ? 'conectado' : `desconectado (${estado})`,
    isConnected: ok && estado === 1,
    hora: new Date().toLocaleString('pt-BR')
  });
});

// GET /api/produtos
app.get('/api/produtos', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const filtro = req.query.categoria ? { categoria: req.query.categoria } : {};
    const produtos = await Produto.find(filtro).sort({ createdAt: -1 });
    res.json(produtos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos', detalhe: err.message });
  }
});

// GET /api/produtos/:id
app.get('/api/produtos/:id', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(produto);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produto', detalhe: err.message });
  }
});

// POST /api/produtos
app.post('/api/produtos', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
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
app.put('/api/produtos/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const atualizado = await Produto.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!atualizado) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ mensagem: 'Produto atualizado!', produto: atualizado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar', detalhe: err.message });
  }
});

// DELETE /api/produtos/:id
app.delete('/api/produtos/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
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

// POST /api/categories — criar (admin)
app.post('/api/categories', verificarSenha, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const nome = req.body.nome?.trim();
    if (!nome) return res.status(400).json({ erro: 'Nome da categoria é obrigatório' });
    const slug = req.body.slug?.trim() ? slugifyNome(req.body.slug) : slugifyNome(nome);
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
  if (!(await ensureDbConnected(res))) return;
  try {
    const removido = await Category.findByIdAndDelete(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ mensagem: 'Categoria removida!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover categoria', detalhe: err.message });
  }
});

// GET /api/banners — listar (público), ordenado por ordem
app.get('/api/banners', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Banner.find().sort({ ordem: 1, createdAt: 1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar banners', detalhe: err.message });
  }
});

// POST /api/banners — criar (admin)
app.post('/api/banners', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
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
app.delete('/api/banners/:id', verificarJWT, async (req, res) => {
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

// --- CONFIGURAÇÃO DA LOJA ---
const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: shopConfig.nomeLoja },
  chavePix: { type: String, default: '' }
});

const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

function mergePublicConfig(doc) {
  const nomeDb = doc?.nomeLoja?.trim();
  const pixDb = doc?.chavePix != null ? String(doc.chavePix).trim() : '';
  return {
    nomeLoja: nomeDb || shopConfig.nomeLoja,
    chavePix: pixDb || (shopConfig.chavePix || '').trim(),
    colors: shopConfig.colors || {},
    pageTitleSuffix: shopConfig.pageTitleSuffix || 'Moda Premium'
  };
}

// Rota pública para o site ler nome da loja, PIX e tema (shopConfig + Mongo)
app.get('/api/config', async (req, res) => {
  let doc = null;
  if (await tryConnectDb()) {
    try {
      doc = await Config.findOne();
      if (!doc) {
        doc = await Config.create({
          nomeLoja: shopConfig.nomeLoja,
          chavePix: shopConfig.chavePix || ''
        });
      }
    } catch (e) {
      console.warn('GET /api/config:', e.message);
    }
  }
  res.json(mergePublicConfig(doc));
});

// Rota protegida para o admin salvar configurações
app.post('/api/config', verificarSenha, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { nomeLoja, chavePix } = req.body;
    const dados = { nomeLoja: nomeLoja?.trim() || shopConfig.nomeLoja };
    if (chavePix !== undefined) {
      dados.chavePix = String(chavePix).trim();
    }
    const atualizado = await Config.findOneAndUpdate({}, dados, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });
    res.json({ mensagem: 'Configuração atualizada!', config: mergePublicConfig(atualizado) });
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

const lojaHtml = path.join(__dirname, 'VN_IMPORTS.html');

// ── SERVIR OS HTMLS (obrigatório na Vercel) ────────────
app.get('/', (req, res) => {
  res.sendFile(lojaHtml);
});

app.get('/index.html', (req, res) => {
  res.sendFile(lojaHtml);
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/VN_IMPORTS.html', (req, res) => {
  res.sendFile(lojaHtml);
});

// Arquivos estáticos por último (evita index.html na raiz roubar GET /)
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}

module.exports = app;

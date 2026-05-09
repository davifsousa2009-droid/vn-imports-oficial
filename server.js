// Local: carrega .env com dotenv. Na Vercel (VERCEL definido) NUNCA usamos dotenv —
// JWT_SECRET e demais chaves vêm só de process.env (painel Project → Environment Variables).
if (!process.env.VERCEL) {
  require('dotenv').config();
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const shopConfig = require('./config');
const Review = require('./models/Review');

/** Normaliza valor de JWT vindo do painel (.trim(), BOM, aspas externas opcionais). */
function normalizeJwtEnvValue(raw) {
  if (raw == null) return '';
  let s = String(raw).trim().replace(/^\uFEFF/, '');
  if (!s) return '';
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || '';
}

/** Compara UTF-8 em tempo constante; não usa .trim() — preserva espaços/caracteres da senha. */
function timingSafePasswordEqual(secretA, secretB) {
  const b1 = Buffer.from(secretA ?? '', 'utf8');
  const b2 = Buffer.from(secretB ?? '', 'utf8');
  if (b1.length !== b2.length) return false;
  if (b1.length === 0) return false;
  return crypto.timingSafeEqual(b1, b2);
}

/** Último recurso se JWT_SECRET falhar — valor público; troque e remova assim que env estiver estável na Vercel. */
const JWT_HARDCODED_TEST_FALLBACK =
  'vn-imports-TEMP-JWT-HARDCODED-remove-after-env-fixed';

let jwtSecretCache = '';
let jwtSourceLoggedLabel = '';

function invalidateJwtSecretCache() {
  jwtSecretCache = '';
  jwtSourceLoggedLabel = '';
}

/** Ordem: JWT_SECRET → JWT_SECRET_FALLBACK (painel alternativo) → literal de teste. */
function resolveJwtSecretWithSourceOnce() {
  const fromJwt = normalizeJwtEnvValue(process.env.JWT_SECRET);
  if (fromJwt)
    return { secret: fromJwt, sourceLabel: 'process.env.JWT_SECRET' };

  const fromFb = normalizeJwtEnvValue(process.env.JWT_SECRET_FALLBACK);
  if (fromFb)
    return {
      secret: fromFb,
      sourceLabel:
        'process.env.JWT_SECRET_FALLBACK (duplique valor em JWT_SECRET no painel e remova FALLBACK)'
    };

  console.error(
    '[jwt] JWT_SECRET vazio → usando JWT_HARDCODED_TEST_FALLBACK (defina JWT_SECRET na Vercel e redeploy)'
  );
  return {
    secret: JWT_HARDCODED_TEST_FALLBACK,
    sourceLabel: 'HARDCODED_TEST_FALLBACK — não use em produção'
  };
}

function getJwtSecret() {
  if (jwtSecretCache) return jwtSecretCache;
  const { secret, sourceLabel } = resolveJwtSecretWithSourceOnce();
  jwtSecretCache = secret;
  if (!jwtSourceLoggedLabel && jwtSecretCache) {
    jwtSourceLoggedLabel = sourceLabel;
    console.log('[jwt] segredo JWT ativo obtido via:', jwtSourceLoggedLabel);
  }
  return jwtSecretCache;
}

/** Poucas leituras de JWT_SECRET antes de usar fallback / HARDCODED (principalmente na Vercel). */
async function probeEnvJwtSecretWithDelay(maxMs = 600) {
  const step = 30;
  for (let t = 0; t < maxMs; t += step) {
    const s = normalizeJwtEnvValue(process.env.JWT_SECRET);
    if (s) return s;
    await new Promise((r) => setTimeout(r, step));
  }
  return normalizeJwtEnvValue(process.env.JWT_SECRET);
}

const app = express();

// Log só na Vercel (Functions → Logs). Não imprime o segredo.
if (process.env.VERCEL) {
  const hasJwt = normalizeJwtEnvValue(process.env.JWT_SECRET).length > 0;
  const hasFb = normalizeJwtEnvValue(process.env.JWT_SECRET_FALLBACK).length > 0;
  console.log('[vn-imports][Vercel] JWT_SECRET preenchido:', hasJwt ? 'sim' : 'não');
  console.log('[vn-imports][Vercel] JWT_SECRET_FALLBACK preenchido:', hasFb ? 'sim' : 'não');
  if (!hasJwt && JWT_HARDCODED_TEST_FALLBACK) {
    console.warn('[vn-imports][Vercel] Se login falhar, o código pode cair em HARDCODED_TEST até JWT_SECRET ficar válido.');
  }
}

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

function slugifyTenantTag(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'loja';
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

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const masterRaw = process.env.ADMIN_PASSWORD;
    if (masterRaw == null || String(masterRaw).length === 0) {
      console.error('ADMIN_PASSWORD não configurada');
      return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
    }

    const bodyPwd =
      req.body?.senha == null
        ? ''
        : typeof req.body.senha === 'string'
          ? req.body.senha
          : String(req.body.senha);

    if (!timingSafePasswordEqual(bodyPwd, String(masterRaw))) {
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    invalidateJwtSecretCache();
    let peek = normalizeJwtEnvValue(process.env.JWT_SECRET);
    if (!peek && process.env.VERCEL) {
      peek = await probeEnvJwtSecretWithDelay(600);
    }
    if (peek) {
      jwtSecretCache = peek;
      jwtSourceLoggedLabel = 'process.env.JWT_SECRET';
      console.log('[jwt] segredo JWT ativo obtido via:', jwtSourceLoggedLabel);
    }

    const secret = getJwtSecret();

    const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: '8h' });
    res.json({ token, expiresIn: '8h' });
  } catch (e) {
    console.error('admin/login:', e.message);
    res.status(500).json({ erro: 'Erro ao processar login.' });
  }
});

function verificarJWT(req, res, next) {
  const secret = getJwtSecret();
  if (!secret) {
    return res.status(500).json({
      erro: 'Falha interna ao obter segredo JWT após fluxo de fallback.'
    });
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
  const masterRaw = process.env.ADMIN_PASSWORD;
  if (masterRaw == null || String(masterRaw).length === 0) {
    console.error('ADMIN_PASSWORD não configurada');
    return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
  }

  const hdr = req.headers['x-admin-password'];
  const recebida = hdr == null ? '' : String(hdr);

  if (!timingSafePasswordEqual(recebida, String(masterRaw))) {
    return res.status(401).json({ erro: 'Senha incorreta ou não fornecida.' });
  }
  next();
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
      let tenantTag = slugifyTenantTag(shopConfig.clienteTag || shopConfig.nomeLoja);
      try {
        if (await tryConnectDb()) {
          const cfg = await Config.findOne().lean();
          tenantTag = slugifyTenantTag(
            cfg?.clienteTag || cfg?.nomeLoja || shopConfig.clienteTag || shopConfig.nomeLoja
          );
        }
      } catch (e) {
        console.warn('Cloudinary tenant tag fallback:', e.message);
      }

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      const result = await cloudinary.uploader.upload(dataUri, undefined, {
        folder: `shops/${tenantTag}`,
        resource_type: 'image',
        unique_filename: true,
        tags: [`shop:${tenantTag}`, `tenant:${tenantTag}`],
        public_id_prefix: `tenant-${tenantTag}`
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

// ══════════════════════════════════════════════════════
//   REVIEWS (Avaliações)
// ══════════════════════════════════════════════════════

// POST /api/reviews (público)
app.post('/api/reviews', async (req, res) => {
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

// GET /api/reviews/public (somente aprovados)
app.get('/api/reviews/public', async (req, res) => {
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

// GET /api/admin/reviews (protegida com JWT)
app.get('/api/admin/reviews', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Review.find().sort({ data: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar avaliações (admin)', detalhe: err.message });
  }
});

// PUT /api/admin/reviews/:id (protegida com JWT para aprovar)
app.put('/api/admin/reviews/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const updated = await Review.findByIdAndUpdate(
      req.params.id,
      { aprovado: true },
      { new: true }
    );
    if (!updated) return res.status(404).json({ erro: 'Avaliação não encontrada' });
    res.json({ mensagem: 'Avaliação aprovada!', review: updated });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar avaliação', detalhe: err.message });
  }
});

// DELETE /api/admin/reviews/:id (protegida com JWT)
app.delete('/api/admin/reviews/:id', verificarJWT, async (req, res) => {
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

// --- SETTINGS (tokens) + ORDERS (pedidos) ---

const SettingsSchema = new mongoose.Schema(
  {
    mp_token: { type: String, default: '' },
    me_token: { type: String, default: '' },
    pix_key: { type: String, default: '' }
  },
  { timestamps: true }
);

const OrderSchema = new mongoose.Schema(
  {
    customerName: { type: String, default: '' },
    items: {
      type: [
        {
          name: { type: String, required: true },
          qty: { type: Number, required: true, min: 1 },
          price: { type: Number, required: true }
        }
      ],
      default: []
    },
    total: { type: Number, required: true },
    cep: { type: String, default: '' },
    status: { type: String, default: 'Pendente' }
  },
  { timestamps: true }
);

const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

function mergePublicSettings(doc) {
  return {
    pix_key: doc?.pix_key != null ? String(doc.pix_key).trim() : ''
  };
}

// GET /api/settings (público filtrado: apenas pix_key)
app.get('/api/settings', async (req, res) => {
  let doc = null;
  try {
    if (await tryConnectDb()) {
      doc = await Settings.findOne().lean();
    }
  } catch (e) {
    // ignora
  }
  if (!doc) doc = { pix_key: '' };
  res.json(mergePublicSettings(doc));
});

// POST /api/settings (admin via x-admin-password)
app.post('/api/settings', verificarSenha, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const mp_token = req.body?.mp_token != null ? String(req.body.mp_token).trim() : '';
    const me_token = req.body?.me_token != null ? String(req.body.me_token).trim() : '';
    const pix_key = req.body?.pix_key != null ? String(req.body.pix_key).trim() : '';

    const updated = await Settings.findOneAndUpdate(
      {},
      { mp_token, me_token, pix_key },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ mensagem: 'Configurações salvas!', config: mergePublicSettings(updated) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar settings', detalhe: err.message });
  }
});

// POST /api/orders (criação automática pelo front após finalizar compra)
app.post('/api/orders', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const customerName = req.body?.customerName != null ? String(req.body.customerName).trim() : '';
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const total = req.body?.total;
    const cep = req.body?.cep != null ? String(req.body.cep).trim() : '';
    const status = req.body?.status != null ? String(req.body.status).trim() : 'Pendente';

    const totalNum = typeof total === 'number' ? total : Number(total);
    if (!Number.isFinite(totalNum)) {
      return res.status(400).json({ erro: 'total inválido' });
    }

    const order = await Order.create({
      customerName,
      items: items.map(i => ({
        name: String(i.name || '').trim(),
        qty: Number(i.qty || 1),
        price: Number(i.price || 0)
      })),
      total: totalNum,
      cep,
      status
    });

    res.status(201).json({ mensagem: 'Pedido criado!', order });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar pedido', detalhe: err.message });
  }
});

// GET /api/orders (admin - listar)
app.get('/api/orders', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar pedidos', detalhe: err.message });
  }
});

// --- CONFIGURAÇÃO DA LOJA ---


const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: shopConfig.nomeLoja },
  chavePix: { type: String, default: '' },
  corPrimaria: { type: String, default: shopConfig.corPrimaria },
  corSecundaria: { type: String, default: shopConfig.corSecundaria },
  whatsappContato: { type: String, default: shopConfig.whatsappContato },
  instagramLink: { type: String, default: shopConfig.instagramLink },
  emailContato: { type: String, default: shopConfig.emailContato },
  clienteTag: { type: String, default: slugifyTenantTag(shopConfig.clienteTag || shopConfig.nomeLoja) }
});

const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

function mergePublicConfig(doc) {
  const nomeDb = doc?.nomeLoja?.trim();
  const pixDb = doc?.chavePix != null ? String(doc.chavePix).trim() : '';
  const corPrimaria = String(doc?.corPrimaria || shopConfig.corPrimaria || '').trim();
  const corSecundaria = String(doc?.corSecundaria || shopConfig.corSecundaria || '').trim();
  const colorsMerged = {
    ...(shopConfig.colors || {}),
    ...(corPrimaria ? { gold: corPrimaria } : {}),
    ...(corSecundaria ? { gold2: corSecundaria } : {})
  };
  return {
    nomeLoja: nomeDb || shopConfig.nomeLoja,
    chavePix: pixDb || (shopConfig.chavePix || '').trim(),
    corPrimaria: corPrimaria || shopConfig.corPrimaria || '',
    corSecundaria: corSecundaria || shopConfig.corSecundaria || '',
    whatsappContato: String(doc?.whatsappContato || shopConfig.whatsappContato || '').trim(),
    instagramLink: String(doc?.instagramLink || shopConfig.instagramLink || '').trim(),
    emailContato: String(doc?.emailContato || shopConfig.emailContato || '').trim(),
    clienteTag: slugifyTenantTag(doc?.clienteTag || doc?.nomeLoja || shopConfig.clienteTag || shopConfig.nomeLoja),
    colors: colorsMerged,
    pageTitleSuffix: shopConfig.pageTitleSuffix || 'Moda Premium'
  };
}

// Rota pública para o site ler nome da loja, PIX e tema (shopConfig + Mongo)
// Observação: não usamos cache para garantir que alterações feitas no admin
// sejam refletidas imediatamente na vitrine.
app.get('/api/config', async (req, res) => {
  let doc = null;
  try {
    if (await tryConnectDb()) {
      doc = await Config.findOne().lean();
      if (!doc) {
        doc = await Config.create({
          nomeLoja: shopConfig.nomeLoja,
          chavePix: shopConfig.chavePix || '',
          corPrimaria: shopConfig.corPrimaria,
          corSecundaria: shopConfig.corSecundaria,
          whatsappContato: shopConfig.whatsappContato,
          instagramLink: shopConfig.instagramLink,
          emailContato: shopConfig.emailContato,
          clienteTag: slugifyTenantTag(shopConfig.clienteTag || shopConfig.nomeLoja)
        });
        doc = doc?.toObject ? doc.toObject() : doc;
      }
    }
  } catch (e) {
    console.warn('GET /api/config:', e.message);
  }

  res.json(mergePublicConfig(doc));
});


// Rota protegida para o admin salvar configurações
app.post('/api/config', verificarSenha, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const {
      nomeLoja,
      chavePix,
      corPrimaria,
      corSecundaria,
      whatsappContato,
      instagramLink,
      emailContato,
      clienteTag
    } = req.body;
    const dados = { nomeLoja: nomeLoja?.trim() || shopConfig.nomeLoja };
    if (chavePix !== undefined) {
      dados.chavePix = String(chavePix).trim();
    }
    if (corPrimaria !== undefined) dados.corPrimaria = String(corPrimaria).trim();
    if (corSecundaria !== undefined) dados.corSecundaria = String(corSecundaria).trim();
    if (whatsappContato !== undefined) dados.whatsappContato = String(whatsappContato).trim();
    if (instagramLink !== undefined) dados.instagramLink = String(instagramLink).trim();
    if (emailContato !== undefined) dados.emailContato = String(emailContato).trim();
    if (clienteTag !== undefined) dados.clienteTag = slugifyTenantTag(clienteTag);
    if (!dados.clienteTag) {
      dados.clienteTag = slugifyTenantTag(dados.nomeLoja || shopConfig.nomeLoja);
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

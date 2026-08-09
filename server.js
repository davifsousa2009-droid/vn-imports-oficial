// Local: carrega .env com dotenv. Na Vercel (VERCEL definido) NUNCA usamos dotenv —
// JWT_SECRET e demais chaves vêm só de process.env (painel Project → Environment Variables).
if (!process.env.VERCEL) {
  require('dotenv').config();
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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



let jwtSecretCache = '';
let jwtSourceLoggedLabel = '';

function invalidateJwtSecretCache() {
  jwtSecretCache = '';
  jwtSourceLoggedLabel = '';
}

/** Ordem: JWT_SECRET (obrigatório). */
function resolveJwtSecretWithSourceOnce() {
  const fromJwt = normalizeJwtEnvValue(process.env.JWT_SECRET);
  if (fromJwt) return { secret: fromJwt, sourceLabel: 'process.env.JWT_SECRET' };

  console.error('[jwt] JWT_SECRET não definido/está vazio. Bloqueando inicialização.');
  return { secret: '', sourceLabel: 'MISSING_JWT_SECRET' };
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


/** Poucas leituras de JWT_SECRET antes de usar fallback / HARDCODED. */
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
  console.log('[vn-imports][Vercel] JWT_SECRET preenchido:', hasJwt ? 'sim' : 'não');
}

// Segurança: JWT_SECRET é obrigatório. Se não existir, bloqueia inicialização.
(function enforceJwtSecretAtStartup() {
  const secret = normalizeJwtEnvValue(process.env.JWT_SECRET);
  if (!secret) {
    console.error('[startup] Erro: JWT_SECRET ausente. Defina JWT_SECRET no painel/ambiente.');
    // evita que servidor rode em modo vulnerável
    process.exit(1);
  }
})();


app.set('trust proxy', 1);

app.use(
  helmet({
    // CSP prática: o front (VN_IMPORTS.html / admin.html) usa <script> e style="" inline,
    // por isso 'unsafe-inline' segue liberado para script/style — travar isso 100% exigiria
    // mover todo o JS/CSS inline para arquivos externos (refactor maior, fora deste escopo).
    // Ainda assim, blindamos img/font/connect só nos domínios que o projeto realmente usa.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // O site usa dezenas de onclick="" inline no HTML (VN_IMPORTS.html e admin.html).
        // CSP trata isso como uma diretiva separada de <script>; sem isso, todo botão
        // com onclick inline fica bloqueado silenciosamente no console do navegador.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com', 'https://images.unsplash.com'],
        connectSrc: ["'self'"]
      }
    }
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

/** Extrai public_id a partir da secure_url padrão do Cloudinary. */
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
// CORS: sempre libera a própria origem do domínio que está servindo a API
// (detectada automaticamente pelo header Host da requisição — funciona sem
// precisar configurar nada). Se ALLOWED_ORIGIN estiver definido (domínios
// separados por vírgula), esses domínios extras também são liberados —
// útil para um domínio próprio além do *.vercel.app, por exemplo.
// localhost sempre é liberado, para não travar o desenvolvimento local.
const extraAllowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      // requisições sem Origin (curl, apps mobile, chamadas do próprio servidor) são liberadas
      if (!origin) return callback(null, true);

      const selfOrigin = req.headers.host ? `https://${req.headers.host}` : null;
      const isLocalDev = /^https?:\/\/localhost(:\d+)?$/.test(origin);
      const isSelf = selfOrigin && origin === selfOrigin;
      const isExtraAllowed = extraAllowedOrigins.includes(origin);

      if (isLocalDev || isSelf || isExtraAllowed) return callback(null, true);

      return callback(new Error('Origem não permitida por CORS: ' + origin), false);
    }
  })(req, res, next);
});
app.use(express.json());

// ── CONEXÃO COM MONGODB (singleton) ────────────────────
// Na Vercel, o mesmo código pode ser executado em múltiplas invocações.
// Guardamos a conexão/promise para evitar reconectar a cada request (causa comum de 503).
let isConnected = false;
let connectPromise = null;

async function connectDB() {
  // Se já conectou e a conexão está ativa, não reconecta.
  if (mongoose.connection.readyState === 1 && isConnected) return;
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }

  // Se uma conexão já está em andamento, reaproveita a promise.
  if (connectPromise) return connectPromise;

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI não definido no ambiente.');
  }

  connectPromise = mongoose
    .connect(mongoUri, {
      // aumenta timeout para reduzir falhas em cold start / Atlas instável
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      // pool pequeno para reduzir agressividade; singleton evita reconexões
      maxPoolSize: 1,
      minPoolSize: 0
    })
    .then(() => {
      isConnected = true;
      console.log('MongoDB conectado');
      return mongoose;
    })
    .catch((err) => {
      // libera promise para próximas tentativas
      isConnected = false;
      connectPromise = null;
      throw err;
    })
    .finally(() => {
      // mantém isConnected, mas não prende connectPromise após sucesso
      connectPromise = null;
    });

  return connectPromise;
}

async function tryConnectDb() {
  try {
    await connectDB();
    return mongoose.connection.readyState === 1;
  } catch (err) {
    console.warn('MongoDB:', err.message);
    return false;
  }
}

async function ensureDbConnected(res) {
  try {
    await connectDB();
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return false;
    }
    return true;
  } catch (err) {
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
  connectDB().catch((err) => console.error('Erro initial MongoDB:', err.message));
}

// ── LOGIN ─────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde alguns minutos.' }
});

// Rate limit para rotas públicas de escrita (evita spam de pedidos/avaliações falsas).
const ordersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.' }
});

const reviewsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas avaliações em pouco tempo. Aguarde alguns minutos.' }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const masterRaw = process.env.ADMIN_PASSWORD;
    if (masterRaw == null || String(masterRaw).length === 0) {
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
      // mesmo em produção, faz poucas tentativas por cold-start
      peek = await probeEnvJwtSecretWithDelay(600);
    }

    if (!peek) {
      return res
        .status(500)
        .json({ erro: 'JWT_SECRET não configurado no ambiente.' });
    }

    jwtSecretCache = peek;
    jwtSourceLoggedLabel = 'process.env.JWT_SECRET';
    console.log('[jwt] segredo JWT ativo obtido via:', jwtSourceLoggedLabel);

    const secret = getJwtSecret();

    const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: '8h' });
    res.json({ token, expiresIn: '8h' });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao processar login.' });
  }
});

function verificarJWT(req, res, next) {
  const secret = getJwtSecret();
  if (!secret) {
    return res.status(500).json({ erro: 'Falha interna ao obter segredo JWT.' });
  }

  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ erro: 'Token não fornecido. Faça login no painel.' });

  try {
    jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

// (REMOVIDO) verificação por senha em texto puro via header x-admin-password.
// Admin deve usar Bearer JWT nas rotas protegidas.


// POST /api/upload
app.post('/api/upload', verificarJWT, (req, res) => {

  const missing =
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET;

  if (missing) {
    return res.status(503).json({
      erro: 'Cloudinary não configurado. Defina CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET.'
    });
  }

  uploadMem.single('arquivo')(req, res, async (err) => {
    if (err) return res.status(400).json({ erro: err.message || 'Erro no upload.' });
    if (!req.file?.buffer) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

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
        // ignore
      }

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      const result = await cloudinary.uploader.upload(dataUri, undefined, {
        folder: `shops/${tenantTag}`,
        resource_type: 'image',
        unique_filename: true,
        tags: [`shop:${tenantTag}`, `tenant:${tenantTag}`],
        public_id_prefix: `tenant-${tenantTag}`
      });

      res.status(201).json({ path: result.secure_url, mensagem: 'Upload concluído.' });
    } catch (e) {
      res.status(503).json({ erro: e.message || 'Erro ao enviar imagem para o Cloudinary.' });
    }
  });
});

// ── MODELS ─────────────────────────────────────────────
const produtoSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true },
    preco: { type: Number, required: true },
    imagem: { type: String, default: '' },
    // Galeria de fotos adicionais (a imagem "de capa" continua sendo `imagem`,
    // essa lista é o restante das fotos mostradas na página do produto).
    imagens: { type: [String], default: [] },
    descricao: { type: String, default: '' },
    categoria: { type: String, default: 'geral' },
    // null = sem controle de estoque habilitado para este produto (não bloqueia compra).
    // Um número (mesmo 0) = controle ativo, com aquela quantidade disponível.
    estoque: { type: Number, default: null },
    // Array de tamanhos disponíveis para o produto (ex: ['P','M','G'])
    sizes: { type: [String], default: [] }
  },
  { timestamps: true }
);
const Produto = mongoose.models.Produto || mongoose.model('Produto', produtoSchema);


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

const BannerSchema = new mongoose.Schema(
  {
    imagem: { type: String, required: true, trim: true },
    ordem: { type: Number, default: 0 }
  },
  { timestamps: true }
);
const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);

// Settings + Orders
const SettingsSchema = new mongoose.Schema(
  {
    mp_token: { type: String, default: '' },
    /** Chave pública do Mercado Pago — usada no front para tokenizar cartão (SDK). */
    mp_public_key: { type: String, default: '' },
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
          price: { type: Number, required: true },
          tamanhoSelecionado: { type: String, default: '' }
        }
      ],
      default: []
    },
    total: { type: Number, required: true },
    cep: { type: String, default: '' },
    frete: { type: Number, default: 0 },
    freteNome: { type: String, default: '' },
    freteEmpresa: { type: String, default: '' },
    status: { type: String, default: 'Pendente' },
    // ID do pagamento no Mercado Pago, salvo quando o QR Pix é gerado.
    // Usado pelo webhook (/api/pix/webhook) para confirmar o pagamento e atualizar o status.
    mpPaymentId: { type: String, default: '' }
  },
  { timestamps: true }
);

const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: shopConfig.nomeLoja },
  chavePix: { type: String, default: '' },
  corPrimaria: { type: String, default: shopConfig.corPrimaria },
  corSecundaria: { type: String, default: shopConfig.corSecundaria },
  whatsappContato: { type: String, default: shopConfig.whatsappContato },
  instagramLink: { type: String, default: shopConfig.instagramLink },
  emailContato: { type: String, default: shopConfig.emailContato },
  clienteTag: { type: String, default: slugifyTenantTag(shopConfig.clienteTag || shopConfig.nomeLoja) },
  // Cidade do lojista — exigida pelo padrão do Pix (BR Code) no Copia e Cola.
  cidadeLoja: { type: String, default: 'SAO PAULO' },

  // Barra de anúncio (frete grátis / parcelamento) — desligada por padrão.
  // Antes esses valores eram texto fixo no HTML, prometendo algo que a loja
  // podia nem oferecer de verdade (ex: parcelamento sem ter cartão configurado).
  freteGratisAtivo: { type: Boolean, default: false },
  freteGratisValor: { type: Number, default: 0 },
  parcelamentoAtivo: { type: Boolean, default: false },
  parcelamentoMax: { type: Number, default: 1 },

  // Banner de promoção — desligado por padrão. Antes era um "Até 40% OFF" fixo,
  // mostrado pra sempre mesmo sem nenhuma promoção real acontecendo.
  promoAtiva: { type: Boolean, default: false },
  promoEyebrow: { type: String, default: '' },
  promoTitulo: { type: String, default: '' },
  promoSubtitulo: { type: String, default: '' },
  promoCtaTexto: { type: String, default: '' },

  // ✅ NOVO: hero do split (imagem principal do rapaz na vitrine)
  heroImagem: { type: String, default: '' },
  heroImagemUrl: { type: String, default: '' },
  // Título do hero e fonte selecionada pelo admin
  heroTitle: { type: String, default: '' },
  heroFont: { type: String, default: 'Lora' },

  // ✅ NOVO: Configurações dinâmicas de conteúdo do site (Admin → vitrine)
  sobreTitulo: { type: String, default: 'Cibelle' },
  sobreTexto: {
    type: String,
    default:
      'Somos apaixonados por moda e por curadoria. A Cibelle Imports nasceu para trazer peças internacionais com qualidade real, caimento impecável e aquele diferencial que faz você se destacar. Hoje, cada produto passa por um processo de seleção para garantir que chegue até você do jeito que você imaginou. Da descoberta ao pós-compra, nosso compromisso é simples: atendimento humano e experiência completa.'
  },

  // Benefício 1: Entrega Rápida
  benef1Titulo: { type: String, default: 'Entrega Rápida' },
  benef1Texto: { type: String, default: 'Receba em até 3 dias úteis. Frete grátis acima de R$299.' },
  benef1IcoEnabled: { type: Boolean, default: true },
  benef1Ico: { type: String, default: '🚚' },

  // Benefício 2: Troca em 30 Dias
  benef2Titulo: { type: String, default: 'Troca em 30 Dias' },
  benef2Texto: { type: String, default: 'Sem burocracia. Sua satisfação é nossa prioridade.' },
  benef2IcoEnabled: { type: Boolean, default: true },
  benef2Ico: { type: String, default: '🔄' },

  // Benefício 3: Pagamento Seguro
  benef3Titulo: { type: String, default: 'Pagamento Seguro' },
  benef3Texto: { type: String, default: 'PIX, cartão e boleto com total segurança.' },
  benef3IcoEnabled: { type: Boolean, default: true },
  benef3Ico: { type: String, default: '🔒' },

  // Benefício 4: Importado Selecionado
  benef4Titulo: { type: String, default: 'Importado Selecionado' },
  benef4Texto: { type: String, default: 'Curadoria rigorosa de produtos internacionais.' },
  benef4IcoEnabled: { type: Boolean, default: true },
  benef4Ico: { type: String, default: '💎' }
});
const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

function mergePublicSettings(doc) {
  return {
    pix_key: doc?.pix_key != null ? String(doc.pix_key).trim() : '',
    mp_public_key: doc?.mp_public_key != null ? String(doc.mp_public_key).trim() : ''
  };
}

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

  const bool = (v, dflt) => {
    if (v === undefined) return dflt;
    return !!v;
  };

  return {
    nomeLoja: nomeDb || shopConfig.nomeLoja,
    chavePix: pixDb || (shopConfig.chavePix || '').trim(),
    corPrimaria,
    corSecundaria,
    whatsappContato: String(doc?.whatsappContato || shopConfig.whatsappContato || '').trim(),
    instagramLink: String(doc?.instagramLink || shopConfig.instagramLink || '').trim(),
    emailContato: String(doc?.emailContato || shopConfig.emailContato || '').trim(),
    clienteTag: slugifyTenantTag(doc?.clienteTag || doc?.nomeLoja || shopConfig.clienteTag || shopConfig.nomeLoja),
    cidadeLoja: String(doc?.cidadeLoja || '').trim().toUpperCase() || 'SAO PAULO',
    colors: colorsMerged,
    pageTitleSuffix: shopConfig.pageTitleSuffix || 'Moda Premium',

    // Conteúdo (About + Benefícios)
    sobreTitulo: String(doc?.sobreTitulo ?? '').trim() || 'Cibelle',
    sobreTexto: String(doc?.sobreTexto ?? '').trim() ||
      'Somos apaixonados por moda e por curadoria. A Cibelle Imports nasceu para trazer peças internacionais com qualidade real, caimento impecável e aquele diferencial que faz você se destacar. Hoje, cada produto passa por um processo de seleção para garantir que chegue até você do jeito que você imaginou. Da descoberta ao pós-compra, nosso compromisso é simples: atendimento humano e experiência completa.',

    benef1Titulo: String(doc?.benef1Titulo ?? '').trim() || 'Entrega Rápida',
    benef1Texto: String(doc?.benef1Texto ?? '').trim() || 'Receba em até 3 dias úteis. Frete grátis acima de R$299.',
    benef1IcoEnabled: bool(doc?.benef1IcoEnabled, true),
    benef1Ico: String(doc?.benef1Ico ?? '').trim() || '🚚',

    benef2Titulo: String(doc?.benef2Titulo ?? '').trim() || 'Troca em 30 Dias',
    benef2Texto: String(doc?.benef2Texto ?? '').trim() || 'Sem burocracia. Sua satisfação é nossa prioridade.',
    benef2IcoEnabled: bool(doc?.benef2IcoEnabled, true),
    benef2Ico: String(doc?.benef2Ico ?? '').trim() || '🔄',

    benef3Titulo: String(doc?.benef3Titulo ?? '').trim() || 'Pagamento Seguro',
    benef3Texto: String(doc?.benef3Texto ?? '').trim() || 'PIX, cartão e boleto com total segurança.',
    benef3IcoEnabled: bool(doc?.benef3IcoEnabled, true),
    benef3Ico: String(doc?.benef3Ico ?? '').trim() || '🔒',

    benef4Titulo: String(doc?.benef4Titulo ?? '').trim() || 'Importado Selecionado',
    benef4Texto: String(doc?.benef4Texto ?? '').trim() || 'Curadoria rigorosa de produtos internacionais.',
    benef4IcoEnabled: bool(doc?.benef4IcoEnabled, true),
    benef4Ico: String(doc?.benef4Ico ?? '').trim() || '💎',

    // Barra de anúncio: só mostra o que o admin realmente ativou.
    freteGratisAtivo: bool(doc?.freteGratisAtivo, false),
    freteGratisValor: Number(doc?.freteGratisValor) || 0,
    parcelamentoAtivo: bool(doc?.parcelamentoAtivo, false),
    parcelamentoMax: Math.max(1, Number(doc?.parcelamentoMax) || 1),

    // Banner de promoção: só aparece quando o admin ativar de verdade.
    promoAtiva: bool(doc?.promoAtiva, false),
    promoEyebrow: String(doc?.promoEyebrow ?? '').trim(),
    promoTitulo: String(doc?.promoTitulo ?? '').trim(),
    promoSubtitulo: String(doc?.promoSubtitulo ?? '').trim(),
    promoCtaTexto: String(doc?.promoCtaTexto ?? '').trim() || 'Ver promoções'
    ,
    // Hero dinâmico: título (texto/HTML limitado) e fonte escolhida pelo admin
    heroTitle: String(doc?.heroTitle ?? '').trim() || '',
    heroFont: String(doc?.heroFont ?? 'Lora').trim()
  };
}

function temMpTokenSalvo(doc) {
  if (!doc) return false;
  const mp = doc?.mp_token != null ? String(doc.mp_token).trim() : '';
  return mp.length > 0;
}

/**
 * Geração do "Pix Copia e Cola" (BR Code), padrão EMV definido pelo Banco Central.
 * Com o campo 54 (valor) preenchido, o app do banco do cliente já abre a tela de
 * pagamento com o valor travado (o cliente só confirma, não digita/edita o valor).
 * Não depende de nenhuma API externa — é só montagem de string + checksum CRC16.
 */
function removerAcentosEEspeciais(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Sanitiza a chave Pix para leitura segura em QR Code / Copia e Cola.
 * Remove parênteses, espaços, traços, pontos e qualquer caractere que
 * não seja dígito, letra, '@', '.' ou '+' (caracteres permitidos pelo
 * padrão BR Code do Banco Central para chaves Pix).
 * Ex: "(35) 99774-0622" → "35997740622" (telefone limpo).
 */
function sanitizarChavePix(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x21-\x7E]/g, '')
    .replace(/[^\w@.+-]/g, '')
    .trim();
}

function tlv(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return `${id}${len}${v}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — exigido pelo padrão do Pix. */
function crc16ccitt(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function gerarPixCopiaCola({ chave, valor, nome, cidade, txid }) {
  const chaveSanit = sanitizarChavePix(chave).slice(0, 77);
  const nomeSanit = (removerAcentosEEspeciais(nome).toUpperCase().slice(0, 25) || 'LOJA').trim();
  const cidadeSanit = (removerAcentosEEspeciais(cidade).toUpperCase().slice(0, 15) || 'SAO PAULO').trim();
  const txidSanit =
    (removerAcentosEEspeciais(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***').trim();
  const valorFormatado = Number(valor).toFixed(2);

  const merchantAccountInfo = tlv('00', 'br.gov.bcb.pix') + tlv('01', chaveSanit);
  const additionalData = tlv('05', txidSanit);

  let payload =
    tlv('00', '01') + // Payload Format Indicator
    tlv('01', '12') + // Point of Initiation Method: 12 = pagamento único com valor fixo
    tlv('26', merchantAccountInfo) + // Merchant Account Info (chave Pix)
    tlv('52', '0000') + // Merchant Category Code
    tlv('53', '986') + // Moeda: BRL
    tlv('54', valorFormatado) + // Valor — é isso que trava o valor no app do banco
    tlv('58', 'BR') + // País
    tlv('59', nomeSanit) + // Nome do recebedor
    tlv('60', cidadeSanit) + // Cidade do recebedor
    tlv('62', additionalData); // Identificador da transação (txid)

  payload += '6304'; // id+tamanho do campo CRC (o valor do CRC vem a seguir)
  const crc = crc16ccitt(payload).toString(16).toUpperCase().padStart(4, '0');
  return payload + crc;
}

// ── ROTAS DA API ─────────────────────────────────────────
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

app.post('/api/produtos', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { nome, preco, sizes } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!preco || isNaN(preco)) return res.status(400).json({ erro: 'Preço inválido' });

    // Garante que sizes chegue como array (ex: ['P','M','G'])
    const normalizedSizes = Array.isArray(sizes)
      ? sizes.map((s) => String(s).trim()).filter(Boolean)
      : [];

    const novo = new Produto({
      ...req.body,
      sizes: normalizedSizes
    });

    await novo.save();
    res.status(201).json({ mensagem: 'Produto salvo!', produto: novo });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar', detalhe: err.message });
  }
});

app.put('/api/produtos/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    // $set evita substituição total do documento — sem isso, editar só o preço
    // apagaria a galeria de fotos (ou qualquer campo fora do corpo da requisição).
    const atualizado = await Produto.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!atualizado) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ mensagem: 'Produto atualizado!', produto: atualizado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar', detalhe: err.message });
  }
});

app.delete('/api/produtos/:id', verificarJWT, async (req, res) => {
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

app.post('/api/categories', verificarJWT, async (req, res) => {

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
    if (err.code === 11000) return res.status(409).json({ erro: 'Slug já cadastrado.' });
    res.status(500).json({ erro: 'Erro ao criar categoria', detalhe: err.message });
  }
});

app.delete('/api/categories/:id', verificarJWT, async (req, res) => {

  if (!(await ensureDbConnected(res))) return;
  try {
    const removido = await Category.findByIdAndDelete(req.params.id);
    if (!removido) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ mensagem: 'Categoria removida!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover categoria', detalhe: err.message });
  }
});

app.get('/api/banners', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Banner.find().sort({ ordem: 1, createdAt: 1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar banners', detalhe: err.message });
  }
});

app.post('/api/banners', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const imagem = req.body.imagem?.trim();
    if (!imagem) return res.status(400).json({ erro: 'Imagem é obrigatória (faça upload no admin).' });
    const ordem = Number.parseInt(req.body.ordem, 10);
    const banner = await Banner.create({ imagem, ordem: Number.isFinite(ordem) ? ordem : 0 });
    res.status(201).json({ mensagem: 'Banner salvo!', banner });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar banner', detalhe: err.message });
  }
});

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

// Reviews
app.post('/api/reviews', reviewsLimiter, async (req, res) => {
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

// Estatística pública e real de clientes (conta pedidos com pagamento confirmado —
// não é fórmula inventada, é dado de verdade do banco).
app.get('/api/stats/clientes', async (req, res) => {
  if (!(await ensureDbConnected(res))) return res.json({ clientes: 0 });
  try {
    const distintos = await Order.distinct('customerName', { status: 'Pago' });
    const clientes = distintos.filter((n) => n && String(n).trim()).length;
    res.json({ clientes });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao calcular estatística', detalhe: err.message });
  }
});

app.get('/api/admin/reviews', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Review.find().sort({ data: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar avaliações (admin)', detalhe: err.message });
  }
});

app.put('/api/admin/reviews/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const updated = await Review.findByIdAndUpdate(req.params.id, { aprovado: true }, { new: true });
    if (!updated) return res.status(404).json({ erro: 'Avaliação não encontrada' });
    res.json({ mensagem: 'Avaliação aprovada!', review: updated });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar avaliação', detalhe: err.message });
  }
});

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

// Settings (public)
app.get('/api/settings', async (req, res) => {
  let doc = null;
  try {
    if (await tryConnectDb()) doc = await Settings.findOne().lean();
  } catch {
    // ignore
  }
  if (!doc) doc = { pix_key: '' };
  res.json(mergePublicSettings(doc));
});

app.post('/api/settings', verificarJWT, async (req, res) => {

  if (!(await ensureDbConnected(res))) return;
  try {
    const mp_token = req.body?.mp_token != null ? String(req.body.mp_token).trim() : '';
    const me_token = req.body?.me_token != null ? String(req.body.me_token).trim() : '';
    const pix_key = req.body?.pix_key != null ? String(req.body.pix_key).trim() : '';

    const updateFields = { mp_token, me_token, pix_key };
    if (req.body?.mp_public_key !== undefined) {
      updateFields.mp_public_key = String(req.body.mp_public_key).trim();
    }

    const updated = await Settings.findOneAndUpdate(
      {},
      { $set: updateFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ mensagem: 'Configurações salvas!', config: mergePublicSettings(updated) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar settings', detalhe: err.message });
  }
});

/**
 * Reverte decrementos de estoque já aplicados quando um pedido falha no meio do processamento
 * (ex: item 3 de 5 sem estoque — os itens 1 e 2 já decrementados precisam voltar).
 */
async function rollbackStock(decrementedList) {
  for (const { productId, qty } of decrementedList) {
    try {
      await Produto.findByIdAndUpdate(productId, { $inc: { estoque: qty } });
    } catch (e) {
      console.error('[orders] Falha ao reverter estoque de', productId, '-', e.message);
    }
  }
}

// Orders
app.post('/api/orders', ordersLimiter, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const customerName = req.body?.customerName != null ? String(req.body.customerName).trim() : '';
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const cep = req.body?.cep != null ? String(req.body.cep).trim() : '';

    if (!rawItems.length) return res.status(400).json({ erro: 'items vazios' });

    // IMPORTANTE: preço e total NUNCA vêm do cliente — sempre recalculados a partir
    // do Produto salvo no banco. Isso impede que alguém edite o carrinho no navegador
    // (localStorage/DevTools) para pagar um valor diferente do real.
    const decrementedForRollback = []; // acumula decrementos aplicados, para rollback em caso de erro
    const itemsForOrder = [];
    let totalNum = 0;

    for (const it of rawItems) {
      const qty = Number(it?.qty || 1);
      if (!Number.isFinite(qty) || qty < 1) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'Quantidade inválida no carrinho.' });
      }

      const productId = it?.productId ? String(it.productId) : (it?._id ? String(it._id) : null);
      if (!productId) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'Item do carrinho sem productId — não é possível validar o preço.' });
      }

      // Decremento atômico: só aplica se o produto tiver controle de estoque ativo
      // (estoque numérico) E quantidade suficiente. Evita condição de corrida entre
      // dois clientes comprando o mesmo item ao mesmo tempo.
      const withStockControl = await Produto.findOneAndUpdate(
        { _id: productId, estoque: { $gte: qty } },
        { $inc: { estoque: -qty } },
        { new: true }
      );

      let prod = withStockControl;
      if (!prod) {
        // Não bateu: produto inexistente, sem controle de estoque (estoque=null) ou estoque insuficiente.
        const existing = await Produto.findById(productId).lean();
        if (!existing) {
          await rollbackStock(decrementedForRollback);
          return res.status(400).json({ erro: 'Produto não encontrado: ' + productId });
        }
        if (existing.estoque == null) {
          // estoque=null => controle de estoque desativado para este produto; não bloqueia a compra.
          prod = existing;
        } else {
          await rollbackStock(decrementedForRollback);
          return res.status(409).json({
            erro: 'Sem estoque suficiente para ' + (existing.nome || it?.name || 'item'),
            produtoId: productId,
            estoqueDisponivel: existing.estoque,
            quantidadeSolicitada: qty
          });
        }
      } else {
        decrementedForRollback.push({ productId, qty });
      }

      const precoReal = Number(prod.preco || 0);
      totalNum += precoReal * qty;

      itemsForOrder.push({
        name: String(prod.nome || it?.name || '').trim(),
        qty,
        price: precoReal,
        tamanhoSelecionado: it?.tamanhoSelecionado ? String(it.tamanhoSelecionado) : ''
      });
    }

    totalNum = Math.round(totalNum * 100) / 100;

    // Frete (Melhor Envio / checkout). Se frete grátis da loja bater, zera.
    let freteNum = Math.max(0, Math.min(800, Number(req.body?.frete) || 0));
    const freteNome = req.body?.freteNome != null ? String(req.body.freteNome).trim().slice(0, 120) : '';
    const freteEmpresa = req.body?.freteEmpresa != null ? String(req.body.freteEmpresa).trim().slice(0, 80) : '';
    try {
      const cfgFrete = await Config.findOne().lean();
      if (cfgFrete?.freteGratisAtivo && Number(cfgFrete.freteGratisValor) > 0 && totalNum >= Number(cfgFrete.freteGratisValor)) {
        freteNum = 0;
      }
    } catch {
      /* mantém freteNum */
    }
    totalNum = Math.round((totalNum + freteNum) * 100) / 100;

    // Status sempre começa "Pendente" — o cliente não pode definir o status do próprio pedido.
    // A confirmação de pagamento (Pix) deve ser tratada separadamente, ver /api/pix/webhook.
    const order = await Order.create({
      customerName,
      items: itemsForOrder,
      total: totalNum,
      cep,
      frete: freteNum,
      freteNome,
      freteEmpresa,
      status: 'Pendente'
    });

    res.status(201).json({ mensagem: 'Pedido criado!', order });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar pedido', detalhe: err.message });
  }
});


app.get('/api/orders', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar pedidos', detalhe: err.message });
  }
});

// Admin pode marcar manualmente um pedido como pago/cancelado (ex: confirmou o Pix na mão).
app.put('/api/orders/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const statusPermitido = ['Pendente', 'Pago', 'Cancelado'];
    const status = String(req.body?.status || '').trim();
    if (!statusPermitido.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido. Use: ' + statusPermitido.join(', ') });
    }
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!order) return res.status(404).json({ erro: 'Pedido não encontrado' });
    res.json({ mensagem: 'Status atualizado!', order });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar pedido', detalhe: err.message });
  }
});

// Admin pode excluir um pedido (ex: pedido de teste, duplicado, ou cancelado de vez).
app.delete('/api/orders/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ erro: 'Pedido não encontrado' });
    res.json({ mensagem: 'Pedido excluído!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir pedido', detalhe: err.message });
  }
});

// Loja config
// Inclui: nome, whatsapp, imagem do hero (banco) e demais tokens usados pelo template.
async function buscarConfigCompleta() {
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
    console.warn('buscarConfigCompleta:', e.message);
  }

  // Para preservar compatibilidade, garantimos campos extras se existirem no banco.
  // Se o banco estiver vazio, retornamos um objeto padrão.
  const publicCfg = mergePublicConfig(doc);

  // default (exemplo) caso não exista no banco
  const defaultHeroImagem =
    'https://images.unsplash.com/photo-1520975916090-3105956dac38?auto=format&fit=crop&w=1200&q=80';

  const heroImagemFile = doc?.heroImagem ? String(doc.heroImagem).trim() : '';
  const heroImagemUrl = doc?.heroImagemUrl ? String(doc.heroImagemUrl).trim() : '';

  const heroImagemFinal = heroImagemFile || heroImagemUrl || defaultHeroImagem;

  return { ...publicCfg, heroImagem: heroImagemFinal };
}

app.get('/api/config', async (req, res) => {
  const cfg = await buscarConfigCompleta();
  return res.json(cfg);
});

app.post('/api/config', verificarJWT, async (req, res) => {
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
      clienteTag,
      cidadeLoja,

      // ✅ NOVO: hero do split
      heroImagem,
      heroImagemUrl,

      // ✅ NOVO: Conteúdo dinâmico
      sobreTitulo,
      sobreTexto,

      benef1Titulo,
      benef1Texto,
      benef1IcoEnabled,
      benef1Ico,

      benef2Titulo,
      benef2Texto,
      benef2IcoEnabled,
      benef2Ico,

      benef3Titulo,
      benef3Texto,
      benef3IcoEnabled,
      benef3Ico,

      benef4Titulo,
      benef4Texto,
      benef4IcoEnabled,
      benef4Ico,

      freteGratisAtivo,
      freteGratisValor,
      parcelamentoAtivo,
      parcelamentoMax,

      promoAtiva,
      promoEyebrow,
      promoTitulo,
      promoSubtitulo,
      promoCtaTexto
    } = req.body;

    const dados = { nomeLoja: nomeLoja?.trim() || shopConfig.nomeLoja };
    if (chavePix !== undefined) dados.chavePix = String(chavePix).trim();
    if (corPrimaria !== undefined) dados.corPrimaria = String(corPrimaria).trim();
    if (corSecundaria !== undefined) dados.corSecundaria = String(corSecundaria).trim();
    if (whatsappContato !== undefined) dados.whatsappContato = String(whatsappContato).trim();
    if (instagramLink !== undefined) dados.instagramLink = String(instagramLink).trim();
    if (emailContato !== undefined) dados.emailContato = String(emailContato).trim();
    if (clienteTag !== undefined) dados.clienteTag = slugifyTenantTag(clienteTag);
    if (cidadeLoja !== undefined) dados.cidadeLoja = String(cidadeLoja).trim().toUpperCase().slice(0, 15);
    if (!dados.clienteTag) dados.clienteTag = slugifyTenantTag(dados.nomeLoja || shopConfig.nomeLoja);

    // ✅ NOVO: hero do split
    if (heroImagem !== undefined) dados.heroImagem = String(heroImagem).trim();
    if (heroImagemUrl !== undefined) dados.heroImagemUrl = String(heroImagemUrl).trim();
    
    // ✅ NOVO: hero title + fonte
    if (req.body?.heroTitle !== undefined) dados.heroTitle = String(req.body.heroTitle).trim();
    if (req.body?.heroFont !== undefined) dados.heroFont = String(req.body.heroFont).trim();

    // ✅ NOVO: Conteúdo dinâmico (About + Benefícios)
    if (sobreTitulo !== undefined) dados.sobreTitulo = String(sobreTitulo).trim();
    if (sobreTexto !== undefined) dados.sobreTexto = String(sobreTexto).trim();

    if (benef1Titulo !== undefined) dados.benef1Titulo = String(benef1Titulo).trim();
    if (benef1Texto !== undefined) dados.benef1Texto = String(benef1Texto).trim();
    if (benef1IcoEnabled !== undefined) dados.benef1IcoEnabled = !!benef1IcoEnabled;
    if (benef1Ico !== undefined) dados.benef1Ico = String(benef1Ico).trim();

    if (benef2Titulo !== undefined) dados.benef2Titulo = String(benef2Titulo).trim();
    if (benef2Texto !== undefined) dados.benef2Texto = String(benef2Texto).trim();
    if (benef2IcoEnabled !== undefined) dados.benef2IcoEnabled = !!benef2IcoEnabled;
    if (benef2Ico !== undefined) dados.benef2Ico = String(benef2Ico).trim();

    if (benef3Titulo !== undefined) dados.benef3Titulo = String(benef3Titulo).trim();
    if (benef3Texto !== undefined) dados.benef3Texto = String(benef3Texto).trim();
    if (benef3IcoEnabled !== undefined) dados.benef3IcoEnabled = !!benef3IcoEnabled;
    if (benef3Ico !== undefined) dados.benef3Ico = String(benef3Ico).trim();

    if (benef4Titulo !== undefined) dados.benef4Titulo = String(benef4Titulo).trim();
    if (benef4Texto !== undefined) dados.benef4Texto = String(benef4Texto).trim();
    if (benef4IcoEnabled !== undefined) dados.benef4IcoEnabled = !!benef4IcoEnabled;
    if (benef4Ico !== undefined) dados.benef4Ico = String(benef4Ico).trim();

    if (freteGratisAtivo !== undefined) dados.freteGratisAtivo = !!freteGratisAtivo;
    if (freteGratisValor !== undefined) dados.freteGratisValor = Number(freteGratisValor) || 0;
    if (parcelamentoAtivo !== undefined) dados.parcelamentoAtivo = !!parcelamentoAtivo;
    if (parcelamentoMax !== undefined) dados.parcelamentoMax = Math.max(1, Number(parcelamentoMax) || 1);

    if (promoAtiva !== undefined) dados.promoAtiva = !!promoAtiva;
    if (promoEyebrow !== undefined) dados.promoEyebrow = String(promoEyebrow).trim();
    if (promoTitulo !== undefined) dados.promoTitulo = String(promoTitulo).trim();
    if (promoSubtitulo !== undefined) dados.promoSubtitulo = String(promoSubtitulo).trim();
    if (promoCtaTexto !== undefined) dados.promoCtaTexto = String(promoCtaTexto).trim();

    // $set é essencial aqui: sem ele, o MongoDB trata isso como substituição
    // TOTAL do documento — qualquer campo fora de `dados` (ex: os salvos pelo
    // outro formulário do admin) seria apagado. Com $set, só o que está em
    // `dados` é tocado; o resto do documento permanece intacto.
    const atualizado = await Config.findOneAndUpdate({}, { $set: dados }, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    res.json({ mensagem: 'Configuração atualizada!', config: mergePublicConfig(atualizado) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── PAGAMENTOS MERCADO PAGO ────────────────────────────

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Cotação de frete via Melhor Envio (me_token em Settings).
 * Body: { cep, subtotal, products? }
 */
app.post('/api/frete/calcular', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE', options: [] });
    }

    const cep = onlyDigits(req.body?.cep);
    if (cep.length !== 8) {
      return res.status(400).json({ ok: false, reason: 'CEP_INVALIDO', options: [] });
    }

    const subtotal = Number(req.body?.subtotal) || 0;
    const cfg = await Config.findOne().lean();
    if (cfg?.freteGratisAtivo && Number(cfg.freteGratisValor) > 0 && subtotal >= Number(cfg.freteGratisValor)) {
      return res.json({ ok: true, freeShipping: true, options: [] });
    }

    const settings = await Settings.findOne().lean();
    const meToken = settings?.me_token ? String(settings.me_token).trim() : '';
    if (!meToken) {
      return res.json({ ok: false, reason: 'NO_ME_TOKEN', options: [] });
    }

    const fromCep = onlyDigits(process.env.ME_CEP_ORIGEM || cfg?.cepOrigem || '01310100');
    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const products = (rawProducts.length ? rawProducts : [{ quantity: 1, unitary_value: subtotal || 1 }]).map((p) => ({
      id: String(p.id || 'item'),
      width: Number(p.width) || 11,
      height: Number(p.height) || 2,
      length: Number(p.length) || 16,
      weight: Number(p.weight) || 0.3,
      insurance_value: Number(p.unitary_value || p.price || 0) || 0,
      quantity: Math.max(1, Number(p.quantity || p.qty) || 1)
    }));

    const meUrl =
      (process.env.ME_API_BASE || 'https://melhorenvio.com.br') +
      '/api/v2/me/shipment/calculate';

    const meRes = await fetch(meUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + meToken,
        'User-Agent': 'VN Imports (contato@' + (shopConfig.nomeLoja || 'loja').toLowerCase().replace(/\s+/g, '') + '.com.br)'
      },
      body: JSON.stringify({
        from: { postal_code: fromCep },
        to: { postal_code: cep },
        products
      })
    });

    const meJson = await meRes.json().catch(() => ([]));
    if (!meRes.ok) {
      return res.status(502).json({
        ok: false,
        reason: 'ME_QUOTE_FAILED',
        options: [],
        meStatus: meRes.status,
        meError: meJson
      });
    }

    const list = Array.isArray(meJson) ? meJson : [];
    const options = list
      .filter((o) => o && !o.error && (o.price != null || o.custom_price != null))
      .map((o) => ({
        id: o.id != null ? String(o.id) : '',
        name: o.name || o.service || 'Frete',
        company: (o.company && (o.company.name || o.company)) || '',
        price: Number(o.custom_price != null ? o.custom_price : o.price) || 0,
        delivery_time: o.custom_delivery_time || o.delivery_time || null
      }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    return res.json({ ok: true, freeShipping: false, options });
  } catch (e) {
    console.error('[frete/calcular]', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', options: [], detalhe: e.message });
  }
});

function splitPayerName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'Cliente', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

async function criarPagamentoMP(mpToken, payload, idempotencyKey) {
  const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mpToken}`,
      'X-Idempotency-Key': idempotencyKey || crypto.randomUUID()
    },
    body: JSON.stringify(payload)
  });
  const mpJson = await mpRes.json().catch(() => ({}));
  return { mpRes, mpJson };
}

/**
 * Config pública do checkout (sem expor mp_token).
 * mp_public_key é segura para o browser (tokenização de cartão).
 */
app.get('/api/payment/config', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
    }
    const doc = await Settings.findOne().lean();
    return res.json({
      hasMpToken: temMpTokenSalvo(doc),
      mpPublicKey: doc?.mp_public_key ? String(doc.mp_public_key).trim() : '',
      pixKeyFallback: sanitizarChavePix(mergePublicSettings(doc).pix_key)
    });
  } catch {
    return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
  }
});

/**
 * Cria pagamento no Mercado Pago (Pix ou Cartão).
 * Body: {
 *   method: 'pix' | 'card',
 *   orderId,
 *   payerEmail, payerName, payerCpf,
 *   // card:
 *   token, installments, payment_method_id, issuer_id?
 * }
 * O valor cobrado SEMPRE vem de order.total no banco (nunca do cliente).
 */
app.post('/api/payment/create', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const settings = await Settings.findOne().lean();
    if (!temMpTokenSalvo(settings)) {
      return res.status(400).json({ ok: false, reason: 'NO_MP_TOKEN' });
    }
    const mpToken = String(settings.mp_token).trim();

    const method = String(req.body?.method || 'pix').trim().toLowerCase();
    if (method !== 'pix' && method !== 'card') {
      return res.status(400).json({ ok: false, reason: 'INVALID_METHOD' });
    }

    const orderId = req.body?.orderId ? String(req.body.orderId) : '';
    if (!orderId) {
      return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED', status: order.status });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, reason: 'INVALID_AMOUNT' });
    }

    const payerEmail = String(req.body?.payerEmail || req.body?.email || '').trim() || 'cliente@email.com';
    const payerName = String(req.body?.payerName || req.body?.first_name || order.customerName || 'Cliente').trim();
    const { first_name, last_name } = splitPayerName(payerName);
    const cpf = onlyDigits(req.body?.payerCpf || req.body?.cpf || '');

    const payer = {
      email: payerEmail,
      first_name,
      last_name
    };
    if (cpf.length === 11) {
      payer.identification = { type: 'CPF', number: cpf };
    }

    let payload;
    if (method === 'pix') {
      payload = {
        transaction_amount: amount,
        description: `Pedido ${orderId} — ${shopConfig.nomeLoja || 'Loja'}`,
        payment_method_id: 'pix',
        payer
      };
    } else {
      const token = String(req.body?.token || '').trim();
      const payment_method_id = String(req.body?.payment_method_id || '').trim();
      const installments = Math.max(1, Number(req.body?.installments) || 1);
      const issuer_id = req.body?.issuer_id != null ? String(req.body.issuer_id).trim() : '';

      if (!token) {
        return res.status(400).json({ ok: false, reason: 'MISSING_CARD_TOKEN' });
      }
      if (!payment_method_id) {
        return res.status(400).json({ ok: false, reason: 'MISSING_PAYMENT_METHOD_ID' });
      }

      payload = {
        transaction_amount: amount,
        token,
        description: `Pedido ${orderId} — ${shopConfig.nomeLoja || 'Loja'}`,
        installments,
        payment_method_id,
        payer
      };
      if (issuer_id) payload.issuer_id = issuer_id;
    }

    const idempotencyKey = `order-${orderId}-${method}-${Date.now()}`;
    const { mpRes, mpJson } = await criarPagamentoMP(mpToken, payload, idempotencyKey);

    if (!mpRes.ok) {
      return res.status(502).json({
        ok: false,
        reason: 'MP_PAYMENT_CREATE_FAILED',
        mpStatus: mpRes.status,
        mpError: mpJson
      });
    }

    const paymentId = mpJson?.id != null ? String(mpJson.id) : '';
    if (paymentId) {
      try {
        order.mpPaymentId = paymentId;
        await order.save();
      } catch (e) {
        console.warn('[payment/create] Falha ao salvar mpPaymentId:', e.message);
      }
    }

    const mpStatus = String(mpJson?.status || '');

    // Cartão aprovado na hora → marca pedido como Pago
    if (method === 'card' && mpStatus === 'approved') {
      try {
        order.status = 'Pago';
        await order.save();
      } catch (e) {
        console.warn('[payment/create] Falha ao marcar pedido como Pago:', e.message);
      }
    }

    if (method === 'pix') {
      const tx = mpJson?.point_of_interaction?.transaction_data || {};
      const qr_code = String(tx.qr_code || mpJson?.qr_code || '').trim();
      const qr_code_base64 = String(tx.qr_code_base64 || mpJson?.qr_code_base64 || '').trim();

      if (!qr_code && !qr_code_base64) {
        return res.status(502).json({
          ok: false,
          reason: 'MP_QR_NOT_FOUND',
          mpPayment: mpJson
        });
      }

      return res.json({
        ok: true,
        method: 'pix',
        paymentId,
        status: mpStatus,
        orderId,
        total: amount,
        qr_code,
        qr_code_base64,
        // aliases amigáveis pro front
        qrCode: qr_code,
        qrCodeBase64: qr_code_base64
      });
    }

    return res.json({
      ok: true,
      method: 'card',
      paymentId,
      status: mpStatus,
      status_detail: mpJson?.status_detail || '',
      orderId,
      total: amount,
      approved: mpStatus === 'approved'
    });
  } catch (e) {
    console.error('[payment/create]', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

/**
 * Status do pagamento (polling do checkout).
 * Consulta o pedido no banco e, se ainda Pendente, sincroniza com o Mercado Pago.
 */
app.get('/api/payment/status/:orderId', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const orderId = String(req.params.orderId || '');
    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }

    let status = String(order.status || 'Pendente');
    let mpStatus = null;

    if (status === 'Pendente' && order.mpPaymentId) {
      const settings = await Settings.findOne().lean();
      if (temMpTokenSalvo(settings)) {
        const mpToken = String(settings.mp_token).trim();
        try {
          const mpRes = await fetch(
            `https://api.mercadopago.com/v1/payments/${encodeURIComponent(order.mpPaymentId)}`,
            { headers: { Authorization: `Bearer ${mpToken}` } }
          );
          const mpJson = await mpRes.json().catch(() => ({}));
          if (mpRes.ok) {
            mpStatus = String(mpJson?.status || '');
            if (mpStatus === 'approved') {
              await Order.findOneAndUpdate(
                { _id: orderId, status: 'Pendente' },
                { status: 'Pago' }
              );
              status = 'Pago';
            } else if (mpStatus === 'cancelled' || mpStatus === 'rejected') {
              // mantém Pendente para revisão manual; expõe mpStatus ao front
            }
          }
        } catch (e) {
          console.warn('[payment/status] Falha ao consultar MP:', e.message);
        }
      }
    }

    return res.json({
      ok: true,
      orderId,
      status,
      approved: status === 'Pago',
      mpPaymentId: order.mpPaymentId || '',
      mpStatus,
      total: order.total
    });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

// ── PIX AUTOMÁTICO ─────────────────────────────────────

// Gera o "Pix Copia e Cola" com valor travado para um pedido específico.
// Usado quando não há token do Mercado Pago configurado (fallback manual) —
// mesmo sem integração automática, o valor não fica mais livre pro cliente editar.
app.post('/api/pix/copia-cola', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (!orderId) return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED' });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, reason: 'INVALID_AMOUNT' });
    }

    const [settingsDoc, configDoc] = await Promise.all([
      Settings.findOne().lean(),
      Config.findOne().lean()
    ]);

    const chave = settingsDoc?.pix_key ? String(settingsDoc.pix_key).trim() : '';
    if (!chave) return res.status(400).json({ ok: false, reason: 'NO_PIX_KEY' });

    const chaveLimpa = sanitizarChavePix(chave);

    const nome = configDoc?.nomeLoja || shopConfig.nomeLoja || 'LOJA';
    const cidade = configDoc?.cidadeLoja || 'SAO PAULO';
    const txid = String(order._id);

    const copiaECola = gerarPixCopiaCola({ chave, valor: amount, nome, cidade, txid });

    // Retorna o valor travado (do pedido no banco) e a chave limpa —
    // o front pode exibir a confirmação de valor antes de o cliente copiar.
    return res.json({ ok: true, copiaECola, valor: amount, chave: chaveLimpa });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

app.get('/api/pix/automatic', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.json({ hasMpToken: false, pixKeyFallback: '' });
    }

    const doc = await Settings.findOne().lean();
    const hasMpToken = temMpTokenSalvo(doc);
    const pixKeyFallback = sanitizarChavePix(mergePublicSettings(doc).pix_key);

    return res.json({ hasMpToken, pixKeyFallback });
  } catch {
    return res.json({ hasMpToken: false, pixKeyFallback: '' });
  }
});

app.post('/api/pix/qr-mp', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE', pixKeyFallback: '' });
    }

    const doc = await Settings.findOne().lean();
    const pixKeyFallback = sanitizarChavePix(mergePublicSettings(doc).pix_key);

    if (!temMpTokenSalvo(doc)) {
      return res.json({ ok: false, reason: 'NO_MP_TOKEN', pixKeyFallback });
    }

    // IMPORTANTE: o valor cobrado no Pix vem do pedido já salvo no banco (orderId),
    // nunca do "total" que o cliente manda — senão dá pra manipular o valor cobrado
    // pelo mesmo jeito que dava pra manipular o total do pedido.
    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (!orderId) {
      return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID', pixKeyFallback });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND', pixKeyFallback });
    }
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED', pixKeyFallback });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        ok: false,
        reason: 'INVALID_AMOUNT',
        pixKeyFallback
      });
    }

    const mpToken = String(doc.mp_token).trim();

    const payload = {
      transaction_amount: amount,
      description: 'Compra na VN Imports',
      payment_method_id: 'pix',
      payer: {
        email: req.body?.payerEmail || 'test@test.com'
      }
    };

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mpToken}`
      },
      body: JSON.stringify(payload)
    });

    const mpJson = await mpRes.json().catch(() => ({}));

    if (!mpRes.ok) {
      return res.status(502).json({
        ok: false,
        reason: 'MP_PAYMENT_CREATE_FAILED',
        mpStatus: mpRes.status,
        mpError: mpJson,
        pixKeyFallback
      });
    }

    const qrCode =
      mpJson?.point_of_interaction?.transaction_data?.qr_code ||
      mpJson?.point_of_interaction?.transaction_data?.qr_code_base64 ||
      mpJson?.qr_code ||
      mpJson?.qr_code_base64 ||
      '';

    const qrCodeBase64 =
      mpJson?.point_of_interaction?.transaction_data?.qr_code_base64 ||
      mpJson?.qr_code_base64 ||
      '';

    if (!qrCode && !qrCodeBase64) {
      return res.status(502).json({
        ok: false,
        reason: 'MP_QR_NOT_FOUND',
        mpPayment: mpJson,
        pixKeyFallback
      });
    }

    // Guarda o ID do pagamento no pedido para o webhook conseguir confirmar depois.
    if (mpJson?.id) {
      try {
        order.mpPaymentId = String(mpJson.id);
        await order.save();
      } catch (e) {
        console.warn('[pix/qr-mp] Falha ao salvar mpPaymentId no pedido:', e.message);
      }
    }

    // O front hoje usa apenas qrCode, mas retornamos também qrCodeBase64.
    return res.json({
      ok: true,
      qrCode,
      qrCodeBase64,
      pixKeyFallback
    });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'ERROR', pixKeyFallback: '' });
  }
});

/**
 * Webhook do Mercado Pago. Configure esta URL (https://SEU_DOMINIO/api/pix/webhook)
 * no painel do Mercado Pago em: Sua integração → Webhooks → Configurar notificações.
 * O MP chama essa rota quando o status de um pagamento muda (ex: Pix aprovado).
 * Aceita tanto o formato novo (body JSON com data.id) quanto o legado (query ?id=&topic=payment).
 */
app.post('/api/pix/webhook', async (req, res) => {
  // Responde 200 rápido mesmo se algo falhar depois — o MP reenvia notificações
  // que não recebem 200, e não queremos ficar recebendo o mesmo evento repetido
  // enquanto investigamos com calma via logs.
  res.status(200).json({ recebido: true });

  try {
    if (!(await tryConnectDb())) {
      console.warn('[pix/webhook] DB indisponível, notificação ignorada.');
      return;
    }

    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.id ||
      req.query?.['data.id'];

    const topic = req.body?.type || req.body?.topic || req.query?.topic;
    if (!paymentId || (topic && topic !== 'payment')) return;

    const settings = await Settings.findOne().lean();
    if (!temMpTokenSalvo(settings)) {
      console.warn('[pix/webhook] Sem mp_token configurado, não é possível confirmar pagamento.');
      return;
    }
    const mpToken = String(settings.mp_token).trim();

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${mpToken}` }
    });
    const mpJson = await mpRes.json().catch(() => ({}));
    if (!mpRes.ok) {
      console.warn('[pix/webhook] Falha ao consultar pagamento no MP:', mpJson);
      return;
    }

    if (mpJson?.status === 'approved') {
      const order = await Order.findOneAndUpdate(
        { mpPaymentId: String(paymentId), status: 'Pendente' },
        { status: 'Pago' },
        { new: true }
      );
      if (order) {
        console.log('[pix/webhook] Pedido', order._id.toString(), 'confirmado como Pago.');
      }
    }
    // outros status (rejected, cancelled, etc.) podem ser tratados aqui se necessário —
    // por ora deixamos o pedido como "Pendente" para revisão manual do admin.
  } catch (e) {
    console.error('[pix/webhook] Erro ao processar notificação:', e.message);
  }
});

// ── INICIAR SERVIDOR (LOCAL) ───────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
}

const lojaHtml = path.join(__dirname, 'VN_IMPORTS.html');

// Cacheia o template bruto do HTML em memória (o arquivo em si só muda com um novo deploy;
// os dados variáveis — cor, imagem, nome — são injetados a cada request por cima do cache).
let lojaHtmlTemplateCache = null;
function getLojaHtmlTemplate() {
  if (!lojaHtmlTemplateCache) {
    lojaHtmlTemplateCache = fs.readFileSync(lojaHtml, 'utf8');
  }
  return lojaHtmlTemplateCache;
}

function escapeParaAtributo(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeParaCss(v) {
  // Valores de cor devem ser simples (#hex, rgb(...), nome). Removemos qualquer coisa
  // que pudesse fechar a tag <style> mais cedo (defesa extra, mesmo sendo admin-controlado).
  return String(v || '').replace(/[<>"'`]/g, '').replace(/\/style/gi, '');
}

/**
 * Monta o HTML da vitrine já com a cor e a imagem do hero atuais do banco embutidas
 * — em vez de mandar o HTML com os valores padrão e trocar depois via JS (o que causava
 * aquele "flash" da cor/imagem antiga por uma fração de segundo a cada F5).
 * Se o banco estiver indisponível, devolve o template original sem quebrar a página.
 */
async function renderLojaHtmlComConfig() {
  let html = getLojaHtmlTemplate();
  try {
    const cfg = await buscarConfigCompleta();
    const nome = escapeParaAtributo(cfg?.nomeLoja);

    // Cores: só gold/gold2 podem realmente divergir do padrão já escrito no arquivo
    // (os outros tokens de cor sempre vêm do mesmo config.js embutido no HTML).
    const gold = escapeParaCss(cfg?.colors?.gold);
    const gold2 = escapeParaCss(cfg?.colors?.gold2);
    if (gold || gold2) {
      const overrideStyle =
        '<style>:root{' +
        (gold ? `--gold:${gold};` : '') +
        (gold2 ? `--gold2:${gold2};` : '') +
        '}</style>\n</head>';
      html = html.replace('</head>', overrideStyle);
    }

    // Imagem do hero: troca o src padrão pelo valor real salvo no banco.
    const heroUrl = escapeParaAtributo(cfg?.heroImagem);
    if (heroUrl) {
      html = html.replace(
        /(<img id="heroImage" alt="Imagem do Hero" src=")[^"]*(")/,
        `$1${heroUrl}$2`
      );
    }

    // Nome da loja: aparece em 6 lugares (logo do nav, rodapé, copyright), todos
    // marcados com data-loja="nome". Substitui todos de uma vez, evitando o flash
    // de "VN IMPORTS" (texto padrão do arquivo) para o nome real configurado.
    if (nome) {
      html = html.replace(/(<span data-loja="nome">)[^<]*(<\/span>)/g, `$1${nome}$2`);
    }

    // Título da página com o nome real da loja.
    const suf = escapeParaAtributo(cfg?.pageTitleSuffix);
    if (nome) {
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${nome}${suf ? ' — ' + suf : ''}</title>`);
    }
  } catch (e) {
    console.warn('renderLojaHtmlComConfig:', e.message);
  }
  return html;
}

const adminHtml = path.join(__dirname, 'admin.html');
let adminHtmlTemplateCache = null;
function getAdminHtmlTemplate() {
  if (!adminHtmlTemplateCache) {
    adminHtmlTemplateCache = fs.readFileSync(adminHtml, 'utf8');
  }
  return adminHtmlTemplateCache;
}

/**
 * Mesma lógica do renderLojaHtmlComConfig, mas para o admin.html: injeta o nome real
 * da loja no título e no logo da barra lateral antes de enviar, evitando o flash de
 * "VN IMPORTS" (nome padrão do arquivo) para o nome real configurado no banco.
 */
async function renderAdminHtmlComConfig() {
  let html = getAdminHtmlTemplate();
  try {
    const cfg = await buscarConfigCompleta();
    const nome = escapeParaAtributo(cfg?.nomeLoja);
    if (nome) {
      html = html.replace(/<title>[^<]*<\/title>/, `<title>Admin — ${nome}</title>`);
      html = html.replace(
        /<div class="sb-logo">[^<]*<span>/,
        `<div class="sb-logo">${nome}<span>`
      );
    }
  } catch (e) {
    console.warn('renderAdminHtmlComConfig:', e.message);
  }
  return html;
}

// SERVIR HTMLS
// Cache-Control: no-store em todas — o HTML agora é montado por request com dados
// do banco (cor, nome, imagem). Sem isso, navegador/CDN podem guardar uma cópia antiga
// e o site continua "preso" numa versão anterior mesmo depois de deployar a correção.
function semCacheHtml(res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

app.get('/', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig());
});
app.get('/index.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig());
});
app.get('/admin.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderAdminHtmlComConfig());
});
app.get('/VN_IMPORTS.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig());
});

// serve também a raiz do app estático (garante consistência)
app.get('/VN_IMPORTS', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig());
});

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}

// ── ROTA 404 (API) ──────────────────────────────────────
// Se nenhuma rota /api/* bateu até aqui, devolve JSON em vez de cair no 404 padrão.
app.use('/api', (req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada: ' + req.method + ' ' + req.originalUrl });
});

// ── TRATAMENTO DE ERRO GLOBAL ───────────────────────────
// Qualquer erro que escape de uma rota (ex: erro de CORS, JSON malformado no
// body, exceção não pega em algum middleware) cai aqui. Sem isso, o Vercel/Express
// devolve uma página de erro HTML genérica — o que faz o front mostrar sempre a
// mesma mensagem vaga, escondendo a causa real. Agora sempre volta como JSON.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isCors = /CORS/i.test(err?.message || '');
  const status = isCors ? 403 : err?.status || 500;
  if (!isCors) console.error('[erro não tratado]', err?.stack || err?.message || err);
  res.status(status).json({ erro: err?.message || 'Erro interno do servidor.' });
});

module.exports = app;
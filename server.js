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

const configPadrao = require('./config');
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
        // Mercado Pago não publica uma lista oficial fechada de domínios pra CSP
        // (pesquisado: não existe página de docs dedicada a isso). Na prática o
        // SDK de cartão (tokenização/Secure Fields) usa os três domínios do
        // grupo Mercado Pago/Mercado Livre — mercadopago.com, mercadolibre.com
        // (iframe e imagem de antifraude) e mlstatic.com (assets estáticos do
        // SDK) — liberados por subdomínio (https://*.dominio.com), não um
        // wildcard genérico: não abre nenhum domínio fora desses 3, que são do
        // próprio Mercado Pago.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://*.mercadopago.com', 'https://*.mercadolibre.com', 'https://*.mlstatic.com'],
        // O site usa dezenas de onclick="" inline no HTML (VN_IMPORTS.html e admin.html).
        // CSP trata isso como uma diretiva separada de <script>; sem isso, todo botão
        // com onclick inline fica bloqueado silenciosamente no console do navegador.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com', 'https://images.unsplash.com', 'https://*.mercadopago.com', 'https://*.mercadolibre.com', 'https://*.mlstatic.com'],
        // Não existia antes: sem frame-src, o iframe de Secure Fields que a
        // tokenização de cartão abre (em mercadolibre.com) caía no default-src
        // 'self' e era bloqueado — era isso que travava o pagamento com cartão.
        frameSrc: ["'self'", 'https://*.mercadopago.com', 'https://*.mercadolibre.com'],
        // viacep.com.br: o autofill de endereço no checkout chama isso direto do
        // navegador (fetch), diferente da cotação de frete, que passa pelo
        // servidor (/api/frete/calcular, same-origin) — sem essa liberação o CSP
        // bloqueia a chamada silenciosamente, sem erro nenhum visível pro usuário.
        // *.mercadopago.com/*.mercadolibre.com/*.mlstatic.com: o SDK de cartão
        // chama vários subdomínios desses 3 domínios direto do navegador (token
        // de cartão + antifraude) — mesmo raciocínio do viacep.com.br.
        connectSrc: ["'self'", 'https://viacep.com.br', 'https://*.mercadopago.com', 'https://*.mercadolibre.com', 'https://*.mlstatic.com'],
        // Reporta ao servidor qualquer violação de CSP que ainda ocorrer (log via
        // POST /api/csp-report), pra não depender do cliente ter o console aberto
        // pra a gente descobrir o próximo domínio que falta liberar.
        reportUri: ['/api/csp-report']
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

// Endpoint de diagnóstico: o navegador envia aqui (via report-uri na CSP acima)
// qualquer violação de CSP que ocorrer, mesmo em produção — só loga no console
// do servidor (visível nos logs da Vercel), não bloqueia nem armazena nada.
// Content-Type é application/csp-report, por isso o parser dedicado abaixo.
app.post(
  '/api/csp-report',
  express.json({ type: ['application/json', 'application/csp-report'] }),
  (req, res) => {
    const relatorio = req.body && req.body['csp-report'] ? req.body['csp-report'] : req.body;
    console.warn('[CSP] Violação reportada:', JSON.stringify(relatorio));
    res.status(204).end();
  }
);

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
      let tenantTag = slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja);
      try {
        if (await tryConnectDb()) {
          const cfg = await Config.findOne().lean();
          tenantTag = slugifyTenantTag(
            cfg?.clienteTag || cfg?.nomeLoja || configPadrao.clienteTag || configPadrao.nomeLoja
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
    sizes: { type: [String], default: [] },
    // Peso/dimensões REAIS do produto pra cotação de frete — conceito
    // diferente de `sizes` acima: sizes é o que o cliente escolhe (P/M/G),
    // isto aqui é o que a transportadora cobra pra despachar a caixa. Um
    // mesmo produto pode ter os dois, sem relação entre eles.
    // null = não cadastrado. Não bloqueia o cadastro/edição do produto (o
    // lojista pode cadastrar sem esse dado), mas bloqueia a VENDA — ver
    // resolverDadosEnvioProduto: sem peso/dimensão próprios nem um padrão da
    // loja configurado (Config.pesoKgPadrao etc.), o produto não entra no
    // carrinho nem em POST /api/orders. Nunca cai num número fixo genérico —
    // foi exatamente isso que fez o frete sair errado pra todo produto antes
    // desta mudança.
    pesoKg: { type: Number, default: null },
    larguraCm: { type: Number, default: null },
    alturaCm: { type: Number, default: null },
    comprimentoCm: { type: Number, default: null },
    // Sinônimos que o lojista escreve pra própria loja (ex: um produto
    // "Jaqueta" pode listar "casaco, blusa de frio") — entram na busca por
    // trecho junto de nome/categoria/descrição (ver GET /api/produtos/search).
    // Opcional de propósito: produto sem palavra-chave nenhuma continua
    // aparecendo normalmente pelos outros campos, isto só amplia o alcance.
    palavrasChave: { type: [String], default: [] }
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
    mp_public_key: { type: String, default: '' },
    me_token: { type: String, default: '' },
    pix_key: { type: String, default: '' },
    // Segredo do webhook (Mercado Pago → Sua integração → Webhooks). Usado só
    // pra validar o header x-signature em /api/pix/webhook — nunca devolvido
    // ao front (mesmo padrão de mp_token/me_token, ver mergePublicSettings).
    mp_webhook_secret: { type: String, default: '' }
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
          tamanhoSelecionado: { type: String, default: '' },
          // productId + estoqueDecrementado guardam, por item, se aquela linha
          // de fato debitou estoque real na criação do pedido (produto com
          // controle de estoque ativo) — é o que permite devolver estoque
          // corretamente depois (ver devolverEstoqueDoPedido), sem depender do
          // estado atual do Produto (que pode ter mudado entre a compra e a
          // devolução).
          productId: { type: String, default: '' },
          estoqueDecrementado: { type: Boolean, default: false }
        }
      ],
      default: []
    },
    total: { type: Number, required: true },
    cep: { type: String, default: '' },
    // Endereço de entrega + contato do cliente. Número e complemento nunca
    // vêm do CEP (ViaCEP não devolve isso) — sempre digitados no checkout.
    // Todos obrigatórios e validados em POST /api/orders antes de qualquer
    // decremento de estoque; pedidos criados antes desta mudança não têm
    // esses campos (default '' cobre a leitura, não quebra o admin).
    rua: { type: String, default: '' },
    numero: { type: String, default: '' },
    complemento: { type: String, default: '' },
    bairro: { type: String, default: '' },
    cidade: { type: String, default: '' },
    estado: { type: String, default: '' },
    email: { type: String, default: '' },
    telefone: { type: String, default: '' },
    cpf: { type: String, default: '' },
    // Frete escolhido no checkout — valor sempre revalidado no servidor
    // (ver /api/orders), nunca aceito cru do que o cliente mandou.
    frete: { type: Number, default: 0 },
    freteNome: { type: String, default: '' },
    freteEmpresa: { type: String, default: '' },
    status: { type: String, default: 'Pendente' },
    // ID do pagamento no Mercado Pago, salvo quando o QR Pix é gerado.
    // Usado pelo webhook (/api/pix/webhook) para confirmar o pagamento e atualizar o status.
    mpPaymentId: { type: String, default: '' },
    // Trava de idempotência: true assim que o estoque deste pedido já foi
    // devolvido (abandono via cron ou cancelamento manual pelo admin). Nunca
    // devolvido duas vezes — ver devolverEstoqueDoPedido.
    estoqueRevertido: { type: Boolean, default: false },
    // null = ainda tem CPF/e-mail/telefone/endereço reais. Data = quando os
    // dados pessoais deste pedido foram removidos (retenção por idade,
    // abandono nunca pago, ou pedido de exclusão do titular — ver
    // camposAnonimizacaoPedido). Também serve de trava de idempotência: uma
    // vez preenchido, as rotinas de expurgo pulam este pedido.
    anonimizadoEm: { type: Date, default: null }
  },
  { timestamps: true }
);

const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// Temas de fundo pré-calibrados pro painel admin (white-label). De propósito
// NÃO é um campo de hex livre como corPrimaria/corSecundaria: --bg também é
// reaproveitado como cor de TEXTO em dezenas de lugares (rodapé, botões no
// hover, badges) sempre que a superfície por trás é escura — um hex qualquer
// escolhido "só pensando em fundo" pode deixar esse texto ilegível sem
// nenhum aviso. bg/bg2/border sempre mudam juntos porque foram calibrados
// visualmente em conjunto (trocar só o --bg deixa cards e divisórias com
// contraste estranho contra o fundo novo). Espelhado em admin.html — mantenha
// os dois catálogos em sincronia se adicionar/mudar um tema.
const TEMAS_FUNDO = {
  creme: { nome: 'Creme Clássico', bg: '#F0E9DC', bg2: '#E8DCC7', border: '#C9B896' },
  gelo: { nome: 'Branco Gelo', bg: '#E8ECF1', bg2: '#DCE3EB', border: '#B8C4D4' },
  rose: { nome: 'Rosé Suave', bg: '#F3E1DD', bg2: '#EDD3CD', border: '#D1A79C' },
  salvia: { nome: 'Verde Sálvia', bg: '#E5EADC', bg2: '#DAE1CB', border: '#AFBE96' },
  neblina: { nome: 'Azul Névoa', bg: '#E1E8EF', bg2: '#D4DEE9', border: '#A8BDD1' }
};

// Catálogo pré-calibrado pra cor do painel de texto do hero (o bloco
// --hero-panel-bg à esquerda, ver VN_IMPORTS.html) — mesmo princípio do
// TEMAS_FUNDO acima: nunca um hex livre, porque texto branco sobre uma cor
// de marca livre (gold/gold2) já reprova contraste na configuração padrão do
// próprio template (medido: ~2.37:1). Todos os 5 tons são escuros e
// dessaturados de propósito — passam AA com folga (pior caso medido:
// 11.56:1) e não ficam "sujos" sob a barra de benefícios flutuante logo
// abaixo do hero, que tem um véu creme translúcido fixo (rgba, não var(--bg))
// independente do tema de fundo escolhido. Token isolado (--hero-panel-bg,
// não --ink): trocar essa cor não pode mudar rodapé/botões/badges, que
// reaproveitam --ink em ~24 lugares fora do hero.
const TEMAS_HERO = {
  preto: { nome: 'Preto Absoluto', cor: '#111111' },
  grafite: { nome: 'Grafite', cor: '#2B2B2B' },
  marinho: { nome: 'Azul-Marinho', cor: '#16233A' },
  verde: { nome: 'Verde Floresta', cor: '#223326' },
  vinho: { nome: 'Vinho', cor: '#3B1B24' }
};

const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: configPadrao.nomeLoja },
  chavePix: { type: String, default: '' },
  corPrimaria: { type: String, default: configPadrao.corPrimaria },
  corSecundaria: { type: String, default: configPadrao.corSecundaria },
  // Chave de um tema pré-calibrado em TEMAS_FUNDO — nunca um hex livre (ver
  // comentário acima do catálogo).
  temaFundo: { type: String, default: 'creme' },
  // Chave de um tom pré-calibrado em TEMAS_HERO (cor do painel de texto do
  // hero) — mesmo princípio do temaFundo acima, nunca hex livre. Default vem
  // de configPadrao (config.js), mesmo padrão de usaTamanhosPadrao: cada
  // implantação pode nascer com outro tom sem afetar lojas já em produção.
  corPainelHero: { type: String, default: TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto' },
  whatsappContato: { type: String, default: configPadrao.whatsappContato },
  instagramLink: { type: String, default: configPadrao.instagramLink },
  emailContato: { type: String, default: configPadrao.emailContato },
  clienteTag: { type: String, default: slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja) },
  // Cidade do lojista — exigida pelo padrão do Pix (BR Code) no Copia e Cola.
  cidadeLoja: { type: String, default: 'SAO PAULO' },
  // CEP de origem (remetente) usado nas cotações do Melhor Envio. Vazio =
  // painel nunca foi usado pra isso — nesse caso o valor efetivo (calculado
  // em mergePublicConfig) cai pra LOJA_CEP_ORIGEM (.env) ou cepOrigem do
  // config.js. Assim que o admin salva algo aqui, esse valor manda, sempre —
  // ver comentário em mergePublicConfig sobre a precedência.
  cepOrigem: { type: String, default: '' },
  // Sufixo do <title> (ex: "Nome da Loja — Loja Oficial"), usado em SEO.
  // Vazio = painel nunca foi usado pra isso — mesmo padrão do cepOrigem
  // acima: o valor efetivo cai pro pageTitleSuffix do config.js, e se
  // também estiver vazio, num fallback fixo neutro.
  pageTitleSuffix: { type: String, default: '' },
  // CNPJ da loja — exigido nas páginas legais (Política de Privacidade,
  // Termos de Uso, Devolução). Não existe fallback nenhum pra isso
  // (config.js não tem CNPJ de propósito — branco-de-loja não pode chumbar
  // documento de empresa): vazio aqui é vazio nas páginas, com aviso pro
  // lojista completar, não um número inventado.
  cnpj: { type: String, default: '' },
  // Prazo (em anos) até um pedido PAGO ser anonimizado (ver
  // /api/cron/anonimizar-pedidos-antigos). null = painel nunca configurado —
  // usa RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK. 5 anos é referência provisória
  // (CTN art. 173), não parecer jurídico/contábil — mantido configurável
  // aqui de propósito pra ajustar sem redeploy assim que confirmado com o
  // contador do lojista.
  retencaoPedidosPagosAnos: { type: Number, default: null },

  // Peso/dimensões padrão da loja, usados só quando um produto específico
  // não tem os próprios cadastrados (ver resolverDadosEnvioProduto) — reduz
  // trabalho de cadastro pra loja com produtos de peso parecido. null em
  // qualquer um destes = sem padrão definido; nesse caso um produto sem dado
  // próprio fica bloqueado pra venda, não usa nenhum valor inventado.
  pesoKgPadrao: { type: Number, default: null },
  larguraCmPadrao: { type: Number, default: null },
  alturaCmPadrao: { type: Number, default: null },
  comprimentoCmPadrao: { type: Number, default: null },

  // Mostra ou não os atalhos de tamanho P/M/G/GG no cadastro de produto do
  // admin — branco-de-loja: nem toda loja vende roupa/calçado. Default vem
  // de configPadrao (config.js), não de um true fixo, pra cada implantação
  // poder nascer já com o valor certo pro segmento do cliente.
  usaTamanhosPadrao: { type: Boolean, default: configPadrao.usaTamanhosPadrao !== false },

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
  // Textos do hero (título, selo "Coleção Exclusiva" e subtítulo). Vazio = mantém
  // o texto padrão já escrito no HTML (o front só sobrescreve quando vier algo).
  heroTitle: { type: String, default: '' },
  heroFont: { type: String, default: '' },
  heroEyebrow: { type: String, default: '' },
  heroSubtitulo: { type: String, default: '' },

  // ✅ NOVO: Configurações dinâmicas de conteúdo do site (Admin → vitrine)
  // Default vem de configPadrao (config.js), mesmo padrão de nomeLoja/corPrimaria
  // acima — não um texto de cliente específico chumbado no schema.
  sobreTitulo: { type: String, default: configPadrao.sobreTitulo },
  sobreTexto: { type: String, default: configPadrao.sobreTexto },

  // Benefício 1: Entrega Rápida
  benef1Titulo: { type: String, default: 'Entrega Rápida' },
  benef1Texto: { type: String, default: 'Receba em até 3 dias úteis. Frete grátis acima de R$299.' },
  benef1IcoEnabled: { type: Boolean, default: true },
  benef1Ico: { type: String, default: '🚚' },

  // Benefício 2: Devolução em 7 Dias (direito de arrependimento, CDC art. 49
  // — nunca "troca": a loja não promete trocar produto por outro tamanho/cor,
  // só devolver dentro do prazo legal. Ver /devolucao.html.)
  benef2Titulo: { type: String, default: 'Devolução em 7 Dias' },
  benef2Texto: { type: String, default: 'Direito de arrependimento garantido por lei.' },
  benef2IcoEnabled: { type: Boolean, default: true },
  benef2Ico: { type: String, default: '↩️' },

  // Benefício 3: Pagamento Seguro
  benef3Titulo: { type: String, default: 'Pagamento Seguro' },
  benef3Texto: { type: String, default: 'PIX com total segurança.' },
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
    // mp_public_key é, por natureza, uma chave pública (usada no SDK do MP
    // direto no navegador pra tokenizar cartão) — diferente de mp_token/
    // me_token, que são credenciais e nunca devem sair daqui.
    mp_public_key: doc?.mp_public_key != null ? String(doc.mp_public_key).trim() : ''
  };
}

// Referência provisória (CTN art. 173 — prazo de 5 anos que a Receita tem
// pra constituir crédito tributário), NÃO parecer jurídico/contábil. Usado só
// como fallback até o lojista confirmar o prazo certo com o contador dele
// (varia por regime tributário) e salvar um valor no painel — ver
// retencaoPedidosPagosAnos no ConfigSchema e /api/cron/anonimizar-pedidos-antigos.
const RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK = 5;

function mergePublicConfig(doc) {
  const nomeDb = doc?.nomeLoja?.trim();
  const pixDb = doc?.chavePix != null ? String(doc.chavePix).trim() : '';
  const corPrimaria = String(doc?.corPrimaria || configPadrao.corPrimaria || '').trim();
  const corSecundaria = String(doc?.corSecundaria || configPadrao.corSecundaria || '').trim();
  const cepOrigemSalvo = doc?.cepOrigem ? String(doc.cepOrigem).replace(/\D/g, '') : '';
  const cepOrigemEfetivo =
    cepOrigemSalvo ||
    String(process.env.LOJA_CEP_ORIGEM || configPadrao.cepOrigem || '01310100').replace(/\D/g, '');
  // Mesmo padrão do cepOrigem acima: painel > config.js > fallback fixo.
  const pageTitleSuffixSalvo = doc?.pageTitleSuffix ? String(doc.pageTitleSuffix).trim() : '';
  const pageTitleSuffixEfetivo =
    pageTitleSuffixSalvo || String(configPadrao.pageTitleSuffix || 'Loja Oficial').trim();
  // Mesmo padrão de painel > fallback fixo dos campos acima — aqui o fallback
  // é RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK (ver comentário na constante).
  const retencaoPedidosPagosAnosSalvo =
    doc?.retencaoPedidosPagosAnos != null && Number.isFinite(Number(doc.retencaoPedidosPagosAnos)) && Number(doc.retencaoPedidosPagosAnos) > 0
      ? Number(doc.retencaoPedidosPagosAnos)
      : null;
  const retencaoPedidosPagosAnosEfetivo =
    retencaoPedidosPagosAnosSalvo || RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK;
  // CNPJ não tem fallback nenhum (ver comentário no schema) — só o que o
  // painel salvou, ou vazio mesmo, pras páginas legais saberem mostrar um
  // aviso de "complete isso" em vez de inventar um número.
  const cnpjSalvo = doc?.cnpj ? String(doc.cnpj).replace(/\D/g, '') : '';
  // Sem terceiro degrau de fallback aqui de propósito (diferente do cepOrigem
  // acima) — um peso/dimensão inventado é exatamente o bug que motivou essa
  // mudança inteira. null = sem padrão definido, e é isso mesmo.
  const numeroPositivoOuNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const pesoKgPadrao = numeroPositivoOuNull(doc?.pesoKgPadrao);
  const larguraCmPadrao = numeroPositivoOuNull(doc?.larguraCmPadrao);
  const alturaCmPadrao = numeroPositivoOuNull(doc?.alturaCmPadrao);
  const comprimentoCmPadrao = numeroPositivoOuNull(doc?.comprimentoCmPadrao);
  // Só aceita chave conhecida do catálogo — nunca um valor arbitrário vindo do banco.
  const temaFundoKey = TEMAS_FUNDO[doc?.temaFundo] ? doc.temaFundo : 'creme';
  const temaFundo = TEMAS_FUNDO[temaFundoKey];
  const corPainelHeroFallback = TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto';
  const corPainelHeroKey = TEMAS_HERO[doc?.corPainelHero] ? doc.corPainelHero : corPainelHeroFallback;
  const corPainelHero = TEMAS_HERO[corPainelHeroKey];
  const colorsMerged = {
    ...(configPadrao.colors || {}),
    bg: temaFundo.bg,
    bg2: temaFundo.bg2,
    border: temaFundo.border,
    // Chave literal igual ao sufixo da CSS custom property (--hero-panel-bg)
    // de propósito: aplicarCoresDaLoja() no client faz 'root.style.setProperty
    // ("--" + chave, valor)' sem nenhuma conversão de camelCase pra
    // kebab-case — uma chave "heroPanelBg" geraria "--heroPanelBg", que não
    // bate com nada no CSS, e o valor nunca apareceria.
    'hero-panel-bg': corPainelHero.cor,
    ...(corPrimaria ? { gold: corPrimaria } : {}),
    ...(corSecundaria ? { gold2: corSecundaria } : {})
  };

  const bool = (v, dflt) => {
    if (v === undefined) return dflt;
    return !!v;
  };

  return {
    nomeLoja: nomeDb || configPadrao.nomeLoja,
    chavePix: pixDb || (configPadrao.chavePix || '').trim(),
    corPrimaria,
    corSecundaria,
    temaFundo: temaFundoKey,
    corPainelHero: corPainelHeroKey,
    whatsappContato: String(doc?.whatsappContato || configPadrao.whatsappContato || '').trim(),
    instagramLink: String(doc?.instagramLink || configPadrao.instagramLink || '').trim(),
    emailContato: String(doc?.emailContato || configPadrao.emailContato || '').trim(),
    clienteTag: slugifyTenantTag(doc?.clienteTag || doc?.nomeLoja || configPadrao.clienteTag || configPadrao.nomeLoja),
    cidadeLoja: String(doc?.cidadeLoja || '').trim().toUpperCase() || 'SAO PAULO',
    // cepOrigem: valor cru salvo pelo painel (vazio = nunca configurado por lá).
    // cepOrigemEfetivo: o que de fato é usado pra cotar frete agora, seguindo a
    // ordem painel > LOJA_CEP_ORIGEM (.env) > cepOrigem do config.js > fallback
    // fixo. Precedência intencional: uma vez que o admin salva um CEP aqui,
    // esse valor manda para sempre — o .env só serve pra inicializar uma loja
    // nova antes do primeiro save, nunca mais depois disso. Os dois campos
    // juntos permitem o painel avisar o lojista quando o valor em uso não é
    // o que está (ou não está) salvo ali, em vez de uma divergência muda.
    cepOrigem: cepOrigemSalvo,
    cepOrigemEfetivo,
    colors: colorsMerged,
    // pageTitleSuffix: valor cru salvo pelo painel (vazio = nunca configurado
    // por lá). pageTitleSuffixEfetivo: o que de fato entra no <title> agora —
    // mesma lógica de precedência do cepOrigem, sem o rung do .env (não faz
    // sentido pra esse campo).
    pageTitleSuffix: pageTitleSuffixSalvo,
    pageTitleSuffixEfetivo,
    cnpj: cnpjSalvo,
    retencaoPedidosPagosAnos: retencaoPedidosPagosAnosSalvo,
    retencaoPedidosPagosAnosEfetivo,
    pesoKgPadrao,
    larguraCmPadrao,
    alturaCmPadrao,
    comprimentoCmPadrao,

    // Textos do hero — vazio de propósito quando não configurado no admin,
    // pra o front saber que deve preservar o texto padrão já no HTML.
    heroTitle: String(doc?.heroTitle ?? '').trim(),
    heroFont: String(doc?.heroFont ?? '').trim(),
    heroEyebrow: String(doc?.heroEyebrow ?? '').trim(),
    heroSubtitulo: String(doc?.heroSubtitulo ?? '').trim(),

    // Conteúdo (About + Benefícios)
    sobreTitulo: String(doc?.sobreTitulo ?? '').trim() || configPadrao.sobreTitulo,
    sobreTexto: String(doc?.sobreTexto ?? '').trim() || configPadrao.sobreTexto,

    benef1Titulo: String(doc?.benef1Titulo ?? '').trim() || 'Entrega Rápida',
    benef1Texto: String(doc?.benef1Texto ?? '').trim() || 'Receba em até 3 dias úteis. Frete grátis acima de R$299.',
    benef1IcoEnabled: bool(doc?.benef1IcoEnabled, true),
    benef1Ico: String(doc?.benef1Ico ?? '').trim() || '🚚',

    benef2Titulo: String(doc?.benef2Titulo ?? '').trim() || 'Devolução em 7 Dias',
    benef2Texto: String(doc?.benef2Texto ?? '').trim() || 'Direito de arrependimento garantido por lei.',
    benef2IcoEnabled: bool(doc?.benef2IcoEnabled, true),
    benef2Ico: String(doc?.benef2Ico ?? '').trim() || '↩️',

    benef3Titulo: String(doc?.benef3Titulo ?? '').trim() || 'Pagamento Seguro',
    benef3Texto: String(doc?.benef3Texto ?? '').trim() || 'PIX com total segurança.',
    benef3IcoEnabled: bool(doc?.benef3IcoEnabled, true),
    benef3Ico: String(doc?.benef3Ico ?? '').trim() || '🔒',

    benef4Titulo: String(doc?.benef4Titulo ?? '').trim() || 'Importado Selecionado',
    benef4Texto: String(doc?.benef4Texto ?? '').trim() || 'Curadoria rigorosa de produtos internacionais.',
    benef4IcoEnabled: bool(doc?.benef4IcoEnabled, true),
    benef4Ico: String(doc?.benef4Ico ?? '').trim() || '💎',

    // Barra de anúncio: só mostra o que o admin realmente ativou.
    usaTamanhosPadrao: bool(doc?.usaTamanhosPadrao, configPadrao.usaTamanhosPadrao !== false),

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

function escapeRegexEspecial(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deixa a busca tolerante a acento (ex: "relogio" encontra "Relógio") sem
// precisar de índice de texto ($text) nem normalizar/migrar os dados já
// salvos no banco: expande cada letra digitada numa classe de caracteres
// que cobre também suas variantes acentuadas.
const MAPA_ACENTOS_BUSCA = { a: 'aàáâãä', e: 'eèéêë', i: 'iìíîï', o: 'oòóôõö', u: 'uùúûü', c: 'cç', n: 'nñ' };
function regexBuscaSemAcento(q) {
  const semAcento = String(q || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const escapado = escapeRegexEspecial(semAcento);
  return escapado.replace(/[a-z]/g, (ch) => {
    const variantes = MAPA_ACENTOS_BUSCA[ch];
    return variantes ? `[${variantes}]` : ch;
  });
}

/**
 * Distância de Damerau-Levenshtein (Levenshtein + transposição de letras
 * adjacentes como 1 edição só, não 2) — usada só no fallback por
 * similaridade abaixo. Escolhida especificamente por causa da transposição:
 * testado antes de implementar, Levenshtein puro não pegava um padrão comum
 * de digitação (ex: "blsua" por "blusa", letras trocadas de lugar).
 */
function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

function normalizarBusca(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

function similaridadeTexto(a, b) {
  const na = normalizarBusca(a), nb = normalizarBusca(b);
  if (!na || !nb) return 0;
  const dist = damerauLevenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - dist / maxLen;
}

// Testado contra pares reais antes de escolher este número: erros de
// digitação típicos ("camsa"/"camisa", "blsua"/"blusa") ficam em 0.80-0.86;
// palavras genuinamente diferentes ("camisa"/"calça", "casaco"/"jaqueta",
// "bolsa"/"bota") ficam em 0.00-0.60. 0.75 separa os dois grupos com folga
// real, não um corte torcido pra caber nos exemplos testados.
const LIMIAR_SIMILARIDADE_BUSCA = 0.75;

// Teto do lote candidato no fallback por similaridade — evita varrer o
// catálogo inteiro sem limite nenhum. Suficiente pra uma loja pequena/média;
// catálogo muito maior que isso é um problema pra reconsiderar depois, não
// pra resolver preventivamente agora.
const TETO_CANDIDATOS_FUZZY = 2000;

/**
 * Fallback só usado quando a busca por trecho (nome/categoria/descrição/
 * palavrasChave) não encontra nada — nunca dilui um resultado que já existe,
 * só entra em ação quando não há nada melhor pra mostrar (evita o problema
 * oposto: "camisa" trazendo calça junto). Roda inteiro em memória, sem
 * nenhum recurso de busca do banco (funciona igual em qualquer tier do
 * MongoDB) e sem montar filtro nenhum a partir do texto do cliente — o
 * texto digitado nunca chega perto de uma query do Mongo aqui, só é
 * comparado como string depois de um find() fixo.
 */
async function buscarPorSimilaridade(q, limit, skip) {
  const palavrasQuery = normalizarBusca(q).split(/\s+/).filter(Boolean);
  if (!palavrasQuery.length) return [];

  const candidatos = await Produto.find({}).sort({ createdAt: -1 }).limit(TETO_CANDIDATOS_FUZZY).lean();

  const pontuados = candidatos
    .map((p) => {
      const palavrasProduto = [
        ...String(p.nome || '').split(/\s+/),
        ...String(p.categoria || '').split(/\s+/),
        ...(Array.isArray(p.palavrasChave) ? p.palavrasChave : [])
      ].filter(Boolean);

      if (!palavrasProduto.length) return null;

      // Exige que TODA palavra da busca tenha uma correspondência razoável
      // em alguma palavra do produto (nome/categoria/palavra-chave) — busca
      // de duas palavras só bate se as duas encontrarem algo, não só uma.
      let somaScores = 0;
      for (const palavraQuery of palavrasQuery) {
        let melhor = 0;
        for (const palavraProduto of palavrasProduto) {
          const s = similaridadeTexto(palavraQuery, palavraProduto);
          if (s > melhor) melhor = s;
        }
        if (melhor < LIMIAR_SIMILARIDADE_BUSCA) return null;
        somaScores += melhor;
      }
      return { produto: p, score: somaScores / palavrasQuery.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return pontuados.slice(skip, skip + limit).map((x) => x.produto);
}

// Precisa vir antes de '/api/produtos/:id' — senão o Express casa "search" como
// se fosse o :id, e o findById("search") quebra com CastError (500).
app.get('/api/produtos/search', async (req, res) => {
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

app.post('/api/produtos', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const { nome, preco, sizes, palavrasChave, pesoKg, larguraCm, alturaCm, comprimentoCm } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!preco || isNaN(preco)) return res.status(400).json({ erro: 'Preço inválido' });

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
      ...campos
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
    const { nome, preco, imagem, imagens, descricao, categoria, estoque, sizes, palavrasChave, pesoKg, larguraCm, alturaCm, comprimentoCm } = req.body;

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

// Árvore de categorias (consumida pelo Mega Menu do site e do produto).
// O schema de Category hoje é flat (sem campo "parent" — não existe UI de
// subcategoria no admin), então cada categoria vira uma raiz sem filhos;
// o front já trata "sem children" tornando o próprio título clicável.
app.get('/api/categories/tree', async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Category.find().sort({ nome: 1 }).lean();
    const tree = list.map(c => ({ ...c, children: [] }));
    res.json(tree);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao montar árvore de categorias', detalhe: err.message });
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
    const mp_public_key = req.body?.mp_public_key != null ? String(req.body.mp_public_key).trim() : '';
    const me_token = req.body?.me_token != null ? String(req.body.me_token).trim() : '';
    const pix_key = req.body?.pix_key != null ? String(req.body.pix_key).trim() : '';
    const mp_webhook_secret = req.body?.mp_webhook_secret != null ? String(req.body.mp_webhook_secret).trim() : '';

    // mp_token/me_token/mp_webhook_secret nunca voltam pro formulário do admin
    // (o valor salvo fica escondido por segurança) — então um valor vazio aqui
    // é ambíguo: pode ser "sem token" ou só "não mexi nesse campo agora". Por
    // isso só sobrescrevemos quando vier algo de fato preenchido, e usamos
    // $set (nunca um objeto de substituição direta) pra essa atualização
    // nunca apagar campos que não fazem parte deste payload.
    // pix_key entra na mesma regra dos tokens acima (achado de auditoria: uma
    // falha ao carregar a página deixava esse campo em branco, indistinguível
    // de "lojista limpou de propósito", e salvar nesse estado apagava a chave
    // Pix real — quebra silenciosa de recebimento). mp_public_key não é
    // segredo e continua sempre aplicado — é o mesmo texto que já aparece
    // preenchido no formulário, sem essa ambiguidade.
    const dados = { mp_public_key };
    if (pix_key) dados.pix_key = pix_key;
    if (mp_token) dados.mp_token = mp_token;
    if (me_token) dados.me_token = me_token;
    if (mp_webhook_secret) dados.mp_webhook_secret = mp_webhook_secret;

    const updated = await Settings.findOneAndUpdate(
      {},
      { $set: dados },
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

/**
 * Campos de dado pessoal zerados na anonimização de um pedido — usado tanto
 * pra pedido nunca pago (devolverEstoqueDoPedido, abaixo) quanto pra pedido
 * pago velho (ver /api/cron/anonimizar-pedidos-antigos) e pra pedido de
 * exclusão sob demanda de um comprador específico (ver
 * /api/admin/orders/anonimizar-comprador). Mantém tudo que tem valor de
 * histórico de vendas — total, items, frete, status — e generaliza em vez de
 * apagar cidade/estado: sozinhos, sem rua/número/CEP, não identificam
 * ninguém, mas ainda dão pro lojista análise regional de vendas.
 */
function camposAnonimizacaoPedido() {
  return {
    customerName: '',
    email: '',
    telefone: '',
    cpf: '',
    rua: '',
    numero: '',
    complemento: '',
    bairro: '',
    cep: '',
    anonimizadoEm: new Date()
  };
}

/**
 * Devolve ao estoque os itens de um pedido que nunca foi pago — abandono
 * detectado pelo cron (ver /api/cron/liberar-estoque-pendente) ou cancelamento
 * manual do admin (ver PUT /api/orders/:id). Sem isso, todo pedido 'Pendente'
 * que o cliente desiste (aba fechada, Pix expirado, cartão recusado) prende o
 * estoque decrementado na criação pra sempre — ver rollbackStock acima, que só
 * cobre falha DENTRO da própria criação do pedido, não abandono depois dela.
 *
 * Também anonimiza o pedido nesse mesmo momento: um pedido nunca pago não
 * gerou venda nem documento fiscal nenhum, então não há razão pra guardar
 * CPF/endereço dele nem um dia além do necessário pra confirmar que ele não
 * vai virar venda. Isso nunca acontece com Pago->Cancelado (reembolso depois
 * do envio, por exemplo) — esse caso não passa por aqui, ver PUT /api/orders/:id.
 *
 * Idempotente e seguro contra corrida: o findOneAndUpdate abaixo só "ganha" o
 * direito de devolver quem conseguir marcar estoqueRevertido false->true
 * primeiro — atômico por documento no Mongo, então mesmo que essa função seja
 * chamada duas vezes pro mesmo pedido (cron sobreposto, clique duplo do admin)
 * apenas uma delas de fato incrementa o estoque (e anonimiza).
 *
 * Só incrementa itens com estoqueDecrementado:true (gravado na criação do
 * pedido) — produtos com controle de estoque desativado (estoque:null) nunca
 * foram decrementados, então nunca são tocados aqui.
 */
async function devolverEstoqueDoPedido(orderId, novoStatus) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, estoqueRevertido: { $ne: true } },
    { $set: { estoqueRevertido: true, status: novoStatus, ...camposAnonimizacaoPedido() } },
    { new: false }
  );
  if (!order) return false; // já tinha sido revertido, ou pedido não existe

  for (const item of order.items || []) {
    if (!item.estoqueDecrementado || !item.productId) continue;
    try {
      await Produto.findByIdAndUpdate(item.productId, { $inc: { estoque: item.qty } });
    } catch (e) {
      console.error('[orders] Falha ao devolver estoque de', item.productId, '-', e.message);
    }
  }
  return true;
}

// Orders
/**
 * customerName vem do checkout sem autenticação nenhuma — era o único campo
 * de pedido renderizado no admin sem escape (achado de auditoria: permitia
 * XSS armazenado só de completar um pedido, sem nem precisar pagar). A defesa
 * real contra XSS é escapar na exibição (corrigido em admin.html), não aqui —
 * mas cortar caracteres sem uso legítimo num nome de pessoa (controle, < e >)
 * e limitar o tamanho reduz o que qualquer consumidor futuro desse dado
 * (relatório, exportação, e-mail automático) precisa se preocupar em escapar,
 * sem arriscar corromper nomes reais: acentos, apóstrofo e hífen (comuns em
 * nomes de verdade) continuam intactos.
 */
function sanitizarNomeCliente(nome) {
  const semControleNemAngulo = Array.from(String(nome || ''))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code > 31 && code !== 127 && ch !== '<' && ch !== '>';
    })
    .join('');
  return semControleNemAngulo.trim().slice(0, 120);
}

app.post('/api/orders', ordersLimiter, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const customerName = sanitizarNomeCliente(req.body?.customerName);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const cep = req.body?.cep != null ? String(req.body.cep).trim() : '';
    const email = req.body?.payerEmail != null ? String(req.body.payerEmail).trim() : '';
    const telefone = req.body?.payerTelefone != null ? String(req.body.payerTelefone).replace(/\D/g, '') : '';
    const cpf = req.body?.payerCpf != null ? String(req.body.payerCpf).replace(/\D/g, '') : '';
    const rua = req.body?.rua != null ? String(req.body.rua).trim() : '';
    const numero = req.body?.numero != null ? String(req.body.numero).trim() : '';
    const complemento = req.body?.complemento != null ? String(req.body.complemento).trim() : '';
    const bairro = req.body?.bairro != null ? String(req.body.bairro).trim() : '';
    const cidade = req.body?.cidade != null ? String(req.body.cidade).trim() : '';
    const estado = req.body?.estado != null ? String(req.body.estado).trim().toUpperCase() : '';

    if (!rawItems.length) return res.status(400).json({ erro: 'items vazios' });

    // Mesmo critério de /api/frete/calcular: CEP precisa ter 8 dígitos.
    // Validado aqui, antes de qualquer decremento de estoque, porque o catch
    // externo desta rota não faz rollbackStock — um CEP malformado não pode
    // ser rejeitado depois que o estoque já foi debitado.
    const cepDigitosValidacao = cep.replace(/\D/g, '');
    if (cepDigitosValidacao.length !== 8) {
      return res.status(400).json({ erro: 'CEP inválido' });
    }

    // Dados de entrega e contato: sem eles o pedido é pago mas não dá pra
    // despachar nem falar com o cliente. O checkout já valida isso no HTML,
    // mas validação de cliente não protege a rota (mesmo motivo do CEP acima)
    // — e como o catch externo desta rota não chama rollbackStock, tudo isso
    // precisa ser checado aqui, antes de qualquer decremento de estoque, não
    // depois. emailPagadorValido é a mesma função usada em /api/payment/create.
    if (!emailPagadorValido(email)) {
      return res.status(400).json({ erro: 'E-mail inválido' });
    }
    if (telefone.length < 10 || telefone.length > 11) {
      return res.status(400).json({ erro: 'Telefone inválido' });
    }
    if (cpf.length !== 11) {
      return res.status(400).json({ erro: 'CPF inválido' });
    }
    // Número e complemento nunca vêm do CEP — sempre digitados pelo cliente,
    // por isso são checados aqui e não deduzidos de nada.
    if (!rua || !numero || !bairro || !cidade || estado.length !== 2) {
      return res.status(400).json({ erro: 'Endereço de entrega incompleto — informe rua, número, bairro, cidade e UF.' });
    }

    // IMPORTANTE: preço e total NUNCA vêm do cliente — sempre recalculados a partir
    // do Produto salvo no banco. Isso impede que alguém edite o carrinho no navegador
    // (localStorage/DevTools) para pagar um valor diferente do real.
    const decrementedForRollback = []; // acumula decrementos aplicados, para rollback em caso de erro
    const itemsForOrder = [];
    // Peso/dimensões reais por item, resolvidos no loop abaixo (produto ou
    // padrão da loja — ver resolverDadosEnvioProduto), pra cotar o frete de
    // verdade mais adiante. Buscamos a Config aqui, antes do loop, porque
    // cfgFrete.pesoKgPadrao etc. são o padrão da loja usado item a item.
    const itemsParaCotarFrete = [];
    const cfgFrete = await buscarConfigCompleta();
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

      // Produto com tamanhos cadastrados exige um tamanho VÁLIDO (um dos
      // valores reais de prod.sizes, não só "não vazio") — achado ao
      // investigar um bug de adicionar-rápido que mandava tamanho vazio ou
      // herdado de outro produto sem passar por nenhuma validação aqui.
      // Igual às checagens acima: antes de somar ao pedido, com rollback de
      // estoque se falhar — o carrinho é do navegador, nunca confiável.
      const tamanhoEnviado = it?.tamanhoSelecionado ? String(it.tamanhoSelecionado).trim() : '';
      if (Array.isArray(prod.sizes) && prod.sizes.length > 0 && !prod.sizes.includes(tamanhoEnviado)) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({
          erro: 'Selecione um tamanho válido para ' + (prod.nome || it?.name || 'item'),
          produtoId: productId,
          motivo: 'TAMANHO_INVALIDO',
          tamanhosDisponiveis: prod.sizes
        });
      }

      // Produto sem peso/dimensão própria nem padrão da loja não pode ser
      // vendido (decisão registrada no schema de Produto) — checado aqui,
      // logo após resolver `prod` e ANTES de somar ao pedido, seguindo o
      // mesmo padrão das validações de endereço acima: nunca decrementar
      // estoque de um item e só descobrir depois que o pedido não pode
      // fechar. Cobre também o produto que perdeu o dado depois de já estar
      // no carrinho do cliente — o carrinho é do navegador, não é confiável.
      const dadosEnvio = resolverDadosEnvioProduto(prod, cfgFrete);
      if (!dadosEnvio.ok) {
        await rollbackStock(decrementedForRollback);
        return res.status(409).json({
          erro: 'Produto sem peso/dimensão cadastrados — indisponível para venda: ' + (prod.nome || it?.name || 'item'),
          produtoId: productId,
          motivo: 'SEM_DADOS_ENVIO'
        });
      }

      const precoReal = Number(prod.preco || 0);
      totalNum += precoReal * qty;

      itemsForOrder.push({
        name: String(prod.nome || it?.name || '').trim(),
        qty,
        price: precoReal,
        tamanhoSelecionado: tamanhoEnviado,
        productId,
        // true só quando este item de fato debitou estoque real (branch do
        // withStockControl acima) — produto com controle de estoque desativado
        // (estoque=null) nunca deve ser incrementado na devolução.
        estoqueDecrementado: !!withStockControl
      });

      itemsParaCotarFrete.push({
        id: productId,
        quantity: qty,
        unitary_value: precoReal,
        pesoKg: dadosEnvio.pesoKg,
        larguraCm: dadosEnvio.larguraCm,
        alturaCm: dadosEnvio.alturaCm,
        comprimentoCm: dadosEnvio.comprimentoCm
      });
    }

    totalNum = Math.round(totalNum * 100) / 100;

    // Frete: req.body.frete NUNCA é usado como valor — mesmo padrão de "preço
    // nunca vem do cliente" já usado acima pros itens. O que o cliente manda
    // (frete, freteServicoId) é só "qual serviço eu escolhi", não "quanto eu
    // vou pagar". O valor de verdade vem de uma nova cotação ao Melhor Envio
    // aqui no servidor, com o CEP e os preços já validados do pedido.
    //
    // Se o subtotal já bate frete grátis, nem cotamos. Senão, cotamos de
    // novo e usamos o preço da opção com o mesmo id que o cliente escolheu
    // (freteServicoId) — ou a mais barata disponível, se o id não bater com
    // nada (cotação mudou, ou o campo não chegou). Só cai pra frete 0/"A
    // combinar" quando não há como cotar de verdade (sem me_token, CEP
    // inválido, Melhor Envio fora do ar) — mesma degradação graciosa que o
    // front já usa nesses casos, pra não travar um checkout legítimo.
    let freteNome = req.body?.freteNome != null ? String(req.body.freteNome).trim() : '';
    let freteEmpresa = req.body?.freteEmpresa != null ? String(req.body.freteEmpresa).trim() : '';
    const freteServicoId = req.body?.freteServicoId != null ? String(req.body.freteServicoId).trim() : '';
    let freteNum = 0;

    // cfgFrete já foi buscada antes do loop de itens (precisava dela ali pra
    // resolver peso/dimensão de cada item) — reaproveitada aqui.
    const freteGratisAplicavel = cfgFrete.freteGratisAtivo && totalNum >= cfgFrete.freteGratisValor;

    if (freteGratisAplicavel) {
      freteNum = 0;
      freteNome = freteNome || 'Frete grátis';
    } else {
      const cepDigitosPedido = cep.replace(/\D/g, '');
      const settingsFrete = await Settings.findOne().lean();
      const meTokenPedido = settingsFrete?.me_token ? String(settingsFrete.me_token).trim() : '';

      let opcoes = [];
      let cepForaDeArea = false;
      if (meTokenPedido && cepDigitosPedido.length === 8) {
        const resultadoFrete = await cotarFreteMelhorEnvio(meTokenPedido, cfgFrete.cepOrigemEfetivo, cepDigitosPedido, itemsParaCotarFrete);
        if (resultadoFrete.ok) {
          opcoes = resultadoFrete.options;
          // Melhor Envio respondeu (ok:true) mas nenhuma opção sobrou depois do
          // filtro de erro: CEP com formato válido, porém fora da área que as
          // transportadoras atendem. Decisão consciente: bloquear o checkout,
          // não cair pra frete 0/"A combinar" — diferente de token ausente ou
          // Melhor Envio fora do ar (ok:false), que continuam com o fallback
          // gracioso abaixo.
          cepForaDeArea = opcoes.length === 0;
        }
      }

      if (cepForaDeArea) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'CEP fora da área de entrega das transportadoras disponíveis.' });
      }

      const opcaoEscolhida = freteServicoId ? opcoes.find((o) => o.id === freteServicoId) : null;
      const opcaoFinal = opcaoEscolhida || opcoes[0] || null;

      if (opcaoFinal) {
        freteNum = opcaoFinal.price;
        freteNome = opcaoFinal.name || freteNome;
        freteEmpresa = opcaoFinal.company || freteEmpresa;
      } else {
        freteNum = 0;
        freteNome = freteNome || 'A combinar';
      }
    }
    freteNum = Math.round(freteNum * 100) / 100;

    const totalComFrete = Math.round((totalNum + freteNum) * 100) / 100;

    // Status sempre começa "Pendente" — o cliente não pode definir o status do próprio pedido.
    // A confirmação de pagamento (Pix) deve ser tratada separadamente, ver /api/pix/webhook.
    const order = await Order.create({
      customerName,
      items: itemsForOrder,
      total: totalComFrete,
      cep,
      rua,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
      email,
      telefone,
      cpf,
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

    let order;
    if (status === 'Cancelado') {
      const atual = await Order.findById(req.params.id).select('status').lean();
      if (!atual) return res.status(404).json({ erro: 'Pedido não encontrado' });
      if (atual.status === 'Pendente') {
        // Cancelar um pedido ainda Pendente é o mesmo "nunca foi pago, nunca vai
        // ser" que o cron detecta por timeout (ver /api/cron/liberar-estoque-pendente)
        // — devolve o estoque pela mesma rotina idempotente. Pago->Cancelado (ex:
        // reembolso depois do envio) não passa por aqui: só troca o status, sem
        // mexer em estoque, porque não há como saber neste ponto se o item já
        // foi despachado.
        await devolverEstoqueDoPedido(req.params.id, 'Cancelado');
        order = await Order.findById(req.params.id);
      } else {
        order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
      }
    } else {
      order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    }

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
    const existente = await Order.findById(req.params.id).select('status estoqueRevertido').lean();
    if (!existente) return res.status(404).json({ erro: 'Pedido não encontrado' });

    if (existente.status === 'Pendente' && !existente.estoqueRevertido) {
      // Hoje este é o único jeito pelo qual o admin "encerra" um pedido Pendente
      // pela UI (não há botão de Cancelar) — excluir um pedido ainda Pendente é
      // abandono na prática, então devolve o estoque pela mesma rotina do
      // cron/cancelamento, o que também protege contra corrida caso o cron
      // esteja processando esse mesmo pedido ao mesmo tempo.
      await devolverEstoqueDoPedido(req.params.id, 'Cancelado');
    }

    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ erro: 'Pedido não encontrado' });
    res.json({ mensagem: 'Pedido excluído!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir pedido', detalhe: err.message });
  }
});

/** Monta o filtro $or de busca por comprador (CPF e/ou e-mail), compartilhado
 * entre a busca (GET) e a anonimização sob demanda (POST) abaixo — pra nunca
 * divergir quem a busca mostra do que a anonimização de fato afeta. */
function montarFiltroComprador({ cpf, email }) {
  const or = [];
  const cpfDigitos = cpf ? String(cpf).replace(/\D/g, '') : '';
  const emailBusca = email ? String(email).trim().toLowerCase() : '';
  if (cpfDigitos) or.push({ cpf: cpfDigitos });
  if (emailBusca) or.push({ email: { $regex: '^' + escapeRegexEspecial(emailBusca) + '$', $options: 'i' } });
  return or.length ? { $or: or } : null;
}

// Busca os pedidos de um comprador específico (por CPF ou e-mail), pro admin
// conferir quais registros existem ANTES de disparar a anonimização — sem
// isso, o lojista teria que vasculhar a tabela de pedidos manualmente pra
// confirmar que está anonimizando a pessoa certa.
app.get('/api/admin/orders/buscar-por-comprador', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const filtro = montarFiltroComprador({ cpf: req.query?.cpf, email: req.query?.email });
    if (!filtro) return res.status(400).json({ erro: 'Informe CPF ou e-mail do comprador.' });
    const list = await Order.find(filtro).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar pedidos do comprador', detalhe: err.message });
  }
});

// Atende um pedido de exclusão (LGPD) de um comprador específico: anonimiza
// TODOS os pedidos dele (qualquer status, qualquer idade — diferente das
// rotinas por idade acima, aqui é sob demanda, disparado pelo lojista) sem
// apagar o histórico de vendas em si (total/itens/data seguem preservados,
// só a identificação do comprador é removida — ver camposAnonimizacaoPedido).
app.post('/api/admin/orders/anonimizar-comprador', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const filtro = montarFiltroComprador({ cpf: req.body?.cpf, email: req.body?.email });
    if (!filtro) return res.status(400).json({ erro: 'Informe CPF ou e-mail do comprador.' });
    const r = await Order.updateMany(
      { ...filtro, anonimizadoEm: null },
      { $set: camposAnonimizacaoPedido() }
    );
    res.json({ mensagem: 'Dados do comprador removidos.', pedidosAfetados: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao anonimizar pedidos do comprador', detalhe: err.message });
  }
});

// Prazo pra considerar um pedido 'Pendente' abandonado. Ajustável: só precisa
// ser longo o bastante pra não cancelar um pagamento genuinamente em andamento
// (Pix ainda não expirou, cliente ainda na tela de cartão).
const HORAS_LIMITE_PEDIDO_PENDENTE = 24;

/**
 * Cron da Vercel (ver vercel.json) — reclama o estoque de pedidos 'Pendente'
 * abandonados há mais de HORAS_LIMITE_PEDIDO_PENDENTE horas (cliente desistiu,
 * fechou a aba, Pix expirou, cartão recusado — nenhum desses casos tem hoje
 * nenhuma rotina de devolução, ver devolverEstoqueDoPedido). Roda sem processo
 * de longa duração porque a Vercel invoca esta rota por agendamento, não um
 * setInterval dentro da função serverless.
 *
 * Protegida por CRON_SECRET: sem isso, seria um endpoint público capaz de
 * mexer em estoque sem autenticação. Falha fechada — sem a env var configurada,
 * ninguém consegue chamar esta rota, nem com o header certo.
 */
app.get('/api/cron/liberar-estoque-pendente', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  if (!(await ensureDbConnected(res))) return;
  try {
    const limite = new Date(Date.now() - HORAS_LIMITE_PEDIDO_PENDENTE * 60 * 60 * 1000);
    const pedidosExpirados = await Order.find({
      status: 'Pendente',
      estoqueRevertido: { $ne: true },
      createdAt: { $lt: limite }
    }).select('_id').lean();

    let liberados = 0;
    for (const p of pedidosExpirados) {
      const revertido = await devolverEstoqueDoPedido(p._id, 'Cancelado');
      if (revertido) liberados++;
    }

    res.json({ ok: true, verificados: pedidosExpirados.length, liberados });
  } catch (err) {
    console.error('[cron/liberar-estoque-pendente] Erro:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

/**
 * Cron da Vercel (ver vercel.json) — anonimiza pedidos PAGOS mais velhos que
 * o prazo de retenção configurado (painel > RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK,
 * ver mergePublicConfig). Deliberadamente uma rota/agendamento SEPARADO do
 * cron de liberação de estoque acima: liberar estoque é sentido no mesmo dia
 * pelo lojista (produto volta a ficar vendável), enquanto anonimizar é faxina
 * sem urgência — se esta rotina falhar, travar em timeout de função serverless
 * ou ficar lenta numa base grande, isso não pode arrastar a liberação de
 * estoque junto.
 *
 * Não mexe em pedido nunca pago — esse caso já é resolvido no mesmo instante
 * do cancelamento por devolverEstoqueDoPedido, não por idade aqui.
 *
 * Protegida por CRON_SECRET, mesmo padrão de /api/cron/liberar-estoque-pendente.
 *
 * Idempotente: cada pedido processado só se anonimizadoEm ainda for null
 * (trava atômica no próprio updateOne) — rodar duas vezes não afeta de novo
 * quem já foi anonimizado.
 */
app.get('/api/cron/anonimizar-pedidos-antigos', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  if (!(await ensureDbConnected(res))) return;
  try {
    const configDoc = await Config.findOne().lean();
    const anosSalvo = configDoc?.retencaoPedidosPagosAnos;
    const anos =
      Number.isFinite(Number(anosSalvo)) && Number(anosSalvo) > 0
        ? Number(anosSalvo)
        : RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK;

    const limite = new Date();
    limite.setFullYear(limite.getFullYear() - anos);

    const candidatos = await Order.find({
      status: 'Pago',
      anonimizadoEm: null,
      createdAt: { $lt: limite }
    }).select('_id').lean();

    let anonimizados = 0;
    for (const p of candidatos) {
      const r = await Order.updateOne(
        { _id: p._id, anonimizadoEm: null },
        { $set: camposAnonimizacaoPedido() }
      );
      if (r.modifiedCount) anonimizados++;
    }

    res.json({ ok: true, retencaoAnos: anos, verificados: candidatos.length, anonimizados });
  } catch (err) {
    console.error('[cron/anonimizar-pedidos-antigos] Erro:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Loja config
// Inclui: nome, whatsapp, imagem do hero (banco) e demais tokens usados pelo template.
//
// PENDÊNCIA REGISTRADA (não mexer agora — próxima rodada): se a leitura do
// Mongo falhar aqui (linha do catch logo abaixo), a função engole o erro e
// segue com doc=null — mergePublicConfig(null) calcula todo campo a partir
// dos fallbacks de configPadrao, e GET /api/config devolve 200 OK com esse
// conteúdo. Do lado de fora, uma falha de banco fica indistinguível de "loja
// realmente configurada assim". Foi um dos dois gatilhos confirmados do bug
// em que o formulário de admin salvou "Minha Loja" por cima de um nome real
// (ver loadConfig()/configCarregado em admin.html — a mitigação atual é do
// lado do cliente, recusando salvar quando o carregamento não foi confirmado
// como bem-sucedido). Vale essa rota propagar a falha (5xx) em vez de
// devolver 200 com fallback — não implementado agora de propósito, pra não
// misturar essa mudança de servidor com a correção já aprovada no cliente.
async function buscarConfigCompleta() {
  let doc = null;
  try {
    if (await tryConnectDb()) {
      doc = await Config.findOne().lean();
      if (!doc) {
        doc = await Config.create({
          nomeLoja: configPadrao.nomeLoja,
          chavePix: configPadrao.chavePix || '',
          corPrimaria: configPadrao.corPrimaria,
          corSecundaria: configPadrao.corSecundaria,
          whatsappContato: configPadrao.whatsappContato,
          instagramLink: configPadrao.instagramLink,
          emailContato: configPadrao.emailContato,
          clienteTag: slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja)
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

  const heroImagemFile = doc?.heroImagem ? String(doc.heroImagem).trim() : '';
  const heroImagemUrl = doc?.heroImagemUrl ? String(doc.heroImagemUrl).trim() : '';
  // Sem foto configurada: gradiente com as cores do tema, nunca mais uma
  // foto de roupa genérica escolhida pra um cliente específico.
  const heroImagemFinal = heroImagemFile || heroImagemUrl || construirHeroPlaceholderSvg(publicCfg);

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
      temaFundo,
      corPainelHero,
      whatsappContato,
      instagramLink,
      emailContato,
      clienteTag,
      cidadeLoja,
      cepOrigem,
      pageTitleSuffix,
      cnpj,
      retencaoPedidosPagosAnos,
      pesoKgPadrao,
      larguraCmPadrao,
      alturaCmPadrao,
      comprimentoCmPadrao,

      // ✅ NOVO: hero do split
      heroImagem,
      heroImagemUrl,
      heroTitle,
      heroFont,
      heroEyebrow,
      heroSubtitulo,

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

      usaTamanhosPadrao,

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

    const dados = { nomeLoja: nomeLoja?.trim() || configPadrao.nomeLoja };
    if (chavePix !== undefined) dados.chavePix = String(chavePix).trim();
    if (corPrimaria !== undefined) dados.corPrimaria = String(corPrimaria).trim();
    if (corSecundaria !== undefined) dados.corSecundaria = String(corSecundaria).trim();
    // Só grava se for uma chave conhecida do catálogo — barra tentativa de
    // salvar um valor arbitrário direto na API, não só na UI do admin.
    if (temaFundo !== undefined) dados.temaFundo = TEMAS_FUNDO[temaFundo] ? temaFundo : 'creme';
    if (corPainelHero !== undefined) {
      dados.corPainelHero = TEMAS_HERO[corPainelHero]
        ? corPainelHero
        : (TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto');
    }
    if (whatsappContato !== undefined) dados.whatsappContato = String(whatsappContato).trim();
    if (instagramLink !== undefined) dados.instagramLink = String(instagramLink).trim();
    if (emailContato !== undefined) dados.emailContato = String(emailContato).trim();
    if (clienteTag !== undefined) dados.clienteTag = slugifyTenantTag(clienteTag);
    if (cidadeLoja !== undefined) dados.cidadeLoja = String(cidadeLoja).trim().toUpperCase().slice(0, 15);
    if (cepOrigem !== undefined) {
      // Mesmo critério de CEP usado em /api/frete/calcular e /api/orders:
      // 8 dígitos ou nada. Vazio é válido de propósito — é como o lojista
      // "desfaz" o valor salvo aqui e volta a depender do .env/config.js.
      const cepOrigemDigitos = String(cepOrigem).replace(/\D/g, '');
      if (cepOrigemDigitos && cepOrigemDigitos.length !== 8) {
        return res.status(400).json({ erro: 'CEP de origem inválido — use 8 dígitos ou deixe em branco.' });
      }
      dados.cepOrigem = cepOrigemDigitos;
    }
    // Vazio é válido de propósito — mesmo raciocínio do cepOrigem: "desfaz" o
    // valor salvo aqui e volta a depender do config.js. Limite de tamanho só
    // pra não deixar alguém colar um parágrafo inteiro num <title>.
    if (pageTitleSuffix !== undefined) dados.pageTitleSuffix = String(pageTitleSuffix).trim().slice(0, 60);
    if (cnpj !== undefined) {
      // Mesmo critério de CPF já usado em /api/orders: 14 dígitos ou nada.
      // Vazio é válido — apaga o CNPJ salvo, as páginas legais voltam a
      // mostrar o aviso de "complete isso" em vez de manter um valor velho.
      const cnpjDigitos = String(cnpj).replace(/\D/g, '');
      if (cnpjDigitos && cnpjDigitos.length !== 14) {
        return res.status(400).json({ erro: 'CNPJ inválido — use 14 dígitos ou deixe em branco.' });
      }
      dados.cnpj = cnpjDigitos;
    }
    if (retencaoPedidosPagosAnos !== undefined) {
      // Vazio é válido de propósito — mesmo raciocínio do cepOrigem: "desfaz"
      // o valor salvo aqui e volta a depender de RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK.
      // Faixa de 1-20 anos é só uma trava de sanidade contra erro de digitação
      // (ex: "500"), não um limite legal.
      const anosRaw = String(retencaoPedidosPagosAnos).trim();
      if (!anosRaw) {
        dados.retencaoPedidosPagosAnos = null;
      } else {
        const anosNum = Number(anosRaw);
        if (!Number.isFinite(anosNum) || !Number.isInteger(anosNum) || anosNum < 1 || anosNum > 20) {
          return res.status(400).json({ erro: 'Prazo de retenção inválido — use um número inteiro de anos entre 1 e 20, ou deixe em branco.' });
        }
        dados.retencaoPedidosPagosAnos = anosNum;
      }
    }
    // Padrão da loja de peso/dimensão — mesmo raciocínio de "vazio apaga o
    // valor salvo" do cepOrigem/retenção acima. Sem terceiro fallback fixo
    // (ver comentário em mergePublicConfig): vazio aqui é vazio de verdade.
    for (const [chave, valor, rotulo] of [
      ['pesoKgPadrao', pesoKgPadrao, 'Peso padrão'],
      ['larguraCmPadrao', larguraCmPadrao, 'Largura padrão'],
      ['alturaCmPadrao', alturaCmPadrao, 'Altura padrão'],
      ['comprimentoCmPadrao', comprimentoCmPadrao, 'Comprimento padrão']
    ]) {
      if (valor === undefined) continue;
      const lido = lerCampoEnvioOpcional(valor, rotulo);
      if (!lido.ok) return res.status(400).json({ erro: lido.erro });
      dados[chave] = lido.valor;
    }
    if (!dados.clienteTag) dados.clienteTag = slugifyTenantTag(dados.nomeLoja || configPadrao.nomeLoja);

    // ✅ NOVO: hero do split
    if (heroImagem !== undefined) dados.heroImagem = String(heroImagem).trim();
    if (heroImagemUrl !== undefined) dados.heroImagemUrl = String(heroImagemUrl).trim();
    if (heroTitle !== undefined) dados.heroTitle = String(heroTitle).trim();
    if (heroFont !== undefined) dados.heroFont = String(heroFont).trim();
    if (heroEyebrow !== undefined) dados.heroEyebrow = String(heroEyebrow).trim();
    if (heroSubtitulo !== undefined) dados.heroSubtitulo = String(heroSubtitulo).trim();

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

    if (usaTamanhosPadrao !== undefined) dados.usaTamanhosPadrao = !!usaTamanhosPadrao;

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

    const nome = configDoc?.nomeLoja || configPadrao.nomeLoja || 'LOJA';
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

// Consumido pelo checkout (VN_IMPORTS.html) pra decidir se mostra a opção de
// pagamento por cartão — precisa de mp_token salvo (credencial, fica só no
// servidor) e mp_public_key (chave pública, essa sim vai pro navegador pra
// inicializar o SDK do Mercado Pago).
app.get('/api/payment/config', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
    }

    const doc = await Settings.findOne().lean();
    const hasMpToken = temMpTokenSalvo(doc);
    const publicCfg = mergePublicSettings(doc);

    return res.json({
      hasMpToken,
      mpPublicKey: publicCfg.mp_public_key,
      pixKeyFallback: sanitizarChavePix(publicCfg.pix_key)
    });
  } catch {
    return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
  }
});

/**
 * O Mercado Pago exige payer.first_name e payer.last_name pra criar um
 * pagamento (cartão ou Pix) — sem os dois, a criação é recusada. O checkout
 * só coleta um campo de nome completo, então quem separa em nome/sobrenome é
 * o servidor, uma vez só, reaproveitado pelas duas rotas que criam pagamento
 * — em vez de cada front-end tentar adivinhar a mesma lógica sozinho.
 * Sem sobrenome informado, repete o primeiro nome nos dois campos: pior que
 * um sobrenome duplicado é a criação do pagamento ser recusada de novo.
 */
function dividirNomePagador(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { first_name: 'Cliente', last_name: 'Cliente' };
  if (partes.length === 1) return { first_name: partes[0], last_name: partes[0] };
  return { first_name: partes[0], last_name: partes.slice(1).join(' ') };
}

// Formato simples, não é validação exaustiva de RFC 5322 — só o suficiente
// pra recusar antes de gastar uma chamada ao MP (que rejeitaria mesmo assim,
// só que sem essa mensagem clara e sem essa rejeição ser rápida).
function emailPagadorValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

/**
 * Cria o pagamento no Mercado Pago (cartão ou Pix via MP) para um pedido já
 * existente. Chamada pelo checkout do VN_IMPORTS.html depois que o cartão foi
 * tokenizado no navegador (ou, no caso do Pix, direto após criar o pedido).
 *
 * IMPORTANTE: o valor cobrado é sempre order.total, já salvo no banco quando
 * o pedido foi criado em /api/orders — nunca o "total" que vem no corpo desta
 * requisição. Confiar no total do cliente reabriria a mesma brecha de
 * manipulação de preço que /api/orders já corrige na criação do pedido.
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

    const method = req.body?.method === 'card' ? 'card' : (req.body?.method === 'pix' ? 'pix' : null);
    if (!method) {
      return res.status(400).json({ ok: false, reason: 'INVALID_METHOD' });
    }

    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (!orderId) {
      return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED' });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, reason: 'INVALID_AMOUNT' });
    }

    const payerEmail = req.body?.payerEmail ? String(req.body.payerEmail).trim() : '';
    // E-mail nunca teve um fallback seguro pro MP — 'test@test.com' passava na
    // validação do formulário (que nem barrava e-mail vazio de verdade) mas é
    // recusado pelo MP em produção. Exige um e-mail plausível antes de gastar
    // a chamada.
    if (!emailPagadorValido(payerEmail)) {
      return res.status(400).json({ ok: false, reason: 'INVALID_PAYER_EMAIL' });
    }
    const payerCpf = req.body?.payerCpf ? String(req.body.payerCpf).replace(/\D/g, '') : '';
    const { first_name, last_name } = dividirNomePagador(req.body?.payerName);
    const payer = {
      email: payerEmail,
      first_name,
      last_name,
      identification: { type: 'CPF', number: payerCpf }
    };

    let payload;
    if (method === 'card') {
      const token = req.body?.token ? String(req.body.token) : '';
      if (!token) {
        return res.status(400).json({ ok: false, reason: 'MISSING_CARD_TOKEN' });
      }
      payload = {
        transaction_amount: amount,
        token,
        description: `Pedido ${orderId} — ${configPadrao.nomeLoja}`,
        installments: Number(req.body?.installments) || 1,
        payment_method_id: req.body?.payment_method_id ? String(req.body.payment_method_id) : '',
        payer
      };
    } else {
      payload = {
        transaction_amount: amount,
        description: `Pedido ${orderId} — ${configPadrao.nomeLoja}`,
        payment_method_id: 'pix',
        payer
      };
    }

    // X-Idempotency-Key evita cobrança duplicada se a mesma requisição for
    // reenviada (retry de rede, dois cliques antes do botão desabilitar).
    // Cartão inclui o token no derivado: cada tokenização é única mesmo numa
    // nova tentativa com o mesmo cartão, então uma tentativa de verdade
    // sempre ganha uma chave nova — só uma requisição IDÊNTICA reenviada
    // (mesmo token) reaproveita a mesma chave e é deduplicada pelo MP, sem
    // travar um retry legítimo após recusa. Pix não tem token por tentativa,
    // mas a criação de um pagamento Pix bem formado praticamente nunca
    // "recusa" pedindo retry com dado diferente (recusa real é payload
    // inválido, que esta correção já resolve) — chavear só por pedido é seguro.
    const idempotencyKey = method === 'card'
      ? `payment-create-card-${orderId}-${payload.token}`
      : `payment-create-pix-${orderId}`;

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mpToken}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    const mpJson = await mpRes.json().catch(() => ({}));

    if (!mpRes.ok) {
      console.error('[payment/create] Mercado Pago recusou a criação do pagamento:', JSON.stringify(mpJson));
      return res.status(502).json({ ok: false, reason: 'MP_PAYMENT_CREATE_FAILED', mpError: mpJson });
    }

    const mpStatus = mpJson?.status || '';
    const approved = mpStatus === 'approved';

    // Guarda o ID do pagamento no pedido em qualquer desfecho — o webhook
    // (/api/pix/webhook) usa isso pra confirmar depois, e vale como registro
    // da tentativa mesmo se for recusada.
    if (mpJson?.id) order.mpPaymentId = String(mpJson.id);
    if (approved) order.status = 'Pago';
    // pendente/em análise (in_process, pending, etc.) mantém status 'Pendente'.
    await order.save();

    if (mpStatus === 'rejected') {
      // Recusado pela operadora/MP — pedido continua Pendente, nada de estoque
      // é decrementado de novo (isso já aconteceu na criação do pedido).
      return res.json({
        ok: false,
        reason: 'MP_PAYMENT_REJECTED',
        mpError: mpJson,
        orderId: String(order._id),
        status: order.status
      });
    }

    const qrCode =
      mpJson?.point_of_interaction?.transaction_data?.qr_code || mpJson?.qr_code || '';
    const qrCodeBase64 =
      mpJson?.point_of_interaction?.transaction_data?.qr_code_base64 || mpJson?.qr_code_base64 || '';

    return res.json({
      ok: true,
      method,
      paymentId: mpJson?.id ? String(mpJson.id) : '',
      status: mpStatus,
      orderId: String(order._id),
      total: order.total,
      approved,
      ...(method === 'pix' ? { qr_code: qrCode, qr_code_base64: qrCodeBase64 } : {})
    });
  } catch (e) {
    console.error('[payment/create] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

/**
 * Consultado pelo checkout em polling (a cada poucos segundos) depois de gerar
 * um Pix ou um cartão que ficou em análise, pra saber se o pagamento já foi
 * confirmado. Mesmo padrão de consulta ao MP do webhook (/api/pix/webhook):
 * nunca deixa a consulta quebrar o processo, só loga e devolve o status atual
 * do pedido se a chamada ao MP falhar.
 */
app.get('/api/payment/status/:orderId', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const orderId = String(req.params.orderId || '');
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }

    // Só consulta o MP se ainda estiver pendente e tiver um pagamento associado —
    // se já está 'Pago', devolve direto lá embaixo sem gastar uma chamada à API do MP.
    if (order.status === 'Pendente' && order.mpPaymentId) {
      const settings = await Settings.findOne().lean();
      if (temMpTokenSalvo(settings)) {
        const mpToken = String(settings.mp_token).trim();
        try {
          const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, {
            headers: { Authorization: `Bearer ${mpToken}` }
          });
          const mpJson = await mpRes.json().catch(() => ({}));
          if (mpRes.ok && mpJson?.status === 'approved') {
            order.status = 'Pago';
            await order.save();
          } else if (!mpRes.ok) {
            console.warn('[payment/status] Falha ao consultar pagamento no MP:', mpJson);
          }
        } catch (e) {
          console.error('[payment/status] Erro ao consultar MP:', e.message);
        }
      }
    }

    return res.json({
      ok: true,
      orderId: String(order._id),
      status: order.status,
      approved: order.status === 'Pago',
      mpPaymentId: order.mpPaymentId || '',
      total: order.total
    });
  } catch (e) {
    console.error('[payment/status] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

/**
 * Resolve o peso/dimensões REAIS de um produto pro cálculo de frete: primeiro
 * o que está cadastrado no próprio produto, campo a campo; qualquer campo
 * ausente cai pro padrão da loja (Config), também campo a campo. Se depois
 * disso ainda faltar algum dos quatro, ok:false — o produto não pode ser
 * vendido (ver decisão registrada nos comentários do schema de Produto).
 * Nunca inventa um número: é essa garantia que corrige o bug de frete fixo
 * (0,3kg/11x2x16 pra qualquer produto) que existia antes desta função.
 */
function resolverDadosEnvioProduto(produto, cfgFrete) {
  const resolverCampo = (valorProduto, valorPadrao) => {
    const p = Number(valorProduto);
    if (Number.isFinite(p) && p > 0) return p;
    const d = Number(valorPadrao);
    if (Number.isFinite(d) && d > 0) return d;
    return null;
  };
  const pesoKg = resolverCampo(produto?.pesoKg, cfgFrete?.pesoKgPadrao);
  const larguraCm = resolverCampo(produto?.larguraCm, cfgFrete?.larguraCmPadrao);
  const alturaCm = resolverCampo(produto?.alturaCm, cfgFrete?.alturaCmPadrao);
  const comprimentoCm = resolverCampo(produto?.comprimentoCm, cfgFrete?.comprimentoCmPadrao);
  if (!pesoKg || !larguraCm || !alturaCm || !comprimentoCm) return { ok: false };
  return { ok: true, pesoKg, larguraCm, alturaCm, comprimentoCm };
}

/**
 * Consulta o Melhor Envio de verdade e devolve as opções de frete disponíveis
 * pro CEP/produtos informados. Compartilhada entre /api/frete/calcular
 * (cotação exibida no checkout) e POST /api/orders (revalidação do frete
 * escolhido antes de fechar o pedido — ver comentário lá).
 *
 * cepOrigem é passado pelo chamador (não lido daqui) — cada chamador já busca
 * a Config completa pra outra coisa (frete grátis) e usa cfg.cepOrigemEfetivo
 * de lá, que resolve painel > .env > config.js > fallback fixo (ver
 * mergePublicConfig). Resolver aqui de novo seria uma segunda fonte de
 * verdade pro mesmo valor.
 *
 * NUNCA lança exceção — qualquer falha (rede, timeout, resposta inesperada)
 * volta como { ok:false }. Isso é proposital: quem chama em /api/orders já
 * decrementou estoque antes de chegar aqui, então um erro não tratado aqui
 * não pode derrubar a criação do pedido inteira.
 */
async function cotarFreteMelhorEnvio(meToken, cepOrigem, cepDigitos, rawProducts) {
  // rawProducts já chega com peso/dimensões REAIS resolvidos por quem chamou
  // (ver resolverDadosEnvioProduto) — cada item da lista é um produto do
  // carrinho, e a Melhor Envio calcula o frete da remessa combinada a partir
  // dessa lista sozinha; não precisamos somar/aproximar caixa nenhuma aqui.
  if (!rawProducts.length) return { ok: false, reason: 'SEM_ITENS', options: [] };
  const produtosParaEnvio = rawProducts.map((p) => ({
    id: p?.id != null ? String(p.id) : undefined,
    width: Number(p?.larguraCm) || 0,
    height: Number(p?.alturaCm) || 0,
    length: Number(p?.comprimentoCm) || 0,
    weight: Number(p?.pesoKg) || 0,
    insurance_value: Number(p?.unitary_value) || 0,
    quantity: Math.max(1, Number(p?.quantity) || 1)
  }));

  try {
    const meRes = await fetch('https://melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Exigido pela API do Melhor Envio — requisições sem User-Agent identificando
        // a aplicação/contato costumam ser rejeitadas.
        'User-Agent': `${configPadrao.nomeLoja} (${configPadrao.emailContato})`,
        Authorization: `Bearer ${meToken}`
      },
      body: JSON.stringify({
        from: { postal_code: cepOrigem },
        to: { postal_code: cepDigitos },
        products: produtosParaEnvio
      }),
      signal: AbortSignal.timeout(8000)
    });

    const meJson = await meRes.json().catch(() => ([]));

    if (!meRes.ok) {
      return { ok: false, reason: 'ME_CALCULATE_FAILED', options: [] };
    }

    const lista = Array.isArray(meJson) ? meJson : [];
    const options = lista
      .filter((opt) => !opt?.error)
      .map((opt) => ({
        id: opt?.id != null ? String(opt.id) : '',
        name: opt?.name || '',
        company: opt?.company?.name || '',
        price: Number(opt?.price) || 0,
        delivery_time: Number(opt?.delivery_time ?? opt?.delivery_range?.min) || 0
      }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    return { ok: true, options };
  } catch (e) {
    return { ok: false, reason: 'ME_CALCULATE_FAILED', options: [], detalhe: e.message };
  }
}

/**
 * Cotação de frete via Melhor Envio pro checkout. Mesmo princípio de "nunca
 * confiar no que o cliente manda" das rotas de pagamento: o preço de cada
 * opção devolvida é sempre o que a API do Melhor Envio cotou de verdade —
 * o front só manda subtotal/produtos pra ajudar a montar a cotação (peso/
 * valor declarado), nunca um preço de frete pronto.
 */
app.post('/api/frete/calcular', async (req, res) => {
  try {
    const cepDigitos = String(req.body?.cep || '').replace(/\D/g, '');
    if (cepDigitos.length !== 8) {
      return res.status(400).json({ ok: false, reason: 'CEP_INVALIDO', options: [] });
    }

    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE', options: [] });
    }

    // Frete grátis: decide isso só com o subtotal + Config, sem gastar uma
    // chamada à API do Melhor Envio.
    const subtotal = Number(req.body?.subtotal) || 0;
    const cfg = await buscarConfigCompleta();
    if (cfg.freteGratisAtivo && subtotal >= cfg.freteGratisValor) {
      return res.json({ ok: true, freeShipping: true, options: [] });
    }

    const settings = await Settings.findOne().lean();
    const meToken = settings?.me_token ? String(settings.me_token).trim() : '';
    if (!meToken) {
      return res.json({ ok: false, reason: 'NO_ME_TOKEN', options: [] });
    }

    // O cliente manda quais produtos/quantidades quer cotar (isso é só uma
    // estimativa antes de fechar o pedido — o valor final é sempre recotado
    // em POST /api/orders), mas peso/dimensão SEMPRE vêm do banco por
    // productId, nunca do que o navegador mandar — mesmo princípio de nunca
    // confiar no cliente já aplicado ao preço/frete. Se o carrinho tiver um
    // item sem peso/dimensão cadastrados (nem padrão da loja), a estimativa
    // já reflete isso em vez de simular uma cotação que não vai fechar depois.
    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const idsSolicitados = rawProducts
      .map((p) => (p?.id != null ? String(p.id) : null))
      .filter(Boolean);
    const produtosDb = idsSolicitados.length
      ? await Produto.find({ _id: { $in: idsSolicitados } }).lean()
      : [];
    const produtoPorId = new Map(produtosDb.map((p) => [String(p._id), p]));

    const itemsParaCotarFrete = [];
    for (const p of rawProducts) {
      const id = p?.id != null ? String(p.id) : null;
      const produtoDb = id ? produtoPorId.get(id) : null;
      if (!produtoDb) {
        return res.json({ ok: false, reason: 'SEM_DADOS_ENVIO', options: [], produtoId: id || '' });
      }
      const dadosEnvio = resolverDadosEnvioProduto(produtoDb, cfg);
      if (!dadosEnvio.ok) {
        return res.json({ ok: false, reason: 'SEM_DADOS_ENVIO', options: [], produtoId: id, produtoNome: produtoDb.nome || '' });
      }
      itemsParaCotarFrete.push({
        id,
        quantity: p?.quantity,
        unitary_value: p?.unitary_value,
        pesoKg: dadosEnvio.pesoKg,
        larguraCm: dadosEnvio.larguraCm,
        alturaCm: dadosEnvio.alturaCm,
        comprimentoCm: dadosEnvio.comprimentoCm
      });
    }

    const resultado = await cotarFreteMelhorEnvio(meToken, cfg.cepOrigemEfetivo, cepDigitos, itemsParaCotarFrete);

    if (!resultado.ok) {
      console.warn('[frete/calcular] Falha ao consultar Melhor Envio:', resultado.reason, resultado.detalhe || '');
      return res.status(502).json({ ok: false, reason: resultado.reason, options: [] });
    }

    return res.json({ ok: true, options: resultado.options, freeShipping: false });
  } catch (e) {
    console.error('[frete/calcular] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', options: [] });
  }
});

/**
 * Valida o header x-signature que o MP assina em cada notificação de webhook,
 * usando o segredo configurado em Sua integração → Webhooks (Settings.mp_webhook_secret).
 * Fórmula documentada pelo MP: HMAC-SHA256 de "id:{data.id};request-id:{x-request-id};ts:{ts};"
 * — data.id sempre vem da query string (nunca do body), minúsculo.
 *
 * Só se aplica ao formato novo de notificação (query ?data.id=...), o único
 * que o MP documenta assinatura pra ele — o formato legado (?id=&topic=payment)
 * não tem x-signature nenhum pra validar. Por isso devolve null (em vez de
 * false) quando data.id não está na query: significa "sem como avaliar", não
 * "inválido". Essa distinção importa porque uma notificação legítima em
 * formato legado, se tratada como "inválida", pararia de confirmar pagamento
 * sozinha e silenciosamente — bem pior que o abuso que essa validação existe
 * pra mitigar.
 */
function validarAssinaturaWebhookMp(req, secret) {
  const dataId = req.query?.['data.id'];
  if (!dataId) return null; // formato legado — nada pra validar aqui

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) return false;

  const partes = {};
  for (const par of String(xSignature).split(',')) {
    const [k, v] = par.split('=');
    if (k && v) partes[k.trim()] = v.trim();
  }
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;
  const hashEsperado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hashEsperado, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false; // v1 com formato/tamanho inesperado
  }
}

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

    if (settings?.mp_webhook_secret) {
      const assinaturaValida = validarAssinaturaWebhookMp(req, settings.mp_webhook_secret);
      // false = avaliamos e não bateu (rejeita, sem consultar o MP nem tocar
      // no banco — é isso que protege contra bombardeio de IDs arbitrários).
      // null = formato legado, sem assinatura pra avaliar — segue normalmente.
      if (assinaturaValida === false) {
        console.warn('[pix/webhook] x-signature inválido para paymentId', paymentId, '— notificação ignorada.');
        return;
      }
    }
    // Sem mp_webhook_secret configurado: segue sem validar, de propósito — ver
    // comentário em validarAssinaturaWebhookMp sobre o risco de rejeitar por
    // engano. A rota continua segura mesmo assim porque nunca confia no corpo
    // da notificação: o status só vem da resposta do MP consultada abaixo.

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
      } else {
        // Aprovado no MP mas não achou um pedido 'Pendente' com esse mpPaymentId:
        // provavelmente o pedido já foi cancelado por abandono (estoque já
        // devolvido, ver /api/cron/liberar-estoque-pendente) antes do pagamento
        // ser confirmado. De propósito NÃO reabre o pedido nem mexe em estoque
        // sozinho aqui — só loga pra revisão manual do admin (dinheiro entrou,
        // mas o estoque pode já ter sido vendido a outra pessoa).
        const pedidoTardio = await Order.findOne({ mpPaymentId: String(paymentId) }).select('_id status').lean();
        if (pedidoTardio && pedidoTardio.status !== 'Pago') {
          console.warn(
            '[pix/webhook] Pagamento aprovado para pedido', pedidoTardio._id.toString(),
            'que já estava', pedidoTardio.status, '— revisão manual necessária.'
          );
        }
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

// Monta o <style> de override com as cores que realmente podem divergir do
// :root estático do arquivo (bg/bg2/border do tema de fundo, gold/gold2 da
// cor da marca, heroPanelBg do tom do painel do hero) — usado por toda
// página pública pra evitar o "flash" de cor padrão -> cor real da loja. Os
// outros tokens (ink, muted, etc.) nunca divergem do que já está no arquivo,
// não precisam de override.
function construirOverrideCoresStyle(cfg) {
  const bg = escapeParaCss(cfg?.colors?.bg);
  const bg2 = escapeParaCss(cfg?.colors?.bg2);
  const border = escapeParaCss(cfg?.colors?.border);
  const gold = escapeParaCss(cfg?.colors?.gold);
  const gold2 = escapeParaCss(cfg?.colors?.gold2);
  const heroPanelBg = escapeParaCss(cfg?.colors?.['hero-panel-bg']);
  const decls =
    (bg ? `--bg:${bg};` : '') +
    (bg2 ? `--bg2:${bg2};` : '') +
    (border ? `--border:${border};` : '') +
    (gold ? `--gold:${gold};` : '') +
    (gold2 ? `--gold2:${gold2};` : '') +
    (heroPanelBg ? `--hero-panel-bg:${heroPanelBg};` : '');
  return decls ? `<style>:root{${decls}}</style>\n</head>` : null;
}

/**
 * Monta o HTML da vitrine já com a cor e a imagem do hero atuais do banco embutidas
 * — em vez de mandar o HTML com os valores padrão e trocar depois via JS (o que causava
 * aquele "flash" da cor/imagem antiga por uma fração de segundo a cada F5).
 * Se o banco estiver indisponível, devolve o template original sem quebrar a página.
 */
async function renderLojaHtmlComConfig(req) {
  let html = getLojaHtmlTemplate();
  try {
    const cfg = await buscarConfigCompleta();
    const nome = escapeParaAtributo(cfg?.nomeLoja);

    // URL real do deploy, sempre calculada do request — nunca um domínio
    // fixo escrito no arquivo. Projeto é white-label: o próximo cliente roda
    // num domínio diferente, e um domínio hardcoded nas meta tags (og:url,
    // canonical) quebraria de novo pra ele, do mesmo jeito que quebrou aqui
    // (apontava pra vnimports.com.br enquanto o site roda em
    // vn-imports-oficial.vercel.app). Mesmo padrão de req.headers.host já
    // usado pro self-origin do CORS acima.
    const baseUrl = req?.headers?.host ? `https://${req.headers.host}` : '';
    if (baseUrl) {
      const baseUrlEsc = escapeParaAtributo(baseUrl + '/');
      html = html.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${baseUrlEsc}$2`);
      html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${baseUrlEsc}$2`);
    }

    // Imagem de preview (WhatsApp/Instagram/etc.): reaproveita a hero image já
    // configurada — sempre uma URL absoluta de verdade (Cloudinary ou o
    // padrão), diferente do og-image.jpg fixo no arquivo, que nunca existiu
    // como arquivo real (por isso o preview sempre veio sem imagem).
    const ogImg = escapeParaAtributo(cfg?.heroImagem);
    if (ogImg) {
      html = html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${ogImg}$2`);
      html = html.replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${ogImg}$2`);
    }

    // Cores: bg/bg2/border (tema de fundo) e gold/gold2 (cor da marca) são os
    // únicos tokens que podem divergir do :root estático do arquivo.
    const overrideStyle = construirOverrideCoresStyle(cfg);
    if (overrideStyle) html = html.replace('</head>', overrideStyle);

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
    const suf = escapeParaAtributo(cfg?.pageTitleSuffixEfetivo);
    if (nome) {
      const tituloCompleto = `${nome}${suf ? ' — ' + suf : ''}`;
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${tituloCompleto}</title>`);
      // og:title/twitter:title nunca eram tocados aqui — só pelo JS client-side
      // (que não roda pra quem faz o preview do link: WhatsApp, Facebook,
      // Twitter etc. não executam JS, só leem o HTML como veio do servidor).
      // Resultado: o preview de link mostrava "VN Imports" fixo pra qualquer
      // loja, mesmo já configurada.
      html = html.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${tituloCompleto}$2`);
      html = html.replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${tituloCompleto}$2`);
    }

  } catch (e) {
    console.warn('renderLojaHtmlComConfig:', e.message);
  }
  return html;
}

/**
 * Monograma SVG (inicial do nome da loja + cor dourada já configurada) usado
 * como favicon. Servido como rota própria (/favicon.svg), referenciada por um
 * <link> estático (caminho relativo, sem domínio nenhum) nos 4 HTMLs — inclusive
 * search.html e produto.html, que são servidos crus/em cache, sem templating
 * por request. Uma rota dedicada resolve os quatro de uma vez só, em vez de
 * estender templating pra páginas que hoje não têm. Branco-de-loja de
 * propósito: nunca uma letra ou cor fixa de um cliente específico.
 */
function construirFaviconSvg(cfg) {
  const nomeRaw = String(cfg?.nomeLoja || 'Loja').trim();
  const inicial = (nomeRaw.match(/[\p{L}\p{N}]/u) || ['L'])[0].toUpperCase();
  const corRaw = String(cfg?.colors?.gold || '#9A7A3A').trim();
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(corRaw) ? corRaw : '#9A7A3A';
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<rect width='64' height='64' rx='14' fill='${cor}'/>` +
    `<text x='32' y='45' font-family='Georgia,serif' font-size='34' font-weight='700' fill='#ffffff' text-anchor='middle'>${inicial}</text>` +
    `</svg>`
  );
}

/**
 * Placeholder do hero (banner principal da vitrine) quando nenhuma foto foi
 * configurada — nunca mais uma foto de roupa genérica escolhida pra um
 * cliente específico. Painel de gradiente com as cores do tema, sem texto:
 * sempre parece intencional, nunca "quebrado", nunca a loja de ninguém.
 * Mesmo princípio branco-de-loja do construirFaviconSvg.
 */
function construirHeroPlaceholderSvg(cfg) {
  const corRaw1 = String(cfg?.colors?.gold || '#9A7A3A').trim();
  const cor1 = /^#[0-9a-fA-F]{3,8}$/.test(corRaw1) ? corRaw1 : '#9A7A3A';
  const corRaw2 = String(cfg?.colors?.gold2 || '#C4A55A').trim();
  const cor2 = /^#[0-9a-fA-F]{3,8}$/.test(corRaw2) ? corRaw2 : '#C4A55A';
  // viewBox horizontal (era 1200x1500, vertical — feito pro painel estreito
  // do hero split antigo). O hero agora é uma faixa larga de ponta a ponta;
  // um gradiente cortado/esticado não perde informação nenhuma (não é foto,
  // não tem "parte importante" pra cortar), mas o viewBox errado fazia o
  // primeiro carregamento de uma loja nova (antes de qualquer foto subida)
  // parecer um recorte estranho em vez de um gradiente intencional.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1920 1080'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0%' stop-color='${cor1}'/><stop offset='100%' stop-color='${cor2}'/>` +
    `</linearGradient></defs>` +
    `<rect width='1920' height='1080' fill='url(#g)'/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
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

// Cache curto (não no-store): o favicon é pedido a cada carregamento de
// página, por todo visitante — recalcular do banco a cada vez seria uma
// carga desnecessária pra algo que muda raramente (nome/cor da loja).
app.get('/favicon.svg', async (req, res) => {
  let cfg = {};
  try {
    cfg = await buscarConfigCompleta();
  } catch (e) {
    console.warn('favicon.svg:', e.message);
  }
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(construirFaviconSvg(cfg));
});

app.get('/', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});
app.get('/index.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});
app.get('/admin.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderAdminHtmlComConfig());
});
app.get('/VN_IMPORTS.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});

// serve também a raiz do app estático (garante consistência)
app.get('/VN_IMPORTS', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});

// search.html e produto.html: o arquivo bruto continua cacheado em memória
// (só lido do disco uma vez por cold start, igual antes) — o que muda por
// request é só o <style> de override de cor, montado em cima do cache, não
// mais uma leitura de disco a mais. Em produção o express.static abaixo fica
// desligado, e sem essas rotas explícitas + os rewrites correspondentes no
// vercel.json essas páginas batiam 404 (a Vercel roteia "/search.html" e
// "/produto.html" para a function em vez de servir o arquivo estático
// diretamente).
const searchHtmlPath = path.join(__dirname, 'search.html');
let searchHtmlCache = null;
function getSearchHtmlTemplate() {
  if (!searchHtmlCache) searchHtmlCache = fs.readFileSync(searchHtmlPath, 'utf8');
  return searchHtmlCache;
}

const produtoHtmlPath = path.join(__dirname, 'produto.html');
let produtoHtmlCache = null;
function getProdutoHtmlTemplate() {
  if (!produtoHtmlCache) produtoHtmlCache = fs.readFileSync(produtoHtmlPath, 'utf8');
  return produtoHtmlCache;
}

// Mesmo princípio de renderLojaHtmlComConfig, só que sem nome/hero/meta tags
// (essas duas páginas nunca tiveram isso, e não foi pedido agora) — apenas o
// override de cor, pra fechar o mesmo flash que search/produto tinham e as
// outras 3 páginas já não têm.
async function renderPaginaComOverrideCores(html) {
  try {
    const cfg = await buscarConfigCompleta();
    const overrideStyle = construirOverrideCoresStyle(cfg);
    if (overrideStyle) html = html.replace('</head>', overrideStyle);
  } catch (e) {
    console.warn('renderPaginaComOverrideCores:', e.message);
  }
  return html;
}

app.get('/search.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderPaginaComOverrideCores(getSearchHtmlTemplate()));
});

app.get('/produto.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderPaginaComOverrideCores(getProdutoHtmlTemplate()));
});

// Páginas legais (Devolução, Privacidade, Termos) — mesmo motivo e mesmo
// tratamento de search.html/produto.html acima: sem rota explícita +
// rewrite correspondente no vercel.json, batem 404 em produção.
const devolucaoHtmlPath = path.join(__dirname, 'devolucao.html');
let devolucaoHtmlCache = null;
app.get('/devolucao.html', (req, res) => {
  if (!devolucaoHtmlCache) devolucaoHtmlCache = fs.readFileSync(devolucaoHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(devolucaoHtmlCache);
});

const privacidadeHtmlPath = path.join(__dirname, 'privacidade.html');
let privacidadeHtmlCache = null;
app.get('/privacidade.html', (req, res) => {
  if (!privacidadeHtmlCache) privacidadeHtmlCache = fs.readFileSync(privacidadeHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(privacidadeHtmlCache);
});

const termosHtmlPath = path.join(__dirname, 'termos.html');
let termosHtmlCache = null;
app.get('/termos.html', (req, res) => {
  if (!termosHtmlCache) termosHtmlCache = fs.readFileSync(termosHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(termosHtmlCache);
});

const jsCompartilhadoCache = {};
function servirJsCompartilhado(nomeArquivo) {
  return (req, res) => {
    if (!jsCompartilhadoCache[nomeArquivo]) {
      jsCompartilhadoCache[nomeArquivo] = fs.readFileSync(path.join(__dirname, 'js', nomeArquivo), 'utf8');
    }
    semCacheHtml(res);
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.send(jsCompartilhadoCache[nomeArquivo]);
  };
}
app.get('/js/cart.js', servirJsCompartilhado('cart.js'));
app.get('/js/colors.js', servirJsCompartilhado('colors.js'));
app.get('/js/theme.js', servirJsCompartilhado('theme.js'));

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

// Superfície de teste: funções puras (sem I/O de banco/rede) expostas só
// pra suite automatizada em test/ — nenhuma rota, nenhum comportamento de
// produção muda por causa disto (app continua sendo o export principal,
// isto é só uma propriedade extra pendurada nele). Ver test/setup.js.
module.exports.testables = {
  crc16ccitt,
  tlv,
  gerarPixCopiaCola,
  sanitizarChavePix,
  removerAcentosEEspeciais,
  resolverDadosEnvioProduto,
  dividirNomePagador,
  emailPagadorValido,
  validarAssinaturaWebhookMp,
  mergePublicConfig,
  mergePublicSettings,
  slugifyNome,
  slugifyTenantTag
};

// Local: carrega .env com dotenv. Na Vercel (VERCEL definido) NUNCA usamos dotenv —
// JWT_SECRET e demais chaves vêm só de process.env (painel Project → Environment Variables).
if (!process.env.VERCEL) {
  require('dotenv').config();
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const helmet = require('helmet');

const configPadrao = require('./config');
const Review = require('./models/Review');

// Máquina de segredo JWT (cache, resolução, verificarJWT) movida para
// middleware/auth.js — reorganização pura, mesmo comportamento/mesmas
// variáveis de estado (agora privadas do módulo, ver primeJwtSecretCache).
const {
  verificarJWT,
  getJwtSecret,
  invalidateJwtSecretCache,
  probeEnvJwtSecretWithDelay,
  normalizeJwtEnvValue,
  timingSafePasswordEqual,
  primeJwtSecretCache
} = require('./middleware/auth');
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

// cloudinaryPublicIdFromUrl/deleteCloudinaryAssetIfApplicable movidos para
// utils/cloudinary.js — reorganização pura, mesma instância singleton do
// pacote cloudinary (module cache do Node), já configurada acima.
const { cloudinaryPublicIdFromUrl, deleteCloudinaryAssetIfApplicable } = require('./utils/cloudinary');

// slugifyTenantTag/slugifyNome movidos para utils/slug.js — reorganização pura.
const { slugifyTenantTag, slugifyNome } = require('./utils/slug');

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

// Conexão singleton com MongoDB movida para utils/db.js — usada por quase
// toda rota (ensureDbConnected/tryConnectDb), então precisa ser um módulo
// independente sem depender de server.js, evitando dependência circular
// quando as rotas também passam a viver em módulos próprios.
const { connectDB, tryConnectDb, ensureDbConnected } = require('./utils/db');

if (process.env.NODE_ENV === 'production') {
  connectDB().catch((e) => console.error('MongoDB (startup):', e.message));
} else {
  connectDB().catch((err) => console.error('Erro initial MongoDB:', err.message));
}

// Rotas de /api/admin/login e /api/upload movidas para routes/auth.js e
// routes/upload.js — reorganização pura (ambos grupos adicionais, não
// estavam na lista original de rotas; upload não pertence claramente a
// nenhum recurso específico, e login é sua própria responsabilidade,
// distinta de verificarJWT que continua em middleware/auth.js).
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/upload'));

// ── MODELS ─────────────────────────────────────────────
// Schemas movidos para /models (um arquivo por model, mesma convenção já
// usada por models/Review.js antes desta refatoração) — reorganização pura,
// nenhum schema/validação/comportamento mudou. Produto/Category/Banner não
// ficam mais em escopo aqui: nenhuma rota restante em server.js os usa
// diretamente (todas as rotas que precisavam deles já foram para routes/).
const Settings = require('./models/Settings');
const Order = require('./models/Order');

// ConfigSchema/Config movidos para models/Config.js — extração adiada até
// aqui de propósito (dependia de utils/temas.js e utils/slug.js, que só
// passaram a existir na fase de utils desta refatoração).
const Config = require('./models/Config');

// mergePublicSettings/temMpTokenSalvo movidos para utils/settingsLoja.js;
// mergePublicConfig movida para utils/configLoja.js — reorganização pura.
// TEMAS_FUNDO/TEMAS_HERO/RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK não ficam mais
// em escopo aqui: nenhuma rota restante em server.js os usa diretamente
// depois que /api/config foi para routes/config.js.
const { mergePublicSettings, temMpTokenSalvo } = require('./utils/settingsLoja');
const { mergePublicConfig } = require('./utils/configLoja');

// Funcoes de geracao do Pix Copia e Cola (BR Code) movidas para utils/pix.js
// -- reorganizacao pura, mesmo comportamento (inclusive o hifen mantido em
// sanitizarChavePix, ja registrado como divergencia doc/codigo conhecida).
const { removerAcentosEEspeciais, sanitizarChavePix, tlv, crc16ccitt, gerarPixCopiaCola, validarAssinaturaWebhookMp } = require('./utils/pix');

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

// Rotas de /api/produtos movidas para routes/produtos.js — reorganização
// pura, mesma ordem interna preservada (search antes de :id, ver comentário
// no arquivo de rota).
app.use('/api', require('./routes/produtos'));

// Rotas de /api/categories e /api/banners movidas para routes/categorias.js
// e routes/banners.js — reorganização pura.
app.use('/api', require('./routes/categorias'));
app.use('/api', require('./routes/banners'));

// Rotas de reviews/stats movidas para routes/reviews.js — reorganização
// pura (grupo adicional, não estava na lista original de rotas — reviews é
// sua própria responsabilidade, distinta de produtos/categorias/etc.).
app.use('/api', require('./routes/reviews'));

// Settings (public)
// Rotas de /api/orders, /api/admin/orders/*, /api/cron/* e
// /api/frete/calcular movidas para routes/pedidos.js -- reorganizacao pura
// (cron e frete dobrados neste grupo, ver relatorio final).
app.use('/api', require('./routes/pedidos'));

// Rotas de /api/settings e /api/config movidas para routes/config.js --
// reorganizacao pura (settings dobrado neste grupo, ver relatorio final).
app.use('/api', require('./routes/config'));

// dividirNomePagador/emailPagadorValido movidos para utils/pagador.js —
// reorganização pura. Mantido em escopo aqui só por causa do
// module.exports.testables (a rota de pagamento que os usa foi para
// routes/pagamento.js, que tem seu próprio require independente).
const { dividirNomePagador, emailPagadorValido } = require('./utils/pagador');

// resolverDadosEnvioProduto ainda precisa estar em escopo aqui só por causa
// do module.exports.testables no fim do arquivo — cotarFreteMelhorEnvio não
// é mais usada em server.js (a rota /api/frete/calcular foi pra
// routes/pedidos.js, ver acima).
const { resolverDadosEnvioProduto } = require('./utils/frete');

// Rotas de /api/pix/* e /api/payment/* movidas para routes/pagamento.js —
// reorganização pura, mesmo comportamento (mesma validação, mesmos nomes
// de campo, mesmas respostas de erro). GRUPO MAIS SENSÍVEL do sistema
// (pagamento/webhook), movido por último e com atenção redobrada — ver
// relatório final da refatoração. Ordem de registro preservada (mesma
// posição relativa aos demais grupos /api).
app.use('/api', require('./routes/pagamento'));

// ── INICIAR SERVIDOR (LOCAL) ───────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
}

// Rotas de HTML público (VN_IMPORTS.html, admin.html, search.html,
// produto.html, páginas legais, favicon, js/css compartilhados) movidas
// para routes/paginas.js — reorganização pura (grupo adicional, não
// estava na lista original de rotas; é a implementação das páginas
// HTML/estáticas, sua própria responsabilidade). __dirname dentro do
// arquivo movido foi corrigido pra apontar pra raiz do projeto (ver
// comentário no próprio arquivo).
app.use('/', require('./routes/paginas'));

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

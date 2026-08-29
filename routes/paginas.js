const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { buscarConfigCompleta } = require('../utils/configLoja');
const { escapeParaAtributo, construirOverrideCoresStyle, construirFaviconSvg } = require('../utils/placeholder');
const { tryConnectDb } = require('../utils/db');
const Banner = require('../models/Banner');

// __dirname aqui é routes/, não a raiz do projeto — por isso todo path.join
// abaixo sobe um nível ('..') antes de apontar pro arquivo, diferente de como
// era em server.js (onde __dirname já era a raiz). Mesmo arquivo final,
// caminho relativo corrigido pra refletir a nova localização deste módulo.
const lojaHtml = path.join(__dirname, '..', 'VN_IMPORTS.html');

// Cacheia o template bruto do HTML em memória (o arquivo em si só muda com um novo deploy;
// os dados variáveis — cor, imagem, nome — são injetados a cada request por cima do cache).
let lojaHtmlTemplateCache = null;
function getLojaHtmlTemplate() {
  if (!lojaHtmlTemplateCache) {
    lojaHtmlTemplateCache = fs.readFileSync(lojaHtml, 'utf8');
  }
  return lojaHtmlTemplateCache;
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

    // Imagem de preview (WhatsApp/Instagram/etc.): reaproveita a imagem do
    // primeiro banner do carrossel (ordem mais baixa), quando existe algum
    // cadastrado — sempre uma URL absoluta de verdade (Cloudinary ou URL
    // direta), nunca o og-image.jpg fixo no arquivo, que nunca existiu como
    // arquivo real (por isso o preview sempre veio sem imagem quando não
    // havia banner). Antes vinha de heroImagem/heroImagemUrl (removidos —
    // ver models/Config.js); a imagem do hero agora é só o banner.
    try {
      if (await tryConnectDb()) {
        const primeiroBanner = await Banner.findOne().sort({ ordem: 1, createdAt: 1 }).select('imagem').lean();
        const ogImg = escapeParaAtributo(primeiroBanner?.imagem);
        if (ogImg) {
          html = html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${ogImg}$2`);
          html = html.replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${ogImg}$2`);
        }
      }
    } catch (e) {
      console.warn('renderLojaHtmlComConfig (og:image do banner):', e.message);
    }

    // Cores: bg/bg2/border (tema de fundo) e gold/gold2 (cor da marca) são os
    // únicos tokens que podem divergir do :root estático do arquivo.
    const overrideStyle = construirOverrideCoresStyle(cfg);
    if (overrideStyle) html = html.replace('</head>', overrideStyle);

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

const adminHtml = path.join(__dirname, '..', 'admin.html');
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
router.get('/favicon.svg', async (req, res) => {
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

router.get('/', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});
router.get('/index.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});
router.get('/admin.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderAdminHtmlComConfig());
});
router.get('/VN_IMPORTS.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderLojaHtmlComConfig(req));
});

// serve também a raiz do app estático (garante consistência)
router.get('/VN_IMPORTS', async (req, res) => {
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
const searchHtmlPath = path.join(__dirname, '..', 'search.html');
let searchHtmlCache = null;
function getSearchHtmlTemplate() {
  if (!searchHtmlCache) searchHtmlCache = fs.readFileSync(searchHtmlPath, 'utf8');
  return searchHtmlCache;
}

const produtoHtmlPath = path.join(__dirname, '..', 'produto.html');
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

router.get('/search.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderPaginaComOverrideCores(getSearchHtmlTemplate()));
});

router.get('/produto.html', async (req, res) => {
  semCacheHtml(res);
  res.send(await renderPaginaComOverrideCores(getProdutoHtmlTemplate()));
});

// Páginas legais (Devolução, Privacidade, Termos) — mesmo motivo e mesmo
// tratamento de search.html/produto.html acima: sem rota explícita +
// rewrite correspondente no vercel.json, batem 404 em produção.
const devolucaoHtmlPath = path.join(__dirname, '..', 'devolucao.html');
let devolucaoHtmlCache = null;
router.get('/devolucao.html', (req, res) => {
  if (!devolucaoHtmlCache) devolucaoHtmlCache = fs.readFileSync(devolucaoHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(devolucaoHtmlCache);
});

const privacidadeHtmlPath = path.join(__dirname, '..', 'privacidade.html');
let privacidadeHtmlCache = null;
router.get('/privacidade.html', (req, res) => {
  if (!privacidadeHtmlCache) privacidadeHtmlCache = fs.readFileSync(privacidadeHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(privacidadeHtmlCache);
});

const termosHtmlPath = path.join(__dirname, '..', 'termos.html');
let termosHtmlCache = null;
router.get('/termos.html', (req, res) => {
  if (!termosHtmlCache) termosHtmlCache = fs.readFileSync(termosHtmlPath, 'utf8');
  semCacheHtml(res);
  res.send(termosHtmlCache);
});

const jsCompartilhadoCache = {};
function servirJsCompartilhado(nomeArquivo) {
  return (req, res) => {
    if (!jsCompartilhadoCache[nomeArquivo]) {
      jsCompartilhadoCache[nomeArquivo] = fs.readFileSync(path.join(__dirname, '..', 'js', nomeArquivo), 'utf8');
    }
    semCacheHtml(res);
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.send(jsCompartilhadoCache[nomeArquivo]);
  };
}
router.get('/js/cart.js', servirJsCompartilhado('cart.js'));
router.get('/js/colors.js', servirJsCompartilhado('colors.js'));
// Divisão do <script> inline de VN_IMPORTS.html por funcionalidade
// (Estágio 2) — cada arquivo abaixo precisa da mesma dupla rota+rewrite
// (ver comentário sobre /css/vn-imports.css logo abaixo) desde o commit
// em que é criado, nunca depois.
router.get('/js/vn-core.js', servirJsCompartilhado('vn-core.js'));
router.get('/js/vn-hero-carousel.js', servirJsCompartilhado('vn-hero-carousel.js'));
router.get('/js/vn-reviews.js', servirJsCompartilhado('vn-reviews.js'));
router.get('/js/vn-nav.js', servirJsCompartilhado('vn-nav.js'));
router.get('/js/vn-shop-config.js', servirJsCompartilhado('vn-shop-config.js'));

// CSS compartilhado entre devolucao.html/privacidade.html/termos.html — ao
// contrário dos js/*.js acima (no-store, mesmo padrão das páginas HTML
// templadas por requisição), este arquivo nunca muda com base em quem
// pediu: cache público curto (mesmo raciocínio do /favicon.svg) em vez de
// no-store, para quem olha mais de uma página legal na mesma visita não
// buscar o mesmo CSS de novo a cada uma.
let legalCssCache = null;
router.get('/css/legal.css', (req, res) => {
  if (!legalCssCache) {
    legalCssCache = fs.readFileSync(path.join(__dirname, '..', 'css', 'legal.css'), 'utf8');
  }
  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(legalCssCache);
});

// CSS extraído do <style> inline de VN_IMPORTS.html (Estágio 1 da divisão do
// arquivo). Mesmo motivo de existir de /css/legal.css acima: em produção o
// express.static de server.js fica desligado (só roda fora de produção —
// ver `if (process.env.NODE_ENV !== 'production')` lá), então NENHUM
// arquivo estático deste projeto é servido de graça — cada um precisa da
// própria rota aqui, IGUAL sua entrada correspondente em vercel.json
// (rewrites), senão a Vercel roteia pra function sem nenhuma rota bater e
// a resposta não vira CSS de verdade (foi exatamente isso que quebrou o
// visual em produção da primeira vez, sem essa rota). Cache público como
// legal.css (não muda por request, só por deploy — não é o caso do
// no-store usado no HTML da loja, que tem cor/imagem/nome variáveis
// injetados por cima do cache em memória a cada request).
let vnImportsCssCache = null;
router.get('/css/vn-imports.css', (req, res) => {
  if (!vnImportsCssCache) {
    vnImportsCssCache = fs.readFileSync(path.join(__dirname, '..', 'css', 'vn-imports.css'), 'utf8');
  }
  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(vnImportsCssCache);
});

module.exports = router;

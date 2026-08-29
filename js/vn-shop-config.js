// Configuração da loja (Admin -> Mongo -> vitrine) — extraído de
// VN_IMPORTS.html (Estágio 2). Cache local (stale-while-revalidate) do
// nome/cor da loja, carregamento de /api/config, aplicação de Sobre +
// Benefícios. Depende de vn-core.js (S, DEF, escapeHtmlTexto, API_URL) e
// de aplicarCoresDaLoja (js/colors.js, já existente). Ponto de entrada
// externo: carregarConfigLoja(), chamado pelo bootstrap no
// DOMContentLoaded.

let vitrineNomeLoja = DEF.store;

// ─── SHOP CONFIG — cache local (stale-while-revalidate) ──────────────────
// Evita o FOUC do nome/logo antigo: aplica o que já está salvo no dispositivo
// na hora (sem esperar rede) e só então busca a config real em background,
// atualizando o DOM e o cache se algo tiver mudado.
const LOJA_CACHE_KEY = 'vni_shopConfigCache';

function lerConfigCache(){
  try{ const raw = localStorage.getItem(LOJA_CACHE_KEY); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function salvarConfigCache(d){
  try{ localStorage.setItem(LOJA_CACHE_KEY, JSON.stringify(d)); }catch(e){ /* localStorage indisponível — segue sem cache */ }
}
function aplicarNomeLojaCache(nome){
  const nomeFinal = String(nome || '').trim();
  if(!nomeFinal) return;
  vitrineNomeLoja = nomeFinal;
  S.store = nomeFinal;
  document.querySelectorAll('[data-loja="nome"]').forEach((el) => {
    el.textContent = nomeFinal;
    el.classList.add('is-ready');
  });
}

/* aplicarCoresDaLoja() agora vem de /js/colors.js (compartilhado com produto.html e search.html) */



/** Mantém o estilo visual: primeira palavra + restante em <em>. */
function formatSobreTituloHtml(titulo) {
  const t = String(titulo || '').trim();
  if (!t) return '';
  const parts = t.split(/\s+/);
  if (parts.length >= 2) {
    return escapeHtmlTexto(parts[0]) + ' <em>' + escapeHtmlTexto(parts.slice(1).join(' ')) + '</em>';
  }
  return escapeHtmlTexto(t);
}

function revelarConteudoEl(el) {
  if (!el) return;
  el.classList.remove('is-loading');
  el.removeAttribute('aria-busy');
  // Força reflow antes do fade-in
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.classList.add('is-ready');
  });
}

function aplicarBeneficioDinamico(n, d) {
  const titulo = d['benef' + n + 'Titulo'];
  const texto = d['benef' + n + 'Texto'];
  const ico = d['benef' + n + 'Ico'];
  const icoOn = d['benef' + n + 'IcoEnabled'] !== false;

  const titEl = document.getElementById('benefit-' + n + '-title');
  const descEl = document.getElementById('benefit-' + n + '-desc');
  const icoEl = document.getElementById('benefit-' + n + '-ico');

  if (titEl) {
    const t = titulo != null && String(titulo).trim() ? String(titulo).trim() : '';
    titEl.textContent = t || ('Benefício ' + n);
    revelarConteudoEl(titEl);
  }
  if (descEl) {
    const tx = texto != null && String(texto).trim() ? String(texto).trim() : '';
    descEl.textContent = tx || '—';
    revelarConteudoEl(descEl);
  }
  if (icoEl) {
    if (!icoOn) {
      icoEl.style.display = 'none';
    } else if (ico != null && String(ico).trim()) {
      icoEl.textContent = String(ico).trim();
      icoEl.style.display = '';
    }
  }
}



/** Aplica Sobre + Benefícios no DOM com fade-in (sem FOUC). */
function aplicarConteudoDinamico(d) {
  if (!d || typeof d !== 'object') return;

  const aboutTitle = document.getElementById('about-title');
  const aboutText = document.getElementById('about-text');

  if (aboutTitle) {
    const titulo = d.sobreTitulo != null && String(d.sobreTitulo).trim()
      ? String(d.sobreTitulo).trim()
      : (vitrineNomeLoja || 'Minha Loja');
    aboutTitle.innerHTML = formatSobreTituloHtml(titulo);
    revelarConteudoEl(aboutTitle);
  }
  if (aboutText) {
    const texto = d.sobreTexto != null && String(d.sobreTexto).trim()
      ? String(d.sobreTexto).trim()
      : 'Conte a história da sua loja aqui.';
    aboutText.textContent = texto;
    revelarConteudoEl(aboutText);
  }

  for (let i = 1; i <= 4; i++) aplicarBeneficioDinamico(i, d);
}

/**
 * Busca o conteúdo dinâmico (Sobre + Benefícios) salvo pelo Admin.
 * Fonte: /api/config. Em falha, revela fallback suave (sem texto chumbado antigo).
 */
async function carregarConteudoDinamico(preloaded) {
  try {
    let d = preloaded;
    if (!d) {
      const r = await fetch(API_URL + '/config');
      if (!r.ok) throw new Error('config http ' + r.status);
      d = await r.json();
    }
    aplicarConteudoDinamico(d);
  } catch {
    aplicarConteudoDinamico({
      sobreTitulo: vitrineNomeLoja || 'Minha Loja',
      sobreTexto: 'Conte a história da sua loja aqui.',
      benef1Titulo: 'Entrega Rápida',
      benef1Texto: 'Receba com agilidade e segurança.',
      benef2Titulo: 'Devolução em 7 Dias',
      benef2Texto: 'Direito de arrependimento garantido por lei.',
      benef3Titulo: 'Pagamento Seguro',
      benef3Texto: 'Pix e cartão com total segurança.',
      benef4Titulo: 'Importado Selecionado',
      benef4Texto: 'Curadoria rigorosa de produtos internacionais.'
    });
  }
}

// Injeta nome da loja, sufixo do título e variáveis CSS da vitrine
async function carregarConfigLoja() {
  // Aplica o nome cacheado imediatamente (antes de qualquer fetch) — some com
  // o flash do nome antigo em visitas repetidas, sem esperar a rede.
  const _cache = lerConfigCache();
  if (_cache && _cache.nomeLoja) aplicarNomeLojaCache(_cache.nomeLoja);

  try {
    const r = await fetch(API_URL + '/config');
    if (!r.ok) {
      if (!_cache) aplicarNomeLojaCache(vitrineNomeLoja);
      return;
    }
    const d = await r.json();
    salvarConfigCache(d);

    const nome = (d.nomeLoja && String(d.nomeLoja).trim()) || vitrineNomeLoja;
    vitrineNomeLoja = nome;
    S.store = nome;

    const suf = (d.pageTitleSuffixEfetivo && String(d.pageTitleSuffixEfetivo).trim()) || 'Loja Oficial';
    document.title = nome + ' — ' + suf;

    // Atualiza OG tags dinamicamente com dados reais da loja. Título/descrição
    // já são templados no servidor (renderLojaHtmlComConfig) — é o único
    // caminho que preview de link (WhatsApp/Facebook etc.) de fato lê, porque
    // esses serviços não executam JS. Isso aqui cobre só og:title/twitter:title
    // como reforço (ex.: se o template server-side falhar por algum motivo,
    // ainda corrige assim que o /api/config carregar no navegador).
    const _ogTitle   = document.querySelector('meta[property="og:title"]');
    const _twTitle   = document.querySelector('meta[name="twitter:title"]');

    const _lojaTitle = nome + ' — ' + suf;

    if (_ogTitle)  _ogTitle.setAttribute('content', _lojaTitle);
    if (_twTitle)  _twTitle.setAttribute('content', _lojaTitle);

    // og:image/twitter:image: sem reforço client-side (a imagem, diferente
    // do título, só é injetada no servidor — ver renderLojaHtmlComConfig em
    // routes/paginas.js, que usa o primeiro banner do carrossel). Antes lia
    // d.heroImagem/d.heroImagemUrl daqui, removidos junto com o hero único.

    document.querySelectorAll('[data-loja="nome"]').forEach((el) => {
      el.textContent = nome;
      el.classList.add('is-ready');
    });

    aplicarCoresDaLoja(d.colors);

    const tel = (d.whatsappContato && String(d.whatsappContato).trim()) || '';
    const email = (d.emailContato && String(d.emailContato).trim()) || '';
    const ig = (d.instagramLink && String(d.instagramLink).trim()) || '';

    const t1 = document.getElementById('contatoTelefone');
    const t2 = document.getElementById('contatoTelefoneDetalhe');
    if (t1 && tel) t1.textContent = tel;
    if (t2 && tel) t2.textContent = tel;

    const e2 = document.getElementById('contatoEmailDetalhe');
    if (e2 && email) e2.textContent = email;

    const igEl = document.getElementById('igLink');
    if (igEl && ig) igEl.href = ig;

    // Integração Pix (chave) — o checkout precisa receber isso.
    // Neste projeto, o checkout é via S.paylink. Como não existe montagem de paylink aqui,
    // ao menos garantimos que a chavePix não seja ignorada e fica disponível.
    const pix = (d.chavePix && String(d.chavePix).trim()) || '';
    S.chavePix = pix;

    // Texto do hero único (título/eyebrow/descrição/fonte custom, lidos de
    // d.heroTitle/d.heroEyebrow/d.heroSubtitulo/d.heroFont) e a foto única
    // (heroImagem/heroImagemUrl, já removida numa etapa anterior) foram
    // ambos removidos — #heroSplitMedia fica vazio, mostrando só seu
    // próprio fundo em gradiente (ver CSS). A imagem do hero agora vem só
    // do carrossel de banners (ver montarHeroCarousel/carregarListaBannersHero
    // mais abaixo, que reaproveitam a MESMA detecção de baixa resolução e a
    // MESMA extração de cor do hero único de foto, por banner individual).

    // Barra de anúncio (frete grátis / parcelamento): só aparece se o admin
    // realmente ativou. Antes era texto fixo prometendo algo que a loja podia
    // nem oferecer (ex: parcelamento sem ter pagamento por cartão configurado).
    const freteOn = !!d.freteGratisAtivo;
    const parcOn = !!d.parcelamentoAtivo;
    const freteVal = Number(d.freteGratisValor) || 0;
    const parcVal = Math.max(1, Number(d.parcelamentoMax) || 1);
    // Globais usados por outras telas (ex: página de produto) que renderizam depois.
    window.S_freteGratisAtivo = freteOn;
    window.S_freteGratisValor = freteVal;
    window.S_parcelamentoAtivo = parcOn;
    window.S_parcelamentoMax = parcVal;
    // Padrão de peso/dimensão da loja — usado por temDadosEnvio() pra decidir
    // se um produto sem peso/dimensão próprio ainda pode ser vendido.
    window.S_pesoKgPadrao = d.pesoKgPadrao ?? null;
    window.S_larguraCmPadrao = d.larguraCmPadrao ?? null;
    window.S_alturaCmPadrao = d.alturaCmPadrao ?? null;
    window.S_comprimentoCmPadrao = d.comprimentoCmPadrao ?? null;
    S.parc = parcVal;
    S.frete = freteVal;

    const pvFeatFrete = document.getElementById('pvFeatFrete');
    if (pvFeatFrete && freteOn) {
      document.getElementById('pvFeatFreteVal').textContent = freteVal.toFixed(0);
      pvFeatFrete.style.display = '';
    }

    // HOME (frete + parcelamento)
    const elAnHome = document.getElementById('announceHome');
    if (elAnHome) {
      if (freteOn || parcOn) {
        document.getElementById('anFrete').textContent = freteVal.toFixed(0);
        document.getElementById('anParc').textContent = String(parcVal);
        if (!freteOn) elAnHome.innerHTML = `Parcele em até <em id="anParc">${parcVal}</em>x sem juros`;
        else if (!parcOn) elAnHome.innerHTML = `Frete <em>GRÁTIS</em> acima de R$<span id="anFrete">${freteVal.toFixed(0)}</span>`;
        elAnHome.style.display = '';
      }
    }
    // PRODUTO (frete + parcelamento)
    const elAnProd = document.getElementById('announceProduct');
    if (elAnProd && (freteOn || parcOn)) {
      if (!freteOn) elAnProd.innerHTML = `Parcele em até <em style="color:var(--gold2);font-style:normal">${parcVal}</em>x sem juros`;
      else if (!parcOn) elAnProd.innerHTML = `Frete <em style="color:var(--gold2);font-style:normal">GRÁTIS</em> acima de R$${freteVal.toFixed(0)}`;
      else {
        document.getElementById('anFreteProd').textContent = freteVal.toFixed(0);
        document.getElementById('anParcProd').textContent = String(parcVal);
      }
      elAnProd.style.display = '';
    }
    // WISHLIST / CONTACT (só frete)
    ['Wishlist', 'Contact'].forEach((suf) => {
      const el = document.getElementById('announce' + suf);
      if (el && freteOn) {
        const span = document.getElementById('anFrete' + (suf === 'Wishlist' ? 'Wl' : 'Ct'));
        if (span) span.textContent = freteVal.toFixed(0);
        el.style.display = '';
      }
    });

    // Banner de promoção: só aparece com o admin ativando e preenchendo o texto.
    const promoOn = !!d.promoAtiva && (d.promoTitulo || '').trim();
    const promoBanner = document.getElementById('promoBanner');
    if (promoBanner && promoOn) {
      const eyeEl = document.getElementById('promoEyebrowEl');
      const titEl = document.getElementById('promoTituloEl');
      const subEl = document.getElementById('promoSubtituloEl');
      const ctaEl = document.getElementById('promoCtaEl');
      if (eyeEl) eyeEl.textContent = d.promoEyebrow || 'Oferta Especial';
      if (titEl) titEl.textContent = d.promoTitulo;
      if (subEl) subEl.textContent = d.promoSubtitulo || '';
      if (ctaEl) ctaEl.textContent = (d.promoCtaTexto || 'Ver promoções') + ' →';
      promoBanner.style.display = '';
    }

    // Sobre Nós + Benefícios (Admin → Mongo → vitrine)
    await carregarConteudoDinamico(d);

    // Se o link de pagamento dependesse da chave (ex.: provider externo), ele deveria ser montado aqui.
    // Como o seu checkout usa S.paylink e ele está vindo vazio no DEF, manteremos um comportamento compatível:
    // - se existir paylink fixo em algum lugar, usamos.
    // - caso contrário, o checkout vai falhar e exibirá instrução.
  } catch {
    // Rede falhou. Se não havia cache pra ter aplicado nome nenhum ainda,
    // usa o padrão local (DEF.store) como último recurso — nunca deixa o
    // logo/nome em branco pra sempre.
    if (!_cache) aplicarNomeLojaCache(vitrineNomeLoja);
  }
}

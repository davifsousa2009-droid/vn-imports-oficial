// Carrossel de banners do hero — extraído de VN_IMPORTS.html (Estágio 2,
// divisão do <script> inline por funcionalidade). Sem dependência de nenhum
// outro arquivo novo desta divisão: usa só DOM/APIs do navegador e o
// endpoint /api/banners. Único ponto de entrada externo:
// montarHeroCarousel(banners), chamado pelo bootstrap inline no fim de
// VN_IMPORTS.html (dentro do DOMContentLoaded), quando há 1+ banner.

// Intervalo de troca automática do carrossel de banners do hero (ver
// montarHeroCarousel/iniciarAutoplayHero mais abaixo) — uma única constante
// no topo do script, não hardcoded em cada lugar que usa o valor.
const HERO_CAROUSEL_INTERVAL_MS = 6000;

// ─── COR DINÂMICA DO HERO (extraída da própria foto) ───
// Usada pelo carrossel de banners (ver montarHeroCarousel mais abaixo),
// uma vez por slide — cada banner tem sua própria cor extraída, aplicada só
// no CTA daquele slide. Sem banner cadastrado, nenhuma extração roda.

// Luminância relativa (WCAG 2.x) e contraste contra branco puro — mesma
// fórmula/piso (4.5:1, AA) já usado pra validar as demais cores do site
// (ex.: .btn-fill): nenhuma cor de marca livre tinha essa garantia antes,
// por isso ficavam de fora.
function luminanciaRelativa(rgb) {
  const linear = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}
function contrasteComBranco(rgb) {
  // Branco puro tem luminância 1; fórmula de contraste WCAG: (L_claro+0.05)/(L_escuro+0.05).
  return 1.05 / (luminanciaRelativa(rgb) + 0.05);
}

// Escurece a cor proporcionalmente (mesma matiz, só reduz luminosidade) até
// o contraste com texto branco passar do piso mínimo. Converge sempre —
// mesmo branco puro (contraste inicial 1:1) chega em ~19 passos; 60 é uma
// margem generosa que nunca deve ser atingida na prática.
function garantirContrasteComBranco(rgb, minimo) {
  minimo = minimo || 4.5;
  let cor = { r: rgb.r, g: rgb.g, b: rgb.b };
  let passos = 0;
  while (contrasteComBranco(cor) < minimo && passos < 60) {
    cor = { r: cor.r * 0.96, g: cor.g * 0.96, b: cor.b * 0.96 };
    passos++;
  }
  return {
    r: Math.max(0, Math.min(255, Math.round(cor.r))),
    g: Math.max(0, Math.min(255, Math.round(cor.g))),
    b: Math.max(0, Math.min(255, Math.round(cor.b)))
  };
}

function rgbParaHex(rgb) {
  const canal = (c) => c.toString(16).padStart(2, '0');
  return '#' + canal(rgb.r) + canal(rgb.g) + canal(rgb.b);
}

// Amostra a cor média de uma foto via <canvas> oculto (nunca inserido no
// DOM) numa cópia SEPARADA da imagem, com crossOrigin — decisão deliberada:
// as <img class="hero-car-img"> visíveis do carrossel NUNCA levam
// crossOrigin, porque isso faria o navegador recusar exibir a foto inteira
// caso o host não mande cabeçalho CORS (comum em URL externa colada pelo
// lojista no banner; já funciona por padrão nas fotos enviadas por upload,
// hospedadas no Cloudinary). Com a amostragem numa imagem própria e
// descartável, uma falha de CORS aqui derruba só a extração de cor (cai no
// catch, cor de marca padrão continua valendo) — a foto real exibida ao
// cliente nunca é afetada de jeito nenhum.
function amostrarCorDominante(url, aoSucesso, aoFalhar) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function () {
    try {
      const LADO = 50;
      const canvas = document.createElement('canvas');
      canvas.width = LADO;
      canvas.height = LADO;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, LADO, LADO);
      const dados = ctx.getImageData(0, 0, LADO, LADO).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < dados.length; i += 4) {
        if (dados[i + 3] < 32) continue; // ignora pixel quase transparente
        r += dados[i]; g += dados[i + 1]; b += dados[i + 2];
        n++;
      }
      if (!n) { aoFalhar(new Error('Amostra sem pixels válidos')); return; }
      aoSucesso({ r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) });
    } catch (e) {
      // getImageData lança SecurityError se o canvas ficou "tainted"
      // (host sem CORS habilitado) — falha esperada, não um bug.
      aoFalhar(e);
    }
  };
  img.onerror = function () { aoFalhar(new Error('Falha ao carregar a foto pra amostragem')); };
  img.src = url;
}

// aplicarCorDinamicaHero (aplicava a cor extraída no hero único de foto só —
// #heroCtaPrimary/.hero-split) foi removida junto com o hero único. As
// funções acima (amostrarCorDominante/garantirContrasteComBranco/
// rgbParaHex) continuam em uso — agora só pelo carrossel, uma vez por
// banner (ver montarHeroCarousel abaixo).

// ─── HERO CARROSSEL (múltiplos banners) ───
// Busca GET /api/banners (já vem ordenado por `ordem` do backend) e decide
// entre o hero único (0 ou 1 banner, tratamento normal) e o carrossel
// completo (2+ banners) — ver chamada em DOMContentLoaded.
async function carregarListaBannersHero() {
  try {
    const r = await fetch(API_URL + '/banners');
    if (!r.ok) return [];
    const lista = await r.json();
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

let heroCarouselState = null;

function prefersReducedMotionHero() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Monta o carrossel completo a partir da lista de banners. Chamada só se
// banners.length >= 1 (ver DOMContentLoaded) — o hero único já foi escondido
// antes de qualquer coisa aqui rodar, então não há os dois visíveis ao
// mesmo tempo em nenhum momento.
function montarHeroCarousel(banners) {
  const secao = document.getElementById('heroCarousel');
  const track = document.getElementById('heroCarouselTrack');
  const dotsWrap = document.getElementById('heroCarDots');
  const btnPrev = document.getElementById('heroCarPrev');
  const btnNext = document.getElementById('heroCarNext');
  const btnPause = document.getElementById('heroCarPause');
  if (!secao || !track) return;

  const total = banners.length;
  // Item único: mostra com o mesmo tratamento adaptativo (letterbox + cor),
  // mas sem seta/bolinha/pausar — não faz sentido controle de carrossel pra
  // um item só (requisito explícito).
  const comControles = total >= 2;

  track.innerHTML = '';
  dotsWrap.innerHTML = '';

  banners.forEach((banner, i) => {
    const eyebrow = banner.eyebrow ? String(banner.eyebrow).trim() : '';
    const titulo = banner.titulo ? String(banner.titulo).trim() : '';
    const subtitulo = banner.subtitulo ? String(banner.subtitulo).trim() : '';
    const textoBotao = banner.textoBotao ? String(banner.textoBotao).trim() : '';
    const linkBotao = banner.linkBotao ? String(banner.linkBotao).trim() : '';
    const temTexto = !!(eyebrow || titulo || subtitulo || textoBotao);

    const slide = document.createElement('div');
    slide.className = 'hero-car-slide' + (i === 0 ? ' on' : '');
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', (i + 1) + ' de ' + total);
    slide.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');

    const mediaEl = document.createElement('div');
    mediaEl.className = 'hero-car-media';

    // Fundo desfocado: cópia da MESMA foto, ampliada e borrada via CSS (ver
    // .hero-car-blur-bg), cobrindo o container inteiro por trás da imagem
    // nítida — só fica visível de verdade quando a foto é pequena demais
    // pra cobrir tudo sozinha (ver .slide-media-compact). Puramente
    // decorativa (é a MESMA foto que a imagem nítida ao lado já descreve
    // pro leitor de tela) — alt vazio + aria-hidden, pra não duplicar o
    // texto alternativo.
    const blurBgEl = document.createElement('img');
    blurBgEl.className = 'hero-car-blur-bg';
    blurBgEl.alt = '';
    blurBgEl.setAttribute('aria-hidden', 'true');
    mediaEl.appendChild(blurBgEl);

    const imgEl = document.createElement('img');
    imgEl.className = 'hero-car-img';
    // Alt: título do banner quando existe, senão texto genérico (requisito
    // de acessibilidade explícito) — nunca alt vazio, a foto é conteúdo, não
    // decoração (é o próprio banner promocional).
    imgEl.alt = titulo || ('Banner promocional ' + (i + 1) + ' de ' + total);
    mediaEl.appendChild(imgEl);
    slide.appendChild(mediaEl);

    let ctaEl = null;
    if (temTexto) {
      const scrim = document.createElement('div');
      scrim.className = 'hero-car-scrim';
      slide.appendChild(scrim);

      const textoWrap = document.createElement('div');
      textoWrap.className = 'hero-car-text';

      // Coreografia de entrada (eyebrow -> título -> subtítulo -> botão):
      // cada item recebe .hero-car-text-item + um animation-delay crescente,
      // na ordem em que REALMENTE aparece nesse slide (um banner sem
      // eyebrow começa a sequência já no título, não fica esperando um
      // atraso "reservado" pra um elemento que não existe).
      let atrasoIndex = 0;
      const marcarEntrada = (el) => {
        el.classList.add('hero-car-text-item');
        el.style.animationDelay = (atrasoIndex * 70) + 'ms';
        atrasoIndex++;
      };

      if (eyebrow) {
        const eyebrowEl = document.createElement('div');
        eyebrowEl.className = 'hero-car-eyebrow';
        eyebrowEl.textContent = eyebrow;
        marcarEntrada(eyebrowEl);
        textoWrap.appendChild(eyebrowEl);
      }
      if (titulo) {
        const h2 = document.createElement('h2');
        h2.className = 'hero-car-title';
        h2.textContent = titulo;
        marcarEntrada(h2);
        textoWrap.appendChild(h2);
      }
      if (subtitulo) {
        const p = document.createElement('p');
        p.className = 'hero-car-subtitle';
        p.textContent = subtitulo;
        marcarEntrada(p);
        textoWrap.appendChild(p);
      }
      if (textoBotao) {
        ctaEl = document.createElement('a');
        ctaEl.className = 'hero-car-cta';
        ctaEl.textContent = textoBotao;
        // linkBotao é opcional mesmo com textoBotao preenchido (schema não
        // exige os dois juntos) — sem link, o botão aparece mas não navega
        // pra lugar nenhum, em vez de virar um href quebrado ou "#" que
        // pula a página pro topo.
        if (linkBotao) {
          ctaEl.href = linkBotao;
        } else {
          ctaEl.href = '#';
          ctaEl.addEventListener('click', (e) => e.preventDefault());
        }
        marcarEntrada(ctaEl);
        textoWrap.appendChild(ctaEl);
      }
      slide.appendChild(textoWrap);
    }

    track.appendChild(slide);

    // Tratamento adaptativo POR SLIDE (requisito 2): mesma detecção de baixa
    // resolução e mesma extração de cor dominante do hero único, uma vez pra
    // cada banner — a cor do CTA de cada slide reflete a foto daquele slide,
    // não uma cor fixa compartilhada.
    const ctaFinal = ctaEl;
    imgEl.addEventListener('load', function onSlideImgLoad() {
      imgEl.removeEventListener('load', onSlideImgLoad);
      const baixaResolucao = imgEl.naturalWidth < 600 || imgEl.naturalHeight < 600;
      mediaEl.classList.toggle('slide-media-compact', baixaResolucao);

      if (!ctaFinal) return; // sem botão neste slide, não há CTA pra colorir
      amostrarCorDominante(banner.imagem, function (corMedia) {
        const corAjustada = garantirContrasteComBranco(corMedia, 4.5);
        const hex = rgbParaHex(corAjustada);
        slide.style.setProperty('--hero-car-color', hex);
        ctaFinal.classList.add('hero-car-cta-dynamic');
      }, function (erro) {
        console.warn('Cor dinâmica do banner ' + (i + 1) + ': extração não disponível, mantendo cor padrão.', erro && erro.message);
      });
    }, { once: true });
    imgEl.src = banner.imagem;
    // Mesma URL na camada de fundo desfocado — o navegador reaproveita do
    // cache HTTP (não baixa a foto de novo), só renderiza uma segunda vez
    // com o filtro blur+scale do CSS por cima.
    blurBgEl.src = banner.imagem;

    if (comControles) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'hero-car-dot';
      dot.setAttribute('aria-label', 'Ir para banner ' + (i + 1));
      dot.setAttribute('aria-current', i === 0 ? 'true' : 'false');
      // Toque roteado pelo ponto mais próximo (não pelo índice fixo `i`
      // capturado no closure): a área de toque ampliada no mobile (ver
      // ::before de 44×44px em @media(max-width:768px)) é maior que o
      // espaçamento real entre bolinhas (~19px), então as áreas de
      // indicadores vizinhos se sobrepõem — inclusive por cima do CENTRO
      // visual de uma bolinha vizinha, não só na borda entre elas. Sem
      // isso, o navegador resolveria pela ordem no DOM (o botão mais à
      // frente sempre venceria), o que podia fazer um toque bem no centro
      // de uma bolinha ativar a bolinha seguinte por engano. Calculando
      // pela distância real do toque (e.clientX) até o centro de cada
      // bolinha, o toque sempre ativa a bolinha mais próxima de verdade —
      // inclusive o centro exato de qualquer uma delas, sempre resolve
      // pra ela mesma (distância zero, não tem como outra vencer).
      dot.addEventListener('click', (e) => {
        const todasBolinhas = Array.from(dotsWrap.querySelectorAll('.hero-car-dot'));
        let maisProxima = i, menorDist = Infinity;
        todasBolinhas.forEach((d, idx) => {
          const r = d.getBoundingClientRect();
          const dist = Math.abs(e.clientX - (r.left + r.width / 2));
          if (dist < menorDist) { menorDist = dist; maisProxima = idx; }
        });
        irParaSlideHero(maisProxima, true);
      });
      dotsWrap.appendChild(dot);
    }
  });

  heroCarouselState = { banners, total, index: 0, timerId: null, pausadoManualmente: false };

  dotsWrap.hidden = !comControles;
  btnPrev.hidden = !comControles;
  btnNext.hidden = !comControles;
  btnPause.hidden = !comControles;

  if (comControles) {
    atualizarBotaoPausaHero(false);
    iniciarAutoplayHero();
  }

  secao.hidden = false;
}

function irParaSlideHero(novoIndex, viaInteracaoUsuario) {
  if (!heroCarouselState) return;
  const { total } = heroCarouselState;
  const idx = ((novoIndex % total) + total) % total;

  if (idx !== heroCarouselState.index) {
    const track = document.getElementById('heroCarouselTrack');
    const slides = track ? track.querySelectorAll('.hero-car-slide') : [];
    slides.forEach((s, i) => {
      const ativo = i === idx;
      s.classList.toggle('on', ativo);
      s.setAttribute('aria-hidden', ativo ? 'false' : 'true');
    });
    document.querySelectorAll('#heroCarDots .hero-car-dot').forEach((d, i) => {
      d.setAttribute('aria-current', i === idx ? 'true' : 'false');
    });
    heroCarouselState.index = idx;
    anunciarSlideHero(idx);
  }

  // Clique manual (seta/bolinha) sempre pausa a troca automática — requisito
  // explícito: "não compete com o clique do usuário".
  if (viaInteracaoUsuario) pausarAutoplayHero();
}

function anunciarSlideHero(idx) {
  const liveEl = document.getElementById('heroCarLive');
  if (!liveEl || !heroCarouselState) return;
  const banner = heroCarouselState.banners[idx];
  const titulo = banner && banner.titulo ? String(banner.titulo).trim() : '';
  const rotulo = titulo || ('banner promocional ' + (idx + 1) + ' de ' + heroCarouselState.total);
  liveEl.textContent = 'Mostrando ' + rotulo + ' (' + (idx + 1) + ' de ' + heroCarouselState.total + ')';
}

function iniciarAutoplayHero() {
  if (!heroCarouselState || heroCarouselState.total < 2) return;
  // WCAG 2.2.2 / requisito explícito: com prefers-reduced-motion, a troca
  // automática nunca inicia — só seta/bolinha (navegação manual) funciona.
  if (prefersReducedMotionHero()) return;
  if (heroCarouselState.timerId) clearInterval(heroCarouselState.timerId);
  heroCarouselState.timerId = setInterval(() => {
    irParaSlideHero(heroCarouselState.index + 1, false);
  }, HERO_CAROUSEL_INTERVAL_MS);
}

function pararAutoplayHero() {
  if (heroCarouselState && heroCarouselState.timerId) {
    clearInterval(heroCarouselState.timerId);
    heroCarouselState.timerId = null;
  }
}

function pausarAutoplayHero() {
  if (!heroCarouselState) return;
  pararAutoplayHero();
  heroCarouselState.pausadoManualmente = true;
  atualizarBotaoPausaHero(true);
}

function retomarAutoplayHero() {
  if (!heroCarouselState) return;
  heroCarouselState.pausadoManualmente = false;
  atualizarBotaoPausaHero(false);
  iniciarAutoplayHero();
}

function alternarPausaHero() {
  if (!heroCarouselState) return;
  if (heroCarouselState.pausadoManualmente) retomarAutoplayHero();
  else pausarAutoplayHero();
}

// aria-pressed sincronizado (requisito explícito de acessibilidade) — único
// lugar que muda o estado visual/ARIA do botão, chamado por toda ação que
// pausa/retoma (clique direto no botão, ou indireto via seta/bolinha).
function atualizarBotaoPausaHero(pausado) {
  const btn = document.getElementById('heroCarPause');
  const icon = document.getElementById('heroCarPauseIcon');
  if (!btn) return;
  btn.setAttribute('aria-pressed', pausado ? 'true' : 'false');
  btn.setAttribute('aria-label', pausado ? 'Retomar troca automática' : 'Pausar troca automática');
  if (icon) {
    icon.classList.toggle('fa-pause', !pausado);
    icon.classList.toggle('fa-play', pausado);
  }
}

document.getElementById('heroCarPrev')?.addEventListener('click', () => irParaSlideHero((heroCarouselState?.index ?? 0) - 1, true));
document.getElementById('heroCarNext')?.addEventListener('click', () => irParaSlideHero((heroCarouselState?.index ?? 0) + 1, true));
document.getElementById('heroCarPause')?.addEventListener('click', alternarPausaHero);

/* ─── SWIPE NO CARROSSEL (mobile) ───
   Achado da auditoria mobile: sem isso, o carrossel só respondia a
   toque em seta/bolinha — arrastar o dedo sobre a foto (o gesto que
   qualquer usuário tenta primeiro) não fazia nada. Reaproveita
   irParaSlideHero() (mesma função de seta/bolinha) pra trocar de slide
   e pausar o autoplay — não duplica lógica nova.
   Listener em #heroCarousel (a <section>, não #heroCarouselTrack): o
   track em si não tem CSS próprio, só ancora os slides (todos
   position:absolute), então tem altura 0 e nunca receberia o toque —
   quem cobre a área visível de verdade é a section, position:relative,
   com min-height real. */
(function initHeroSwipe(){
  const carrossel = document.getElementById('heroCarousel');
  if (!carrossel) return;
  const LIMIAR_PX = 50;
  const FATOR_HORIZONTAL = 1.5; // |deltaX| precisa ser > |deltaY| * este fator pra contar como swipe
  let startX = 0, startY = 0, tocando = false, decidido = false, ehSwipeHorizontal = false;

  carrossel.addEventListener('touchstart', (e) => {
    if (!heroCarouselState || heroCarouselState.total < 2) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    tocando = true;
    decidido = false;
    ehSwipeHorizontal = false;
  }, { passive: true });

  carrossel.addEventListener('touchmove', (e) => {
    if (!tocando) return;
    const t = e.touches[0];
    const deltaX = t.clientX - startX;
    const deltaY = t.clientY - startY;
    if (!decidido) {
      // só decide a direção depois de um deslocamento mínimo, pra não
      // travar a decisão em cima de tremor/jitter do toque inicial
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        decidido = true;
        ehSwipeHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * FATOR_HORIZONTAL;
      }
    }
    // preventDefault só quando já temos certeza que é um swipe horizontal
    // de carrossel — antes disso (ou se for vertical), a página tem que
    // rolar normalmente, sem travar (requisito explícito da auditoria).
    if (decidido && ehSwipeHorizontal) e.preventDefault();
  }, { passive: false });

  function finalizarToque(e) {
    if (!tocando) return;
    tocando = false;
    if (!decidido || !ehSwipeHorizontal) return;
    const t = e.changedTouches[0];
    const deltaX = t.clientX - startX;
    if (Math.abs(deltaX) < LIMIAR_PX) return; // arraste curto demais, ignora
    const atual = heroCarouselState?.index ?? 0;
    // esquerda -> próximo, direita -> anterior (mesma lógica das setas)
    irParaSlideHero(deltaX < 0 ? atual + 1 : atual - 1, true);
  }
  carrossel.addEventListener('touchend', finalizarToque);
  carrossel.addEventListener('touchcancel', () => { tocando = false; });
})();

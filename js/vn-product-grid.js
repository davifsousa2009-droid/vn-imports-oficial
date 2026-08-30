// Vitrine de produtos — extraído de VN_IMPORTS.html (Estágio 2).
// Renderização da home/grid, filtro simples de categoria por botão
// (filter/filterAndGo — distinto do painel de filtros avançado, que fica
// em vn-filters-sort.js), abertura do drawer de produto (openProd) e toda
// a galeria/lupa/lightbox dele, conversão de produto do formato Mongo
// (converterProduto/temDadosEnvio) e os cards "Explore por Categoria"
// (renderCategoriasHome/renderFilterBar). Depende de vn-core.js (S,
// escapeHtmlTexto, R$, showToast, categoriasVitrine) e chama
// renderQuickAddAction/renderQuickAddBtnInner/toggleWL (js/vn-cart-
// wishlist.js, ainda inline nesta etapa) só de dentro de templates HTML
// e handlers de clique — deferido, seguro independentemente da ordem de
// carregamento entre os arquivos.

/* ─── RENDER HOME ─── */
function renderHome(){
  document.title = S.store + ' — Moda Premium';

  // sincroniza a sidebar de filtros quando os produtos chegam/atualizam
  try { renderFilterSidebar(); } catch(e) {}

  document.getElementById('footYear').textContent = new Date().getFullYear();

  // hero cards (primeiros 2 produtos)
  const hc = document.getElementById('heroCards');
  if (hc) {
    hc.innerHTML = S.products.slice(0,2).map(p=>`
    <div class="hero-feat-card" onclick="openProd(${p.id})">
      <div class="hfc-img">${p.img?`<img src="${escHtml(p.img)}" alt="${escHtml(p.name)}">`:`<span class="prod-img-empty">Sem imagem</span>`}</div>
      <div class="hfc-body">
        <div>
          <div class="hfc-tag">${p.badge==='new'?'Novo':p.badge==='hot'?'Destaque':'Importado'}</div>
          <div class="hfc-name">${escHtml(p.name)}</div>
          <div class="hfc-desc">${escHtml(p.desc.substring(0,55))}…</div>
        </div>
        <div class="hfc-foot">
          <span class="hfc-price">${R$(p.price)}</span>
          ${renderQuickAddAction(p, 'btn-sm', '+ Carrinho')}
        </div>
      </div>
    </div>`).join('');
  }

  // Renderização segura: alguns layouts antigos/rascunhos podem não ter o container de vitrine presente.
  const containerHome = document.getElementById('prodGrid') || document.getElementById('lista-produtos-real');
  if(containerHome){
    renderGrid(S.products);
  } else {
    console.warn('Aviso: Container de produtos não encontrado na função renderHome. Abortando renderização segura.', {
      prodGrid: !!document.getElementById('prodGrid'),
      listaProdutosReal: !!document.getElementById('lista-produtos-real')
    });
  }
  try {

    // carrega avaliações sem bloquear o carregamento dos produtos
    if (typeof carregarReviewsPublic === 'function') {
      carregarReviewsPublic().catch((e) => console.error(e));
    }
  } catch (e) {
    console.error(e);
  }
}

/* ─── SKELETON (função) ─── */
function showSkeletonGrid(n=8){
  const container = document.getElementById('prodGrid');
  if(!container) return;
  const count = Math.max(0, Number(n)||0);

  // mantém container consistente com o grid real
  container.innerHTML = `
    <div class="sk-grid" role="status" aria-label="Carregando produtos...">
      ${Array.from({length:count}).map(()=>`
        <div class="sk-card">
          <div class="sk-media"></div>
          <div class="sk-line lg"></div>
          <div class="sk-line md"></div>
          <div class="sk-actions">
            <div class="sk-btn" style="width:100%"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderGrid(list){
  console.log('renderGrid recebendo produtos:', list);

  const container = document.getElementById('prodGrid');
  if(!container){
    console.error('renderGrid: container #prodGrid não encontrado.');
    return;
  }

  container.innerHTML = '';

  if(!Array.isArray(list) || list.length === 0){
    container.innerHTML = '<div style="padding:40px;color:var(--muted);grid-column:1/-1">Nenhum produto encontrado com os filtros atuais</div>';
    return;
  }

  const productCardHTML = list.map((p, i) => {
    const inWL = !!(wl && wl.includes(p._id));

    // badgePct vinha de p.badge==='sale', valor que nunca era escrito em
    // lugar nenhum (dead code) — agora deriva do desconto real (p.old, ver
    // converterProduto). p.badge (separado) segue livre pra sinalizar "Novo".
    const badgePct = (p.old && p.old > p.price) ? Math.round(100 - (p.price / p.old * 100)) : 0;

    // Categoria/subtítulo minimalista (se existir, usa; se não, usa marca)
    const subTxt = (p.cat && String(p.cat).trim() && p.cat !== 'geral') ? String(p.cat) : (p.brand || 'Produto');

    const heartIcon = inWL
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>';

    // stock null = controle de estoque desativado, nunca esgotado. Só 0 é esgotado de verdade.
    const esgotado = p.stock === 0;
    // Sem peso/dimensão (própria ou padrão da loja): não pode ser vendido —
    // mesma mecânica visual do "Esgotado", rótulo diferente pro cliente não
    // confundir os dois motivos (ver decisão registrada em temDadosEnvio).
    const semDadosEnvio = !esgotado && !temDadosEnvio(p);
    const indisponivel = esgotado || semDadosEnvio;
    const rotuloIndisponivel = esgotado ? 'Esgotado' : 'Indisponível';

    // Miniaturas de variação: imagem de capa (p.img) + galeria (p.imgs) — só
    // aparecem quando há pelo menos uma foto ALÉM da capa (p.imgs não vazio).
    // Clicar troca o src da <img> principal (ver listener delegado logo
    // abaixo desta função) — sem estado por card, o próprio DOM é o estado.
    const galeria = [p.img, ...p.imgs].filter(Boolean);
    const temMiniaturas = !indisponivel && p.imgs.length > 0 && galeria.length > 1;
    const thumbsHtml = temMiniaturas
      ? `<div class="prod-thumbs">${galeria.map((src, gi) => `<button type="button" class="prod-thumb${gi===0?' on':''}" data-src="${escHtml(src)}" aria-label="Ver foto ${gi+1}" onclick="event.stopPropagation();trocarImagemPrincipalCard(this)"><img src="${escHtml(src)}" alt="" loading="lazy"></button>`).join('')}</div>`
      : '';

    return `
      <div class="prod-card" onclick="openProd(${p.id})" data-pid="${p._id}" style="animation-delay:${Math.min(i*0.05,0.45)}s">
        <div class="prod-card-frame">

          <div class="prod-card-media${indisponivel?' esgotado':''}">
            ${indisponivel
              ? `<span class="prod-badge-esgotado">${rotuloIndisponivel}</span>`
              : (p.badge==='new' ? `<span class="prod-badge-new">Novo</span>` : '')
            }
            ${p.img
              ? `<img src="${escHtml(p.img)}" alt="${escHtml(p.name)}" loading="lazy" />`
              : `<div class="prod-card-empty">Sem imagem</div>`
            }

            <button
              type="button"
              class="prod-wish-btn${inWL?' on':''}"
              aria-label="Favoritar"
              onclick="event.stopPropagation();toggleWL('${p._id}')"
            >${heartIcon}</button>
          </div>

          ${thumbsHtml}

          <div class="prod-card-body">
            <div class="prod-card-sub">${escHtml(subTxt)}</div>
            <div class="prod-card-name">${escHtml(p.name)}</div>

            <div class="prod-card-price-row">
              ${p.old ? `<div class="prod-price-was-row"><span class="prod-old-price">${R$(p.old)}</span>${badgePct ? `<span class="prod-off">${badgePct}% off</span>` : ''}</div>` : ''}
              <span class="prod-price${p.old?' prod-price-deal':''}">${R$(p.price)}</span>
            </div>

            ${indisponivel
              ? `<button class="btn-fill prod-add-btn cart-add-fx" disabled aria-disabled="true">${rotuloIndisponivel}</button>`
              : renderQuickAddAction(p, 'btn-fill prod-add-btn', 'Adicionar ao Carrinho')
            }
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = productCardHTML;
}


function filter(btn, cat){
  // legacy: apenas atualiza estado central (não renderiza lista por conta própria)
  document.querySelectorAll('.flt').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');

  window.activeFilters.categories = (cat && cat !== 'all') ? [String(cat)] : [];
  syncFilterUI();
  applyFilters();
}

function filterAndGo(cat){
  garantirViewHome();
  scrollTo_('sec-prod');
  setTimeout(()=>{
    const btns = document.querySelectorAll('.flt');
    const pick = (cat && cat !== 'all')
      ? Array.from(btns).find(x=>x.textContent.toLowerCase().includes(String(cat).toLowerCase()))
      : (btns[0] || null);
    filter(pick, cat);
  }, 200);
}



/* ─── PRODUCT PAGE ─── */
function openProd(id){
  const p = S.products[id]; curProd=p;
  let selectedSize = '';
  window.__vn_selectedSize = selectedSize;
  // Galeria real: capa + fotos adicionais cadastradas, sem repetir a mesma imagem.
  const galeria = [...new Set([p.img, ...(p.imgs || [])].filter(Boolean))];

  const gal = document.getElementById('pvGallery');
  gal.innerHTML = galeria.length
    ? galeria.map((src,i) => `<div class="pv-gallery-img${galeria.length===1?' only':''}" onclick="openLightbox(${i})"><img src="${escHtml(src)}" alt="${escHtml(p.name)}"></div>`).join('')
    : `<div class="pv-gallery-img only"><span class="prod-img-empty">Sem imagem</span></div>`;

  // guarda a galeria atual pro lightbox conseguir navegar entre as fotos
  window.__pvGaleriaAtual = galeria;

  const dotsWrap = document.getElementById('pvGalleryDots');
  if (dotsWrap) {
    dotsWrap.innerHTML = galeria.length > 1
      ? galeria.map((_,i) => `<span class="pv-gallery-dot${i===0?' on':''}"></span>`).join('')
      : '';
  }

  document.getElementById('pvBrand').textContent = p.brand;
  document.getElementById('pvName').textContent  = p.name;
  document.getElementById('pvDesc').textContent  = p.desc;
  document.getElementById('pvPrice').innerHTML = `${R$(p.price)}${p.old?`<span>${R$(p.old)}</span>`:''}`;
  if (window.S_parcelamentoAtivo) {
    const parc = (p.price/S.parc).toFixed(2);
    document.getElementById('pvInst').innerHTML = `ou <b>${S.parc}x de ${R$(parc)}</b> sem juros`;
  } else {
    document.getElementById('pvInst').innerHTML = '';
  }


  // sizes
  const sg = document.getElementById('pvSizes');
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  sg.innerHTML = sizes.length
    ? sizes.map((s,i)=>`<button class="pv-size ${i===0?'on':''}" onclick="selSize(this)">${s}</button>`).join('')
    : '<span style="font-size:13px;color:var(--muted)">Tamanho único</span>';

  // default selection: if exists sizes, preselect first for UX; but still enforce on add.
  if(sizes.length){
    window.__vn_selectedSize = (sizes[0] || '').trim();
  } else {
    window.__vn_selectedSize = '';
  }


  // wishlist btn
  const wb = document.getElementById('pvWishBtn');
  const inWL = wl.includes(p._id);
  // Mesmo par de SVG (preenchido/contorno) já usado no coração dos cards
  // (ver heartIcon em renderGrid) — unifica com o ícone do cabeçalho em vez
  // de trocar classe fa-regular/fa-solid.
  const heartFilled = '<svg class="ui-ico" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>';
  const heartOutline = '<svg class="ui-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>';
  wb.innerHTML = inWL
    ? heartFilled + 'Nos Favoritos'
    : heartOutline + 'Adicionar aos Favoritos';
  wb.onclick = ()=>{
    toggleWL(p._id);
    wb.innerHTML = wl.includes(p._id)
      ? heartFilled + 'Nos Favoritos'
      : heartOutline + 'Adicionar aos Favoritos';
  };
  // stock null = controle de estoque desativado, nunca esgotado. Só 0 é esgotado de verdade.
  const esgotado = p.stock === 0;
  // Sem peso/dimensão (própria ou padrão da loja): mesma mecânica visual do
  // "Esgotado", rótulo diferente pro cliente não confundir os dois motivos.
  const semDadosEnvio = !esgotado && !temDadosEnvio(p);
  const indisponivel = esgotado || semDadosEnvio;
  const addBtn = document.getElementById('pvAddBtn');
  const indisponivelMsg = document.getElementById('pvIndisponivelMsg');
  if (indisponivelMsg) indisponivelMsg.style.display = semDadosEnvio ? 'block' : 'none';
  if (addBtn) {
    addBtn.disabled = indisponivel;
    // .textContent no label interno (não no botão inteiro): o botão agora
    // carrega os ícones do efeito cart-add-fx como filhos, que
    // addBtn.textContent apagaria (mesmo ajuste já feito em produto.html).
    const pvAddBtnLabel = document.getElementById('pvAddBtnLabel');
    if (pvAddBtnLabel) pvAddBtnLabel.textContent = esgotado ? 'Esgotado' : (semDadosEnvio ? 'Indisponível' : 'Adicionar ao Carrinho');
    addBtn.onclick = indisponivel ? null : ()=>{
      // Só exige tamanho quando o produto de fato tem tamanho cadastrado —
      // achado ao mexer nesta linha: antes disso, `!sel` bloqueava qualquer
      // produto sem tamanho também, porque window.__vn_selectedSize começa
      // vazio pra "tamanho único" (ver openProd acima). Corrigido junto,
      // já que a regra do site inteiro agora é a mesma em todo lugar.
      const sizesPv = Array.isArray(p.sizes) ? p.sizes : [];
      const sel = (window.__vn_selectedSize || '').trim();
      if (sizesPv.length && !sizesPv.includes(sel)) {
        const box = document.getElementById('pvSizes');
        if(box){
          box.insertAdjacentHTML('afterend', '<div class="pv-alert-tam" style="margin-top:-12px;margin-bottom:18px;font-size:12px;color:#fff;background:#A0391E;border:1px solid rgba(160,57,30,.75);padding:10px 12px;border-radius:12px;">Selecione um tamanho para adicionar ao carrinho.</div>');
        }
        box?.scrollIntoView({behavior:'smooth',block:'center'});
        return;
      }
      addCart(p, sel);
    };
  }


  goView('view-product');
}

// ─── LIGHTBOX / LUPA (galeria da página de produto) ───────────────────────
let __lbIndex = 0;

function openLightbox(index){
  const galeria = window.__pvGaleriaAtual || [];
  if (!galeria.length) return;
  __lbIndex = index || 0;
  renderLightboxImg();
  document.getElementById('pvLightbox').classList.add('on');
  document.body.style.overflow = 'hidden';
}

function closeLightbox(){
  document.getElementById('pvLightbox').classList.remove('on');
  document.body.style.overflow = '';
}

function onLightboxBackdropClick(e){
  if (e.target.id === 'pvLightbox') closeLightbox();
}

function lightboxNav(dir){
  const galeria = window.__pvGaleriaAtual || [];
  if (!galeria.length) return;
  __lbIndex = (__lbIndex + dir + galeria.length) % galeria.length;
  renderLightboxImg();
}

function renderLightboxImg(){
  const galeria = window.__pvGaleriaAtual || [];
  const img = document.getElementById('pvLightboxImg');
  const count = document.getElementById('pvLightboxCount');
  const prevBtn = document.querySelector('.pv-lightbox-prev');
  const nextBtn = document.querySelector('.pv-lightbox-next');
  if (!galeria.length) return;
  img.src = galeria[__lbIndex];
  img.alt = curProd?.name ? `${curProd.name} — foto ${__lbIndex + 1} de ${galeria.length}` : '';
  if (count) count.textContent = galeria.length > 1 ? `${__lbIndex+1} / ${galeria.length}` : '';
  const mostraNav = galeria.length > 1;
  if (prevBtn) prevBtn.style.display = mostraNav ? '' : 'none';
  if (nextBtn) nextBtn.style.display = mostraNav ? '' : 'none';
}

// Efeito lupa: segue o mouse dentro da imagem e mostra uma versão ampliada
// na posição exata do cursor (padrão clássico de e-commerce).
(function initMagnifier(){
  const stage = document.getElementById('pvLightboxStage');
  const lens = document.getElementById('pvLightboxLens');
  if (!stage || !lens) return;
  const ZOOM = 2.2; // fator de ampliação
  const LENS_SIZE = 180; // diâmetro da lupa em px

  stage.addEventListener('mousemove', (e) => {
    const img = document.getElementById('pvLightboxImg');
    const rect = img.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      stage.classList.remove('zoomed');
      return;
    }
    stage.classList.add('zoomed');
    lens.style.width = LENS_SIZE + 'px';
    lens.style.height = LENS_SIZE + 'px';
    lens.style.left = (rect.left - stage.getBoundingClientRect().left + x - LENS_SIZE/2) + 'px';
    lens.style.top = (rect.top - stage.getBoundingClientRect().top + y - LENS_SIZE/2) + 'px';
    lens.style.backgroundImage = `url('${img.src}')`;
    lens.style.backgroundRepeat = 'no-repeat';
    lens.style.backgroundSize = (rect.width*ZOOM) + 'px ' + (rect.height*ZOOM) + 'px';
    const bgX = -(x*ZOOM - LENS_SIZE/2);
    const bgY = -(y*ZOOM - LENS_SIZE/2);
    lens.style.backgroundPosition = bgX + 'px ' + bgY + 'px';
  });
  stage.addEventListener('mouseleave', () => stage.classList.remove('zoomed'));
})();

// Fecha com ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('pvLightbox');
    if (lb && lb.classList.contains('on')) closeLightbox();
  }
  if (document.getElementById('pvLightbox')?.classList.contains('on')) {
    if (e.key === 'ArrowLeft') lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(1);
  }
});

// Sincroniza as bolinhas do carrossel mobile com a foto visível ao arrastar.
(function initGalleryDotsSync(){
  const gal = document.getElementById('pvGallery');
  if (!gal) return;
  let raf = null;
  gal.addEventListener('scroll', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const imgs = gal.querySelectorAll('.pv-gallery-img');
      const dots = document.querySelectorAll('.pv-gallery-dot');
      if (!imgs.length || !dots.length) return;
      const idx = Math.round(gal.scrollLeft / gal.clientWidth);
      dots.forEach((d,i) => d.classList.toggle('on', i===idx));
    });
  });
})();

function selSize(el){
  document.querySelectorAll('.pv-size').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  const v = (el.textContent || '').trim();
  window.__vn_selectedSize = v || '';
  el?.closest('.pv-info')?.querySelectorAll('.pv-alert-tam')?.forEach(a=>a.remove());
}

// Converte produto do formato MongoDB → formato da loja
function converterProduto(p, index) {
  // Fonte de verdade: tamanhos cadastrados no banco.
  // Compatibilidade: alguns projetos podem ter usado `tamanhos`; mas o schema atual usa `sizes`.
  const rawSizes = Array.isArray(p?.sizes)
    ? p.sizes
    : Array.isArray(p?.tamanhos)
      ? p.tamanhos
      : [];

  const normalizedSizes = rawSizes
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  return {
    id: index,
    _id: p._id,
    name: p.nome,
    brand: vitrineNomeLoja,
    cat: p.categoria || 'geral',
    // Tipo de medida da categoria do produto ('roupa'|'joia'|'outro') — usado
    // pra separar o filtro "Tamanho de Roupa" de "Medida de Joia" (ver
    // categoriaTipoMap). Cai em 'outro' se a categoria não existir mais no
    // mapa (categoria apagada) ou nunca teve tipo classificado.
    kind: categoriaTipoMap.get(p.categoria) || 'outro',
    price: Number(p.preco),
    // Preço "de" (riscado), só quando o produto está em promoção de verdade —
    // ver precoOriginal no schema (server.js). null = sem promoção.
    old: p.precoOriginal != null ? Number(p.precoOriginal) : null,
    img: p.imagem || '',
    imgs: Array.isArray(p.imagens) ? p.imagens.filter(Boolean) : [],
    desc: p.descricao || p.nome,
    sizes: normalizedSizes,
    // "Novo" = cadastrado há menos de 30 dias — deriva de createdAt (todo
    // produto já tem, timestamps:true no schema), não é um campo próprio.
    badge: (p.createdAt && (Date.now() - new Date(p.createdAt).getTime()) < 30 * 24 * 60 * 60 * 1000) ? 'new' : null,
    // Guardado só pra ordenação "Mais recentes" (ver applyFilters) — não
    // exibido em lugar nenhum do card.
    createdAt: p.createdAt || null,
    // null = controle de estoque desativado (nunca esgotado); um número é a
    // quantidade real — só 0 significa esgotado de verdade.
    stock: p.estoque != null ? Number(p.estoque) : null,
    // Peso/dimensão pra cálculo de frete — null = não cadastrado (usado por
    // temDadosEnvio() pra saber se o produto pode entrar no carrinho).
    pesoKg: p.pesoKg != null ? Number(p.pesoKg) : null,
    larguraCm: p.larguraCm != null ? Number(p.larguraCm) : null,
    alturaCm: p.alturaCm != null ? Number(p.alturaCm) : null,
    comprimentoCm: p.comprimentoCm != null ? Number(p.comprimentoCm) : null
  };
}

// Espelha resolverDadosEnvioProduto do servidor (peso/dimensão própria,
// senão o padrão da loja) só pra decidir se o botão de comprar fica ativo —
// a garantia de verdade é sempre no servidor (POST /api/orders rejeita o
// pedido de qualquer forma); isto aqui é só a experiência do cliente.
function temDadosEnvio(p) {
  const resolve = (proprio, padrao) => {
    const v = Number(proprio);
    if (Number.isFinite(v) && v > 0) return true;
    const d = Number(padrao);
    return Number.isFinite(d) && d > 0;
  };
  return resolve(p.pesoKg, window.S_pesoKgPadrao)
    && resolve(p.larguraCm, window.S_larguraCmPadrao)
    && resolve(p.alturaCm, window.S_alturaCmPadrao)
    && resolve(p.comprimentoCm, window.S_comprimentoCmPadrao);
}


function renderFilterBar() {
  const fb = document.getElementById('filterBar');
  if (!fb) return;
  const botoes = ['<button class="flt on" onclick="filter(this,\'all\')">Todos</button>']
    .concat(categoriasVitrine.map(c => `<button class="flt" onclick="filter(this,'${c.slug}')">${c.nome}</button>`));
  fb.innerHTML = botoes.join('');
}

function renderCategoriasHome() {
  const cg = document.getElementById('catsGrid');
  if (!cg) return;
  if (!categoriasVitrine.length) {
    cg.innerHTML = `<div class="cat-card"><div class="cat-name">Sem categorias cadastradas</div><div class="cat-sub">Cadastre categorias no painel admin</div><div class="cat-arr">→</div></div>`;
    return;
  }
  cg.innerHTML = categoriasVitrine.map(c => {
    // Usa a foto do primeiro produto cadastrado nessa categoria como imagem de fundo —
    // sem precisar de upload extra, e sempre com foto real (nunca placeholder genérico).
    const prod = (S.products || []).find(p => p.cat === c.slug && p.img);
    const bg = prod ? `style="background-image:url('${prod.img.replace(/'/g,"%27")}')"` : '';
    return `
    <div class="cat-card${prod ? ' has-img' : ''}" onclick="filterAndGo('${c.slug}')" ${bg}>
      <div class="cat-card-overlay"></div>
      <div class="cat-card-body">
        <div class="cat-name">${c.nome}</div>
        <div class="cat-sub">Ver produtos</div>
        <div class="cat-arr">→</div>
      </div>
    </div>`;
  }).join('');
}

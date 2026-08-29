// Filtros (painel lateral + mobile), dropdown "Ordenar por" e
// carregamento de categorias/produtos do servidor — extraído de
// VN_IMPORTS.html (Estágio 2). Depende de vn-core.js (S, window.
// activeFilters, filterRuntime, categoriasVitrine(+Tree),
// expandirSlugsComFilhos, escapeHtmlTexto, R$, API_URL) e chama
// renderGrid/showSkeletonGrid/renderFilterBar/renderCategoriasHome
// (js/vn-product-grid.js) só de dentro de funções/handlers — deferido,
// seguro independentemente da ordem de carregamento entre os arquivos.

// Renderiza em TODAS as cópias do painel que existirem no DOM no momento
// (querySelectorAll, não getElementById) — a home tem duas: o sidebar
// desktop e, quando aberto, o clone do overlay mobile (mesmas classes
// .flt-target-*, IDs diferentes). Usar só um ID único é frágil porque as
// duas cópias coexistem: renderizar num só deixa a outra desatualizada.
// Ordem "de moda" pros tamanhos-letra — nunca alfabética (senão G vem antes
// de M/P). Numeração de calçado (numérica) sempre antes das letras de
// vestuário, e em ordem crescente entre si. Desconhecido cai no fim,
// alfabético entre si.
const ORDEM_TAMANHOS_LETRA = ['PP','P','M','G','GG','XG','XGG','EG','EGG'];
function compararTamanhos(a, b){
  const na = Number(a), nb = Number(b);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if(aNum && bNum) return na - nb;
  if(aNum && !bNum) return -1;
  if(!aNum && bNum) return 1;
  const ia = ORDEM_TAMANHOS_LETRA.indexOf(String(a).toUpperCase());
  const ib = ORDEM_TAMANHOS_LETRA.indexOf(String(b).toUpperCase());
  if(ia >= 0 && ib >= 0) return ia - ib;
  if(ia >= 0) return -1;
  if(ib >= 0) return 1;
  return String(a).localeCompare(String(b));
}

function syncFilterUI(){
  const catsEls = document.querySelectorAll('.flt-target-cats');

  const selectedCats = window.activeFilters.categories || [];

  if(catsEls.length){
    const cats = categoriasVitrine || [];
    const html = [
      `<button type="button" class="fcat-item${selectedCats.length===0?' active':''}" onclick="setCat('all')">Todos</button>`
    ].concat((cats || []).map(c=>`<button type="button" class="fcat-item${selectedCats.includes(c.slug)?' active':''}" onclick="setCat('${c.slug}')">${escapeHtmlTexto(c.nome)}</button>`)).join('');
    catsEls.forEach(el => { el.innerHTML = html; });
  }

  {
    // Tamanhos disponíveis: união dinâmica dos tamanhos presentes nos
    // produtos carregados, ordenados (ver compararTamanhos) em vez de ficar
    // na ordem crua em que apareceram nos produtos.
    // Com alguma categoria selecionada, o pool é escopado só aos produtos
    // dela — reusa expandirSlugsComFilhos, a mesma expansão pai/filho que
    // applyFilters usa pra filtrar de verdade, pra o pool nunca divergir do
    // que está realmente na grade (uma comparação ingênua de slug quebraria
    // em silêncio assim que uma categoria-pai com filhas fosse marcada).
    //
    // Dividido em dois pools por p.kind (ver converterProduto/categoriaTipoMap)
    // — "Tamanho de Roupa" só pega produtos de categoria tipo 'roupa',
    // "Medida de Joia" só 'joia'. Antes disso, os dois entravam juntos no
    // mesmo pool/lista, o que misturava tamanho de roupa com aro de joia
    // sem separação nenhuma (o problema original que motivou este filtro).
    const selSizes = window.activeFilters.sizes || [];

    let poolSource = Array.isArray(S.products) ? S.products : [];
    if (selectedCats.length) {
      const setCatsPool = expandirSlugsComFilhos(categoriasVitrineTree, selectedCats);
      poolSource = poolSource.filter(p => setCatsPool.has(p.cat));
    }

    const montarLista = (produtos) => {
      const pool = produtos
        .flatMap(p => Array.isArray(p?.sizes) ? p.sizes : [])
        .map(s => String(s || '').trim())
        .filter(Boolean);
      const seen = new Set();
      const lista = [];
      for (const s of pool) {
        if (!seen.has(s)) { seen.add(s); lista.push(s); }
      }
      lista.sort(compararTamanhos);
      return lista;
    };

    const listaRoupa = montarLista(poolSource.filter(p => p.kind === 'roupa'));
    const listaJoia = montarLista(poolSource.filter(p => p.kind === 'joia'));

    // Filtro fantasma: um tamanho marcado que não existe mais em NENHUM dos
    // dois pools atuais é removido do estado (não só escondido do menu) —
    // escondido sem remover recriaria o mesmo bug pelo caminho desta própria
    // correção, porque applyFilters() roda logo depois desta função, na
    // mesma sequência síncrona (ver setCat/toggleSize), e ainda filtraria
    // pelo tamanho morto. Removido de verdade do array, não guardado em
    // lugar nenhum — voltar pra "Todos" não ressuscita a marcação.
    const disponiveis = new Set([...listaRoupa, ...listaJoia]);
    const sizesValidas = selSizes.filter(s => disponiveis.has(s));
    if (sizesValidas.length !== selSizes.length) {
      window.activeFilters.sizes = sizesValidas;
    }

    const montarHtml = (lista) => lista.map(s => {
      const on = sizesValidas.includes(s);
      return `<button type="button" class="prod-size-chip${on?' on':''}" onclick="toggleSize('${escapeHtmlTexto(s)}')">${escapeHtmlTexto(s)}</button>`;
    }).join('');

    document.querySelectorAll('.flt-target-sizes-roupa').forEach(el => { el.innerHTML = montarHtml(listaRoupa); });
    document.querySelectorAll('.flt-target-sizes-joia').forEach(el => { el.innerHTML = montarHtml(listaJoia); });

    // Grupo inteiro (título + acordeão) some quando não há nenhum produto
    // desse tipo nos resultados atuais — não só a lista de chips vazia.
    document.querySelectorAll('[data-size-group="roupa"]').forEach(el => { el.style.display = listaRoupa.length ? '' : 'none'; });
    document.querySelectorAll('[data-size-group="joia"]').forEach(el => { el.style.display = listaJoia.length ? '' : 'none'; });
  }


  updatePriceSliders();
}

function renderFilterSidebar(){
  syncFilterUI();
}


function setCat(slug){
  // Multi-select: marcar/desmarcar só alterna a categoria clicada nas outras
  // já marcadas continuam. "Todos" (slug null) sempre limpa tudo.
  const val = slug && slug !== 'all' ? String(slug) : null;
  if(!val){
    window.activeFilters.categories = [];
  }else{
    const arr = window.activeFilters.categories;
    const idx = arr.indexOf(val);
    if(idx >= 0) arr.splice(idx,1);
    else arr.push(val);
  }
  syncFilterUI();
  applyFilters();
}

function toggleSize(s){
  const size = String(s||'').trim();
  if(!size) return;
  const arr = window.activeFilters.sizes;
  const idx = arr.indexOf(size);
  if(idx >= 0) arr.splice(idx,1);
  else arr.push(size);
  syncFilterUI();
  applyFilters();
}

// Acordeão dos filtros (Categorias/Tamanho/Preço) — recolhidos por padrão, estilo Nike.
function toggleFblk(titleEl){
  const blk = titleEl.closest('.fblk');
  if (blk) blk.classList.toggle('open');
}

function resetFilters(){
  window.activeFilters.categories = [];
  window.activeFilters.sizes = [];
  window.activeFilters.maxPrice = Infinity;
  filterRuntime.priceMin = null;
  filterRuntime.priceMax = null;
  filterRuntime.priceCap = getPriceCap();
  syncFilterUI(true);
  applyFilters(true);
}


function getPriceCap(){
  const list = Array.isArray(S.products)?S.products:[];
  const max = list.reduce((m,p)=>Math.max(m, Number(p.price)||0),0);
  return max || 0;
}

function updatePriceSliders(){
  const cap = getPriceCap();
  filterRuntime.priceCap = cap;
  window.activeFilters.maxPrice = Infinity; // reset lógico; real aplicado via runtime

  // Mesma lógica de multi-target de syncFilterUI: pode haver o slider desktop
  // e o clone mobile ao mesmo tempo no DOM.
  const maxRanges = document.querySelectorAll('.flt-target-price-max');
  const minRanges = document.querySelectorAll('.flt-target-price-min');
  const hints = document.querySelectorAll('.flt-target-price-hint');
  const fills = document.querySelectorAll('.flt-target-price-fill');

  const vMax = filterRuntime.priceMax==null ? cap : Number(filterRuntime.priceMax);
  maxRanges.forEach(el => {
    el.min = 0;
    el.max = String(cap);
    el.value = String(vMax);
  });

  const vMin = filterRuntime.priceMin==null ? 0 : Number(filterRuntime.priceMin);
  minRanges.forEach(el => {
    el.min = 0;
    el.max = String(cap);
    el.value = String(vMin);
  });

  // Faixa preenchida entre os dois puxadores — mesma conta de search.html
  // (updatePriceFill), só que já com vMin/vMax/cap calculados aqui em cima.
  const range = cap || 1;
  const left = (vMin / range) * 100;
  const right = (vMax / range) * 100;
  fills.forEach(el => {
    el.style.left = Math.max(0, left) + '%';
    el.style.width = Math.max(0, right - left) + '%';
  });

  // R$() é a mesma função usada no preço dos cards (moeda em pt-BR: vírgula
  // decimal) — antes esse texto vinha de um template cru, sem formatação.
  hints.forEach(el => {
    el.textContent = cap ? `${R$(vMin)} — ${R$(vMax)}` : '—';
  });
}

function onPriceMin(v){
  const num = Number(v);
  if(Number.isFinite(num)) filterRuntime.priceMin = num;
  if(filterRuntime.priceMax!=null && filterRuntime.priceMin>filterRuntime.priceMax) filterRuntime.priceMax = filterRuntime.priceMin;
  updatePriceSliders();
  applyFilters();
}

function onPriceMax(v){
  const num = Number(v);
  if(Number.isFinite(num)) filterRuntime.priceMax = num;
  if(filterRuntime.priceMin!=null && filterRuntime.priceMin>filterRuntime.priceMax) filterRuntime.priceMin = filterRuntime.priceMax;
  updatePriceSliders();
  applyFilters();
}

// Mantém hint sincronizado ao chamar applyFilters
function syncPriceHint(){
  const cap = filterRuntime.priceCap || 0;
  const minV = filterRuntime.priceMin==null ? 0 : Number(filterRuntime.priceMin);
  const maxV = filterRuntime.priceMax==null ? cap : Number(filterRuntime.priceMax);
  const hint = document.getElementById('priceHint');
  if(hint){
    hint.textContent = cap? `R$ ${minV} — R$ ${maxV}` : '—';
  }
}


function applyFilters(forceRenderEmpty=false){
  // fonte de verdade (dataset original completo)
  const original = Array.isArray(S.products) ? S.products : [];

  // categoria — marcar uma categoria-pai também inclui as filhas dela
  // (mesma árvore que o mega menu usa; ver expandirSlugsComFilhos)
  let list = original;
  const cats = window.activeFilters.categories || [];
  if(cats.length){
    const setCats = expandirSlugsComFilhos(categoriasVitrineTree, cats);
    list = list.filter(p => setCats.has(p.cat));
  }

  // tamanho
  const sizes = window.activeFilters.sizes || [];
  if(sizes.length){
    const setSizes = new Set(sizes);
    list = list.filter(p => Array.isArray(p.sizes) && p.sizes.some(sz => setSizes.has(sz)));
  }

  // preço (maxPrice) — compat com o slider existente (runtime guarda min/max)
  const cap = (filterRuntime.priceCap || getPriceCap() || 0);
  const maxPrice = filterRuntime.priceMax==null ? cap : Number(filterRuntime.priceMax);
  window.activeFilters.maxPrice = maxPrice;

  list = list.filter(p => {
    const pr = Number(p.price) || 0;
    return pr <= window.activeFilters.maxPrice;
  });

  // opcional: minPrice também ajuda UX do range atual
  const minPrice = filterRuntime.priceMin==null ? 0 : Number(filterRuntime.priceMin);
  if(filterRuntime.priceMin!=null){
    list = list.filter(p => (Number(p.price)||0) >= minPrice);
  }

  // ordenação — aplicada por último, depois de todos os filtros, sem afetar
  // a lista original (S.products) nem o teto do slider de preço (getPriceCap
  // continua lendo S.products direto, nunca esta `list` já filtrada/ordenada).
  const sortValue = window.prodSortValue || 'relevancia';
  list = list.slice();
  if (sortValue === 'menor') list.sort((a, b) => a.price - b.price);
  else if (sortValue === 'maior') list.sort((a, b) => b.price - a.price);
  else if (sortValue === 'recentes') list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  atualizarBreadcrumbEContador(cats, list.length);

  renderGrid(list);
}

// Breadcrumb simples + contador dinâmico acima da grade de produtos —
// título vira o nome da categoria quando exatamente uma está selecionada,
// senão fica genérico ("Produtos"), já que este filtro permite multi-seleção.
function atualizarBreadcrumbEContador(selectedCatSlugs, total) {
  let titulo = 'Produtos';
  if (selectedCatSlugs.length === 1) {
    const catObj = (categoriasVitrine || []).find(c => c.slug === selectedCatSlugs[0]);
    if (catObj) titulo = catObj.nome;
  }
  const bc = document.getElementById('prodBreadcrumb');
  if (bc) bc.textContent = 'Início / ' + titulo;
  const count = document.getElementById('prodCount');
  if (count) count.textContent = '(' + total + ')';
}

function onProdSortChange(value) {
  window.prodSortValue = value;
  applyFilters();
}

// ─── DROPDOWN "ORDENAR POR" (combobox/listbox ARIA custom) ───────
// Substitui um <select> nativo pra poder animar o painel de opções (ver
// comentário no CSS de .sort-listbox). Foco de DOM fica sempre no botão
// (padrão "select-only combobox" do WAI-ARIA APG) — aria-activedescendant
// aponta pra opção "ativa" durante navegação por teclado, sem mover o
// foco de verdade pra dentro da lista. Isso é o que permite Esc devolver
// o foco ao botão de graça (o foco nunca saiu de lá).
const SORT_OPTIONS = [
  { value: 'relevancia', label: 'Relevância' },
  { value: 'menor', label: 'Menor preço' },
  { value: 'maior', label: 'Maior preço' },
  { value: 'recentes', label: 'Mais recentes' }
];
let sortActiveIndex = 0;

function isSortDropdownOpen() {
  const panel = document.getElementById('sortListbox');
  return !!panel && panel.classList.contains('on');
}

function openSortDropdown() {
  const btn = document.getElementById('sortComboBtn');
  const panel = document.getElementById('sortListbox');
  if (!btn || !panel || panel.classList.contains('on')) return;
  panel.classList.add('on');
  btn.setAttribute('aria-expanded', 'true');
  const currentValue = window.prodSortValue || 'relevancia';
  const idx = SORT_OPTIONS.findIndex(o => o.value === currentValue);
  setSortActiveOption(idx >= 0 ? idx : 0);
  document.addEventListener('click', onSortOutsideClick, true);
}

function closeSortDropdown() {
  const btn = document.getElementById('sortComboBtn');
  const panel = document.getElementById('sortListbox');
  if (!btn || !panel || !panel.classList.contains('on')) return;
  panel.classList.remove('on');
  btn.setAttribute('aria-expanded', 'false');
  btn.removeAttribute('aria-activedescendant');
  document.querySelectorAll('.sort-option.active').forEach(el => el.classList.remove('active'));
  document.removeEventListener('click', onSortOutsideClick, true);
}

function toggleSortDropdown() {
  if (isSortDropdownOpen()) closeSortDropdown();
  else openSortDropdown();
}

function onSortOutsideClick(e) {
  const wrap = document.getElementById('sortComboBtn')?.closest('.sort-select-wrap');
  if (wrap && !wrap.contains(e.target)) closeSortDropdown();
}

function setSortActiveOption(index) {
  sortActiveIndex = index;
  const opt = SORT_OPTIONS[index];
  document.querySelectorAll('.sort-option.active').forEach(el => el.classList.remove('active'));
  const optEl = document.getElementById('sortOpt-' + opt.value);
  if (optEl) optEl.classList.add('active');
  document.getElementById('sortComboBtn')?.setAttribute('aria-activedescendant', 'sortOpt-' + opt.value);
}

function chooseSortOption(index) {
  const opt = SORT_OPTIONS[index];
  if (!opt) return;
  document.querySelectorAll('.sort-option').forEach(el => {
    el.setAttribute('aria-selected', el.id === 'sortOpt-' + opt.value ? 'true' : 'false');
  });
  const valueEl = document.getElementById('sortComboValue');
  if (valueEl) valueEl.textContent = opt.label;
  // Mantido em sincronia só por segurança — nada mais lê este elemento hoje.
  const hidden = document.getElementById('prodSortSelect');
  if (hidden) hidden.value = opt.value;
  onProdSortChange(opt.value);
  closeSortDropdown();
  document.getElementById('sortComboBtn')?.focus();
}

function chooseSortOptionByValue(value) {
  const idx = SORT_OPTIONS.findIndex(o => o.value === value);
  if (idx >= 0) chooseSortOption(idx);
}

function onSortComboKeydown(event) {
  const open = isSortDropdownOpen();
  const n = SORT_OPTIONS.length;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open) openSortDropdown();
      else setSortActiveOption(Math.min(sortActiveIndex + 1, n - 1));
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (!open) openSortDropdown();
      else setSortActiveOption(Math.max(sortActiveIndex - 1, 0));
      break;
    case 'Home':
      if (open) { event.preventDefault(); setSortActiveOption(0); }
      break;
    case 'End':
      if (open) { event.preventDefault(); setSortActiveOption(n - 1); }
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (open) chooseSortOption(sortActiveIndex);
      else openSortDropdown();
      break;
    case 'Escape':
      if (open) { event.preventDefault(); closeSortDropdown(); document.getElementById('sortComboBtn')?.focus(); }
      break;
    case 'Tab':
      if (open) closeSortDropdown();
      break;
    default:
      // Digitar uma letra pula pra próxima opção (a partir da atual,
      // com volta ao início) que começa com ela — mesmo comportamento de
      // um <select> nativo. Busca sempre depois do índice ativo, então
      // apertar a mesma letra várias vezes cicla entre as opções que
      // começam com ela (ex: "m" alterna Menor/Maior/Mais).
      if (open && event.key.length === 1) {
        const letter = event.key.toLowerCase();
        if (/[a-zà-ÿ0-9]/.test(letter)) {
          for (let step = 1; step <= n; step++) {
            const idx = (sortActiveIndex + step) % n;
            if (SORT_OPTIONS[idx].label.toLowerCase().startsWith(letter)) {
              setSortActiveOption(idx);
              break;
            }
          }
        }
      }
  }
}

// Dispara a micro-animação das barras do ícone (equalizador) — reiniciável
// mesmo em cliques rápidos seguidos: remove a classe, força reflow
// (void ...offsetWidth), readiciona. Sem o reflow forçado, re-adicionar a
// mesma classe que o elemento já tem não reinicia a @keyframes.
function pulseFilterIcon(btn) {
  if (!btn) return;
  btn.classList.remove('fbar-pulse');
  void btn.offsetWidth;
  btn.classList.add('fbar-pulse');
}

function prefersReducedMotionFilters() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let filtersHideTimer = null;

// Troca de estado em duas fases, sempre lendo o estado real do DOM (nunca
// uma variável paralela) — clicar rápido várias vezes nunca desincroniza:
// cada chamada cancela qualquer timer pendente da chamada anterior antes
// de agendar o seu próprio.
//   Escondendo: o painel foge (fade+translateX) primeiro, com a coluna do
//   grid ainda ocupada; só depois de 200ms (a transição de verdade
//   terminar) o JS recolhe a coluna do grid (display:none via
//   #secProdWrap.filters-hidden) — se as duas mudanças fossem juntas, o
//   reflow do grid (instantâneo, não anima) cortaria a animação do painel
//   pela metade.
//   Mostrando: a coluna do grid volta primeiro (o painel reaparece no
//   lugar certo, mas ainda transparente/deslocado por .fh-hiding), só
//   então o fade+translateX de entrada é disparado — na ordem inversa,
//   pelo mesmo motivo.
function setFiltersVisualState(hidden) {
  const wrap = document.getElementById('secProdWrap');
  const btn = document.getElementById('filtersToggleBtn');
  const label = document.getElementById('filtersToggleLabel');
  if (!wrap || !btn) return;
  const filtersEl = wrap.querySelector('.filters');

  clearTimeout(filtersHideTimer);
  pulseFilterIcon(btn);
  btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  if (label) label.textContent = hidden ? 'Mostrar Filtros' : 'Ocultar Filtros';

  if (hidden) {
    if (filtersEl) filtersEl.classList.add('fh-hiding');
    const collapseGrid = () => wrap.classList.add('filters-hidden');
    if (prefersReducedMotionFilters()) collapseGrid();
    else filtersHideTimer = setTimeout(collapseGrid, 200);
  } else {
    wrap.classList.remove('filters-hidden');
    if (filtersEl) {
      void filtersEl.offsetWidth; // força reflow antes de tirar .fh-hiding, senão o navegador pode fundir as duas mudanças sem transição
      filtersEl.classList.remove('fh-hiding');
    }
  }
}

function toggleFiltersVisibility() {
  const btn = document.getElementById('filtersToggleBtn');
  if (!btn) return;
  // Lê aria-pressed, não #secProdWrap.filters-hidden: o recolhimento do
  // grid é deliberadamente atrasado 200ms (ver setFiltersVisualState),
  // mas aria-pressed é setado na hora — cliques rápidos repetidos
  // continuam lendo o estado "de intenção" mais recente, não o estado
  // "de layout" ainda em trânsito.
  const willHide = btn.getAttribute('aria-pressed') !== 'true';
  setFiltersVisualState(willHide);
}


function toggleMobileFilters(){
  const overlay = document.getElementById('mobileFiltersOverlayVn');
  if(overlay && overlay.classList.contains('on')){
    overlay.classList.remove('on');
    return;
  }
  showMobileFiltersOverlay();
}


function showMobileFiltersOverlay(){
  let overlay = document.getElementById('mobileFiltersOverlayVn');
  if(!overlay){
    overlay = document.createElement('div');
    overlay.id = 'mobileFiltersOverlayVn';
    overlay.className = 'mobile-filters-overlay';
    overlay.innerHTML = `
      <div class="mobile-filters-panel">
        <div class="mobile-filters-top">
          <div class="filters-title" style="font-size:11px;">Filtros</div>
          <button class="mobile-filters-close" onclick="(function(){var o=document.getElementById('mobileFiltersOverlayVn'); if(o) o.classList.remove('on');})()">Fechar</button>
        </div>
        <div class="mobile-filters-wrap" id="mobileFiltersWrapVn"></div>
      </div>`;
    document.body.appendChild(overlay);
  }

  // clona sidebar
  const wrap = document.getElementById('mobileFiltersWrapVn');
  if(wrap && document.getElementById('filtersAside')){
    // remove handlers via inline onclick remain (ok)
    wrap.innerHTML = document.getElementById('filtersAside').innerHTML;

    // ids duplicados: vamos ajustar somente elementos de conteúdo
    wrap.querySelector('#fltCats')?.setAttribute('id','fltCatsMobileVn');
    wrap.querySelector('#fltSizesRoupa')?.setAttribute('id','fltSizesRoupaMobileVn');
    wrap.querySelector('#fltSizesJoia')?.setAttribute('id','fltSizesJoiaMobileVn');
    wrap.querySelector('#priceHint')?.setAttribute('id','priceHintMobileVn');
    wrap.querySelector('#priceMaxRange')?.setAttribute('id','priceMaxRangeMobileVn');
    wrap.querySelector('#priceMinRange')?.setAttribute('id','priceMinRangeMobileVn');

    // trocar calls de oninput para ids móveis
    const maxR = wrap.querySelector('#priceMaxRangeMobileVn');
    const minR = wrap.querySelector('#priceMinRangeMobileVn');
    if(maxR) maxR.setAttribute('oninput','onPriceMax(this.value)');
    if(minR) minR.setAttribute('oninput','onPriceMin(this.value)');
  }

  overlay.classList.add('on');
  // renderiza com dados atuais
  // (móvel usa mesmas funções de setcat/togglesize, então os ids mudaram apenas no DOM)
  // atualiza valores de slider local (hint)
  // Simples: re-aplica renderFilterSidebar e applyFilters depois de curto delay.
  setTimeout(()=>{
    renderFilterSidebar();
    applyFilters();
  },0);
}


async function carregarCategoriasDoServidor() {
  // /api/categories/tree — mesma fonte que o mega menu do topo consome.
  // categoriasVitrine (lista plana) continua alimentando o mega menu antigo
  // (renderFilterBar) e os cards "Explore por Categoria" (renderCategoriasHome)
  // sem mudança nenhuma de formato pra eles.
  try {
    const r = await fetch(`${API_URL}/categories/tree`);
    if (!r.ok) throw new Error('Erro categorias');
    const dados = await r.json();
    categoriasVitrineTree = Array.isArray(dados) ? dados.filter(c => c && c.slug && c.nome) : [];
    categoriasVitrine = flattenCategoryTree(categoriasVitrineTree);
  } catch {
    categoriasVitrineTree = [];
    categoriasVitrine = [];
  }
  categoriaTipoMap = new Map(categoriasVitrine.map(c => [c.slug, c.tipo || 'outro']));
  renderFilterSidebar();
  renderCategoriasHome();
}

// carregarStatsDestaque (preenchia #stProdutos/#stAvaliacao/#stClientes,
// dentro de .hero-stats) removida — .hero-stats não existe mais no hero
// único, ver remoção do texto do hero.

// Busca produtos do banco e atualiza a vitrine
async function carregarProdutosDoServidor(categoria) {
  showSkeletonGrid();
  try {
    const url = categoria && categoria !== 'all'
      ? `${API_URL}/produtos?categoria=${categoria}`
      : `${API_URL}/produtos`;

    const r = await fetch(url);
    if (!r.ok) throw new Error('Erro na resposta do servidor');
    const dados = await r.json();

    S.products = Array.isArray(dados) ? dados.map(converterProduto) : [];

    const lista = categoria && categoria !== 'all'
      ? S.products.filter(p => p.cat === categoria)
      : S.products;

    console.log('renderGrid: lista carregada', { total: lista.length, categoria, first: lista[0] });
    renderGrid(lista);

    // Repopula a sidebar de filtros (chips de tamanho, teto do slider de preço)
    // agora que S.products tem dados de verdade. renderHome() já chama isso no
    // DOMContentLoaded, mas antes de carregarProdutosDoServidor() resolver —
    // S.products ainda está vazio nesse ponto, então a sidebar nascia sem
    // tamanho nenhum e com o slider preso em max=0, e nunca era repopulada.
    renderFilterSidebar();

    // Recarrega as imagens dos cards de categoria agora que os produtos chegaram
    // (só na carga inicial sem filtro — filtrado, S.products teria só 1 categoria).
    if (!categoria || categoria === 'all') renderCategoriasHome();
  } catch (err) {
    console.warn('Servidor offline.', err.message);
    S.products = [];
    renderGrid([]);
  }
}

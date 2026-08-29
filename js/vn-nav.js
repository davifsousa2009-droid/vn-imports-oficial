// Navegação/chrome do site — extraído de VN_IMPORTS.html (Estágio 2).
// Menu mobile off-canvas, busca (dropdown com resultados), header que
// desgruda pra não cobrir o rodapé no mobile, mega menu (acordeão mobile +
// carregamento dinâmico das categorias via /api/categories/tree). Depende
// de vn-core.js (escapeHtmlTexto/API_URL) e chama filterAndGo/renderGrid/
// converterProduto/openProd (js/vn-product-grid.js, ainda inline nesta
// etapa) só dentro de handlers de clique — deferido, seguro
// independentemente da ordem de carregamento entre os arquivos.

/* ─── MENU MOBILE (off-canvas) ─── */
function abrirMenuMobile(btn){
  const nav = btn.closest('nav');
  const links = nav && nav.querySelector('.nav-links');
  if(links) links.classList.add('open');
  document.querySelectorAll('.mobile-nav-overlay').forEach(o=>o.classList.add('on'));
  document.body.style.overflow = 'hidden';
}
function fecharMenuMobile(){
  document.querySelectorAll('.nav-links.open').forEach(el=>el.classList.remove('open'));
  document.querySelectorAll('.mobile-nav-overlay').forEach(o=>o.classList.remove('on'));
  // Só libera o scroll do body se nenhum outro overlay que também trava
  // scroll (filtros mobile ou lightbox de fotos) continuar aberto — evita
  // destravar o body enquanto outro modal ainda está em cima. Elementos que
  // não existem nesta página avaliam pra undefined e o check não se aplica.
  const outroOverlayAberto =
    document.getElementById('filtersAside')?.classList.contains('open') ||
    document.getElementById('mobileFiltersOverlayVn')?.classList.contains('on') ||
    document.getElementById('pvLightbox')?.classList.contains('on');
  if(!outroOverlayAberto) document.body.style.overflow = '';
}
// Fecha a gaveta ao navegar (menos no toggle "Categorias", que só expande o acordeão).
// Delegado no .nav-links pra também pegar os links do mega menu, injetados depois via JS.
document.querySelectorAll('.nav-links').forEach(nav=>{
  nav.addEventListener('click', (e)=>{
    const a = e.target.closest('a');
    if(!a || a.classList.contains('nav-link-cats')) return;
    if(window.innerWidth <= 768) fecharMenuMobile();
  });
});

/* ─── SEARCH ─── */
let srOpen=false;
let _searchDebounceTimer = null;
function toggleSearch(){
  srOpen=!srOpen;
  document.getElementById('searchWrap').classList.toggle('on',srOpen);
  if(srOpen) setTimeout(()=>document.getElementById('searchInp').focus(),300);
  else { document.getElementById('searchRes').classList.remove('on'); document.getElementById('searchInp').value=''; }
}

// Abre produto a partir do _id do Mongo (usado pelos resultados da busca remota)
async function openProdByDbId(dbId){
  try{
    const r = await fetch(API_URL + '/produtos/' + encodeURIComponent(dbId));
    if(!r.ok) return;
    const p = await r.json();
    // Se já existir nos produtos carregados, usa o índice existente
    const existing = S.products.findIndex(x => x._id === p._id);
    if(existing !== -1){ openProd(existing); return; }
    // Caso contrário, adiciona temporariamente e abre
    const newIndex = S.products.length;
    S.products.push(converterProduto(p, newIndex));
    renderGrid(S.products);
    openProd(newIndex);
  }catch(e){ console.warn('Erro ao abrir produto:', e.message); }
}

function doSearch(q){
  clearTimeout(_searchDebounceTimer);
  const query = String(q || '').trim();
  const res = document.getElementById('searchRes');
  if(!res) return;

  if(!query || query.length < 2){
    res.classList.remove('on');
    // quando apagamos a busca, restaura a grid completa
    if(!query) renderGrid(S.products);
    return;
  }

  res.classList.add('on');
  res.innerHTML = `<div style="padding:12px 24px;color:var(--muted)">Buscando…</div>`;

  _searchDebounceTimer = setTimeout(async () => {
    try{
      const r = await fetch(API_URL + '/produtos/search?q=' + encodeURIComponent(query));
      if(!r.ok) throw new Error('search http ' + r.status);
      const data = await r.json();

      if(!Array.isArray(data) || data.length === 0){
        res.innerHTML = `<div style="padding:16px;font-size:13px;color:var(--muted)">Nenhum produto encontrado para "${escapeHtmlTexto(query)}"</div>`;
        renderGrid([]);
        return;
      }

      res.innerHTML = `<div class="sr-wrap">${data.map(p => `
        <div class="sr-item" onclick="(function(){toggleSearch();openProdByDbId('${p._id}');})()">
          <div class="sr-img">${p.imagem?`<img src="${p.imagem}" style="width:100%;height:100%;object-fit:cover">`:`<span class="prod-img-empty">Sem imagem</span>`}</div>
          <div><div class="sr-name">${escapeHtmlTexto(p.nome)}</div><div class="sr-price">${R$(p.preco)}</div></div>
        </div>`).join('')}</div>`;

      // Também atualiza a vitrine com os resultados (UX: mostra os itens encontrados)
      const conv = data.map((p, i) => converterProduto(p, i));
      renderGrid(conv);

    }catch(err){
      console.warn('search error', err);
      res.innerHTML = `<div style="padding:12px;color:var(--muted)">Erro na busca</div>`;
    }
  }, 300);
}

function goToSearch(q){
  const term = String(q || '').trim();
  if(!term) return;
  // redirect to search page with query
  window.location.href = '/search.html?q=' + encodeURIComponent(term);
}

// Fecha dropdown de busca ao clicar fora
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('searchWrap');
  const res = document.getElementById('searchRes');
  if (!wrap || !res) return;
  if (!wrap.contains(e.target)) {
    res.classList.remove('on');
  }
});









/* ─── SCROLL ─── */
window.addEventListener('scroll',()=>{ const el=document.getElementById('back-to-top'); if(el) el.classList.toggle('on',scrollY>500); });

/* ─── HEADER NÃO COBRIR RODAPÉ (mobile) ───
   #main-nav é sticky (não fixed): cobre sempre os primeiros ~121px da
   tela atual (nav + .search-wrap sempre expandida no mobile — ver
   @media(max-width:768px)), em qualquer posição de scroll, inclusive no
   fim da página. O rodapé real é mais curto que essa faixa "segura"
   (viewport−header), então padding/scroll-padding no fim do documento
   NÃO resolve — só empurra o link pra fora da tela por cima em vez de
   pra baixo do header (matemática conferida ao vivo antes de escolher
   esta abordagem). Fix real: assim que o <footer> começa a entrar na
   tela, desgruda o header (position:sticky→static via .nav-unstick) —
   ele some de vista (volta pro topo do documento) e libera a tela toda
   pro rodapé. Regruda automaticamente ao rolar de volta pra cima. */
(function(){
  const nav = document.getElementById('main-nav');
  const footerEl = document.querySelector('footer');
  if(!nav || !footerEl) return;
  function aplicar(footerVisivel){
    nav.classList.toggle('nav-unstick', footerVisivel && window.innerWidth <= 768);
  }
  const navUnstickObs = new IntersectionObserver(entries=>{
    entries.forEach(e=> aplicar(e.isIntersecting));
  }, { threshold: 0 });
  navUnstickObs.observe(footerEl);
  window.addEventListener('resize', ()=>{
    const r = footerEl.getBoundingClientRect();
    aplicar(r.top < window.innerHeight && r.bottom > 0);
  });
})();

/* Mega menu: acordeão mobile + fecha ao clicar fora. Delegado em document
   (em vez de pegar só o primeiro .nav-item-mega) porque agora existe um em
   cada nav — a home e as gavetas das views secundárias. */
(function(){
  function closeAllMega(){
    document.querySelectorAll('.nav-item-mega.open').forEach(item=>{
      item.classList.remove('open');
      item.querySelector('.nav-link-cats')?.setAttribute('aria-expanded','false');
    });
  }

  document.addEventListener('click', (e)=>{
    const toggleLink = e.target.closest('.nav-link-cats');
    if(toggleLink){
      if(window.innerWidth <= 768){
        e.preventDefault();
        const navItem = toggleLink.closest('.nav-item-mega');
        if(navItem){
          const vaiAbrir = !navItem.classList.contains('open');
          closeAllMega();
          if(vaiAbrir){
            navItem.classList.add('open');
            toggleLink.setAttribute('aria-expanded', 'true');
          }
        }
      }
      return;
    }
    // Clique fora de qualquer .nav-item-mega aberto: fecha.
    if(window.innerWidth <= 768 && !e.target.closest('.nav-item-mega')){
      closeAllMega();
    }
  });

  // Fecha o estado mobile ao redimensionar pra desktop (hover cuida do resto via CSS).
  window.addEventListener('resize', ()=>{ if(window.innerWidth>768) closeAllMega(); });
})();



// Carrega e renderiza o megamenu dinamicamente (não bloqueante)
// Monta as colunas do mega menu (DOM de verdade, não string) dentro de um
// container — precisa ser chamada uma vez por container porque
// addEventListener não sobrevive a cópia por innerHTML/cloneNode.
function montarColunasMegaMenu(container, dados){
  container.innerHTML = '';
  dados.forEach(cat => {
    const col = document.createElement('div');
    col.className = 'mega-col';
    const h = document.createElement('h4'); h.className = 'mega-col-title'; h.textContent = cat.nome || '—';
    const ul = document.createElement('ul');
    (Array.isArray(cat.children) && cat.children.length ? cat.children : []).forEach(child => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = child.nome || child.slug || '—';
      a.addEventListener('click', (e)=>{ e.preventDefault(); filterAndGo(child.slug || child.nome); });
      li.appendChild(a);
      ul.appendChild(li);
    });
    // se não tem children, permite clicar no título para ir para essa categoria
    if(!(Array.isArray(cat.children) && cat.children.length)){
      h.style.cursor = 'pointer';
      h.addEventListener('click', ()=>{ filterAndGo(cat.slug || cat.nome); });
    }
    col.appendChild(h);
    col.appendChild(ul);
    container.appendChild(col);
  });
}

// Um .megamenu-inner por nav — a home e cada gaveta das views secundárias —
// todos precisam ser preenchidos com o mesmo conteúdo.
async function loadMegaMenu(){
  const containers = document.querySelectorAll('.megamenu-inner');
  if(!containers.length) return;
  containers.forEach(c => { c.innerHTML = '<div style="padding:18px;color:var(--muted)">Carregando categorias…</div>'; });
  try{
    const res = await fetch(API_URL + '/categories/tree');
    if(!res.ok) throw new Error('Não foi possível obter categorias');
    const dados = await res.json();
    if(!Array.isArray(dados) || dados.length===0){
      containers.forEach(c => { c.innerHTML = '<div style="padding:18px;color:var(--muted)">Nenhuma categoria cadastrada</div>'; });
      return;
    }
    containers.forEach(c => montarColunasMegaMenu(c, dados));
  }catch(e){
    containers.forEach(c => { c.innerHTML = '<div style="padding:18px;color:var(--red)">Erro ao carregar categorias</div>'; });
    console.error('loadMegaMenu:', e);
  }
}

// Chama em background — não bloqueia renderização
setTimeout(()=>{ try{ loadMegaMenu(); }catch(e){console.warn(e);} }, 200);

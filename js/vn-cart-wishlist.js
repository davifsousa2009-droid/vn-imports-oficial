// Carrinho + favoritos (UI de página, não a persistência de baixo nível
// — essa já é /js/cart.js) — extraído de VN_IMPORTS.html (Estágio 2).
// Wishlist da grade (toggleWL/renderWL/trocarImagemPrincipalCard),
// gaveta de carrinho completa (addCart/renderCart/openCart/closeCart/
// chQty/delItem) e o botão de adicionar reutilizado em grade/drawer/
// wishlist (renderQuickAddAction/renderQuickAddBtnInner/
// toggleQuickSize/addCartComTamanho), além do efeito visual de toque no
// botão .cart-add-fx. Depende de vn-core.js (cart, wl, persistCart,
// saveC, R$, showToast, S) e de getWishlist/saveWishlist/syncDots
// (js/cart.js, já existente). Chama temDadosEnvio (js/vn-product-
// grid.js) só de dentro de addCart() — deferido, seguro
// independentemente da ordem de carregamento entre os arquivos.

/* ─── WISHLIST ─── */
// id aqui é sempre o _id (string, Mongo) do produto — nunca o índice p.id.
function toggleWL(id){
  const idx = wl.indexOf(id);
  if(idx>-1){ wl.splice(idx,1); showToast('heartOutline','Removido dos favoritos'); }
  else { wl.push(id); showToast('heart','Adicionado aos favoritos!'); }
  saveWishlist(wl);
  syncDots();
  // Atualiza só o coração desse produto no grid, sem re-renderizar tudo
  // (evitava que a animação de entrada dos cards repetisse a cada favorito).
  const nowIn = wl.includes(id);
  document.querySelectorAll('.prod-card[data-pid="'+id+'"] .prod-wish-btn').forEach(btn=>{
    btn.classList.toggle('on', nowIn);
    btn.innerHTML = nowIn
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>';
  });
}
// Clique numa miniatura de variação (.prod-thumb) troca só o src da <img>
// principal do card — sem estado em JS, o próprio DOM (qual botão tem
// .on) é a fonte da verdade, igual ao padrão de toggleQuickSize().
function trocarImagemPrincipalCard(btn){
  const src = btn.dataset.src;
  if(!src) return;
  const media = btn.closest('.prod-card-frame')?.querySelector('.prod-card-media');
  const img = media?.querySelector('img');
  if(img) img.src = src;
  btn.parentElement?.querySelectorAll('.prod-thumb').forEach(t => t.classList.toggle('on', t === btn));
}
function renderWL(){
  const g=document.getElementById('wGrid');
  // wl guarda só _id — resolve contra o catálogo atual pra ter os produtos
  // completos. Um _id salvo que não existe mais no catálogo (produto
  // removido) é descartado aqui, silenciosamente, pelo filter(Boolean).
  const items = wl.map(id => S.products.find(x => x._id === id)).filter(Boolean);
  document.getElementById('wSubtitle').textContent=items.length+' item'+(items.length!==1?'s':'')+' salvo'+(items.length!==1?'s':'');
  if(!items.length){ g.innerHTML=`<div class="prod-card" style="grid-column:1/-1;padding:60px;text-align:center;color:var(--muted)"><div style="margin-bottom:12px;color:var(--muted)"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg></div><p>Nenhum favorito ainda.<br><br><button class="btn-fill" onclick="goHome()">Explorar produtos</button></p></div>`; return; }
  g.innerHTML=items.map(p=>`
    <div class="prod-card" onclick="openProd(${p.id})">
      <div class="prod-img-wrap">
        ${p.img?`<img src="${escHtml(p.img)}" alt="${escHtml(p.name)}">`:`<span class="prod-img-empty">Sem imagem</span>`}
        <div class="prod-hover-btns">
          ${renderQuickAddAction(p, 'phb phb-cart', '+ Carrinho')}
          <button class="phb phb-wish on" onclick="event.stopPropagation();toggleWL('${p._id}');renderWL()"><svg class="ui-ico" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.6z"/></svg>Remover</button>
        </div>
      </div>
      <div class="prod-info">
        <div class="prod-brand">${escHtml(p.brand)}</div>
        <div class="prod-name">${escHtml(p.name)}</div>
        <div class="prod-foot"><span class="prod-price">${R$(p.price)}</span></div>
      </div>
    </div>`).join('');
}

/* ─── CART ─── */
// tamanho vem sempre explícito de quem chama — nunca lido de uma variável
// global compartilhada. Era exatamente essa variável (window.__vn_selectedSize)
// que causava o bug de tamanho herdado: ela guardava o tamanho do ÚLTIMO
// produto aberto na página do produto, e um clique em "+ Carrinho" nos
// destaques ou nos favoritos (que nunca passa pela página do produto) lia
// esse valor achando que era do produto errado — às vezes vazio, às vezes o
// tamanho de um produto completamente diferente.
function addCart(p, tamanho){
  // Checagem client-side só de UX (evita o cliente chegar até o checkout pra
  // descobrir ali) — quem trava de verdade é o decremento atômico no servidor.
  if (p.stock === 0) {
    showToast('warn','Produto esgotado.');
    return;
  }
  if (!temDadosEnvio(p)) {
    showToast('warn','Este produto está temporariamente indisponível para compra.');
    return;
  }
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  const sel = (tamanho || '').trim();
  // Só exige tamanho de produto que de fato tem tamanhos cadastrados — e o
  // valor precisa ser um dos tamanhos reais do produto, não qualquer string
  // não-vazia (mesma whitelist aplicada no servidor em POST /api/orders).
  if (sizes.length && !sizes.includes(sel)) {
    showToast('warn','Selecione um tamanho.');
    return;
  }

  const ex = cart.find(i=>i.id===p.id && (i.tamanhoSelecionado||'')===sel);
  if(ex){
    ex.qty++;
  } else {
    cart.push({...p, qty: 1, tamanhoSelecionado: sel});
  }

  persistCart();
  syncDots();
  renderCart();
  showToast('ok', p.name+' adicionado!');
  setTimeout(openCart,350);
}

/** Gera o botão/ação de "adicionar" de um card: produto sem tamanho continua
 * um toque só e direto; produto com tamanho revela os chips no lugar do
 * botão (ver toggleQuickSize/addCartComTamanho) em vez de navegar pra
 * página do produto — mesmo padrão nos três carrosséis (grid, destaques,
 * favoritos), pra um produto nunca se comportar diferente dependendo de
 * onde o cliente clicou. */
/* Conteúdo interno do botão de carrinho: só o "Adicionar ao Carrinho" real
   (btnClass contendo prod-add-btn) recebe o par de ícones do efeito
   cart-add-fx (decisão do cliente, exclusiva desse botão) — as variantes
   curtas '+ Carrinho' (btn-sm/phb-cart, usadas em carrossel de destaques e
   na barra fixa mobile do produto) continuam só com texto, sem mexer. */
function renderQuickAddBtnInner(btnClass, btnLabel){
  if (!btnClass.includes('prod-add-btn')) return btnLabel;
  return `<span class="cart-add-fx-iconslot" aria-hidden="true"><i class="fa-solid fa-cart-shopping cart-add-fx-icon"></i><i class="fa-solid fa-check cart-add-fx-fly"></i></span><span class="cart-add-fx-label">${btnLabel}</span>`;
}

function renderQuickAddAction(p, btnClass, btnLabel){
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  const cls = btnClass.includes('prod-add-btn') ? `${btnClass} cart-add-fx` : btnClass;
  const inner = renderQuickAddBtnInner(btnClass, btnLabel);
  if (!sizes.length) {
    return `<button class="${cls}" onclick="event.stopPropagation();addCart(S.products[${p.id}],'')">${inner}</button>`;
  }
  return `
    <div class="qa-wrap">
      <button class="${cls} qa-btn" onclick="event.stopPropagation();toggleQuickSize(this)">${inner}</button>
      <div class="qa-sizes" style="display:none">
        ${sizes.map(s => `<button type="button" class="qa-size-chip" data-tamanho="${escHtml(s)}" onclick="event.stopPropagation();addCartComTamanho(this,${p.id})">${escHtml(s)}</button>`).join('')}
      </div>
    </div>`;
}

function toggleQuickSize(btn){
  const wrap = btn.closest('.qa-wrap');
  if (!wrap) return;
  const sizesBox = wrap.querySelector('.qa-sizes');
  if (!sizesBox) return;
  const abrindo = sizesBox.style.display === 'none';
  sizesBox.style.display = abrindo ? 'flex' : 'none';
  btn.style.display = abrindo ? 'none' : '';
}

function addCartComTamanho(chip, pid){
  const p = S.products[pid];
  if (!p) return;
  addCart(p, chip.dataset.tamanho || '');
  const wrap = chip.closest('.qa-wrap');
  if (wrap) {
    const sizesBox = wrap.querySelector('.qa-sizes');
    const btn = wrap.querySelector('.qa-btn');
    if (sizesBox) sizesBox.style.display = 'none';
    if (btn) btn.style.display = '';
  }
}

function openCart(){  document.getElementById('cartDrawer').classList.add('on');  document.getElementById('overlay').classList.add('on'); }
function closeCart(){ document.getElementById('cartDrawer').classList.remove('on'); document.getElementById('overlay').classList.remove('on'); }
function chQty(i,d){
  cart[i].qty += d;
  if (cart[i].qty < 1) cart.splice(i, 1);
  persistCart();
  syncDots();
  renderCart();
}
function delItem(i){
  cart.splice(i,1);
  persistCart();
  syncDots();
  renderCart();
}


function renderCart(){
  const total=cart.reduce((s,i)=>s+i.price*i.qty,0);
  const count=cart.reduce((s,i)=>s+i.qty,0);
  const foot=document.getElementById('cdFoot');
  foot.style.display=cart.length?'block':'none';
  if(cart.length){ document.getElementById('cdSub').textContent=R$(total); document.getElementById('cdTotal').textContent=R$(total); }
  const el=document.getElementById('cdItems');
  if(!cart.length){ el.innerHTML=`<div class="cd-empty"><div class="cd-empty-ico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div><p>Carrinho vazio</p></div>`; return; }
  el.innerHTML=cart.map((it,i)=>`
    <div class="ci">
      <div class="ci-img">${it.img?`<img src="${it.img}" alt="">`:`<span class="prod-img-empty">Sem imagem</span>`}</div>
      <div class="ci-body">
        <div class="ci-name">${it.name}</div>
        ${it.tamanhoSelecionado ? `<div class="ci-sizepick" style="margin-bottom:8px;font-size:11px;color:var(--gold);font-weight:700">Tam: ${it.tamanhoSelecionado}</div>` : ''}
        <div class="ci-price">${R$(it.price)}</div>

        <div class="ci-qrow">
          <button class="cqb" onclick="chQty(${i},-1)">−</button>
          <span class="cqn">${it.qty}</span>
          <button class="cqb" onclick="chQty(${i},1)">+</button>
        </div>
      </div>
<button class="ci-del" onclick="delItem(${i})"><i class="fa-solid fa-trash-can ui-ico" aria-hidden="true"></i></button>
    </div>`).join('');
}

/* Botão "Adicionar ao Carrinho" (.cart-add-fx): em touch não existe
   :hover de verdade, então replicamos o mesmo efeito visual com uma
   classe adicionada no touchstart e removida ~900ms depois — só decora,
   nunca bloqueia o clique real (addCart/toggleQuickSize continuam no
   onclick normal do botão, intocados). Delegado em document (não por
   botão): os cards são renderizados dinamicamente (renderGrid etc.),
   um listener por elemento se perderia toda vez que o grid é refeito. */
document.addEventListener('touchstart', function(e){
  const btn = e.target.closest('.cart-add-fx');
  if (!btn) return;
  btn.classList.add('cart-add-fx-touch');
  clearTimeout(btn.__cartAddFxTimer);
  btn.__cartAddFxTimer = setTimeout(() => btn.classList.remove('cart-add-fx-touch'), 900);
}, { passive: true });

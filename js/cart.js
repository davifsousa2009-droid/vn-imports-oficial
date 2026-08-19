// Carrinho e favoritos — compartilhado entre VN_IMPORTS.html, produto.html e
// search.html. As 3 páginas tinham cópias quase idênticas destas funções,
// mantidas manualmente em sincronia — foi assim que um bug no contador do
// carrinho ficou meses sem a correção em uma das cópias (ver
// AUDITORIA_QUALIDADE.md, achado 1.1). Daqui em diante, uma correção aqui
// vale para as 3 páginas de uma vez.
//
// Chaves de localStorage (únicas, usadas pelas 3 páginas):
//   vn_cart       — itens do carrinho
//   vni_wishlist  — IDs (_id do Mongo) dos produtos favoritados

function getCart(){ try{ return JSON.parse(localStorage.getItem('vn_cart')||'[]'); }catch(e){ return []; } }
function saveCart(c){ try{ localStorage.setItem('vn_cart', JSON.stringify(c||[])); }catch(e){} }

function getWishlist(){ try{ return JSON.parse(localStorage.getItem('vni_wishlist')||'[]'); }catch(e){ return []; } }
function saveWishlist(w){ try{ localStorage.setItem('vni_wishlist', JSON.stringify(w||[])); }catch(e){} }
function isInWishlist(id){ return getWishlist().includes(id); }

function toggleWishlist(id, btnEl){
  const list = getWishlist();
  const idx = list.indexOf(id);
  if(idx>-1){ list.splice(idx,1); showToast('Removido dos favoritos'); if(btnEl) btnEl.classList.remove('on'); }
  else { list.push(id); showToast('Adicionado aos favoritos'); if(btnEl) btnEl.classList.add('on'); }
  saveWishlist(list);
  syncDots();
}

const VN_CART_DOT_IDS = ['cDot','cDot2','cDot3','cDot4','cDot5','cDot6'];
const VN_WISH_DOT_IDS = ['wDot','wDot2','wDot3','wDot4','wDot5'];

function syncDots(){
  const hC = getCart().reduce((s,i)=>s+(i.qty||1),0) > 0;
  const hW = getWishlist().length > 0;
  VN_CART_DOT_IDS.forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.toggle('on',hC); });
  VN_WISH_DOT_IDS.forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.toggle('on',hW); });
}

window.addEventListener('storage', (e)=>{ if(e.key==='vn_cart' || e.key==='vni_wishlist') syncDots(); });

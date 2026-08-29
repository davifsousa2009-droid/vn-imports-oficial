// Núcleo compartilhado — extraído de VN_IMPORTS.html (Estágio 2, divisão
// do <script> inline por funcionalidade). Estado global (S, cart, wl,
// categorias, filtros), persistência, formatação/escape de texto, toast,
// navegação entre views e o fade-in por IntersectionObserver — tudo usado
// por 3 ou mais dos outros arquivos desta divisão. Carrega ANTES de
// qualquer um dos outros (é a base; os outros arquivos assumem que estas
// funções/variáveis já existem quando são de fato invocados — o que só
// acontece depois de DOMContentLoaded ou de uma interação do usuário,
// muito depois de todo <script> ter terminado de carregar).

/* ─── DADOS PADRÃO ─── */
const DEF = {
  // slogan/herodesc/tel/email/footdesc/parctxt/paylink existiam aqui mas
  // nunca eram lidos em lugar nenhum (só DEF.store é usado) — removidos.
  store:'Minha Loja',
  frete:299, parc:12,
  products:[]
};

/* ─── ESTADO ─── */
let S = JSON.parse(localStorage.getItem('vn_data')||'null') || JSON.parse(JSON.stringify(DEF));
let cart = JSON.parse(localStorage.getItem('vn_cart')||'[]');

// persistência: ao carregar a página, recupere o carrinho e renderize
window.addEventListener('load', () => {
  try {
    cart = JSON.parse(localStorage.getItem('vn_cart') || '[]');
  } catch {
    cart = [];
  }
  renderCart();
  syncDots();
});

// Persistência do carrinho (localStorage)
function persistCart(){
  try { localStorage.setItem('vn_cart', JSON.stringify(cart || [])); } catch {}
}


// wl guarda só os _id (string, Mongo) dos produtos favoritados — persistido em
// 'vni_wishlist' via getWishlist()/saveWishlist() (js/cart.js), a mesma chave
// que produto.html/search.html já usavam. Antes ficava só em memória (nunca
// era salva), então favoritar na home não sobrevivia a um F5 nem aparecia
// nas outras duas páginas (ver AUDITORIA_QUALIDADE.md).
let wl = getWishlist();
let curProd = null;
// categoriasVitrine: lista plana (raízes + filhas, sem indentação — mesmo
// formato de antes) usada pelo mega menu antigo e pelos cards "Explore por
// Categoria". categoriasVitrineTree guarda a árvore crua (com children),
// usada só pelo matching do filtro (ver expandirSlugsComFilhos).
let categoriasVitrine = [];
let categoriasVitrineTree = [];
// categoria.slug -> categoria.tipo ('roupa'|'joia'|'outro') — reconstruído
// toda vez que categoriasVitrine é recarregada (carregarCategoriasDoServidor),
// consultado por converterProduto pra decidir se o produto entra no grupo de
// filtro "Tamanho de Roupa" ou "Medida de Joia". Chave é SEMPRE o slug, nunca
// o nome — é o slug que o resto do arquivo usa pra casar produto<->categoria
// (p.cat, expandirSlugsComFilhos etc). Categoria sem tipo salvo (criada antes
// desse campo existir) cai em 'outro', igual ao default do schema.
let categoriaTipoMap = new Map();

function flattenCategoryTree(tree) {
  const out = [];
  (tree || []).forEach((raiz) => {
    if (raiz && raiz.slug && raiz.nome) out.push(raiz);
    (raiz?.children || []).forEach((filha) => {
      if (filha && filha.slug && filha.nome) out.push(filha);
    });
  });
  return out;
}

// Dado o conjunto de slugs marcados no filtro, devolve o conjunto de slugs
// que efetivamente contam como "match" — marcar uma categoria-pai também
// inclui os produtos das filhas dela (consistente com o mega menu, que usa
// a mesma árvore). Hoje o schema de Category não tem parent/children
// preenchido (todo mundo é raiz sem filhos), então isso ainda não muda nada
// na prática — mas fica correto pro dia em que existir.
function expandirSlugsComFilhos(tree, slugsSelecionados) {
  const selecionados = new Set(slugsSelecionados);
  const resultado = new Set();
  (tree || []).forEach((raiz) => {
    const filhas = raiz?.children || [];
    if (selecionados.has(raiz.slug)) {
      resultado.add(raiz.slug);
      filhas.forEach((f) => resultado.add(f.slug));
    }
    filhas.forEach((f) => {
      if (selecionados.has(f.slug)) resultado.add(f.slug);
    });
  });
  return resultado;
}

// ─── FILTROS — Lógica unificada (reativa) ───
// Estado centralizado (o segredo): sempre fonte de verdade
window.activeFilters = window.activeFilters || {
  categories: [],
  sizes: [],
  maxPrice: Infinity
};

// Mantém valores numéricos do slider em um único lugar
const filterRuntime = {
  priceMin: null,
  priceMax: null,
  priceCap: 0
};



const save  = ()=>localStorage.setItem('vn_data', JSON.stringify(S));
const saveC = ()=>localStorage.setItem('vn_cart', JSON.stringify(cart));
const R$    = v=>'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2});

// Só chamar quando o pedido é um compromisso real do cliente: pagamento
// confirmado (cartão/Pix via Mercado Pago) ou Pix manual mostrado ao cliente
// (sem confirmação automática possível nesse caso). Nunca antes disso — uma
// recusa de cartão não pode deixar o cliente com o carrinho vazio e sem
// como tentar de novo.
function limparCarrinhoPosPedido(){
  S.cart = [];
  cart = [];
  saveC();
  renderCart();
  syncDots();
}

/* ─── VIEWS ─── */
function goView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({top:0,behavior:'instant'});
  if(id==='view-wishlist') renderWL();
  syncDots();
}
function goHome(){ goView('view-home'); }
function openSobre(){ goView('view-sobre'); }
function openAvaliacoes(){ goView('view-avaliacoes'); }

// Usado por links que só existem/fazem sentido dentro da view-home (rolar até
// uma seção dela) mas agora também aparecem no menu completo das views
// secundárias — garante que a home esteja ativa antes de rolar, senão
// scrollIntoView não funciona num elemento escondido (display:none).
function garantirViewHome(){
  const home = document.getElementById('view-home');
  if(home && !home.classList.contains('active')) goHome();
}

function scrollTo_(id){
  document.getElementById(id)?.scrollIntoView({behavior:'smooth'});
}

/* ─── FADE IN ─── */
const io=new IntersectionObserver(entries=>{ entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('vis'); e.target.querySelectorAll('.rbar-fill[data-w]').forEach(b=>setTimeout(()=>b.style.width=b.dataset.w,150)); } }); },{threshold:.12});
function observeFI(){ document.querySelectorAll('.fi').forEach(el=>io.observe(el)); }

/* ══════════════════════════════════════════════════════════
   INTEGRAÇÃO COM O BACKEND — VN IMPORTS
   Nome, PIX e cores vêm de /api/config (shopConfig.js + Mongo no servidor).
══════════════════════════════════════════════════════════ */
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

function escapeHtmlTexto(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── CONTACT ─── */
function submitForm(e){ e.preventDefault(); const ok=document.getElementById('formOk'); ok.classList.add('on'); e.target.reset(); setTimeout(()=>ok.classList.remove('on'),5000); }

/* ─── TOAST ─── */
let toastT;
function showToast(ico,msg){
  const iconMap = {
    success: 'fa-check',
    warning: 'fa-triangle-exclamation',
    warn: 'fa-triangle-exclamation',
    ok: 'fa-circle-check',
    heart: 'fa-heart',
    heartOutline: 'fa-heart',
    info: 'fa-info-circle',
    error: 'fa-circle-xmark'
  };
  const iconClass = iconMap[ico] || 'fa-check';
  document.getElementById('toastIco').innerHTML = `<i class="fa-solid ${iconClass}" aria-hidden="true"></i>`;
  document.getElementById('toastMsg').textContent = msg;
  const t=document.getElementById('toast'); t.classList.add('on');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('on'),3000);
}

function escHtml(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

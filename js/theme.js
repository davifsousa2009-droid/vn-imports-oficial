// Tema claro/escuro. Compartilhado entre produto.html e search.html — antes
// existiam 2 cópias idênticas deste arquivo, uma por página. VN_IMPORTS.html
// (a home) ainda não tem alternância de tema; ver AUDITORIA_QUALIDADE.md.
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-icon-sun').forEach(el => el.style.display = theme==='dark' ? 'none' : '');
  document.querySelectorAll('.theme-icon-moon').forEach(el => el.style.display = theme==='dark' ? '' : 'none');
}
function toggleTheme(){
  const atual = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const novo = atual === 'dark' ? 'light' : 'dark';
  applyTheme(novo);
  try { localStorage.setItem('vn_theme', novo); } catch(e) {}
}
(function initTheme(){
  let salvo = null;
  try { salvo = localStorage.getItem('vn_theme'); } catch(e) {}
  const preferido = salvo || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(preferido);
})();

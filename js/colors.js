// Aplica o tema de cores da loja (vindo de /api/config) nas custom properties
// do :root. Compartilhado entre VN_IMPORTS.html, produto.html e search.html —
// antes existiam 3 cópias idênticas deste arquivo, uma por página.
function aplicarCoresDaLoja(colors) {
  if (!colors || typeof colors !== 'object') return;
  const root = document.documentElement;
  Object.keys(colors).forEach((k) => {
    const v = colors[k];
    if (typeof v === 'string' && v.trim()) root.style.setProperty('--' + k, v.trim());
  });
}

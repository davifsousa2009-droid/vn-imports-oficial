function escapeParaAtributo(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeParaCss(v) {
  // Valores de cor devem ser simples (#hex, rgb(...), nome). Removemos qualquer coisa
  // que pudesse fechar a tag <style> mais cedo (defesa extra, mesmo sendo admin-controlado).
  return String(v || '').replace(/[<>"'`]/g, '').replace(/\/style/gi, '');
}

// Monta o <style> de override com as cores que podem divergir do :root
// estático do arquivo (bg/bg2/border do tema de fundo, gold/gold2 da cor da
// marca, heroPanelBg do tom do painel do hero, e ink/accent — ver comentário
// abaixo) — usado por toda página pública pra evitar o "flash" de cor padrão
// -> cor real da loja. Os demais tokens (muted, silver, etc.) nunca divergem
// do que já está no arquivo, não precisam de override.
//
// ink/accent entraram aqui no rebrand pra navy (2026): são "fixos, mesmo
// valor pra qualquer loja" (nunca vêm do painel — só de config.js, igual
// antes), mas agora que config.js deixou de usar os valores de fábrica
// originais, sem override SSR o primeiro paint mostraria a cor antiga até
// aplicarCoresDaLoja() rodar no cliente. Incluir aqui não muda a regra de
// "nunca variam por loja no painel" — só fecha a janela de flash, seguindo
// o mesmo caminho já usado por bg/gold/heroPanelBg.
function construirOverrideCoresStyle(cfg) {
  const bg = escapeParaCss(cfg?.colors?.bg);
  const bg2 = escapeParaCss(cfg?.colors?.bg2);
  const border = escapeParaCss(cfg?.colors?.border);
  const gold = escapeParaCss(cfg?.colors?.gold);
  const gold2 = escapeParaCss(cfg?.colors?.gold2);
  const heroPanelBg = escapeParaCss(cfg?.colors?.['hero-panel-bg']);
  const ink = escapeParaCss(cfg?.colors?.ink);
  const accent = escapeParaCss(cfg?.colors?.accent);
  const decls =
    (bg ? `--bg:${bg};` : '') +
    (bg2 ? `--bg2:${bg2};` : '') +
    (border ? `--border:${border};` : '') +
    (gold ? `--gold:${gold};` : '') +
    (gold2 ? `--gold2:${gold2};` : '') +
    (heroPanelBg ? `--hero-panel-bg:${heroPanelBg};` : '') +
    (ink ? `--ink:${ink};` : '') +
    (accent ? `--accent:${accent};` : '');
  return decls ? `<style>:root{${decls}}</style>\n</head>` : null;
}

/**
 * Monograma SVG (inicial do nome da loja + cor dourada já configurada) usado
 * como favicon. Servido como rota própria (/favicon.svg), referenciada por um
 * <link> estático (caminho relativo, sem domínio nenhum) nos 4 HTMLs — inclusive
 * search.html e produto.html, que são servidos crus/em cache, sem templating
 * por request. Uma rota dedicada resolve os quatro de uma vez só, em vez de
 * estender templating pra páginas que hoje não têm. Branco-de-loja de
 * propósito: nunca uma letra ou cor fixa de um cliente específico.
 */
function construirFaviconSvg(cfg) {
  const nomeRaw = String(cfg?.nomeLoja || 'Loja').trim();
  const inicial = (nomeRaw.match(/[\p{L}\p{N}]/u) || ['L'])[0].toUpperCase();
  const corRaw = String(cfg?.colors?.gold || '#9A7A3A').trim();
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(corRaw) ? corRaw : '#9A7A3A';
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<rect width='64' height='64' rx='14' fill='${cor}'/>` +
    `<text x='32' y='45' font-family='Georgia,serif' font-size='34' font-weight='700' fill='#ffffff' text-anchor='middle'>${inicial}</text>` +
    `</svg>`
  );
}

// construirHeroPlaceholderSvg (placeholder do hero antigo, sem foto
// configurada) foi removida junto com heroImagem/heroImagemUrl — o
// carrossel de banners não precisa de um placeholder gerado por SVG: sem
// nenhum banner cadastrado, o próprio CSS de fundo do hero (gradiente nas
// cores da marca) já cobre o caso, sem depender de nada vindo do servidor.

module.exports = {
  escapeParaAtributo,
  escapeParaCss,
  construirOverrideCoresStyle,
  construirFaviconSvg
};

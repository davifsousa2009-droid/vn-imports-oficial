/**
 * Teste de regressão INFORMAL (não faz parte de `npm test`/CI) pra dois
 * bugs que já aconteceram nesta base de código, os dois pela mesma causa
 * raiz — um item de CSS Grid/Flexbox tem min-width:auto por padrão, então
 * texto com white-space:nowrap pode forçar o item a nunca encolher:
 *
 *   1) "Grid blowout": o TRACK do grid (.prod-grid) fica maior que o
 *      container real pra caber o conteúdo, empurrando cards pra fora da
 *      tela — corrigido antes com min-width:0 em .prod-card.
 *   2) "Corte sem reticências": um elemento com overflow:hidden +
 *      white-space:nowrap recorta o texto no meio da palavra, sem "…" —
 *      porque a truncagem foi declarada num ANCESTRAL (ex: o botão), não
 *      no elemento cujo conteúdo de fato não cabe (ex: o span do rótulo,
 *      que é item de flex e se recusa a encolher) — corrigido no rótulo
 *      .cart-add-fx-label.
 *
 * Em vez de travar num seletor só (.prod-add-btn, .cart-add-fx-label...),
 * varre a página INTEIRA por qualquer elemento com essa combinação de
 * propriedades — pra pegar uma 3ª ocorrência em QUALQUER componente
 * futuro, não só nos dois já corrigidos.
 *
 * Requer puppeteer instalado (não é dependência do projeto — instala só
 * quando for rodar este teste, de propósito, pra não pesar o template):
 *   npm install puppeteer --no-save
 * E o servidor rodando localmente antes:
 *   node server.js
 *
 * Uso:
 *   node scripts/teste-regressao-grid-mobile.js
 *   node scripts/teste-regressao-grid-mobile.js https://minha-loja.vercel.app
 */

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.error(
    'Falta o puppeteer (não é dependência do projeto, de propósito).\n' +
    'Rode: npm install puppeteer --no-save\ne tente de novo.'
  );
  process.exit(1);
}

const URL_BASE = process.argv[2] || 'http://localhost:3000';
const LARGURAS = [320, 375, 390, 414];

async function checarLargura(browser, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1200, deviceScaleFactor: 2 });
  await page.goto(URL_BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // grid/preços/badges renderizam via JS após o load

  const resultado = await page.evaluate(() => {
    const problemas = [];

    // ── 1) Overflow horizontal da PÁGINA inteira (sintoma mais grave de
    // grid blowout: se acontecer em QUALQUER lugar, o body inteiro ganha
    // barra de rolagem horizontal). ──
    if (document.body.scrollWidth > document.body.clientWidth + 1) {
      problemas.push({
        tipo: 'overflow-pagina',
        detalhe: `body.scrollWidth=${document.body.scrollWidth} > clientWidth=${document.body.clientWidth}`,
      });
    }

    // ── 2) grid-template-columns computado vs largura real do container,
    // especificamente pro grid de produtos (onde o bug já aconteceu). ──
    const grid = document.querySelector('.prod-grid');
    if (grid) {
      const cs = getComputedStyle(grid);
      const colunas = cs.gridTemplateColumns.trim().split(/\s+/).map(parseFloat);
      const gapPx = parseFloat(cs.columnGap) || 0;
      const somaColunas = colunas.reduce((a, b) => a + b, 0) + gapPx * Math.max(0, colunas.length - 1);
      const containerWidth = grid.getBoundingClientRect().width;
      if (somaColunas > containerWidth + 1) {
        problemas.push({
          tipo: 'grid-estourado',
          detalhe: `soma das colunas (${somaColunas.toFixed(1)}px) > largura do container (${containerWidth.toFixed(1)}px) — grid-template-columns: ${cs.gridTemplateColumns}`,
        });
      }
    }

    // ── 3) Texto cortado SEM reticências em QUALQUER elemento da página
    // (não só o botão já corrigido) — varredura genérica pra pegar uma 3ª
    // ocorrência em componente novo.
    //
    // IMPORTANTE (achado testando o próprio detector contra o bug real,
    // antes de confiar nele — ver histórico da conversa): checar
    // overflow:hidden só no elemento-folha NÃO pega esse bug, porque quem
    // recorta normalmente é um ANCESTRAL (o botão), não o span do texto —
    // o span em si fica com overflow:visible, então scrollWidth==clientWidth
    // nele (nada "transborda" do PRÓPRIO ponto de vista do span, mesmo
    // sendo cortado por fora). Por isso o algoritmo sobe a árvore a partir
    // da folha até achar quem REALMENTE recorta (overflow/overflow-x:
    // hidden), e só aceita como "ok" quando esse recortador for o PRÓPRIO
    // elemento de texto (truncagem de si mesmo com text-overflow:ellipsis)
    // — que é o único padrão em que a elipse do CSS funciona de verdade. ──
    const todosLeaf = Array.from(document.querySelectorAll('body *')).filter(
      (el) => el.children.length === 0 && el.textContent && el.textContent.trim()
    );
    todosLeaf.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return; // não visível, ignora
      // "sr-only"/visualmente-oculto-pra-leitor-de-tela (ex: .hero-car-sr,
      // status do carrossel): técnica proposital de acessibilidade — clipa
      // o texto num box de ~1px de propósito, não é bug de truncagem
      // visual (não há nada "visível" ali pra cortar mal). Um corte de
      // verdade sempre tem um box com largura razoável (o botão, o card
      // etc.), nunca ~1px.
      if (rect.width <= 4 || rect.height <= 4) return;

      // sobe a árvore (a partir do próprio elemento, inclusive) até achar
      // quem efetivamente recorta o eixo X
      let clipador = null;
      let node = el;
      while (node && node !== document.documentElement) {
        const csNode = getComputedStyle(node);
        if (csNode.overflow === 'hidden' || csNode.overflowX === 'hidden') { clipador = node; break; }
        node = node.parentElement;
      }
      if (!clipador) return; // nada recorta esse texto — não tem como cortar mal
      // body/html com overflow(-x):hidden é um reset genérico comum (evita
      // scroll bounce horizontal), não indica um recorte de texto de
      // verdade — é exatamente o que também "recorta" qualquer gaveta
      // off-canvas por design (menu mobile, carrinho) antes de abrir,
      // gerando falso positivo em todo o conteúdo delas.
      if (clipador === document.body || clipador === document.documentElement) return;

      const clipRect = clipador.getBoundingClientRect();
      const estouraClipador = rect.right > clipRect.right + 1 || rect.left < clipRect.left - 1;
      if (!estouraClipador) return; // cabe dentro de quem recorta, tudo bem

      // só é "ok" se o próprio elemento de texto for quem recorta A SI
      // MESMO, com white-space:nowrap + text-overflow:ellipsis (o único
      // caso em que a elipse do CSS realmente aparece)
      const csEl = getComputedStyle(el);
      const autoTruncamentoOk = clipador === el && csEl.whiteSpace === 'nowrap' && csEl.textOverflow === 'ellipsis';
      if (autoTruncamentoOk) return;

      problemas.push({
        tipo: 'texto-cortado-sem-reticencias',
        detalhe: `<${el.tagName.toLowerCase()} class="${el.className}"> texto="${el.textContent.trim().slice(0, 40)}" recortado por <${clipador.tagName.toLowerCase()} class="${clipador.className}">`,
      });
    });

    return problemas;
  });

  await page.close();
  return resultado;
}

(async () => {
  console.log(`Testando ${URL_BASE} em ${LARGURAS.join('px, ')}px...\n`);
  const browser = await puppeteer.launch({ headless: 'new' });
  let totalProblemas = 0;

  for (const w of LARGURAS) {
    const problemas = await checarLargura(browser, w);
    if (problemas.length) {
      console.log(`✖ ${w}px — ${problemas.length} problema(s):`);
      problemas.forEach((p) => console.log(`   [${p.tipo}] ${p.detalhe}`));
      totalProblemas += problemas.length;
    } else {
      console.log(`✔ ${w}px — sem overflow de grid nem texto cortado sem indicação`);
    }
  }

  await browser.close();

  console.log('');
  if (totalProblemas > 0) {
    console.log(`FALHOU: ${totalProblemas} problema(s) encontrado(s) no total.`);
    process.exit(1);
  } else {
    console.log('OK: nenhum problema encontrado em nenhuma largura testada.');
  }
})();

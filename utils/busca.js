const Produto = require('../models/Produto');

function escapeRegexEspecial(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deixa a busca tolerante a acento (ex: "relogio" encontra "Relógio") sem
// precisar de índice de texto ($text) nem normalizar/migrar os dados já
// salvos no banco: expande cada letra digitada numa classe de caracteres
// que cobre também suas variantes acentuadas.
const MAPA_ACENTOS_BUSCA = { a: 'aàáâãä', e: 'eèéêë', i: 'iìíîï', o: 'oòóôõö', u: 'uùúûü', c: 'cç', n: 'nñ' };
function regexBuscaSemAcento(q) {
  const semAcento = String(q || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const escapado = escapeRegexEspecial(semAcento);
  return escapado.replace(/[a-z]/g, (ch) => {
    const variantes = MAPA_ACENTOS_BUSCA[ch];
    return variantes ? `[${variantes}]` : ch;
  });
}

/**
 * Distância de Damerau-Levenshtein (Levenshtein + transposição de letras
 * adjacentes como 1 edição só, não 2) — usada só no fallback por
 * similaridade abaixo. Escolhida especificamente por causa da transposição:
 * testado antes de implementar, Levenshtein puro não pegava um padrão comum
 * de digitação (ex: "blsua" por "blusa", letras trocadas de lugar).
 */
function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

function normalizarBusca(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

function similaridadeTexto(a, b) {
  const na = normalizarBusca(a), nb = normalizarBusca(b);
  if (!na || !nb) return 0;
  const dist = damerauLevenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - dist / maxLen;
}

// Testado contra pares reais antes de escolher este número: erros de
// digitação típicos ("camsa"/"camisa", "blsua"/"blusa") ficam em 0.80-0.86;
// palavras genuinamente diferentes ("camisa"/"calça", "casaco"/"jaqueta",
// "bolsa"/"bota") ficam em 0.00-0.60. 0.75 separa os dois grupos com folga
// real, não um corte torcido pra caber nos exemplos testados.
const LIMIAR_SIMILARIDADE_BUSCA = 0.75;

// Teto do lote candidato no fallback por similaridade — evita varrer o
// catálogo inteiro sem limite nenhum. Suficiente pra uma loja pequena/média;
// catálogo muito maior que isso é um problema pra reconsiderar depois, não
// pra resolver preventivamente agora.
const TETO_CANDIDATOS_FUZZY = 2000;

/**
 * Fallback só usado quando a busca por trecho (nome/categoria/descrição/
 * palavrasChave) não encontra nada — nunca dilui um resultado que já existe,
 * só entra em ação quando não há nada melhor pra mostrar (evita o problema
 * oposto: "camisa" trazendo calça junto). Roda inteiro em memória, sem
 * nenhum recurso de busca do banco (funciona igual em qualquer tier do
 * MongoDB) e sem montar filtro nenhum a partir do texto do cliente — o
 * texto digitado nunca chega perto de uma query do Mongo aqui, só é
 * comparado como string depois de um find() fixo.
 */
async function buscarPorSimilaridade(q, limit, skip) {
  const palavrasQuery = normalizarBusca(q).split(/\s+/).filter(Boolean);
  if (!palavrasQuery.length) return [];

  const candidatos = await Produto.find({}).sort({ createdAt: -1 }).limit(TETO_CANDIDATOS_FUZZY).lean();

  const pontuados = candidatos
    .map((p) => {
      const palavrasProduto = [
        ...String(p.nome || '').split(/\s+/),
        ...String(p.categoria || '').split(/\s+/),
        ...(Array.isArray(p.palavrasChave) ? p.palavrasChave : [])
      ].filter(Boolean);

      if (!palavrasProduto.length) return null;

      // Exige que TODA palavra da busca tenha uma correspondência razoável
      // em alguma palavra do produto (nome/categoria/palavra-chave) — busca
      // de duas palavras só bate se as duas encontrarem algo, não só uma.
      let somaScores = 0;
      for (const palavraQuery of palavrasQuery) {
        let melhor = 0;
        for (const palavraProduto of palavrasProduto) {
          const s = similaridadeTexto(palavraQuery, palavraProduto);
          if (s > melhor) melhor = s;
        }
        if (melhor < LIMIAR_SIMILARIDADE_BUSCA) return null;
        somaScores += melhor;
      }
      return { produto: p, score: somaScores / palavrasQuery.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return pontuados.slice(skip, skip + limit).map((x) => x.produto);
}

module.exports = {
  escapeRegexEspecial,
  regexBuscaSemAcento,
  buscarPorSimilaridade
};

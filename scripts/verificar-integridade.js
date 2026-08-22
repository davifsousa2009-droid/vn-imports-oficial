#!/usr/bin/env node
'use strict';
// Verificação estática rápida, sem dependência nova — pensada pra rodar no
// CI a cada push (ver .github/workflows/ci.yml) e também localmente
// (`npm run verificar`). Junta 5 checagens que antes eram feitas à mão a
// cada rodada de edição neste projeto:
//
//   1. Sintaxe válida em todo arquivo .js do repositório (node --check).
//   2. Sintaxe válida em todo bloco <script> inline dos arquivos HTML.
//   3. Nenhum byte de controle (corrupção silenciosa de edição, já
//      aconteceu neste projeto e passou despercebido até quebrar uma
//      edição posterior).
//   4. JSON válido em package.json / package-lock.json / vercel.json.
//   5. Toda página/arquivo estático servido por server.js que precisa de
//      entrada em vercel.json (produção não tem express.static — só
//      local) realmente tem as duas pontas, nos dois sentidos.
//
// Cada problema é reportado com arquivo (+ linha, quando aplicável) e uma
// descrição específica — nunca só "falhou". Pensado pra ser lido na aba
// Actions do GitHub, no celular, sem contexto nenhum de qual edição rodou.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Fora de escopo: node_modules (código de terceiro), .git (interno), e
// UPSites (template white-label congelado — não é código deste projeto,
// ver MAPA_DO_PROJETO.md).
const IGNORAR_DIRS = new Set(['node_modules', '.git', 'UPSites']);

function listarArquivos(dir, extensoes) {
  const resultado = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      resultado.push(...listarArquivos(full, extensoes));
    } else if (extensoes.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      resultado.push(full);
    }
  }
  return resultado;
}

const problemas = [];
function reportar(arquivo, linha, mensagem) {
  const rel = path.relative(ROOT, arquivo).replace(/\\/g, '/');
  problemas.push(linha ? `${rel}:${linha} — ${mensagem}` : `${rel} — ${mensagem}`);
}

// ── 1. Sintaxe dos arquivos .js ──────────────────────────────────────────
function checarSintaxeJs() {
  for (const arquivo of listarArquivos(ROOT, ['.js'])) {
    try {
      execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' });
    } catch (e) {
      const stderr = (e.stderr || Buffer.from('')).toString();
      // .trimEnd() em cada linha: no Windows, execFileSync devolve stderr
      // com \r\n — sem isso, o \r sobrando quebra o regex de fim-de-linha
      // abaixo (:(\d+)$ nunca bate com "...config.js:55\r").
      const linhas = stderr.split('\n').map((l) => l.trimEnd()).filter((l) => l);
      const primeira = linhas[0] || '';
      const m = primeira.match(/:(\d+)$/);
      const linha = m ? Number(m[1]) : null;
      const erro = linhas.find((l) => /Error:/.test(l)) || primeira || 'erro de sintaxe desconhecido';
      reportar(arquivo, linha, erro.trim());
    }
  }
}

// ── 2. Sintaxe dos <script> inline nos HTMLs ─────────────────────────────
function checarScriptsInlineHtml() {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const arquivo of listarArquivos(ROOT, ['.html'])) {
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    re.lastIndex = 0;
    let m;
    let indice = 0;
    while ((m = re.exec(conteudo))) {
      indice++;
      const codigo = m[1];
      if (!codigo.trim()) continue;
      try {
        new Function(codigo);
      } catch (e) {
        const antes = conteudo.slice(0, m.index);
        const linha = antes.split('\n').length;
        reportar(arquivo, linha, `bloco <script> inline #${indice} com erro de sintaxe — ${e.message}`);
      }
    }
  }
}

// ── 3. Bytes de controle ─────────────────────────────────────────────────
function checarBytesControle() {
  const RE_CONTROLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
  for (const arquivo of listarArquivos(ROOT, ['.js', '.html', '.json', '.md'])) {
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    const linhas = conteudo.split('\n');
    linhas.forEach((linhaTexto, idx) => {
      if (RE_CONTROLE.test(linhaTexto)) {
        reportar(arquivo, idx + 1, 'byte de controle inesperado nesta linha (possível corrupção de edição)');
      }
    });
  }
}

// ── 4. JSON válido ────────────────────────────────────────────────────────
function checarJson() {
  const candidatos = ['package.json', 'package-lock.json', 'vercel.json']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f));
  for (const arquivo of candidatos) {
    try {
      JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    } catch (e) {
      reportar(arquivo, null, `JSON inválido — ${e.message}`);
    }
  }
}

// ── 5. Consistência vercel.json ↔ server.js ──────────────────────────────
// Convenção documentada em MAPA_DO_PROJETO.md (seção 6): em produção o
// express.static fica desligado, então toda página/arquivo estático servido
// via app.get(...) em server.js PRECISA de uma entrada correspondente em
// vercel.json (rewrites), e vice-versa — senão bate 404 só em produção,
// nunca localmente (onde express.static cobre por engano).
function checarConsistenciaRotas() {
  const vercelPath = path.join(ROOT, 'vercel.json');
  const serverPath = path.join(ROOT, 'server.js');
  if (!fs.existsSync(vercelPath) || !fs.existsSync(serverPath)) return;

  let vercelConfig;
  try {
    vercelConfig = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
  } catch {
    return; // já reportado por checarJson()
  }

  const rewrites = Array.isArray(vercelConfig.rewrites) ? vercelConfig.rewrites : [];
  const serverCode = fs.readFileSync(serverPath, 'utf8');
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Só nos interessam rotas literais (sem regex/parâmetro) que não sejam
  // /api/* — a API inteira já é coberta por um único rewrite coringa
  // (/api/(.*)), não por um par 1:1 rota-a-rota como as páginas/arquivos.
  const ehRotaLiteralNaoApi = (rota) => /^\/[a-zA-Z0-9_\-./]*$/.test(rota) && !rota.startsWith('/api');

  // Rotas de página podem estar direto em server.js (app.get(...)) OU num
  // router montado via app.use(prefixo, require('./routes/X')) — desde a
  // divisão de server.js em routes/*.js isso passou a valer pra páginas
  // também (ver routes/paginas.js). Junta as duas fontes num único mapa
  // rota -> arquivo onde ela é definida, pra checar consistência igual
  // nos dois casos.
  const rotaParaArquivo = new Map();

  for (const m of serverCode.matchAll(/app\.get\(\s*['"](\/(?!api)[a-zA-Z0-9_\-./]*)['"]/g)) {
    rotaParaArquivo.set(m[1], serverPath);
  }

  const juntarRota = (prefixo, sub) => {
    if (prefixo === '/' || prefixo === '') return sub;
    return (prefixo + sub).replace(/\/{2,}/g, '/');
  };

  for (const m of serverCode.matchAll(/app\.use\(\s*['"]([^'"]*)['"]\s*,\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g)) {
    const prefixo = m[1];
    if (prefixo.startsWith('/api')) continue; // API é coberta pelo rewrite coringa, não 1:1
    const requirePath = m[2];
    const arquivoRota = path.join(ROOT, requirePath.endsWith('.js') ? requirePath : `${requirePath}.js`);
    if (!fs.existsSync(arquivoRota)) continue;
    let codigoRota;
    try {
      codigoRota = fs.readFileSync(arquivoRota, 'utf8');
    } catch {
      continue;
    }
    for (const rm of codigoRota.matchAll(/router\.get\(\s*['"](\/(?!api)[a-zA-Z0-9_\-./]*)['"]/g)) {
      rotaParaArquivo.set(juntarRota(prefixo, rm[1]), arquivoRota);
    }
  }

  // Sentido 1: rewrite existe, rota não está definida em nenhuma das fontes acima.
  for (const r of rewrites) {
    if (r.destination !== '/server.js' || !ehRotaLiteralNaoApi(r.source)) continue;
    if (!rotaParaArquivo.has(r.source)) {
      reportar(
        vercelPath,
        null,
        `rewrite "${r.source}" aponta pra /server.js, mas não existe app.get('${r.source}', ...) nem router.get('${r.source}', ...) em nenhuma rota montada — em produção isso bate 404 (o rewrite manda pro server.js, que não sabe responder)`
      );
    }
  }

  // Sentido 2: rota definida (em server.js ou num router montado) existe,
  // rewrite não — o mais perigoso dos dois, porque funciona local
  // (express.static/o próprio Express cobre) e só quebra depois de já
  // estar no ar.
  const fontesRewrite = new Set(rewrites.map((r) => r.source));
  for (const [rota, arquivoRota] of rotaParaArquivo) {
    if (!fontesRewrite.has(rota)) {
      reportar(
        arquivoRota,
        null,
        `rota '${rota}' existe, mas não há rewrite "${rota}" -> "/server.js" em vercel.json — funciona local (express.static cobre por engano), bate 404 em produção`
      );
    }
  }
}

// ── EXECUÇÃO ──────────────────────────────────────────────────────────────
checarSintaxeJs();
checarScriptsInlineHtml();
checarBytesControle();
checarJson();
checarConsistenciaRotas();

if (problemas.length) {
  console.error(`\n✖ ${problemas.length} problema(s) encontrado(s):\n`);
  for (const p of problemas) console.error('  ' + p);
  console.error('');
  process.exit(1);
} else {
  console.log('✔ Nenhum problema encontrado (sintaxe .js, <script> inline, bytes de controle, JSON, rotas vercel.json/server.js).');
}

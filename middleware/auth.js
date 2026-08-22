const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/** Normaliza valor de JWT vindo do painel (.trim(), BOM, aspas externas opcionais). */
function normalizeJwtEnvValue(raw) {
  if (raw == null) return '';
  let s = String(raw).trim().replace(/^﻿/, '');
  if (!s) return '';
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || '';
}

/** Compara UTF-8 em tempo constante; não usa .trim() — preserva espaços/caracteres da senha. */
function timingSafePasswordEqual(secretA, secretB) {
  const b1 = Buffer.from(secretA ?? '', 'utf8');
  const b2 = Buffer.from(secretB ?? '', 'utf8');
  if (b1.length !== b2.length) return false;
  if (b1.length === 0) return false;
  return crypto.timingSafeEqual(b1, b2);
}

let jwtSecretCache = '';
let jwtSourceLoggedLabel = '';

function invalidateJwtSecretCache() {
  jwtSecretCache = '';
  jwtSourceLoggedLabel = '';
}

/** Ordem: JWT_SECRET (obrigatório). */
function resolveJwtSecretWithSourceOnce() {
  const fromJwt = normalizeJwtEnvValue(process.env.JWT_SECRET);
  if (fromJwt) return { secret: fromJwt, sourceLabel: 'process.env.JWT_SECRET' };

  console.error('[jwt] JWT_SECRET não definido/está vazio. Bloqueando inicialização.');
  return { secret: '', sourceLabel: 'MISSING_JWT_SECRET' };
}

function getJwtSecret() {
  if (jwtSecretCache) return jwtSecretCache;
  const { secret, sourceLabel } = resolveJwtSecretWithSourceOnce();
  jwtSecretCache = secret;
  if (!jwtSourceLoggedLabel && jwtSecretCache) {
    jwtSourceLoggedLabel = sourceLabel;
    console.log('[jwt] segredo JWT ativo obtido via:', jwtSourceLoggedLabel);
  }
  return jwtSecretCache;
}

/** Poucas leituras de JWT_SECRET antes de usar fallback / HARDCODED. */
async function probeEnvJwtSecretWithDelay(maxMs = 600) {
  const step = 30;
  for (let t = 0; t < maxMs; t += step) {
    const s = normalizeJwtEnvValue(process.env.JWT_SECRET);
    if (s) return s;
    await new Promise((r) => setTimeout(r, step));
  }
  return normalizeJwtEnvValue(process.env.JWT_SECRET);
}

// Usado só por POST /api/admin/login (routes/auth.js), depois de reobter o
// segredo via probeEnvJwtSecretWithDelay — grava direto no cache deste
// módulo (mesma variável que getJwtSecret() lê) em vez de expor
// jwtSecretCache/jwtSourceLoggedLabel como variáveis mutáveis externas.
function primeJwtSecretCache(secret, sourceLabel) {
  jwtSecretCache = secret;
  jwtSourceLoggedLabel = sourceLabel;
  console.log('[jwt] segredo JWT ativo obtido via:', jwtSourceLoggedLabel);
}

function verificarJWT(req, res, next) {
  const secret = getJwtSecret();
  if (!secret) {
    return res.status(500).json({ erro: 'Falha interna ao obter segredo JWT.' });
  }

  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ erro: 'Token não fornecido. Faça login no painel.' });

  try {
    jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

// (REMOVIDO) verificação por senha em texto puro via header x-admin-password.
// Admin deve usar Bearer JWT nas rotas protegidas.

module.exports = {
  verificarJWT,
  getJwtSecret,
  invalidateJwtSecretCache,
  probeEnvJwtSecretWithDelay,
  normalizeJwtEnvValue,
  timingSafePasswordEqual,
  primeJwtSecretCache
};

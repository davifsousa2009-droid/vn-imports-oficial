const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const {
  timingSafePasswordEqual,
  invalidateJwtSecretCache,
  normalizeJwtEnvValue,
  probeEnvJwtSecretWithDelay,
  primeJwtSecretCache,
  getJwtSecret
} = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde alguns minutos.' }
});

router.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const masterRaw = process.env.ADMIN_PASSWORD;
    if (masterRaw == null || String(masterRaw).length === 0) {
      return res.status(500).json({ erro: 'Configuração do servidor incorreta.' });
    }

    const bodyPwd =
      req.body?.senha == null
        ? ''
        : typeof req.body.senha === 'string'
          ? req.body.senha
          : String(req.body.senha);

    if (!timingSafePasswordEqual(bodyPwd, String(masterRaw))) {
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    invalidateJwtSecretCache();
    let peek = normalizeJwtEnvValue(process.env.JWT_SECRET);
    if (!peek && process.env.VERCEL) {
      // mesmo em produção, faz poucas tentativas por cold-start
      peek = await probeEnvJwtSecretWithDelay(600);
    }

    if (!peek) {
      return res
        .status(500)
        .json({ erro: 'JWT_SECRET não configurado no ambiente.' });
    }

    primeJwtSecretCache(peek, 'process.env.JWT_SECRET');

    const secret = getJwtSecret();

    const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: '8h' });
    res.json({ token, expiresIn: '8h' });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao processar login.' });
  }
});

module.exports = router;

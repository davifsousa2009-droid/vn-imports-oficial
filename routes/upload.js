const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const configPadrao = require('../config');
const Config = require('../models/Config');
const { verificarJWT } = require('../middleware/auth');
const { tryConnectDb } = require('../utils/db');
const { slugifyTenantTag } = require('../utils/slug');

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && /^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas arquivos de imagem são permitidos.'));
  }
});

router.post('/upload', verificarJWT, (req, res) => {

  const missing =
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET;

  if (missing) {
    return res.status(503).json({
      erro: 'Cloudinary não configurado. Defina CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET.'
    });
  }

  uploadMem.single('arquivo')(req, res, async (err) => {
    if (err) return res.status(400).json({ erro: err.message || 'Erro no upload.' });
    if (!req.file?.buffer) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    try {
      let tenantTag = slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja);
      try {
        if (await tryConnectDb()) {
          const cfg = await Config.findOne().lean();
          tenantTag = slugifyTenantTag(
            cfg?.clienteTag || cfg?.nomeLoja || configPadrao.clienteTag || configPadrao.nomeLoja
          );
        }
      } catch (e) {
        // ignore
      }

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      // Assinatura real do SDK é upload(file, options, callback) — passar
      // `undefined` na posição de options e o objeto de opções na posição
      // de callback (como estava antes) faz o Cloudinary tentar chamar esse
      // objeto como função ao terminar o upload, derrubando o processo
      // inteiro (TypeError: callback is not a function). Achado testando
      // upload real de arquivo pra banner — afetava qualquer upload do
      // site, não só banner.
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: `shops/${tenantTag}`,
        resource_type: 'image',
        unique_filename: true,
        tags: [`shop:${tenantTag}`, `tenant:${tenantTag}`],
        public_id_prefix: `tenant-${tenantTag}`
      });

      res.status(201).json({ path: result.secure_url, mensagem: 'Upload concluído.' });
    } catch (e) {
      res.status(503).json({ erro: e.message || 'Erro ao enviar imagem para o Cloudinary.' });
    }
  });
});

module.exports = router;

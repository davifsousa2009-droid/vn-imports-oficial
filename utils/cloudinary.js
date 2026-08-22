const cloudinary = require('cloudinary').v2;

/** Extrai public_id a partir da secure_url padrão do Cloudinary. */
function cloudinaryPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || !url.includes(`res.cloudinary.com/${cloud}/`)) return null;
  const m = url.match(/\/(?:image|raw)\/upload\/(?:v\d+\/)?(.+)$/i);
  if (!m) return null;
  let rest = m[1];
  const dot = rest.lastIndexOf('.');
  if (dot > 0) rest = rest.slice(0, dot);
  return rest || null;
}

async function deleteCloudinaryAssetIfApplicable(url) {
  const publicId = cloudinaryPublicIdFromUrl(url);
  if (!publicId) return;
  try {
    // Mesmo bug de argumento trocado do routes/upload.js (ver comentário lá):
    // destroy(public_id, options, callback) — o `undefined` extra aqui
    // jogava o objeto de opções pra posição de callback, e o Cloudinary
    // tentava invocá-lo como função ao terminar, derrubando o processo
    // inteiro. O try/catch abaixo não protegia contra isso porque o erro é
    // lançado de dentro de um handler de evento interno do SDK (IncomingMessage
    // 'end'), fora da cadeia de promise que o await/catch cobre.
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (e) {
    console.warn('Cloudinary destroy:', e.message);
  }
}

module.exports = { cloudinaryPublicIdFromUrl, deleteCloudinaryAssetIfApplicable };

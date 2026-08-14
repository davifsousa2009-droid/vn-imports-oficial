/**
 * Configuração white-label padrão.
 * Para um novo cliente, altere apenas este arquivo.
 */
module.exports = {
  nomeLoja: 'Minha Loja',
  corPrimaria: '#9A7A3A',
  corSecundaria: '#C4A55A',
  whatsappContato: '',
  instagramLink: '',
  emailContato: '',
  /** CEP de origem (remetente) para cotação de frete no Melhor Envio.
   *  Troque pelo CEP real da loja — ou defina LOJA_CEP_ORIGEM no .env, que
   *  tem prioridade sobre este valor sem precisar mexer no código. */
  cepOrigem: '37006-670',
  /** Identificador do cliente para uploads/tags no Cloudinary */
  clienteTag: 'minha-loja',
  /** Chave PIX exibida quando não houver valor salvo no painel */
  chavePix: '',
  pageTitleSuffix: 'Loja Oficial',
  colors: {
    bg: '#F7F4F0',
    bg2: '#EDE9E3',
    ink: '#111111',
    ink2: '#1E1E1E',
    mid: '#444444',
    muted: '#888888',
    silver: '#BBBBBB',
    border: '#D9D4CC',
    border2: '#C8C2B8',
    white: '#FFFFFF',
    accent: '#2B2B2B',
    gold: '#9A7A3A',
    gold2: '#C4A55A',
    red: '#A0391E',
    green: '#2E6B47'
  }
};
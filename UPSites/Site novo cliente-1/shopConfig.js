/**
 * Configuração central da vitrine (nome, PIX padrão, paleta).
 * Para um site novo, ajuste este arquivo; o admin pode sobrescrever nome e PIX no banco.
 */
module.exports = {
  nomeLoja: 'VN IMPORTS',
  /** Chave PIX exibida quando não houver valor salvo no painel (Mongo). */
  chavePix: '',
  pageTitleSuffix: 'Moda Premium',
  /** Variáveis CSS (--token) usadas pela vitrine. */
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

/**
 * Configuração white-label padrão.
 * Para um novo cliente, altere apenas este arquivo.
 */
module.exports = {
  nomeLoja: 'UpSites',
  corPrimaria: '#16598A',
  corSecundaria: '#103F63',
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
  /** Controla os atalhos de tamanho de roupa/calçado (P/M/G/GG) no cadastro
   *  de produto do admin. Deixe true para lojas de roupa/calçado. Para um
   *  cliente novo que não vende isso (pet shop, joia, peça, impressão 3D),
   *  troque para false aqui — o campo de texto livre de variação continua
   *  funcionando normalmente, só os atalhos fixos somem do formulário. */
  usaTamanhosPadrao: true,
  /** Chave de um tom pré-calibrado em TEMAS_HERO (server.js) pra cor do
   *  painel de texto do hero. 'preto' mantém a aparência de hoje (mesmo hex
   *  de --ink). Troque aqui se quiser que um cliente novo já nasça com outro
   *  tom (grafite/marinho/verde/vinho) sem precisar configurar no painel. */
  corPainelHero: 'marinho',
  /** Título e texto da seção "Sobre" da vitrine — mesmo padrão de nomeLoja
   *  acima: valor de fábrica genérico, trocado por loja aqui ou sobrescrito
   *  a qualquer momento pelo painel (Configurações → Conteúdo do Site). */
  sobreTitulo: 'Sobre Nós',
  sobreTexto:
    'Somos apaixonados pelo que fazemos. Cada produto passa por um processo de seleção cuidadoso para garantir que chegue até você com a qualidade que você espera. Da descoberta ao pós-compra, nosso compromisso é simples: atendimento humano e experiência completa.',
  colors: {
    bg: '#F7F4F0',
    bg2: '#EDE9E3',
    ink: '#0E2233',
    ink2: '#1E1E1E',
    mid: '#444444',
    muted: '#5C5C5C',
    silver: '#BBBBBB',
    border: '#D9D4CC',
    border2: '#C8C2B8',
    white: '#FFFFFF',
    accent: '#1C6FA0',
    gold: '#16598A',
    gold2: '#103F63',
    red: '#A0391E',
    green: '#2E6B47'
  }
};
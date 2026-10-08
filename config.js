/**
 * Configuração white-label padrão.
 * Para um novo cliente, altere apenas este arquivo.
 */
module.exports = {
  nomeLoja: 'UpSmart',
  /** Coral escuro da marca: passa AA como texto sobre fundo claro e com
   *  texto branco por cima (5.6:1). */
  corPrimaria: '#B8341D',
  /** Âmbar da logo — usado sobre o grafite (rodapé/faixa de aviso) e em
   *  estrelas/contornos. */
  corSecundaria: '#F0A15E',
  whatsappContato: '',
  instagramLink: 'https://www.instagram.com/upsmartvga/',
  emailContato: '',
  /** CEP de origem (remetente) para cotação de frete no Melhor Envio.
   *  Troque pelo CEP real da loja — ou defina LOJA_CEP_ORIGEM no .env, que
   *  tem prioridade sobre este valor sem precisar mexer no código. */
  cepOrigem: '37006-670',
  /** Identificador do cliente para uploads/tags no Cloudinary */
  clienteTag: 'minha-loja',
  /** Chave PIX exibida quando não houver valor salvo no painel */
  chavePix: '',
  pageTitleSuffix: 'Varginha',
  /** Controla os atalhos de tamanho de roupa/calçado (P/M/G/GG) no cadastro
   *  de produto do admin. Deixe true para lojas de roupa/calçado. Para um
   *  cliente novo que não vende isso (pet shop, joia, peça, impressão 3D),
   *  troque para false aqui — o campo de texto livre de variação continua
   *  funcionando normalmente, só os atalhos fixos somem do formulário. */
  usaTamanhosPadrao: false,
  /** Chave de um tom pré-calibrado em TEMAS_HERO (server.js) pra cor do
   *  painel de texto do hero. 'preto' mantém a aparência de hoje (mesmo hex
   *  de --ink). Troque aqui se quiser que um cliente novo já nasça com outro
   *  tom (grafite/marinho/verde/vinho) sem precisar configurar no painel. */
  corPainelHero: 'preto',
  /** Título e texto da seção "Sobre" da vitrine — mesmo padrão de nomeLoja
   *  acima: valor de fábrica genérico, trocado por loja aqui ou sobrescrito
   *  a qualquer momento pelo painel (Configurações → Conteúdo do Site). */
  sobreTitulo: 'Sobre Nós',
  sobreTexto:
    'Somos apaixonados pelo que fazemos. Cada produto passa por um processo de seleção cuidadoso para garantir que chegue até você com a qualidade que você espera. Da descoberta ao pós-compra, nosso compromisso é simples: atendimento humano e experiência completa.',
  /** Paleta UpSmart (grafite + coral/âmbar da logo). bg/bg2/border =
   *  tema "neutro" de TEMAS_FUNDO; gold/gold2 = corPrimaria/corSecundaria.
   *  O resto é fixo pra loja inteira (ver MAPA_DO_PROJETO.md, seção 4). */
  colors: {
    bg: '#F3F3F5',
    bg2: '#E9E9ED',
    ink: '#121119',
    ink2: '#1D1C25',
    mid: '#3F3E48',
    muted: '#5A5866',
    silver: '#B9B7C2',
    border: '#D3D2DA',
    border2: '#C4C3CC',
    white: '#FFFFFF',
    accent: '#B8341D',
    gold: '#B8341D',
    gold2: '#F0A15E',
    red: '#A0391E',
    green: '#2E6B47'
  }
};
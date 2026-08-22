// Temas de fundo pré-calibrados pro painel admin (white-label). De propósito
// NÃO é um campo de hex livre como corPrimaria/corSecundaria: --bg também é
// reaproveitado como cor de TEXTO em dezenas de lugares (rodapé, botões no
// hover, badges) sempre que a superfície por trás é escura — um hex qualquer
// escolhido "só pensando em fundo" pode deixar esse texto ilegível sem
// nenhum aviso. bg/bg2/border sempre mudam juntos porque foram calibrados
// visualmente em conjunto (trocar só o --bg deixa cards e divisórias com
// contraste estranho contra o fundo novo). Espelhado em admin.html — mantenha
// os dois catálogos em sincronia se adicionar/mudar um tema.
const TEMAS_FUNDO = {
  creme: { nome: 'Creme Clássico', bg: '#F0E9DC', bg2: '#E8DCC7', border: '#C9B896' },
  gelo: { nome: 'Branco Gelo', bg: '#E8ECF1', bg2: '#DCE3EB', border: '#B8C4D4' },
  rose: { nome: 'Rosé Suave', bg: '#F3E1DD', bg2: '#EDD3CD', border: '#D1A79C' },
  salvia: { nome: 'Verde Sálvia', bg: '#E5EADC', bg2: '#DAE1CB', border: '#AFBE96' },
  neblina: { nome: 'Azul Névoa', bg: '#E1E8EF', bg2: '#D4DEE9', border: '#A8BDD1' }
};

// Catálogo pré-calibrado pra cor do painel de texto do hero (o bloco
// --hero-panel-bg à esquerda, ver VN_IMPORTS.html) — mesmo princípio do
// TEMAS_FUNDO acima: nunca um hex livre, porque texto branco sobre uma cor
// de marca livre (gold/gold2) já reprova contraste na configuração padrão do
// próprio template (medido: ~2.37:1). Todos os 5 tons são escuros e
// dessaturados de propósito — passam AA com folga (pior caso medido:
// 11.56:1) e não ficam "sujos" sob a barra de benefícios flutuante logo
// abaixo do hero, que tem um véu creme translúcido fixo (rgba, não var(--bg))
// independente do tema de fundo escolhido. Token isolado (--hero-panel-bg,
// não --ink): trocar essa cor não pode mudar rodapé/botões/badges, que
// reaproveitam --ink em ~24 lugares fora do hero.
const TEMAS_HERO = {
  preto: { nome: 'Preto Absoluto', cor: '#111111' },
  grafite: { nome: 'Grafite', cor: '#2B2B2B' },
  marinho: { nome: 'Azul-Marinho', cor: '#16233A' },
  verde: { nome: 'Verde Floresta', cor: '#223326' },
  vinho: { nome: 'Vinho', cor: '#3B1B24' }
};

module.exports = { TEMAS_FUNDO, TEMAS_HERO };

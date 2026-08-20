// Helper compartilhado pelos arquivos de teste — não é um arquivo de teste em
// si (não é passado pro `node --test` no package.json), só evita repetir o
// mesmo preparo de ambiente em cada um.
'use strict';

// server.js só sobe de verdade (process.exit(1)) sem JWT_SECRET — não pode
// faltar mesmo em teste que nunca chega perto de rota autenticada, porque a
// checagem roda uma vez, no carregamento do módulo, antes de qualquer coisa.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'chave-de-teste-nao-usada-em-producao';
}

// NODE_ENV=production faz server.js pular seu próprio app.listen() interno
// (bloco "INICIAR SERVIDOR (LOCAL)") — sem isso, cada arquivo de teste que
// exige server.js abriria um servidor de verdade na porta padrão (3000),
// colidindo com qualquer servidor de desenvolvimento já rodando. Os testes
// de integração que precisam de um servidor de verdade sobem o deles próprio
// via http.createServer(app).listen(0, ...), numa porta livre escolhida pelo
// SO — nunca reaproveitam esse listen interno.
process.env.NODE_ENV = 'production';

const server = require('../server.js');

module.exports = {
  app: server,
  testables: server.testables
};

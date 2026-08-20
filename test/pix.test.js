'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { testables } = require('./setup.js');
const { crc16ccitt, tlv, gerarPixCopiaCola, sanitizarChavePix, removerAcentosEEspeciais } = testables;

// require('../server.js') abre uma conexão Mongo real em segundo plano (não
// precisamos dela pra testar estas funções puras, mas server.js dispara isso
// incondicionalmente ao ser carregado). Sem fechar, o processo do teste nunca
// fica ocioso e trava — mongoose é o mesmo singleton que server.js usou
// internamente (mesmo módulo, mesmo processo), então dá pra desconectar
// daqui mesmo sem server.js exportar isso. Importante: NÃO usar
// process.exit() aqui — isso mata o processo-filho do `node --test` antes
// dele reportar os testes individuais, e todo o arquivo aparece como "1
// teste" só, escondendo falhas reais.
after(async () => {
  await mongoose.disconnect().catch(() => {});
});

test('crc16ccitt: bate com o vetor de teste catalogado do algoritmo CRC-16/CCITT-FALSE', () => {
  // Vetor de referência público do próprio algoritmo (poly 0x1021, init
  // 0xFFFF, sem reflexão): CRC de "123456789" é sempre 0x29B1, não é
  // específico do Pix — é assim que se confirma que a implementação segue a
  // variante certa do CRC-16, e não uma de outra família parecida.
  assert.equal(crc16ccitt('123456789'), 0x29b1);
});

test('crc16ccitt: determinístico e sensível a qualquer mudança no payload', () => {
  const a = crc16ccitt('mesma-string-teste');
  const b = crc16ccitt('mesma-string-teste');
  const c = crc16ccitt('mesma-string-teste!');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('tlv: monta ID + tamanho (2 dígitos) + valor', () => {
  assert.equal(tlv('00', '01'), '000201');
  assert.equal(tlv('26', 'br.gov.bcb.pix'), '2614br.gov.bcb.pix');
});

test('tlv: tamanho de 2 dígitos cobre valores de 10 a 99 caracteres sem quebrar o padding', () => {
  const valor10 = '0123456789';
  assert.equal(tlv('05', valor10), '0510' + valor10);
});

test('gerarPixCopiaCola: payload termina com um CRC que bate ao ser recalculado sobre o próprio payload', () => {
  const payload = gerarPixCopiaCola({
    chave: 'contato@loja.com.br',
    valor: 125.9,
    nome: 'Loja Teste',
    cidade: 'Sao Paulo',
    txid: 'PEDIDO123'
  });
  // Os últimos 4 caracteres são o CRC; tudo antes, incluindo o prefixo fixo
  // '6304' do próprio campo do CRC, é o payload sobre o qual ele foi calculado.
  const crcInformado = payload.slice(-4);
  const semCrc = payload.slice(0, -4);
  const crcRecalculado = crc16ccitt(semCrc).toString(16).toUpperCase().padStart(4, '0');
  assert.equal(crcInformado, crcRecalculado);
});

test('gerarPixCopiaCola: valor sempre com 2 casas decimais, mesmo pra valor inteiro', () => {
  const payload = gerarPixCopiaCola({ chave: 'x@x.com', valor: 200, nome: 'A', cidade: 'B', txid: '1' });
  assert.match(payload, /5406200\.00/); // campo 54 (valor), tamanho 06, "200.00"
});

test('gerarPixCopiaCola: nome do recebedor truncado em 25 caracteres', () => {
  const nomeLongo = 'Nome De Loja Muito Comprido Que Passa Do Limite De Verdade';
  const payload = gerarPixCopiaCola({ chave: 'x@x.com', valor: 10, nome: nomeLongo, cidade: 'SP', txid: '1' });
  // campo 59 = nome; extrai o valor logo depois de "59" + 2 dígitos de tamanho
  const m = payload.match(/59(\d{2})([^]*?)60\d{2}/);
  assert.ok(m, 'campo 59 (nome) não encontrado no payload');
  assert.ok(m[2].length <= 25, `nome ficou com ${m[2].length} caracteres, esperado <= 25`);
});

test('gerarPixCopiaCola: cidade truncada em 15 caracteres', () => {
  const cidadeLonga = 'Uma Cidade Com Nome Bem Mais Longo Que Quinze';
  const payload = gerarPixCopiaCola({ chave: 'x@x.com', valor: 10, nome: 'A', cidade: cidadeLonga, txid: '1' });
  const m = payload.match(/60(\d{2})([^]*?)62\d{2}/);
  assert.ok(m, 'campo 60 (cidade) não encontrado no payload');
  assert.ok(m[2].length <= 15, `cidade ficou com ${m[2].length} caracteres, esperado <= 15`);
});

test('gerarPixCopiaCola: acento é removido e nome/cidade viram maiúsculas (padrão BR Code)', () => {
  const payload = gerarPixCopiaCola({ chave: 'x@x.com', valor: 10, nome: 'João', cidade: 'São Paulo', txid: '1' });
  assert.match(payload, /JOAO/);
  assert.match(payload, /SAO PAULO/);
  assert.doesNotMatch(payload, /[ãÃéÉíÍóÓúÚçÇ]/);
});

test('sanitizarChavePix: remove parênteses e espaço de telefone formatado', () => {
  // NÃO é '35997740622' (sem hífen) — apesar do comentário da função em
  // server.js dizer "Remove parênteses, espaços, traços..." e dar esse
  // resultado como exemplo, o regex real (`[^\w@.+-]`) mantém o hífen na
  // lista de caracteres permitidos, junto de '.', '+' e '@'. Comportamento
  // real, não o documentado — reportado à parte, não corrigido aqui (fora
  // do escopo desta suite).
  assert.equal(sanitizarChavePix('(35) 99774-0622'), '3599774-0622');
});

test('sanitizarChavePix: preserva chave de e-mail intacta (@ e . são válidos no padrão)', () => {
  assert.equal(sanitizarChavePix('contato@minhaloja.com.br'), 'contato@minhaloja.com.br');
});

test('removerAcentosEEspeciais: normaliza acentos e cedilha sem deixar caractere não-ASCII', () => {
  assert.equal(removerAcentosEEspeciais('Codificação Ação Ímã'), 'Codificacao Acao Ima');
});

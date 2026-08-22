const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    customerName: { type: String, default: '' },
    items: {
      type: [
        {
          name: { type: String, required: true },
          qty: { type: Number, required: true, min: 1 },
          price: { type: Number, required: true },
          tamanhoSelecionado: { type: String, default: '' },
          // productId + estoqueDecrementado guardam, por item, se aquela linha
          // de fato debitou estoque real na criação do pedido (produto com
          // controle de estoque ativo) — é o que permite devolver estoque
          // corretamente depois (ver devolverEstoqueDoPedido), sem depender do
          // estado atual do Produto (que pode ter mudado entre a compra e a
          // devolução).
          productId: { type: String, default: '' },
          estoqueDecrementado: { type: Boolean, default: false }
        }
      ],
      default: []
    },
    total: { type: Number, required: true },
    cep: { type: String, default: '' },
    // Endereço de entrega + contato do cliente. Número e complemento nunca
    // vêm do CEP (ViaCEP não devolve isso) — sempre digitados no checkout.
    // Todos obrigatórios e validados em POST /api/orders antes de qualquer
    // decremento de estoque; pedidos criados antes desta mudança não têm
    // esses campos (default '' cobre a leitura, não quebra o admin).
    rua: { type: String, default: '' },
    numero: { type: String, default: '' },
    complemento: { type: String, default: '' },
    bairro: { type: String, default: '' },
    cidade: { type: String, default: '' },
    estado: { type: String, default: '' },
    email: { type: String, default: '' },
    telefone: { type: String, default: '' },
    cpf: { type: String, default: '' },
    // Frete escolhido no checkout — valor sempre revalidado no servidor
    // (ver /api/orders), nunca aceito cru do que o cliente mandou.
    frete: { type: Number, default: 0 },
    freteNome: { type: String, default: '' },
    freteEmpresa: { type: String, default: '' },
    status: { type: String, default: 'Pendente' },
    // ID do pagamento no Mercado Pago, salvo quando o QR Pix é gerado.
    // Usado pelo webhook (/api/pix/webhook) para confirmar o pagamento e atualizar o status.
    mpPaymentId: { type: String, default: '' },
    // Trava de idempotência: true assim que o estoque deste pedido já foi
    // devolvido (abandono via cron ou cancelamento manual pelo admin). Nunca
    // devolvido duas vezes — ver devolverEstoqueDoPedido.
    estoqueRevertido: { type: Boolean, default: false },
    // null = ainda tem CPF/e-mail/telefone/endereço reais. Data = quando os
    // dados pessoais deste pedido foram removidos (retenção por idade,
    // abandono nunca pago, ou pedido de exclusão do titular — ver
    // camposAnonimizacaoPedido). Também serve de trava de idempotência: uma
    // vez preenchido, as rotinas de expurgo pulam este pedido.
    anonimizadoEm: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Order || mongoose.model('Order', OrderSchema);

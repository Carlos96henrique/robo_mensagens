const LIMITE_POR_LOJA = 10;
const TOTAL_ITENS_LOTE = LIMITE_POR_LOJA * 2;

function contarItensPorOrigem(itens, origem) {
    return itens.filter(item => item?.origem === origem).length;
}

function validarLote(itens) {
    if (!Array.isArray(itens)) {
        throw new Error('A lista do lote é inválida.');
    }

    const quantidadeShopee = contarItensPorOrigem(itens, 'shopee');
    const quantidadeMercadoLivre = contarItensPorOrigem(itens, 'mercado-livre');

    if (
        itens.length !== TOTAL_ITENS_LOTE
        || quantidadeShopee !== LIMITE_POR_LOJA
        || quantidadeMercadoLivre !== LIMITE_POR_LOJA
    ) {
        throw new Error(
            `Lote incompleto: ${quantidadeShopee}/${LIMITE_POR_LOJA} da Shopee e `
            + `${quantidadeMercadoLivre}/${LIMITE_POR_LOJA} do Mercado Livre; `
            + `o total deve ser exatamente ${TOTAL_ITENS_LOTE} itens.`
        );
    }
}

module.exports = {
    LIMITE_POR_LOJA,
    TOTAL_ITENS_LOTE,
    contarItensPorOrigem,
    validarLote
};

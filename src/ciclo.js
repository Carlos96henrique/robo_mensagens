const disparador = require('./disparador');
const coletorMercadoLivre = require('./coletor');
const coletorShopee = require('./coletor-shopee');
const gerenciador = require('./gerenciador-mensagens');
const logger = require('./gerenciador-log');
const Embaralhador = require('./embaralhador');
const { LIMITE_POR_LOJA, validarLote } = require('./lote');

const INTERVALO_APOS_ERRO_MS = 60000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executarCiclo(listaMensagens, canal) {
    const client = canal?.client ?? await gerenciador.inicializaGerenciador();
    try {
        const canalVerificado = canal ?? await gerenciador.verificarDisponibilidade(client);
        await coletorShopee.automatizarPagina(listaMensagens, { limite: LIMITE_POR_LOJA });
        await coletorMercadoLivre.automatizarPagina(listaMensagens, { limite: LIMITE_POR_LOJA });

        validarLote(listaMensagens);
        const itensEmbaralhados = Embaralhador.embaralhar(listaMensagens);
        listaMensagens.splice(0, listaMensagens.length, ...itensEmbaralhados);
        await disparador.executar(listaMensagens, canalVerificado);
    } finally {
        if (!canal) await gerenciador.encerrarGerenciador(client);
    }
}

async function iniciarCicloContinuo(listaMensagens, {
    executar = executarCiclo,
    aguardar = delay
} = {}) {
    let client;
    let canal;
    try {
        while (true) {
            try {
                if (!canal) {
                    client ??= await gerenciador.inicializaGerenciador();
                    canal = await gerenciador.verificarDisponibilidade(client);
                }
                await executar(listaMensagens, canal);
            } catch (error) {
                if (!canal && client) {
                    await gerenciador.encerrarGerenciador(client);
                    client = undefined;
                } else if (error.code === disparador.FALHA_ENVIO_WHATSAPP) {
                    canal = undefined;
                    logger.info('WhatsApp será verificado novamente após a falha de envio.');
                }
                logger.error(`Erro no ciclo do coletor/disparador: ${error.message}, stack: ${error.stack}`);
                logger.info(`Nova tentativa em ${INTERVALO_APOS_ERRO_MS / 1000} segundos.`);
                await aguardar(INTERVALO_APOS_ERRO_MS);
            }
        }
    } finally {
        if (client) await gerenciador.encerrarGerenciador(client);
    }
}

module.exports = { executarCiclo, iniciarCicloContinuo };

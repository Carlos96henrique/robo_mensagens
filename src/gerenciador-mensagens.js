const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('./gerenciador-log');

const TIMEOUT_INICIALIZACAO_MS = 120000;
const TIMEOUT_VERIFICACAO_MS = 30000;
const TRECHO_NOME_DESTINO = 'Grupo de ofertas';

async function encerrarGerenciador(client) {
    try {
        await client.destroy();
    } catch (error) {
        logger.error(`Erro ao encerrar cliente do WhatsApp: ${error.message}, stack: ${error.stack}`);
    }
}

async function inicializaGerenciador({ criarCliente = () => new Client({
    authStrategy: new LocalAuth()
}), timeoutMs = TIMEOUT_INICIALIZACAO_MS } = {}) {
    let client;
    try {
        client = criarCliente();
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => falhar(new Error(
                `Inicialização do WhatsApp excedeu ${timeoutMs / 1000} segundos.`
            )), timeoutMs);
            const limpar = () => {
                clearTimeout(timeout);
                client.removeListener('ready', pronto);
                client.removeListener('auth_failure', falhaAutenticacao);
                client.removeListener('disconnected', desconectado);
            };
            const pronto = () => { limpar(); resolve(); };
            const falhar = error => { limpar(); reject(error); };
            const falhaAutenticacao = message => falhar(new Error(`Falha de autenticação: ${message}`));
            const desconectado = reason => falhar(new Error(`WhatsApp desconectado na inicialização: ${reason}`));

            client.on('qr', qr => {
                qrcode.generate(qr, { small: true });
                logger.info('QR Code recebido, escaneie para conectar!');
            });

            client.once('ready', pronto);
            client.once('auth_failure', falhaAutenticacao);
            client.once('disconnected', desconectado);

            // Estes eventos também precisam ser registrados depois de o cliente ficar pronto.
            client.on('auth_failure', message => logger.error(`Falha de autenticação do WhatsApp: ${message}`));
            client.on('disconnected', reason => logger.error(`WhatsApp desconectado: ${reason}`));

            try {
                Promise.resolve(client.initialize()).catch(falhar);
            } catch (error) {
                falhar(error);
            }
        });
        logger.info('Cliente está pronto!');
        return client;
    } catch (error) {
        logger.error(`Erro ao inicializar WhatsApp: ${error.message}, stack: ${error.stack}`);
        if (client) await encerrarGerenciador(client);
        throw error;
    }
}

async function verificarDisponibilidade(client, { timeoutMs = TIMEOUT_VERIFICACAO_MS } = {}) {
    let timeout;
    let aoAck;
    let aoDesconectar;
    let encerrada = false;

    try {
        logger.info('Verificando conexão, destino e envio do WhatsApp antes das coletas.');
        return await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(
                `Verificação do WhatsApp excedeu ${timeoutMs / 1000} segundos sem confirmação de envio.`
            )), timeoutMs);
            aoDesconectar = reason => reject(new Error(`WhatsApp desconectado durante a verificação: ${reason}`));
            client.on('disconnected', aoDesconectar);

            (async () => {
                const estado = await client.getState();
                if (encerrada) return;
                if (estado !== 'CONNECTED') {
                    throw new Error(`WhatsApp não está conectado (estado: ${estado}).`);
                }

                const grupoId = await buscarGrupoPorNome(client, TRECHO_NOME_DESTINO);
                if (encerrada) return;
                if (!grupoId) throw new Error('Não foi possível encontrar o grupo de destino. Verifique o nome.');

                const destinoVerificacao = client.info?.wid?._serialized;
                if (!destinoVerificacao) throw new Error('Conta conectada indisponível para verificar o envio do WhatsApp.');

                let mensagemId;
                const acks = new Map();
                const confirmar = ack => {
                    if (ack >= 1) {
                        logger.info('WhatsApp ativo e envio confirmado pelo servidor. Coletas liberadas.');
                        resolve({ client, grupoId });
                    } else if (ack === -1) {
                        reject(new Error('WhatsApp recusou a mensagem de verificação.'));
                    }
                };
                // O ACK pode chegar antes de sendMessage retornar o objeto da mensagem.
                aoAck = (mensagem, ack) => {
                    const id = mensagem.id?._serialized;
                    if (id) acks.set(id, ack);
                    if (mensagemId && id === mensagemId) confirmar(ack);
                };
                client.on('message_ack', aoAck);

                const mensagem = await client.sendMessage(
                    destinoVerificacao,
                    'Verificação automática do robô: envio do WhatsApp ativo.',
                    { waitUntilMsgSent: true }
                );
                if (encerrada) return;
                mensagemId = mensagem?.id?._serialized;
                if (!mensagemId) throw new Error('WhatsApp não retornou a mensagem de verificação.');
                confirmar(acks.get(mensagemId) ?? mensagem.ack);
            })().catch(reject);
        });
    } catch (error) {
        logger.error(`Erro na verificação do WhatsApp antes das coletas: ${error.message}, stack: ${error.stack}`);
        throw error;
    } finally {
        encerrada = true;
        clearTimeout(timeout);
        if (aoAck) client?.removeListener('message_ack', aoAck);
        if (aoDesconectar) client?.removeListener('disconnected', aoDesconectar);
    }
}

async function buscarGrupoPorNome(client, trechoNome) {
    if (!client?.pupPage) {
        throw new Error('Cliente de mensagens não inicializado.');
    }

    if (typeof trechoNome !== 'string' || !trechoNome.trim()) {
        throw new Error('Critério de busca do destino inválido.');
    }

    return client.pupPage.evaluate((trecho) => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        const grupo = chats.find(chat => {
            const idSerializado = chat.id?._serialized
                ?? chat.id?.$1
                ?? chat.id?.toString?.();
            const nome = chat.name ?? chat.formattedTitle ?? '';
            const ehGrupo = Boolean(chat.groupMetadata)
                || chat.id?.server === 'g.us'
                || idSerializado?.endsWith('@g.us');

            return ehGrupo && nome.includes(trecho);
        });

        if (!grupo) {
            return null;
        }

        return grupo.id?._serialized
            ?? grupo.id?.$1
            ?? grupo.id?.toString?.()
            ?? null;
    }, trechoNome.trim());
}

module.exports = {
    inicializaGerenciador,
    verificarDisponibilidade,
    encerrarGerenciador,
    buscarGrupoPorNome
};

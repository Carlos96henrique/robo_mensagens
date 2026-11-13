const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('./gerenciador-log');

async function inicializaGerenciador() {
    return new Promise((resolve, reject) => {
        const client = new Client({
            authStrategy: new LocalAuth()
        });

        client.on('qr', qr => {
            qrcode.generate(qr, { small: true });
            logger.info('QR Code recebido, escaneie para conectar!');
        });

        client.on('ready', () => {
            logger.info('Cliente está pronto!');
            resolve(client);
        });

        client.on('auth_failure', (message) => {
            logger.error(`Falha de autenticação: ${message}`);
            reject(new Error(`Falha de autenticação: ${message}`));
        });

        client.on('disconnected', (reason) => {
            logger.warn(`Cliente desconectado: ${reason}`);
        });

        try {
            client.initialize();
        } catch (error) {
            logger.error(`Erro ao inicializar cliente: ${error.message}, stack: ${error.stack}`);
            reject(error);
        }
    });
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
    buscarGrupoPorNome
};

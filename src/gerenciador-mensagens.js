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

module.exports = {
    inicializaGerenciador
};


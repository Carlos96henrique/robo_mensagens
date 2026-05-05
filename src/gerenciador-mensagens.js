const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

async function inicializaGerenciador() {
    return new Promise((resolve, reject) => {
        const client = new Client({
            authStrategy: new LocalAuth()
        });

        client.on('qr', qr => {
            qrcode.generate(qr, { small: true });
            console.log('QR Code recebido, escaneie para conectar!');
        });

        client.on('ready', () => {
            console.log('Cliente está pronto!');
            resolve(client);
        });

        client.on('auth_failure', (message) => {
            reject(new Error(`Falha de autenticação: ${message}`));
        });

        client.on('disconnected', (reason) => {
            console.log('Cliente desconectado:', reason);
        });

        try {
            client.initialize();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = {
    inicializaGerenciador
};



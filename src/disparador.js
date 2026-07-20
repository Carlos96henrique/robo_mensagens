const gerenciador = require('./gerenciador-mensagens');
const logger = require('./gerenciador-log');

const TAMANHO_MINIMO_FILA = 10;
const INTERVALO_VERIFICACAO_MS = 5000;

function getRandomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatarTextoMultilinha(texto) {
    if (typeof texto !== 'string') {
        return texto;
    }

    const textoFormatado = texto
        .split(/\r?\n+/)
        .map(parte => parte.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+,/g, ',')
        .replace(/,\s+/g, ',')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return textoFormatado.replace(/(\d)\s+((?:\d+%)(?:\s*[A-Za-z]+)?)/g, '$1 - $2');
}

function armazenarNumeros(quantidade) {
    const numeros = [];
    for (let i = 0; i < quantidade; i += 1) {
        numeros.push(getRandomIntInclusive(1, 10));
    }
    logger.info(`Números sorteados: ${numeros.join(', ')}`);
    return numeros;
}

async function removerMensagens(mensagens) {
    if(mensagens.length > 0) {
        const msg = mensagens.pop();
        logger.info(`Mensagem removida: ${JSON.stringify(msg)}`);
        return await estruturarMensagem(msg);
    }
    return;
}

async function aguardarFilaMinima(mensagens) {
    if (mensagens.length !== 0) {
        return;
    }

    logger.info(`Fila com 0 item(ns). Aguardando até atingir ${TAMANHO_MINIMO_FILA} ou mais...`);
    while (mensagens.length < TAMANHO_MINIMO_FILA) {
        await delay(INTERVALO_VERIFICACAO_MS);
        logger.info(`Fila atual: ${mensagens.length}. Ainda aguardando mínimo de ${TAMANHO_MINIMO_FILA}.`);
    }
    logger.info(`Fila atingiu ${mensagens.length} item(ns). Iniciando disparos.`);
}

async function executar(mensagens) {
    if (!Array.isArray(mensagens)) {
        throw new Error('A lista de mensagens é inválida.');
    }

    await aguardarFilaMinima(mensagens);

    const filaMensagens = mensagens;
    const numeros = armazenarNumeros(filaMensagens.length);
    const client = await gerenciador.inicializaGerenciador();

    try {
        const chats = await client.getChats();
        const grupo = chats.find(chat => chat.isGroup && chat.name.includes('Teste'));

        if (!grupo) {
            throw new Error('Não foi possível encontrar o grupo de destino. Verifique o nome.');
        }

        logger.info(`Grupo encontrado: ${grupo.name}`);

        const sendPromises = numeros.map((minutos) => {
            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        const mensagem = await removerMensagens(filaMensagens);
                        logger.info(`Mensagem estruturada: ${mensagem}`);
                        if (!mensagem) {
                            throw new Error(`Mensagem não encontrada`);
                        }
                        await grupo.sendMessage(mensagem, {
                            linkPreview: true,
                            waitUntilMsgSent: true
                        });
                        logger.info(`Mensagem enviada após ${minutos} minutos: ${mensagem}`);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }, (minutos * 60 * 1000));
            });
        });

        await Promise.all(sendPromises);
        logger.info('Todos os disparos foram concluídos.');
        logger.info(`Fila após disparo: ${filaMensagens.length} item(ns).`);
    } catch (error) {
        logger.error(`Erro ao executar o disparador: ${error.message}, stack: ${error.stack}`);
        throw error;
    } finally {
        await client.destroy();
    }
}

async function estruturarMensagem(anuncio) {
    const titulo = formatarTextoMultilinha(anuncio.titulo);
    const preco = formatarTextoMultilinha(anuncio.preco);
    const link = formatarTextoMultilinha(anuncio.link);

    return `Confira este produto incrível: ${titulo}\n\nPreço: ${preco}!\n\nLink: ${link}`;
}

module.exports = {
    executar
};

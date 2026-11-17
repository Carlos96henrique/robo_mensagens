const { MessageMedia } = require('whatsapp-web.js');

const gerenciador = require('./gerenciador-mensagens');
const logger = require('./gerenciador-log');
const { validarLote } = require('./lote');

const TIMEOUT_IMAGEM_MS = 20000;
const TAMANHO_MAXIMO_IMAGEM_BYTES = 10 * 1024 * 1024;
const MAX_TENTATIVAS_IMAGEM = 3;
const INTERVALO_TENTATIVAS_IMAGEM_MS = 2000;

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

function removerMensagemEnviada(mensagens, anuncio) {
    const indice = mensagens.lastIndexOf(anuncio);

    if (indice !== -1) {
        mensagens.splice(indice, 1);
    }
}

function identificarMimeType(buffer, contentType) {
    const mimeInformado = contentType?.split(';')[0]?.trim().toLowerCase();
    if (mimeInformado?.startsWith('image/')) {
        return mimeInformado;
    }

    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return 'image/jpeg';
    }
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
        return 'image/gif';
    }

    return null;
}

function obterExtensaoImagem(mimeType) {
    const extensoes = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif'
    };

    return extensoes[mimeType] || 'img';
}

async function baixarImagem(imagemUrl, fetchImpl = fetch) {
    if (typeof imagemUrl !== 'string' || !/^https?:\/\//i.test(imagemUrl)) {
        throw new Error('Produto sem URL de imagem válida.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_IMAGEM_MS);

    try {
        const response = await fetchImpl(imagemUrl, {
            headers: {
                Accept: 'image/*',
                'User-Agent': 'Mozilla/5.0'
            },
            redirect: 'follow',
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Servidor da imagem respondeu com HTTP ${response.status}.`);
        }

        const tamanhoInformado = Number(response.headers.get('content-length'));
        if (Number.isFinite(tamanhoInformado) && tamanhoInformado > TAMANHO_MAXIMO_IMAGEM_BYTES) {
            throw new Error('Imagem excede o limite permitido de 10 MB.');
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
            throw new Error('Servidor retornou uma imagem vazia.');
        }
        if (buffer.length > TAMANHO_MAXIMO_IMAGEM_BYTES) {
            throw new Error('Imagem excede o limite permitido de 10 MB.');
        }

        const mimeType = identificarMimeType(buffer, response.headers.get('content-type'));
        if (!mimeType) {
            throw new Error('Conteúdo baixado não é uma imagem reconhecida.');
        }

        const extensao = obterExtensaoImagem(mimeType);
        return new MessageMedia(
            mimeType,
            buffer.toString('base64'),
            `produto.${extensao}`,
            buffer.length
        );
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Download da imagem excedeu ${TIMEOUT_IMAGEM_MS / 1000} segundos.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function baixarImagemComRetentativa(imagemUrl, baixarImagemImpl = baixarImagem) {
    let ultimoErro;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_IMAGEM; tentativa += 1) {
        try {
            return await baixarImagemImpl(imagemUrl);
        } catch (error) {
            ultimoErro = error;
            logger.warn(
                `Falha ao carregar imagem na tentativa ${tentativa}/${MAX_TENTATIVAS_IMAGEM}: ${error.message}`
            );

            if (tentativa < MAX_TENTATIVAS_IMAGEM) {
                await delay(INTERVALO_TENTATIVAS_IMAGEM_MS);
            }
        }
    }

    throw new Error(`Não foi possível carregar a imagem do produto: ${ultimoErro.message}`);
}

function validarFilaPronta(mensagens) {
    validarLote(mensagens);
}

async function executar(mensagens, canal) {
    if (!Array.isArray(mensagens)) {
        throw new Error('A lista de mensagens é inválida.');
    }

    validarFilaPronta(mensagens);

    const filaMensagens = mensagens;
    const numeros = armazenarNumeros(filaMensagens.length);
    const client = canal?.client ?? await gerenciador.inicializaGerenciador();

    try {
        const { grupoId } = canal ?? await gerenciador.verificarDisponibilidade(client);

        logger.info('Destino de mensagens encontrado.');

        const anunciosAgendados = [...filaMensagens];

        const sendPromises = numeros.map((minutos, indice) => {
            const anuncio = anunciosAgendados[indice];

            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        if (!anuncio) {
                            throw new Error(`Mensagem não encontrada`);
                        }

                        const mensagem = await estruturarMensagem(anuncio);
                        const imagem = await baixarImagemComRetentativa(anuncio.imagemUrl);
                        await client.sendMessage(grupoId, imagem, {
                            caption: mensagem,
                            waitUntilMsgSent: true
                        });
                        removerMensagemEnviada(filaMensagens, anuncio);
                        logger.info(`Mensagem enviada após ${minutos} minuto(s).`);
                        resolve();
                    } catch (error) {
                        logger.error(`Erro ao enviar mensagem pelo WhatsApp: ${error.message}, stack: ${error.stack}`);
                        reject(error);
                    }
                }, (minutos * 60 * 1000));
            });
        });

        const resultados = await Promise.allSettled(sendPromises);
        const falhas = resultados.filter(resultado => resultado.status === 'rejected');

        if (falhas.length > 0) {
            throw new Error(`${falhas.length} de ${resultados.length} envio(s) falharam.`);
        }

        logger.info('Todos os disparos foram concluídos com sucesso.');
        logger.info(`Fila após disparo: ${filaMensagens.length} item(ns).`);
    } catch (error) {
        logger.error(`Erro ao executar o disparador: ${error.message}, stack: ${error.stack}`);
        throw error;
    } finally {
        if (!canal) await gerenciador.encerrarGerenciador(client);
    }
}

async function estruturarMensagem(anuncio) {
    const titulo = formatarTextoMultilinha(anuncio.titulo);
    const preco = formatarTextoMultilinha(anuncio.preco);
    const link = formatarTextoMultilinha(anuncio.link);
    const categoria = formatarTextoMultilinha(anuncio.categoria) || 'Categoria não informada';

    return `Confira este produto incrível: ${titulo}\n\nCategoria: ${categoria}\n\nPreço: ${preco}!\n\nLink: ${link}`;
}

module.exports = {
    baixarImagem,
    baixarImagemComRetentativa,
    executar,
    estruturarMensagem,
    identificarMimeType,
    validarFilaPronta
};

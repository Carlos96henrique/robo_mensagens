const gerenciador = require('./gerenciador-mensagens');

const mensagens = [
    '10 - Última mensagem do teste!',
    '9 - Preparando para finalizar o teste!',
    '8 - Ignorem, ainda é um robô!',
    '7 - Essa mensagem é uma pergunta?',
    '6 - Na hora de testar o código eu havia me esquecido dessa mensagem e deu undefined! kkkkk',
    '5 - O whassapp ironicamente não gosta de robôs!',
    '4 - Preenchendo texto!',
    '3 - O teste foi um sucesso!',
    '2- Teste de log',
    '1 - Primeira mensagem!'
];

function getRandomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function armazenarNumeros() {
    const numeros = [];
    for (let i = 0; i < 10; i += 1) {
        numeros.push(getRandomIntInclusive(1, 10));
    }
    console.log('Números sorteados:', numeros);
    return numeros;
}

async function removerMensagens() {
    if(mensagens.length > 0) {
        return mensagens.pop();
    }
    return;
}

async function executar() {
    const numeros = armazenarNumeros();
    const client = await gerenciador.inicializaGerenciador();

    try {
        const chats = await client.getChats();
        const grupoUm = chats.find(chat => chat.isGroup && chat.name.includes('Teste'));
        const grupoDois = chats.find(chat => chat.isGroup && chat.name.includes('Penumbra'));

        console.log('Grupos encontrados:', grupoUm.name, grupoDois.name);

        if (!grupoUm || !grupoDois) {
            throw new Error('Não foi possível encontrar os grupos de destino. Verifique os nomes.');
        }

        const sendPromises = numeros.map((minutos) => {
            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        const mensagem = await removerMensagens();
                        if (!mensagem) {
                            throw new Error(`Mensagem não encontrada`);
                        }
                        await grupoUm.sendMessage(mensagem);
                        await grupoDois.sendMessage(mensagem);
                        console.log(`Mensagem enviada após ${minutos} minutos: ${mensagem}`);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }, (minutos * 60 * 1000));
            });
        });

        await Promise.all(sendPromises);
        console.log('Todos os disparos foram concluídos.');
    } catch (error) {
        console.error('Erro ao executar o disparador:', error);
        throw error;
    } finally {
        await client.destroy();
    }
}

module.exports = {
    executar
};
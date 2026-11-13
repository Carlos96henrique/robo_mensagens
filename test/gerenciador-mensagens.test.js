const test = require('node:test');
const assert = require('node:assert/strict');

const gerenciador = require('../src/gerenciador-mensagens');

function criarClienteComChats(chats) {
    return {
        pupPage: {
            async evaluate(funcao, trecho) {
                global.window = {
                    require: () => ({
                        Chat: {
                            getModelsArray: () => chats
                        }
                    })
                };

                try {
                    return funcao(trecho);
                } finally {
                    delete global.window;
                }
            }
        }
    };
}

test('localiza grupo usando o identificador legado _serialized', async () => {
    const cliente = criarClienteComChats([
        {
            id: { _serialized: 'grupo-ficticio@g.us', server: 'g.us' },
            name: 'Ofertas fictícias',
            groupMetadata: {}
        }
    ]);

    const id = await gerenciador.buscarGrupoPorNome(cliente, 'Ofertas');

    assert.equal(id, 'grupo-ficticio@g.us');
});

test('localiza grupo usando o novo fallback $1', async () => {
    const cliente = criarClienteComChats([
        {
            id: { $1: 'grupo-novo@g.us', server: 'g.us' },
            formattedTitle: 'Promoções fictícias',
            groupMetadata: {}
        }
    ]);

    const id = await gerenciador.buscarGrupoPorNome(cliente, 'Promoções');

    assert.equal(id, 'grupo-novo@g.us');
});

test('ignora conversa individual com o mesmo trecho de nome', async () => {
    const cliente = criarClienteComChats([
        {
            id: { _serialized: 'contato-ficticio@c.us', server: 'c.us' },
            name: 'Ofertas fictícias'
        }
    ]);

    const id = await gerenciador.buscarGrupoPorNome(cliente, 'Ofertas');

    assert.equal(id, null);
});

test('rejeita cliente ou critério inválido', async () => {
    await assert.rejects(
        gerenciador.buscarGrupoPorNome(null, 'Ofertas'),
        /não inicializado/
    );

    const cliente = criarClienteComChats([]);
    await assert.rejects(
        gerenciador.buscarGrupoPorNome(cliente, '   '),
        /inválido/
    );
});

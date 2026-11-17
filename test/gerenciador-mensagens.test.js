const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const gerenciador = require('../src/gerenciador-mensagens');
const logger = require('../src/gerenciador-log');

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

function criarClienteAtivo() {
    return Object.assign(new EventEmitter(), {
        info: { wid: { _serialized: 'conta-ficticia@c.us' } },
        pupPage: { async evaluate() { return 'grupo-ficticio@g.us'; } },
        async getState() { return 'CONNECTED'; },
        async sendMessage() { return { id: { _serialized: 'verificacao' }, ack: 1 }; },
        async destroy() {}
    });
}

test('verifica conexão, destino e envio confirmado para a própria conta', async t => {
    const client = criarClienteAtivo();
    const enviar = t.mock.method(client, 'sendMessage', async (destino, texto, opcoes) => {
        assert.equal(destino, client.info.wid._serialized);
        assert.match(texto, /Verificação automática/);
        assert.equal(opcoes.waitUntilMsgSent, true);
        return { id: { _serialized: 'verificacao' }, ack: 1 };
    });
    const resultado = await gerenciador.verificarDisponibilidade(client);
    assert.deepEqual(resultado, { client, grupoId: 'grupo-ficticio@g.us' });
    assert.equal(enviar.mock.callCount(), 1);
    assert.equal(client.listenerCount('message_ack'), 0);
    assert.equal(client.listenerCount('disconnected'), 0);
});

for (const antecipado of [true, false]) {
    test(`aguarda ACK do servidor ${antecipado ? 'recebido antes do retorno' : 'recebido depois do retorno'}`, async () => {
        const client = criarClienteAtivo();
        client.sendMessage = async () => {
            const mensagem = { id: { _serialized: 'verificacao' }, ack: 0 };
            if (antecipado) client.emit('message_ack', mensagem, 1);
            else setImmediate(() => client.emit('message_ack', mensagem, 1));
            return mensagem;
        };
        await gerenciador.verificarDisponibilidade(client);
        assert.equal(client.listenerCount('message_ack'), 0);
    });
}

test('não aceita ACK de outra mensagem como confirmação', async t => {
    const client = criarClienteAtivo();
    client.sendMessage = async () => {
        client.emit('message_ack', { id: { _serialized: 'outra' } }, 1);
        return { id: { _serialized: 'verificacao' }, ack: 0 };
    };
    const log = t.mock.method(logger, 'error', () => {});
    await assert.rejects(gerenciador.verificarDisponibilidade(client, { timeoutMs: 10 }), /sem confirmação/);
    assert.match(log.mock.calls[0].arguments[0], /Erro na verificação.*stack:/);
    assert.equal(client.listenerCount('message_ack'), 0);
});

test('interrompe e registra falhas de estado, consulta, destino, conta e envio', async t => {
    const cenarios = [
        [client => { client.getState = async () => 'UNPAIRED'; }, /não está conectado/],
        [client => { client.getState = async () => { throw new Error('consulta indisponível'); }; }, /consulta indisponível/],
        [client => { client.pupPage.evaluate = async () => null; }, /grupo de destino/],
        [client => { client.pupPage.evaluate = async () => { throw new Error('consulta de destino falhou'); }; }, /consulta de destino falhou/],
        [client => { client.info = {}; }, /Conta conectada indisponível/],
        [client => { client.sendMessage = async () => { throw new Error('envio recusado'); }; }, /envio recusado/],
        [client => { client.sendMessage = async () => undefined; }, /não retornou/],
        [client => { client.sendMessage = async () => ({ id: { _serialized: 'verificacao' }, ack: -1 }); }, /recusou/],
        [client => { client.getState = async () => { client.emit('disconnected', 'rede'); return 'CONNECTED'; }; }, /desconectado/]
    ];
    const log = t.mock.method(logger, 'error', () => {});
    for (const [preparar, erro] of cenarios) {
        const client = criarClienteAtivo();
        preparar(client);
        await assert.rejects(gerenciador.verificarDisponibilidade(client), erro);
        assert.equal(client.listenerCount('message_ack'), 0);
        assert.equal(client.listenerCount('disconnected'), 0);
    }
    assert.equal(log.mock.callCount(), cenarios.length);
});

test('consulta travada expira sem enviar mensagem ao terminar atrasada', async () => {
    const client = criarClienteAtivo();
    let liberar;
    let envios = 0;
    client.getState = () => new Promise(resolve => { liberar = resolve; });
    client.sendMessage = async () => { envios += 1; };
    await assert.rejects(gerenciador.verificarDisponibilidade(client, { timeoutMs: 10 }), /excedeu/);
    liberar('CONNECTED');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(envios, 0);
    assert.equal(client.listenerCount('message_ack'), 0);
});

test('inicialização aguarda ready e captura rejeição assíncrona, autenticação, desconexão e timeout', async t => {
    t.mock.method(logger, 'error', () => {});
    const pronto = criarClienteAtivo();
    pronto.initialize = async () => { pronto.emit('ready'); };
    assert.equal(await gerenciador.inicializaGerenciador({ criarCliente: () => pronto }), pronto);

    const cenarios = [
        [() => { throw new Error('erro síncrono'); }, /erro síncrono/],
        [async () => { throw new Error('erro assíncrono'); }, /erro assíncrono/],
        [client => client.emit('auth_failure', 'sessão inválida'), /Falha de autenticação/],
        [client => client.emit('disconnected', 'rede'), /desconectado/],
        [() => new Promise(() => {}), /excedeu/]
    ];
    for (const [inicializar, erro] of cenarios) {
        const client = criarClienteAtivo();
        client.initialize = () => inicializar(client);
        const destruir = t.mock.method(client, 'destroy', async () => {});
        await assert.rejects(gerenciador.inicializaGerenciador({
            criarCliente: () => client, timeoutMs: 10
        }), erro);
        assert.equal(destruir.mock.callCount(), 1);
        assert.equal(client.listenerCount('ready'), 0);
    }
});

test('registra falha ao encerrar o WhatsApp', async t => {
    const client = criarClienteAtivo();
    client.destroy = async () => { throw new Error('falha de fechamento'); };
    const log = t.mock.method(logger, 'error', () => {});
    await gerenciador.encerrarGerenciador(client);
    assert.match(log.mock.calls[0].arguments[0], /Erro ao encerrar.*falha de fechamento/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { executarCiclo, iniciarCicloContinuo } = require('../src/ciclo');
const gerenciador = require('../src/gerenciador-mensagens');
const shopee = require('../src/coletor-shopee');
const mercadoLivre = require('../src/coletor');
const disparador = require('../src/disparador');
const logger = require('../src/gerenciador-log');

function prepararCiclo(t, { erroInicializacao, erroVerificacao, erroColeta } = {}) {
    const eventos = [];
    const client = {};
    const canal = { client, grupoId: 'grupo-ficticio@g.us' };
    t.mock.method(gerenciador, 'inicializaGerenciador', async () => {
        eventos.push('inicializar');
        if (erroInicializacao) throw erroInicializacao;
        return client;
    });
    t.mock.method(gerenciador, 'verificarDisponibilidade', async recebido => {
        assert.equal(recebido, client);
        eventos.push('verificar');
        if (erroVerificacao) throw erroVerificacao;
        return canal;
    });
    for (const [coletor, origem] of [[shopee, 'shopee'], [mercadoLivre, 'mercado-livre']]) {
        t.mock.method(coletor, 'automatizarPagina', async (fila, { limite }) => {
            eventos.push(origem);
            if (erroColeta) throw erroColeta;
            for (let i = 0; i < limite; i += 1) fila.push({ origem });
        });
    }
    t.mock.method(disparador, 'executar', async (fila, recebido) => {
        assert.equal(recebido, canal);
        assert.equal(fila.length, 20);
        eventos.push('enviar');
        fila.splice(0);
    });
    t.mock.method(gerenciador, 'encerrarGerenciador', async recebido => {
        assert.equal(recebido, client);
        eventos.push('encerrar');
    });
    return eventos;
}

test('só coleta após confirmar WhatsApp e reutiliza a mesma sessão até o envio', async t => {
    const eventos = prepararCiclo(t);
    const fila = [];
    await executarCiclo(fila);
    assert.deepEqual(eventos, ['inicializar', 'verificar', 'shopee', 'mercado-livre', 'enviar', 'encerrar']);
    assert.deepEqual(fila, []);
});

for (const etapa of ['Inicializacao', 'Verificacao', 'Coleta']) {
    test(`falha na etapa ${etapa} bloqueia o restante do ciclo e preserva a fila`, async t => {
        const erro = new Error(`Falha ${etapa}`);
        const eventos = prepararCiclo(t, { [`erro${etapa}`]: erro });
        const fila = [{ origem: 'shopee', titulo: 'Pendente' }];
        const anterior = [...fila];
        await assert.rejects(executarCiclo(fila), erro);
        assert.deepEqual(fila, anterior);
        const esperados = etapa === 'Inicializacao' ? ['inicializar']
            : etapa === 'Verificacao' ? ['inicializar', 'verificar', 'encerrar']
                : ['inicializar', 'verificar', 'shopee', 'encerrar'];
        assert.deepEqual(eventos, esperados);
    });
}

test('registra o erro e repete a verificação antes de coletar na tentativa seguinte', async t => {
    const fila = [];
    const eventos = prepararCiclo(t, { erroVerificacao: new Error('WhatsApp indisponível') });
    const log = t.mock.method(logger, 'error', () => {});
    let tentativas = 0;
    const fim = new Error('Fim do teste');
    await assert.rejects(iniciarCicloContinuo(fila, {
        executar: executarCiclo,
        async aguardar(ms) {
            assert.equal(ms, 60000);
            tentativas += 1;
            if (tentativas === 2) throw fim;
        }
    }), fim);
    assert.deepEqual(eventos, ['inicializar', 'verificar', 'encerrar', 'inicializar', 'verificar', 'encerrar']);
    assert.equal(log.mock.callCount(), 2);
    assert.match(log.mock.calls[0].arguments[0], /WhatsApp indisponível.*stack:/);
});

for (const falhaDeEnvio of [false, true]) {
    test(`ciclo contínuo ${falhaDeEnvio ? 'reverifica o mesmo cliente depois de uma falha real de envio' : 'reutiliza a sessão após lotes bem-sucedidos e erros sem relação com o envio'}`, async t => {
        const eventos = prepararCiclo(t);
        const fila = [];
        const erro = new Error('Falha simulada');
        if (falhaDeEnvio) erro.code = disparador.FALHA_ENVIO_WHATSAPP;
        const fim = new Error('Fim do teste');
        let ciclos = 0;
        let esperas = 0;

        await assert.rejects(iniciarCicloContinuo(fila, {
            async executar(lista, canal) {
                ciclos += 1;
                if (ciclos === 2) throw erro;
                if (ciclos === 4) throw fim;
                await executarCiclo(lista, canal);
            },
            async aguardar(ms) {
                assert.equal(ms, 60000);
                if (++esperas === 2) throw fim;
            }
        }), fim);

        assert.deepEqual(eventos, [
            'inicializar', 'verificar', 'shopee', 'mercado-livre', 'enviar',
            ...(falhaDeEnvio ? ['verificar'] : []),
            'shopee', 'mercado-livre', 'enviar', 'encerrar'
        ]);
        assert.deepEqual(fila, []);
    });
}

test('ciclo contínuo recria o cliente quando a verificação após a falha de envio também falha', async t => {
    const clientes = [{}, {}];
    let iniciado = 0;
    let verificacoes = 0;
    const inicializar = t.mock.method(gerenciador, 'inicializaGerenciador', async () => clientes[iniciado++]);
    const verificar = t.mock.method(gerenciador, 'verificarDisponibilidade', async client => {
        verificacoes += 1;
        if (verificacoes === 2) throw new Error('Cliente desconectado');
        return { client };
    });
    const encerrar = t.mock.method(gerenciador, 'encerrarGerenciador', async () => {});
    const falha = new Error('Envio recusado');
    falha.code = disparador.FALHA_ENVIO_WHATSAPP;
    const fim = new Error('Fim do teste');
    let esperas = 0;

    await assert.rejects(iniciarCicloContinuo([], {
        async executar(_fila, { client }) {
            throw client === clientes[0] ? falha : fim;
        },
        async aguardar() {
            if (++esperas === 3) throw fim;
        }
    }), fim);

    assert.equal(inicializar.mock.callCount(), 2);
    assert.deepEqual(verificar.mock.calls.map(chamada => chamada.arguments[0]), [clientes[0], ...clientes]);
    assert.deepEqual(encerrar.mock.calls.map(chamada => chamada.arguments[0]), clientes);
});

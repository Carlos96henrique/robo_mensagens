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

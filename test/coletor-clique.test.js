const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { clicarElementoPorTexto } = require('../src/coletor');

function elemento({ oculto = false, disabled = false, link = false, produto = false } = {}) {
    return {
        innerText: 'Música, Filmes e Seriados',
        disabled,
        oculto,
        cliques: 0,
        getBoundingClientRect: () => ({ width: 100, height: 20, top: 0 }),
        getAttribute: () => null,
        matches(seletor) {
            return seletor.includes('.poly-card') ? produto : seletor.includes('button');
        },
        closest(seletor) {
            if (seletor === 'a') return link ? this : null;
            if (seletor === '.poly-card') return produto ? this : null;
            return this;
        },
        scrollIntoView() {},
        click() { this.cliques += 1; }
    };
}

test('Mercado Livre espera uma opção visível e habilitada e clica usando o mesmo critério', async t => {
    const setTimeoutOriginal = global.setTimeout;
    t.mock.method(global, 'setTimeout', callback => setTimeoutOriginal(callback, 0));
    const ignorados = [
        elemento({ oculto: true }), elemento({ disabled: true }),
        elemento({ link: true }), elemento({ produto: true })
    ];
    const alvo = elemento();
    const elementos = [...ignorados];
    const executar = (funcao, args) => vm.runInNewContext(`(${funcao.toString()})(...args)`, {
        args,
        document: { querySelectorAll: () => elementos },
        window: { getComputedStyle: el => ({ display: el.oculto ? 'none' : 'block', visibility: 'visible' }) }
    });
    let predicadoEspera;
    const page = {
        async waitForFunction(funcao, opcoes, ...args) {
            predicadoEspera = funcao;
            assert.equal(executar(funcao, args), false);
            elementos.push(alvo);
            assert.equal(executar(funcao, args), true);
            assert.equal(alvo.cliques, 0);
        },
        async evaluate(funcao, ...args) {
            assert.equal(funcao, predicadoEspera);
            return executar(funcao, args);
        }
    };

    await clicarElementoPorTexto(page, '  MÚSICA, Filmes e Seriados  ');

    assert.equal(alvo.cliques, 1);
    assert.equal(ignorados.every(el => el.cliques === 0), true);
});

test('Mercado Livre informa qual elemento excedeu a espera e preserva a causa', async () => {
    const cause = new Error('Waiting failed: 15000ms exceeded');
    cause.name = 'TimeoutError';
    const page = { async waitForFunction() { throw cause; } };

    await assert.rejects(clicarElementoPorTexto(page, 'Música, Filmes e Seriados'), error => {
        assert.equal(error.code, 'ELEMENTO_INDISPONIVEL');
        assert.match(error.message, /Música, Filmes e Seriados/);
        assert.match(error.message, /15000 ms/);
        assert.equal(error.cause, cause);
        return true;
    });
});

test('Mercado Livre trata desaparecimento do elemento entre espera e clique', async () => {
    const page = { async waitForFunction() {}, async evaluate() { return false; } };

    await assert.rejects(clicarElementoPorTexto(page, 'Categorias'), error => {
        assert.equal(error.code, 'ELEMENTO_INDISPONIVEL');
        assert.match(error.cause.message, /deixou de estar disponível/);
        return true;
    });
});

test('Mercado Livre não transforma desconexão do navegador em categoria indisponível', async () => {
    const erro = new Error('Target closed');
    const page = { async waitForFunction() { throw erro; } };

    await assert.rejects(clicarElementoPorTexto(page, 'Categorias'), erro);
    assert.equal(erro.code, undefined);
});

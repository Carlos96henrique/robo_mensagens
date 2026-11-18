const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const puppeteer = require('puppeteer');
const coletor = require('../src/coletor');

function criarNavegador(quantidadeAbas, { erroNavegacao, erroFecharAba } = {}) {
    const abas = [];
    const eventos = [];
    let novasAbas = 0;
    let fechado = false;

    function criarAba() {
        const id = abas.length;
        let fechada = false;
        let url = 'about:blank';
        const aba = {
            isClosed: () => fechada,
            url: () => url,
            async close(opcoes) {
                assert.equal(opcoes.runBeforeUnload, false);
                eventos.push(`fechar-aba-${id}`);
                if (erroFecharAba) throw erroFecharAba;
                fechada = true;
            },
            async goto(destino) {
                eventos.push(`navegar-${id}`);
                assert.equal(abas.filter(p => !p.isClosed()).length, 1);
                if (erroNavegacao) throw erroNavegacao;
                url = destino;
            },
            async waitForFunction() {},
            async evaluate(funcao, ...args) {
                // Cliques dos filtros recebem argumentos; leitura do link não.
                return args.length ? true : 'https://example.com/oferta';
            },
            async click() {},
            async $() { return { async click() {} }; },
            async $$() {
                return [{
                    async $eval(seletor) {
                        if (seletor === 'img') return 'https://example.com/imagem.jpg';
                        if (seletor === '.poly-price__current') return 'R$ 10,00';
                        return 'Produto fictício';
                    },
                    async $() { return { async click() {} }; }
                }];
            }
        };
        abas.push(aba);
        return aba;
    }

    for (let i = 0; i < quantidadeAbas; i += 1) criarAba();

    return {
        eventos,
        get novasAbas() { return novasAbas; },
        get fechado() { return fechado; },
        async pages() { return abas.filter(p => !p.isClosed()); },
        async newPage() {
            novasAbas += 1;
            return criarAba();
        },
        async close() {
            eventos.push('fechar-navegador');
            fechado = true;
        }
    };
}

function opcoesColeta() {
    const estadoNavegacao = coletor.criarEstadoNavegacao();
    estadoNavegacao.categorias = [{ nome: 'Categoria fictícia' }];
    return { limite: 1, estadoNavegacao };
}

async function simularCategorias(t, disponibilidade, indiceInicial = 0) {
    const setTimeoutOriginal = global.setTimeout;
    t.mock.method(global, 'setTimeout', callback => setTimeoutOriginal(callback, 0));
    const browser = criarNavegador(1);
    const launch = t.mock.method(puppeteer, 'launch', async () => browser);
    const [page] = await browser.pages();
    const cards = await page.$$('.poly-card');
    let indiceProduto = 0;
    const avaliar = page.evaluate.bind(page);
    t.mock.method(page, 'evaluate', async (funcao, ...args) => args.length
        ? avaliar(funcao, ...args)
        : `https://example.com/oferta/${indiceProduto}`);
    const consultas = {};
    const opcoes = opcoesColeta();
    opcoes.estadoNavegacao.categorias = Object.keys(disponibilidade).map(nome => ({ nome }));
    opcoes.estadoNavegacao.proximoIndiceCategoria = indiceInicial;
    t.mock.method(page, '$$', async () => {
        const nome = opcoes.estadoNavegacao.categoriaAtual.nome;
        const consulta = consultas[nome] || 0;
        consultas[nome] = consulta + 1;
        const respostas = disponibilidade[nome];
        const quantidade = Number(respostas[Math.min(consulta, respostas.length - 1)]);
        return Array.from({ length: quantidade }, (_, indice) => ({
            ...cards[0],
            async $() {
                return { async click() { indiceProduto = indice; } };
            }
        }));
    });
    return { browser, page, opcoes, consultas, launch };
}

test('Mercado Livre usa o executável do Chrome instalado e o perfil de login manual quando configurado', async t => {
    const configuracaoAnterior = process.env.MERCADO_LIVRE_CHROME;
    t.after(() => {
        if (configuracaoAnterior === undefined) delete process.env.MERCADO_LIVRE_CHROME;
        else process.env.MERCADO_LIVRE_CHROME = configuracaoAnterior;
    });
    process.env.MERCADO_LIVRE_CHROME = 'instalado';
    const caminhoChrome = resolve('Chrome instalado', 'chrome');
    const localizarChrome = t.mock.method(puppeteer, 'executablePath', () => caminhoChrome);
    const { opcoes, launch } = await simularCategorias(t, { Casa: [1] });

    const fila = await coletor.automatizarPagina([], opcoes);

    assert.deepEqual(localizarChrome.mock.calls[0].arguments, ['chrome']);
    const opcoesChrome = launch.mock.calls[0].arguments[0];
    assert.equal(opcoesChrome.executablePath, caminhoChrome);
    assert.equal(opcoesChrome.userDataDir, resolve(__dirname, '../perfil/chrome-instalado'));
    assert.deepEqual(opcoesChrome.ignoreDefaultArgs, ['--password-store=basic', '--use-mock-keychain']);
    assert.equal(fila.length, 1);
});

const urlAfiliados = 'https://www.mercadolivre.com.br/afiliados';
for (const { login, destino, navegacoesEsperadas } of [
    {
        login: 'https://www.mercadolivre.com/jms/mlb/lgz/login',
        destino: `${urlAfiliados}/?origem=login`,
        navegacoesEsperadas: 1
    },
    {
        login: 'https://www.mercadolivre.com.br/gz/account-verification',
        destino: 'https://www.mercadolivre.com.br/',
        navegacoesEsperadas: 2
    }
]) {
    test(`Mercado Livre aguarda o login manual e retoma a coleta após abrir ${destino}`, async t => {
        const { browser, page, opcoes, consultas } = await simularCategorias(t, { Casa: [1] });
        const navegar = page.goto.bind(page);
        let navegadorNoLogin = true;
        const abertura = t.mock.method(page, 'goto', async url => navegadorNoLogin
            ? navegar(login)
            : navegar(url));
        const esperaIniciada = Promise.withResolvers();
        const loginManual = Promise.withResolvers();
        const dispose = t.mock.fn(async () => {});
        const espera = t.mock.method(page, 'waitForFunction', async (funcao, config, ...args) => {
            if (config.timeout !== 0) return;
            const verificaRetorno = url => runInNewContext(`(${funcao})(...args)`, {
                window: { location: new URL(url) }, args
            });
            esperaIniciada.resolve(verificaRetorno);
            await loginManual.promise;
            return { dispose };
        });
        const itemShopee = { origem: 'shopee' };
        const fila = [itemShopee];

        const coleta = coletor.automatizarPagina(fila, opcoes);
        const verificaRetorno = await Promise.race([
            esperaIniciada.promise,
            coleta.then(() => assert.fail('A coleta terminou sem aguardar o login.'))
        ]);
        try {
            assert.equal(verificaRetorno(login), false);
            assert.equal(verificaRetorno('https://www.mercadolivre.com/jms/mlb/lgz/msl/login'), false);
            assert.equal(verificaRetorno('https://example.com/afiliados'), false);
            assert.equal(verificaRetorno(destino), true);
            assert.equal(espera.mock.callCount(), 1);
            assert.equal(abertura.mock.callCount(), 1);
            assert.deepEqual(fila, [itemShopee]);
            assert.deepEqual(consultas, {});
            assert.equal(browser.fechado, false);
        } finally {
            navegadorNoLogin = false;
            await navegar(destino);
            loginManual.resolve();
            await coleta;
        }

        assert.equal(dispose.mock.callCount(), 1);
        assert.equal(abertura.mock.callCount(), navegacoesEsperadas);
        assert.deepEqual(consultas, { Casa: 1 });
        assert.equal(fila[1].categoria, 'Casa');
        assert.equal(browser.novasAbas, 0);
        assert.equal(browser.fechado, true);
    });
}

test('Mercado Livre pula categorias sem cards e coleta na mesma aba', async t => {
    const { browser, opcoes, consultas, launch } = await simularCategorias(t, {
        Vazia: [false], Ingressos: [false], Outra: [false], Casa: [true]
    });
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila[0].categoria, 'Casa');
    assert.deepEqual(consultas, { Vazia: 4, Outra: 4, Casa: 1 });
    assert.equal(launch.mock.callCount(), 1);
    assert.equal(browser.novasAbas, 0);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre retorna ao início após categoria vazia e descarta seus itens pendentes', async t => {
    const { opcoes, consultas } = await simularCategorias(t, { Casa: [2], Vazia: [false] }, 1);
    opcoes.limite = 2;
    const pendente = { origem: 'mercado-livre', categoria: 'Vazia', link: 'https://example.com/pendente' };
    const fila = [pendente];
    opcoes.estadoNavegacao.proximosIndicesPorCategoria.Vazia = 10;

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila.length, 2);
    assert.equal(fila.includes(pendente), false);
    assert.equal(fila.every(produto => produto.categoria === 'Casa'), true);
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
    assert.equal(opcoes.estadoNavegacao.proximosIndicesPorCategoria.Vazia, 0);
    assert.deepEqual(consultas, { Vazia: 4, Casa: 1 });
});

test('Mercado Livre aguarda cards atrasados sem pular a categoria', async t => {
    const { opcoes, consultas } = await simularCategorias(t, { Casa: [false, false, true], Outra: [true] });
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila[0].categoria, 'Casa');
    assert.deepEqual(consultas, { Casa: 3 });
});

test('Mercado Livre encerra após uma volta vazia e permite tentar novamente no próximo ciclo', async t => {
    const disponibilidade = { Vazia: [false], Outra: [false], Cupons: [false], Ingressos: [false] };
    const { browser, opcoes, consultas } = await simularCategorias(t, disponibilidade);
    const pendente = { origem: 'shopee' };
    const fila = [pendente];

    await assert.rejects(coletor.automatizarPagina(fila, opcoes), /Nenhuma categoria.*completou a cota/);

    assert.deepEqual(consultas, { Vazia: 4, Outra: 4 });
    assert.deepEqual(fila, [pendente]);
    assert.equal(browser.fechado, true);
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
    // Usa uma nova instância, como faz o ciclo principal após o intervalo de erro.
    const proximoBrowser = criarNavegador(1);
    t.mock.method(puppeteer, 'launch', async () => proximoBrowser);
    await coletor.automatizarPagina(fila, opcoes);
    assert.equal(fila.length, 2);
    assert.equal(fila[1].categoria, 'Vazia');
    assert.equal(proximoBrowser.fechado, true);
});

test('Mercado Livre descarta categoria com cinco produtos e preenche dez da próxima na mesma aba', async t => {
    const { browser, opcoes, consultas, launch } = await simularCategorias(t, { Curta: [5], Casa: [10] });
    opcoes.limite = 10;
    const shopee = { origem: 'shopee', categoria: 'Curta' };
    const fila = [shopee];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila.length, 11);
    assert.equal(fila[0], shopee);
    assert.equal(fila.slice(1).every(produto => produto.categoria === 'Casa'), true);
    // As duas categorias usam os mesmos links: o descarte deve liberar a deduplicação.
    assert.equal(new Set(fila.slice(1).map(produto => produto.link)).size, 10);
    assert.deepEqual(consultas, { Curta: 4, Casa: 1 });
    assert.equal(opcoes.estadoNavegacao.proximosIndicesPorCategoria.Curta, 0);
    assert.equal(opcoes.estadoNavegacao.proximosIndicesPorCategoria.Casa, 10);
    assert.equal(opcoes.estadoNavegacao.categoriaConcluida, true);
    assert.equal(launch.mock.callCount(), 1);
    assert.equal(browser.novasAbas, 0);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre remove resíduos antigos da categoria insuficiente e volta ao início', async t => {
    const { opcoes } = await simularCategorias(t, { Casa: [10], Curta: [5] }, 1);
    opcoes.limite = 10;
    opcoes.estadoNavegacao.proximosIndicesPorCategoria.Curta = 3;
    const residuos = Array.from({ length: 3 }, (_, indice) => ({
        origem: 'mercado-livre', categoria: 'Curta', link: `https://example.com/oferta/${indice}`
    }));
    const fila = [...residuos];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila.length, 10);
    assert.equal(fila.some(produto => residuos.includes(produto)), false);
    assert.equal(fila.every(produto => produto.categoria === 'Casa'), true);
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
});

test('Mercado Livre tenta carregar mais cards antes de descartar uma categoria', async t => {
    const { opcoes, consultas } = await simularCategorias(t, { Casa: [5, 10], Outra: [10] });
    opcoes.limite = 10;
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila.length, 10);
    assert.equal(fila.every(produto => produto.categoria === 'Casa'), true);
    assert.deepEqual(consultas, { Casa: 2 });
});

test('Mercado Livre encerra uma volta de categorias insuficientes sem deixar lotes parciais', async t => {
    const { browser, opcoes, consultas } = await simularCategorias(t, { Curta: [3], Vazia: [0], Outra: [2] });
    opcoes.limite = 10;
    const shopee = { origem: 'shopee' };
    const fila = [shopee];

    await assert.rejects(coletor.automatizarPagina(fila, opcoes), /Nenhuma categoria.*cota de 10/);

    assert.deepEqual(fila, [shopee]);
    assert.deepEqual(consultas, { Curta: 4, Vazia: 4, Outra: 4 });
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
    assert.equal(opcoes.estadoNavegacao.categoriaConcluida, false);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre não aceita dez cards quando os produtos têm links duplicados', async t => {
    const { page, opcoes } = await simularCategorias(t, { Duplicados: [10], Casa: [10] });
    const avaliar = page.evaluate.bind(page);
    t.mock.method(page, 'evaluate', async (funcao, ...args) => {
        if (!args.length && opcoes.estadoNavegacao.categoriaAtual.nome === 'Duplicados') {
            return 'https://example.com/oferta/0';
        }
        return avaliar(funcao, ...args);
    });
    opcoes.limite = 10;
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(fila.length, 10);
    assert.equal(fila.every(produto => produto.categoria === 'Casa'), true);
});

test('Mercado Livre preserva coleta parcial quando há erro técnico ao carregar mais cards', async t => {
    const { browser, page, opcoes } = await simularCategorias(t, { Casa: [3], Outra: [10] });
    const buscarCards = page.$$.bind(page);
    let consultas = 0;
    const erro = new Error('Falha de conexão simulada');
    t.mock.method(page, '$$', async () => {
        if (consultas++ > 0) throw erro;
        return buscarCards();
    });
    opcoes.limite = 10;
    const fila = [];

    await assert.rejects(coletor.automatizarPagina(fila, opcoes), erro);

    assert.equal(fila.length, 3);
    assert.equal(fila.every(produto => produto.categoria === 'Casa'), true);
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre recupera timeout de categoria recarregando a mesma aba', async t => {
    const { page, browser, opcoes, launch } = await simularCategorias(t, { Casa: [true] });
    let tentativas = 0;
    t.mock.method(page, 'waitForFunction', async (funcao, config, texto) => {
        if (texto === 'casa' && tentativas++ === 0) throw new puppeteer.TimeoutError('Waiting failed');
    });
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(tentativas, 2);
    assert.equal(fila[0].categoria, 'Casa');
    assert.equal(browser.eventos.filter(evento => evento === 'navegar-0').length, 2);
    assert.equal(launch.mock.callCount(), 1);
    assert.equal(browser.novasAbas, 0);
});

test('Mercado Livre pula categoria indisponível após duas tentativas sem coletar cards do filtro errado', async t => {
    const { page, opcoes, consultas } = await simularCategorias(t, { Ausente: [10], Casa: [10] });
    opcoes.limite = 10;
    let tentativas = 0;
    t.mock.method(page, 'waitForFunction', async (funcao, config, texto) => {
        if (texto === 'ausente') {
            tentativas += 1;
            throw new puppeteer.TimeoutError('Waiting failed');
        }
    });
    const pendente = { origem: 'mercado-livre', categoria: 'Ausente', link: 'https://example.com/oferta/0' };
    const shopee = { origem: 'shopee' };
    const fila = [shopee, pendente];

    await coletor.automatizarPagina(fila, opcoes);

    assert.equal(tentativas, 2);
    assert.deepEqual(consultas, { Casa: 1 });
    assert.equal(fila.length, 11);
    assert.equal(fila[0], shopee);
    assert.equal(fila.includes(pendente), false);
    assert.equal(fila.slice(1).every(produto => produto.categoria === 'Casa'), true);
});

test('Mercado Livre encerra uma volta de categorias indisponíveis sem tentativas infinitas', async t => {
    const { page, browser, opcoes, consultas } = await simularCategorias(t, { Ausente: [10], Outra: [10] });
    let tentativas = 0;
    t.mock.method(page, 'waitForFunction', async (funcao, config, texto) => {
        if (['ausente', 'outra'].includes(texto)) {
            tentativas += 1;
            throw new puppeteer.TimeoutError('Waiting failed');
        }
    });

    await assert.rejects(coletor.automatizarPagina([], opcoes), /Nenhuma categoria.*completou/);

    assert.equal(tentativas, 4);
    assert.deepEqual(consultas, {});
    assert.equal(browser.fechado, true);
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
});

test('Mercado Livre preserva os itens quando o menu Categorias inteiro está indisponível', async t => {
    const { page, browser, opcoes, consultas } = await simularCategorias(t, { Casa: [10] });
    opcoes.limite = 10;
    let tentativas = 0;
    t.mock.method(page, 'waitForFunction', async (funcao, config, texto) => {
        if (texto === 'categorias') {
            tentativas += 1;
            throw new puppeteer.TimeoutError('Waiting failed');
        }
    });
    const pendente = { origem: 'mercado-livre', categoria: 'Casa' };
    const fila = [pendente];

    await assert.rejects(coletor.automatizarPagina(fila, opcoes), error => {
        assert.equal(error.code, 'ELEMENTO_INDISPONIVEL');
        assert.match(error.message, /Categorias/);
        return true;
    });

    assert.equal(tentativas, 2);
    assert.deepEqual(consultas, {});
    assert.deepEqual(fila, [pendente]);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre reutiliza uma única aba em ciclos sucessivos e fecha tudo ao concluir', async t => {
    const setTimeoutOriginal = global.setTimeout;
    t.mock.method(global, 'setTimeout', callback => setTimeoutOriginal(callback, 0));
    const navegadores = [];
    t.mock.method(puppeteer, 'launch', async () => {
        // Simula também abas restauradas de execuções anteriores.
        const browser = criarNavegador(4);
        navegadores.push(browser);
        return browser;
    });

    for (let ciclo = 0; ciclo < 3; ciclo += 1) {
        const fila = [];
        await coletor.automatizarPagina(fila, opcoesColeta());
        assert.equal(fila.length, 1);
        const browser = navegadores[ciclo];
        assert.equal(browser.novasAbas, 0);
        assert.equal(browser.fechado, true);
        assert.deepEqual(await browser.pages(), []);
        assert.deepEqual(browser.eventos, [
            'fechar-aba-1', 'fechar-aba-2', 'fechar-aba-3',
            'navegar-0', 'fechar-aba-0', 'fechar-navegador'
        ]);
    }
});

test('Mercado Livre coleta na primeira categoria sem clicar em Cupons ao completar a volta', async t => {
    const setTimeoutOriginal = global.setTimeout;
    t.mock.method(global, 'setTimeout', callback => setTimeoutOriginal(callback, 0));
    const browser = criarNavegador(1);
    t.mock.method(puppeteer, 'launch', async () => browser);
    const [page] = await browser.pages();
    const avaliar = t.mock.method(page, 'evaluate');
    const opcoes = opcoesColeta();
    opcoes.estadoNavegacao.categorias.push({ nome: 'Cupons' });
    opcoes.estadoNavegacao.proximoIndiceCategoria = 1;
    opcoes.estadoNavegacao.categoriaAtual = opcoes.estadoNavegacao.categorias[1];
    const fila = [];

    await coletor.automatizarPagina(fila, opcoes);

    const filtrosClicados = avaliar.mock.calls
        .filter(chamada => chamada.arguments.length > 1)
        .map(chamada => chamada.arguments[1]);
    assert.deepEqual(filtrosClicados, ['mais vendidos', 'categorias', 'categoria ficticia']);
    assert.equal(fila.length, 1);
    assert.equal(fila[0].categoria, 'Categoria fictícia');
    assert.equal(opcoes.estadoNavegacao.proximoIndiceCategoria, 0);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre cria uma aba somente quando o navegador não possui nenhuma', async t => {
    const erro = new Error('Falha simulada de navegação');
    const browser = criarNavegador(0, { erroNavegacao: erro });
    t.mock.method(puppeteer, 'launch', async () => browser);

    await assert.rejects(coletor.automatizarPagina([], opcoesColeta()), erro);
    assert.equal(browser.novasAbas, 1);
    assert.equal(browser.fechado, true);
    assert.deepEqual(await browser.pages(), []);
});

test('Mercado Livre fecha a aba reutilizada e o navegador quando a coleta falha', async t => {
    const erro = new Error('Falha simulada de navegação');
    const browser = criarNavegador(2, { erroNavegacao: erro });
    t.mock.method(puppeteer, 'launch', async () => browser);

    await assert.rejects(coletor.automatizarPagina([], opcoesColeta()), erro);
    assert.equal(browser.novasAbas, 0);
    assert.deepEqual(browser.eventos, [
        'fechar-aba-1', 'navegar-0', 'fechar-aba-0', 'fechar-navegador'
    ]);
});

test('Mercado Livre encerra o navegador mesmo se uma aba não puder ser fechada', async t => {
    const erro = new Error('Falha simulada de navegação');
    const browser = criarNavegador(1, {
        erroNavegacao: erro,
        erroFecharAba: new Error('Aba desconectada')
    });
    t.mock.method(puppeteer, 'launch', async () => browser);

    await assert.rejects(coletor.automatizarPagina([], opcoesColeta()), erro);
    assert.equal(browser.fechado, true);
});

test('Mercado Livre encerra o navegador se a limpeza inicial de abas falhar', async t => {
    const erro = new Error('Falha simulada ao fechar aba restaurada');
    const browser = criarNavegador(2, { erroFecharAba: erro });
    t.mock.method(puppeteer, 'launch', async () => browser);

    await assert.rejects(coletor.automatizarPagina([], opcoesColeta()), erro);
    assert.equal(browser.fechado, true);
    assert.equal(browser.eventos.some(evento => evento.startsWith('navegar-')), false);
});

test('Mercado Livre encerra o navegador mesmo se a listagem de abas falhar', async t => {
    const erro = new Error('Falha simulada ao listar abas');
    const browser = criarNavegador(1);
    t.mock.method(browser, 'pages', async () => { throw erro; });
    t.mock.method(puppeteer, 'launch', async () => browser);

    await assert.rejects(coletor.automatizarPagina([], opcoesColeta()), erro);
    assert.equal(browser.fechado, true);
});

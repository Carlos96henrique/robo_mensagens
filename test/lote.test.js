const test = require('node:test');
const assert = require('node:assert/strict');

const coletorMercadoLivre = require('../src/coletor');
const disparador = require('../src/disparador');

test('coletor do Mercado Livre considera somente a própria origem na cota', async () => {
    const fila = [
        ...Array.from({ length: 10 }, () => ({ origem: 'shopee' })),
        ...Array.from({ length: 10 }, () => ({ origem: 'mercado-livre' }))
    ];

    const resultado = await coletorMercadoLivre.automatizarPagina(fila, { limite: 10 });

    assert.equal(resultado, fila);
    assert.equal(resultado.length, 20);
});

test('Mercado Livre continua do próximo card entre ciclos', () => {
    const cards = Array.from({ length: 20 }, (_, indice) => ({ indice }));
    const estadoNavegacao = coletorMercadoLivre.criarEstadoNavegacao();
    const categoria = 'Eletrônicos';
    const primeiroCiclo = Array.from(
        { length: 10 },
        () => coletorMercadoLivre.obterProximoCard(cards, estadoNavegacao, categoria).indice
    );
    const segundoCiclo = Array.from(
        { length: 10 },
        () => coletorMercadoLivre.obterProximoCard(cards, estadoNavegacao, categoria).indice
    );

    assert.deepEqual(primeiroCiclo, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(segundoCiclo, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(estadoNavegacao.proximosIndicesPorCategoria[categoria], 20);
    assert.equal(
        coletorMercadoLivre.obterProximoCard(cards, estadoNavegacao, categoria),
        null
    );
});

test('Mercado Livre lista categorias visíveis e remove opções genéricas', async () => {
    const page = {
        async evaluate() {
            return ['Categorias', 'Eletrônicos', 'Casa e Decoração', 'Eletrônicos', 'Todos'];
        }
    };

    const categorias = await coletorMercadoLivre.listarCategoriasVisiveis(page);

    assert.deepEqual(categorias, [
        { nome: 'Eletrônicos' },
        { nome: 'Casa e Decoração' }
    ]);
});

test('Mercado Livre alterna categorias e mantém um cursor por categoria', () => {
    const categorias = [{ nome: 'Eletrônicos' }, { nome: 'Casa e Decoração' }];
    const estado = coletorMercadoLivre.criarEstadoNavegacao();
    const cards = [{ indice: 0 }, { indice: 1 }, { indice: 2 }];

    const primeira = coletorMercadoLivre.selecionarCategoria(categorias, estado);
    coletorMercadoLivre.obterProximoCard(cards, estado, primeira.nome);
    coletorMercadoLivre.obterProximoCard(cards, estado, primeira.nome);
    estado.categoriaAtual = null;
    estado.proximoIndiceCategoria = 1;
    const segunda = coletorMercadoLivre.selecionarCategoria(categorias, estado);
    coletorMercadoLivre.obterProximoCard(cards, estado, segunda.nome);

    assert.equal(primeira.nome, 'Eletrônicos');
    assert.equal(segunda.nome, 'Casa e Decoração');
    assert.equal(estado.proximosIndicesPorCategoria[primeira.nome], 2);
    assert.equal(estado.proximosIndicesPorCategoria[segunda.nome], 1);
});

test('Mercado Livre pula Cupons para a próxima categoria de produtos', () => {
    const categorias = [{ nome: 'Eletrônicos' }, { nome: '  CUPONS  ' }, { nome: 'Casa' }];
    const estado = coletorMercadoLivre.criarEstadoNavegacao();
    estado.proximoIndiceCategoria = 1;

    assert.equal(coletorMercadoLivre.selecionarCategoria(categorias, estado), categorias[2]);
    assert.equal(estado.proximoIndiceCategoria, 2);
    assert.equal(estado.categoriaAtual, categorias[2]);
});

test('Mercado Livre volta ao início se Cupons for a última categoria, preservando os cursores', () => {
    const categorias = [{ nome: 'Eletrônicos' }, { nome: 'Cupons' }];
    const estado = coletorMercadoLivre.criarEstadoNavegacao();
    estado.proximoIndiceCategoria = 1;
    estado.categoriaAtual = categorias[1];
    estado.proximosIndicesPorCategoria['Eletrônicos'] = 10;

    assert.equal(coletorMercadoLivre.selecionarCategoria(categorias, estado), categorias[0]);
    assert.equal(estado.proximoIndiceCategoria, 0);
    assert.equal(estado.proximosIndicesPorCategoria['Eletrônicos'], 10);
});

test('Mercado Livre preserva a categoria ativa de uma coleta com itens pendentes', () => {
    const categorias = [{ nome: 'Cupons' }, { nome: 'Casa' }];
    const estado = coletorMercadoLivre.criarEstadoNavegacao();
    estado.proximoIndiceCategoria = 1;
    estado.categoriaAtual = categorias[1];
    estado.categoriaConcluida = true;

    assert.equal(coletorMercadoLivre.selecionarCategoria(categorias, estado), categorias[1]);
    assert.equal(estado.categoriaConcluida, true);
});

test('Mercado Livre interrompe a busca sem loop infinito quando só existe Cupons', () => {
    const estado = coletorMercadoLivre.criarEstadoNavegacao();

    assert.throws(
        () => coletorMercadoLivre.selecionarCategoria([{ nome: 'Cupons' }], estado),
        /Nenhuma categoria de produtos disponível/
    );
    assert.equal(estado.categoriaAtual, null);
    assert.equal(estado.proximoIndiceCategoria, 0);
});

test('Mercado Livre pula Ingressos e Cupons consecutivos ao voltar ao início', () => {
    const categorias = [{ nome: 'Casa' }, { nome: ' INGRESSOS ' }, { nome: 'Cupons' }];
    const estado = coletorMercadoLivre.criarEstadoNavegacao();
    estado.proximoIndiceCategoria = 1;

    assert.equal(coletorMercadoLivre.selecionarCategoria(categorias, estado), categorias[0]);
    assert.equal(estado.proximoIndiceCategoria, 0);
    assert.throws(
        () => coletorMercadoLivre.selecionarCategoria(categorias.slice(1), coletorMercadoLivre.criarEstadoNavegacao()),
        /Nenhuma categoria de produtos disponível/
    );
});

test('Mercado Livre carrega mais cards por rolagem sem recarregar a página', async () => {
    let rolouPagina = false;
    let quantidadeConsultas = 0;
    const page = {
        async evaluate() {
            rolouPagina = true;
        },
        async $$(seletor) {
            assert.equal(seletor, '.poly-card');
            quantidadeConsultas += 1;
            return Array.from({ length: 10 + quantidadeConsultas });
        }
    };

    const cards = await coletorMercadoLivre.carregarMaisCards(
        page,
        10,
        async () => {}
    );

    assert.equal(rolouPagina, true);
    assert.equal(cards.length, 11);
    assert.equal(typeof page.reload, 'undefined');
});

test('disparador aceita somente o lote completo de 20 itens', () => {
    const loteValido = [
        ...Array.from({ length: 10 }, () => ({ origem: 'shopee' })),
        ...Array.from({ length: 10 }, () => ({ origem: 'mercado-livre' }))
    ];

    assert.throws(
        () => disparador.validarFilaPronta(loteValido.slice(0, 19)),
        /exatamente 20 itens/
    );
    assert.doesNotThrow(
        () => disparador.validarFilaPronta(loteValido)
    );
    assert.throws(
        () => disparador.validarFilaPronta(
            Array.from({ length: 20 }, () => ({ origem: 'shopee' }))
        ),
        /0\/10 do Mercado Livre/
    );
});

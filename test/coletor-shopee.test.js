const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const coletor = require('../src/coletor-shopee');
const disparador = require('../src/disparador');
const CATEGORIA = { id: 100010, nome: 'Home Appliances' };

function criarEstadoComCategorias(categorias = [CATEGORIA]) {
    const estado = coletor.criarEstadoPaginacao();
    estado.categorias = categorias;
    return estado;
}

test('gera a assinatura SHA-256 esperada pela API da Shopee', () => {
    const appIdAnterior = process.env.SHOPEE_APP_ID;
    const secretAnterior = process.env.SHOPEE_APP_SECRET;
    process.env.SHOPEE_APP_ID = 'app-ficticio';
    process.env.SHOPEE_APP_SECRET = 'secret-ficticio';

    try {
        const payload = JSON.stringify({ query: '{ ping }' });
        const timestamp = 1700000000;
        const assinatura = crypto
            .createHash('sha256')
            .update(`app-ficticio${timestamp}${payload}secret-ficticio`)
            .digest('hex');
        const headers = coletor.gerarHeaders(payload, timestamp);

        assert.equal(
            headers.Authorization,
            `SHA256 Credential=app-ficticio, Timestamp=${timestamp}, Signature=${assinatura}`
        );
    } finally {
        if (appIdAnterior === undefined) {
            delete process.env.SHOPEE_APP_ID;
        } else {
            process.env.SHOPEE_APP_ID = appIdAnterior;
        }

        if (secretAnterior === undefined) {
            delete process.env.SHOPEE_APP_SECRET;
        } else {
            process.env.SHOPEE_APP_SECRET = secretAnterior;
        }
    }
});

test('normaliza produto e prefere o link de afiliado', () => {
    const produto = coletor.normalizarProduto({
        itemId: 123,
        productName: ' Produto fictício ',
        productLink: 'https://example.invalid/produto',
        offerLink: 'https://example.invalid/afiliado',
        imageUrl: 'https://example.invalid/imagem.jpg',
        priceMin: '19.90',
        priceMax: '19.90'
    }, CATEGORIA.nome);

    assert.deepEqual(produto, {
        titulo: 'Produto fictício',
        preco: 'R$\u00a019,90',
        link: 'https://example.invalid/afiliado',
        imagemUrl: 'https://example.invalid/imagem.jpg',
        categoria: CATEGORIA.nome,
        origem: 'shopee',
        idExterno: '123'
    });
});

test('buscarPagina trata a resposta GraphQL sem expor autenticação', async () => {
    const fetchFalso = async (url, options) => {
        assert.match(url, /open-api\.affiliate\.shopee\.com\.br\/graphql/);
        assert.equal(options.method, 'POST');
        assert.match(options.headers.Authorization, /^SHA256 Credential=/);

        const body = JSON.parse(options.body);
        assert.match(body.query, /productOfferV2/);
        assert.deepEqual(body.variables, {
            productCatId: CATEGORIA.id,
            page: 1,
            limit: 1
        });

        return {
            ok: true,
            async json() {
                return {
                    data: {
                        productOfferV2: {
                            nodes: [{ itemId: 1 }],
                            pageInfo: { hasNextPage: false }
                        }
                    }
                };
            }
        };
    };

    const pagina = await coletor.buscarPagina(1, 1, CATEGORIA.id, fetchFalso);

    assert.equal(pagina.produtos.length, 1);
    assert.equal(pagina.temProximaPagina, false);
});

test('lista e normaliza categorias disponíveis na API da Shopee', async () => {
    const fetchFalso = async (url, options) => {
        assert.match(url, /open-api\.affiliate\.shopee\.com\.br\/graphql/);
        const body = JSON.parse(options.body);
        assert.match(body.query, /shopeeOfferV2/);

        return {
            ok: true,
            async json() {
                return {
                    data: {
                        shopeeOfferV2: {
                            nodes: [
                                { offerName: '- - Home Appliances', offerType: 2, categoryId: 100010 },
                                { offerName: 'Campanha geral', offerType: 1, categoryId: null }
                            ],
                            pageInfo: { hasNextPage: false }
                        }
                    }
                };
            }
        };
    };

    const categorias = await coletor.buscarCategorias(fetchFalso);

    assert.deepEqual(categorias, [{ id: 100010, nome: 'Eletrodomésticos' }]);
});

test('completa somente a cota de 10 produtos da Shopee em uma fila mista', async () => {
    const produtos = Array.from({ length: 10 }, (_, indice) => ({
        itemId: indice + 1,
        productName: `Produto fictício ${indice + 1}`,
        offerLink: `https://example.invalid/afiliado/${indice + 1}`,
        imageUrl: `https://example.invalid/imagem/${indice + 1}.jpg`,
        priceMin: '10.00',
        priceMax: '10.00'
    }));
    const itensMercadoLivre = Array.from({ length: 10 }, (_, indice) => ({
        titulo: `Produto Mercado Livre ${indice + 1}`,
        origem: 'mercado-livre'
    }));
    const fila = [...itensMercadoLivre];

    await coletor.automatizarPagina(fila, {
        estadoPaginacao: criarEstadoComCategorias(),
        buscarPaginaImpl: async () => ({
            produtos,
            temProximaPagina: false
        })
    });

    const itensShopee = fila.filter(item => item.origem === 'shopee');
    assert.equal(fila.length, 20);
    assert.equal(itensShopee.length, 10);
    assert.deepEqual(fila.slice(0, 10), itensMercadoLivre);
    assert.ok(itensShopee.every(item => item.titulo && item.preco && item.link && item.imagemUrl));
    assert.ok(itensShopee.every(item => item.categoria === CATEGORIA.nome));
});

test('não considera itens de outra loja no limite da Shopee', async () => {
    const fila = Array.from({ length: 20 }, (_, indice) => ({
        titulo: `Produto Mercado Livre ${indice + 1}`,
        origem: 'mercado-livre'
    }));

    await coletor.automatizarPagina(fila, {
        limite: 1,
        estadoPaginacao: criarEstadoComCategorias(),
        buscarPaginaImpl: async () => ({
            produtos: [{
                itemId: 1,
                productName: 'Produto Shopee',
                offerLink: 'https://example.invalid/afiliado/1',
                imageUrl: 'https://example.invalid/imagem/1.jpg',
                priceMin: '10.00',
                priceMax: '10.00'
            }],
            temProximaPagina: false
        })
    });

    assert.equal(fila.length, 21);
    assert.equal(fila.filter(item => item.origem === 'shopee').length, 1);
});

test('rejeita a coleta quando a Shopee não completa a cota solicitada', async () => {
    const fila = [];

    await assert.rejects(
        coletor.automatizarPagina(fila, {
            limite: 2,
            estadoPaginacao: criarEstadoComCategorias(),
            buscarPaginaImpl: async () => ({
                produtos: [{
                    itemId: 1,
                    productName: 'Produto Shopee',
                    offerLink: 'https://example.invalid/afiliado/1',
                    imageUrl: 'https://example.invalid/imagem/1.jpg',
                    priceMin: '10.00',
                    priceMax: '10.00'
                }],
                temProximaPagina: false
            })
        }),
        /Nenhuma das 1 categorias.*cota de 2 produto/
    );
    assert.equal(fila.length, 0);
});

test('pula categoria da Shopee que não consegue completar um lote novo', async () => {
    const categorias = [
        CATEGORIA,
        { id: 100013, nome: 'Mobile & Gadgets' }
    ];
    const estadoPaginacao = criarEstadoComCategorias(categorias);
    const categoriasConsultadas = [];

    const fila = [];
    await coletor.automatizarPagina(fila, {
        limite: 2,
        estadoPaginacao,
        buscarPaginaImpl: async (pagina, limite, categoriaId) => {
            categoriasConsultadas.push(categoriaId);
            const quantidade = categoriaId === CATEGORIA.id ? 1 : 2;
            return {
                produtos: Array.from({ length: quantidade }, (_, indice) => ({
                    itemId: `${categoriaId}${indice}`,
                    productName: `Produto ${categoriaId}-${indice}`,
                    offerLink: `https://example.invalid/afiliado/${categoriaId}/${indice}`,
                    imageUrl: `https://example.invalid/imagem/${categoriaId}/${indice}.jpg`,
                    priceMin: '10.00',
                    priceMax: '10.00'
                })),
                temProximaPagina: false
            };
        }
    });

    assert.deepEqual(categoriasConsultadas, [100010, 100013]);
    assert.equal(fila.length, 2);
    assert.ok(fila.every(produto => produto.categoria === 'Mobile & Gadgets'));
});

test('continua na página seguinte da Shopee em um novo ciclo', async () => {
    const estadoPaginacao = criarEstadoComCategorias();
    const paginasConsultadas = [];
    const buscarPaginaImpl = async pagina => {
        paginasConsultadas.push(pagina);
        return {
            produtos: [{
                itemId: pagina,
                productName: `Produto da página ${pagina}`,
                offerLink: `https://example.invalid/afiliado/${pagina}`,
                imageUrl: `https://example.invalid/imagem/${pagina}.jpg`,
                priceMin: '10.00',
                priceMax: '10.00'
            }],
            temProximaPagina: true
        };
    };

    const primeiroLote = [];
    await coletor.automatizarPagina(primeiroLote, {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl
    });

    const segundoLote = [];
    await coletor.automatizarPagina(segundoLote, {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl
    });

    assert.deepEqual(paginasConsultadas, [1, 2]);
    assert.equal(estadoPaginacao.paginasPorCategoria[CATEGORIA.id], 3);
    assert.equal(primeiroLote[0].idExterno, '1');
    assert.equal(segundoLote[0].idExterno, '2');
});

test('reinicia a Shopee na primeira página somente após a última página', async () => {
    const estadoPaginacao = criarEstadoComCategorias();
    estadoPaginacao.paginasPorCategoria[CATEGORIA.id] = 4;

    await coletor.automatizarPagina([], {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl: async pagina => ({
            produtos: [{
                itemId: pagina,
                productName: `Produto da página ${pagina}`,
                offerLink: `https://example.invalid/afiliado/${pagina}`,
                imageUrl: `https://example.invalid/imagem/${pagina}.jpg`,
                priceMin: '10.00',
                priceMax: '10.00'
            }],
            temProximaPagina: false
        })
    });

    assert.equal(estadoPaginacao.paginasPorCategoria[CATEGORIA.id], 1);
});

test('alterna a categoria da Shopee a cada lote concluído', async () => {
    const categorias = [
        CATEGORIA,
        { id: 100013, nome: 'Mobile & Gadgets' }
    ];
    const estadoPaginacao = criarEstadoComCategorias(categorias);
    const categoriasConsultadas = [];
    const buscarPaginaImpl = async (pagina, limite, categoriaId) => {
        categoriasConsultadas.push(categoriaId);
        return {
            produtos: [{
                itemId: categoriaId,
                productName: `Produto ${categoriaId}`,
                offerLink: `https://example.invalid/afiliado/${categoriaId}`,
                imageUrl: `https://example.invalid/imagem/${categoriaId}.jpg`,
                priceMin: '10.00',
                priceMax: '10.00'
            }],
            temProximaPagina: true
        };
    };

    const primeiroLote = [];
    await coletor.automatizarPagina(primeiroLote, {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl
    });
    const segundoLote = [];
    await coletor.automatizarPagina(segundoLote, {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl
    });

    assert.deepEqual(categoriasConsultadas, [100010, 100013]);
    assert.equal(primeiroLote[0].categoria, 'Home Appliances');
    assert.equal(segundoLote[0].categoria, 'Mobile & Gadgets');
});

test('mantém a categoria da Shopee ao recompor um lote residual', async () => {
    const categorias = [
        CATEGORIA,
        { id: 100013, nome: 'Mobile & Gadgets' }
    ];
    const estadoPaginacao = criarEstadoComCategorias(categorias);
    const categoriasConsultadas = [];
    let contadorItem = 0;
    const buscarPaginaImpl = async (pagina, limite, categoriaId) => {
        categoriasConsultadas.push(categoriaId);
        contadorItem += 1;
        return {
            produtos: [{
                itemId: contadorItem,
                productName: `Produto ${contadorItem}`,
                offerLink: `https://example.invalid/afiliado/${contadorItem}`,
                imageUrl: `https://example.invalid/imagem/${contadorItem}.jpg`,
                priceMin: '10.00',
                priceMax: '10.00'
            }],
            temProximaPagina: true
        };
    };

    const primeiroLote = [];
    await coletor.automatizarPagina(primeiroLote, {
        limite: 1,
        estadoPaginacao,
        buscarPaginaImpl
    });

    const filaResidual = [primeiroLote[0]];
    await coletor.automatizarPagina(filaResidual, {
        limite: 2,
        estadoPaginacao,
        buscarPaginaImpl
    });

    assert.deepEqual(categoriasConsultadas, [100010, 100010]);
    assert.ok(filaResidual.every(produto => produto.categoria === CATEGORIA.nome));
});

test('produto da Shopee é aceito pelo formatador do disparador', async () => {
    const produto = coletor.normalizarProduto({
        itemId: 123,
        productName: 'Produto fictício',
        offerLink: 'https://example.invalid/afiliado',
        imageUrl: 'https://example.invalid/imagem.jpg',
        priceMin: '25.90',
        priceMax: '25.90'
    }, CATEGORIA.nome);

    const mensagem = await disparador.estruturarMensagem(produto);

    assert.match(mensagem, /Produto fictício/);
    assert.match(mensagem, /Categoria: Home Appliances/);
    assert.match(mensagem, /R\$\s*25,90/);
    assert.match(mensagem, /https:\/\/example\.invalid\/afiliado/);
});

test('propaga erros GraphQL que impedem a coleta', async () => {
    const fetchFalso = async () => ({
        ok: true,
        async json() {
            return {
                errors: [{
                    message: 'Consulta recusada',
                    extensions: { code: 10020 }
                }]
            };
        }
    });

    await assert.rejects(
        coletor.buscarPagina(1, 1, CATEGORIA.id, fetchFalso),
        /10020: Consulta recusada/
    );
});

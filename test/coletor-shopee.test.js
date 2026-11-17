const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const coletor = require('../src/coletor-shopee');
const disparador = require('../src/disparador');
const logger = require('../src/gerenciador-log');
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

function produtoDaPagina(pagina, categoriaId = CATEGORIA.id) {
    return {
        itemId: `${categoriaId}-${pagina}`,
        productName: `Produto ${categoriaId}-${pagina}`,
        offerLink: `https://example.invalid/produto/${categoriaId}/${pagina}`,
        imageUrl: `https://example.invalid/imagem/${categoriaId}/${pagina}.jpg`,
        priceMin: '10.00', priceMax: '10.00'
    };
}

function simularConsulta(responder) {
    return (pagina, limite, categoriaId) => coletor.buscarPagina(pagina, limite, categoriaId, async (url, options) => {
        const resposta = responder(JSON.parse(options.body).variables);
        return {
            ok: true,
            async json() {
                if (resposta.erros) {
                    return { errors: resposta.erros.map(code => ({
                        message: 'Consulta recusada', extensions: { code }
                    })) };
                }
                return { data: { productOfferV2: {
                    nodes: resposta.produtos ?? [produtoDaPagina(pagina, categoriaId)],
                    pageInfo: { hasNextPage: resposta.temProximaPagina ?? true }
                } } };
            }
        };
    });
}

test('erro 10000 avança a página, completa a coleta e registra contexto da falha', async t => {
    const paginas = [];
    const estado = criarEstadoComCategorias();
    const log = t.mock.method(logger, 'error', () => {});
    const fila = [];
    await coletor.automatizarPagina(fila, {
        limite: 1, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(({ page }) => {
            paginas.push(page);
            return page === 1 ? { erros: ['10000'] } : {};
        })
    });
    assert.deepEqual(paginas, [1, 2]);
    assert.equal(fila[0].idExterno, `${CATEGORIA.id}-2`);
    assert.equal(estado.paginasPorCategoria[CATEGORIA.id], 3);
    assert.equal(log.mock.callCount(), 1);
    assert.match(log.mock.calls[0].arguments[0], /erro 10000.*Home Appliances.*100010.*página 1; próxima página: 2.*stack:/);
});

test('preserva produtos anteriores e deduplicação ao pular uma página com erro', async () => {
    const anterior = coletor.normalizarProduto(produtoDaPagina(1), CATEGORIA.nome);
    const outro = { origem: 'mercado-livre', titulo: 'Produto pendente' };
    const fila = [anterior, outro];
    const estado = criarEstadoComCategorias();
    estado.paginasPorCategoria[CATEGORIA.id] = 2;
    await coletor.automatizarPagina(fila, {
        limite: 3, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(({ page }) => {
            if (page === 3) return { erros: [10000] };
            return { produtos: [produtoDaPagina(1), produtoDaPagina(page)] };
        })
    });
    assert.equal(fila.length, 4);
    assert.equal(fila[0], anterior);
    assert.equal(fila[1], outro);
    assert.deepEqual(fila.filter(p => p.origem === 'shopee').map(p => p.idExterno), [
        `${CATEGORIA.id}-1`, `${CATEGORIA.id}-2`, `${CATEGORIA.id}-4`
    ]);
});

test('três páginas com erro em um lote novo levam à categoria seguinte', async () => {
    const segunda = { id: 100013, nome: 'Celulares' };
    const estado = criarEstadoComCategorias([CATEGORIA, segunda]);
    const consultas = [];
    const fila = [];
    await coletor.automatizarPagina(fila, {
        limite: 1, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(({ page, productCatId }) => {
            consultas.push([productCatId, page]);
            return productCatId === CATEGORIA.id ? { erros: [10000] } : {};
        })
    });
    assert.deepEqual(consultas, [[100010, 1], [100010, 2], [100010, 3], [100013, 1]]);
    assert.equal(fila[0].categoria, segunda.nome);
    assert.equal(estado.paginasPorCategoria[CATEGORIA.id], 4);
});

test('encerra após uma volta se todas as categorias falham, sem perder itens de outra loja', async () => {
    const estado = criarEstadoComCategorias([CATEGORIA, { id: 100013, nome: 'Celulares' }]);
    const pendente = { origem: 'mercado-livre' };
    const fila = [pendente];
    let consultas = 0;
    await assert.rejects(coletor.automatizarPagina(fila, {
        limite: 1, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(() => { consultas += 1; return { erros: [10000] }; })
    }), /Nenhuma das 2 categorias/);
    assert.equal(consultas, 6);
    assert.deepEqual(fila, [pendente]);
    assert.equal(estado.paginasPorCategoria[100010], 4);
    assert.equal(estado.paginasPorCategoria[100013], 4);
});

test('após três falhas preserva lote residual e retoma da página avançada na nova tentativa', async () => {
    const estado = criarEstadoComCategorias();
    const pendente = coletor.normalizarProduto(produtoDaPagina(10), CATEGORIA.nome);
    const fila = [pendente];
    await assert.rejects(coletor.automatizarPagina(fila, {
        limite: 2, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(() => ({ erros: [10000] }))
    }), /apenas 1\/2/);
    assert.deepEqual(fila, [pendente]);
    assert.equal(estado.paginasPorCategoria[CATEGORIA.id], 4);
    const paginas = [];
    await coletor.automatizarPagina(fila, {
        limite: 2, estadoPaginacao: estado,
        buscarPaginaImpl: simularConsulta(({ page }) => { paginas.push(page); return {}; })
    });
    assert.deepEqual(paginas, [4]);
    assert.equal(fila.length, 2);
    assert.equal(fila[0], pendente);
});

test('uma página bem-sucedida reinicia a contagem de erros consecutivos', async () => {
    const paginas = [];
    const fila = [];
    await coletor.automatizarPagina(fila, {
        limite: 2, estadoPaginacao: criarEstadoComCategorias(),
        buscarPaginaImpl: simularConsulta(({ page }) => {
            paginas.push(page);
            return page % 3 === 0 ? {} : { erros: [10000] };
        })
    });
    assert.deepEqual(paginas, [1, 2, 3, 4, 5, 6]);
    assert.equal(fila.length, 2);
});

test('erros de autenticação, limite, parâmetros ou mistos não são tratados como página a pular', async () => {
    for (const erros of [[10020], [10030], [11001], [10000, 10020], [undefined]]) {
        const estado = criarEstadoComCategorias();
        let consultas = 0;
        await assert.rejects(coletor.automatizarPagina([], {
            limite: 1, estadoPaginacao: estado,
            buscarPaginaImpl: simularConsulta(() => { consultas += 1; return { erros }; })
        }), /API da Shopee recusou/);
        assert.equal(consultas, 1);
        assert.equal(estado.paginasPorCategoria[CATEGORIA.id], undefined);
    }
});

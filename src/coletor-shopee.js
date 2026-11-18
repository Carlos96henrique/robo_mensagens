const crypto = require('node:crypto');

const logger = require('./gerenciador-log');
require('./configuracao-ambiente');

const API_URL = process.env.SHOPEE_API_URL
    || 'https://open-api.affiliate.shopee.com.br/graphql';
const LIMITE_PADRAO = 10;
const TAMANHO_PAGINA = 10;
const TAMANHO_PAGINA_CATEGORIAS = 50;
const TIMEOUT_REQUISICAO_MS = 30000;
const MAX_PAGINAS_COM_ERRO_CONSECUTIVAS = 3;
const estadoPaginacaoPadrao = criarEstadoPaginacao();
const NOMES_CATEGORIAS_PT_BR = {
    100001: 'Saúde',
    100009: 'Acessórios de Moda',
    100010: 'Eletrodomésticos',
    100011: 'Roupas Masculinas',
    100012: 'Calçados Masculinos',
    100013: 'Celulares e Dispositivos',
    100015: 'Viagem e Bagagem',
    100016: 'Bolsas Femininas',
    100017: 'Roupas Femininas',
    100531: 'Delivery de Comida',
    100532: 'Calçados Femininos',
    100533: 'Bolsas Masculinas',
    100534: 'Relógios',
    100535: 'Áudio',
    100629: 'Alimentos e Bebidas',
    100630: 'Beleza',
    100631: 'Animais de Estimação',
    100632: 'Mamãe e Bebê',
    100633: 'Moda Infantil',
    100634: 'Games e Consoles',
    100635: 'Câmeras e Drones',
    100636: 'Casa e Construção',
    100637: 'Esportes e Atividades ao Ar Livre',
    100638: 'Papelaria',
    100639: 'Brinquedos e Hobbies',
    100640: 'Automóveis',
    100641: 'Motocicletas',
    100642: 'Ingressos, Vouchers e Serviços',
    100643: 'Livros e Revistas',
    100644: 'Computadores e Acessórios'
};

const QUERY_PRODUTOS = `
    query ProductOffers($productCatId: Int!, $page: Int!, $limit: Int!) {
        productOfferV2(productCatId: $productCatId, page: $page, limit: $limit) {
            nodes {
                itemId
                productName
                productLink
                offerLink
                imageUrl
                priceMin
                priceMax
                priceDiscountRate
                sales
                ratingStar
                shopId
                shopName
            }
            pageInfo {
                page
                limit
                hasNextPage
            }
        }
    }
`;

const QUERY_CATEGORIAS = `
    query CategoryOffers($page: Int!, $limit: Int!) {
        shopeeOfferV2(page: $page, limit: $limit) {
            nodes {
                offerName
                offerType
                categoryId
            }
            pageInfo {
                page
                limit
                hasNextPage
            }
        }
    }
`;

function obterCredenciais() {
    const appId = process.env.SHOPEE_APP_ID?.trim();
    const appSecret = process.env.SHOPEE_APP_SECRET?.trim();

    if (!appId || !appSecret) {
        throw new Error(
            'Credenciais da Shopee ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.'
        );
    }

    return { appId, appSecret };
}

function gerarHeaders(payloadBody, timestamp = Math.floor(Date.now() / 1000)) {
    const { appId, appSecret } = obterCredenciais();
    const assinatura = crypto
        .createHash('sha256')
        .update(`${appId}${timestamp}${payloadBody}${appSecret}`)
        .digest('hex');

    return {
        'Content-Type': 'application/json',
        Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${assinatura}`
    };
}

function descreverErrosApi(erros) {
    return erros
        .map(erro => {
            const codigo = erro.extensions?.code;
            const mensagem = erro.extensions?.message || erro.message || 'Erro desconhecido';
            return codigo ? `${codigo}: ${mensagem}` : mensagem;
        })
        .join('; ');
}

async function executarConsultaGraphQL(operationName, query, variables, fetchImpl = fetch) {
    const payload = JSON.stringify({
        operationName,
        query,
        variables
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_REQUISICAO_MS);

    try {
        const response = await fetchImpl(API_URL, {
            method: 'POST',
            headers: gerarHeaders(payload),
            body: payload,
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`API da Shopee respondeu com HTTP ${response.status}.`);
        }

        const resultado = await response.json();
        if (Array.isArray(resultado.errors) && resultado.errors.length > 0) {
            const erro = new Error(`API da Shopee recusou a consulta: ${descreverErrosApi(resultado.errors)}.`);
            erro.codigosApi = resultado.errors.map(item => Number(item.extensions?.code));
            throw erro;
        }

        return resultado.data;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`A API da Shopee excedeu o timeout de ${TIMEOUT_REQUISICAO_MS / 1000} segundos.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function buscarPagina(pagina, limite, categoriaId, fetchImpl = fetch) {
    const resultado = await executarConsultaGraphQL(
        'ProductOffers',
        QUERY_PRODUTOS,
        {
            productCatId: categoriaId,
            page: pagina,
            limit: limite
        },
        fetchImpl
    );
    const dados = resultado?.productOfferV2;

    if (!dados || !Array.isArray(dados.nodes)) {
        throw new Error('Resposta da API da Shopee não contém uma lista de produtos válida.');
    }

    return {
        produtos: dados.nodes,
        temProximaPagina: Boolean(dados.pageInfo?.hasNextPage)
    };
}

function normalizarNomeCategoria(nome, id) {
    return NOMES_CATEGORIAS_PT_BR[id]
        || normalizarTexto(nome).replace(/^(?:-\s*)+/, '').trim();
}

async function buscarCategorias(fetchImpl = fetch) {
    const categorias = [];
    const idsEncontrados = new Set();
    let pagina = 1;
    let continuar = true;

    while (continuar) {
        const resultado = await executarConsultaGraphQL(
            'CategoryOffers',
            QUERY_CATEGORIAS,
            { page: pagina, limit: TAMANHO_PAGINA_CATEGORIAS },
            fetchImpl
        );
        const dados = resultado?.shopeeOfferV2;

        if (!dados || !Array.isArray(dados.nodes)) {
            throw new Error('Resposta da API da Shopee não contém uma lista de categorias válida.');
        }

        for (const oferta of dados.nodes) {
            const id = Number(oferta?.categoryId);
            const nome = normalizarNomeCategoria(oferta?.offerName, id);

            if (oferta?.offerType !== 2 || !Number.isInteger(id) || !nome || idsEncontrados.has(id)) {
                continue;
            }

            idsEncontrados.add(id);
            categorias.push({ id, nome });
        }

        continuar = Boolean(dados.pageInfo?.hasNextPage) && dados.nodes.length > 0;
        pagina += 1;
    }

    if (categorias.length === 0) {
        throw new Error('A API da Shopee não retornou categorias disponíveis.');
    }

    return categorias;
}

function converterPrecoParaNumero(valor) {
    if (typeof valor === 'number') {
        return Number.isFinite(valor) ? valor : null;
    }

    if (typeof valor !== 'string' || !valor.trim()) {
        return null;
    }

    const somenteNumero = valor.trim().replace(/[^\d,.-]/g, '');
    const normalizado = somenteNumero.includes(',')
        ? somenteNumero.replace(/\./g, '').replace(',', '.')
        : somenteNumero;
    const numero = Number(normalizado);

    return Number.isFinite(numero) ? numero : null;
}

function formatarPreco(precoMinimo, precoMaximo) {
    const minimo = converterPrecoParaNumero(precoMinimo);
    const maximo = converterPrecoParaNumero(precoMaximo);
    const formatador = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });

    if (minimo === null && maximo === null) {
        return null;
    }

    if (minimo !== null && maximo !== null && minimo !== maximo) {
        return `${formatador.format(minimo)} a ${formatador.format(maximo)}`;
    }

    return formatador.format(minimo ?? maximo);
}

function normalizarTexto(valor) {
    return typeof valor === 'string' ? valor.trim() : '';
}

function normalizarProduto(produto, categoria = 'Categoria não informada') {
    const titulo = normalizarTexto(produto?.productName);
    const link = normalizarTexto(produto?.offerLink)
        || normalizarTexto(produto?.productLink);
    const imagemUrl = normalizarTexto(produto?.imageUrl);
    const preco = formatarPreco(produto?.priceMin, produto?.priceMax);

    if (!titulo || !link || !imagemUrl || !preco) {
        return null;
    }

    return {
        titulo,
        preco,
        link,
        imagemUrl,
        categoria: normalizarTexto(categoria) || 'Categoria não informada',
        origem: 'shopee',
        idExterno: produto.itemId ? String(produto.itemId) : null
    };
}

function gerarChaveProduto(produto) {
    return produto.idExterno
        ? `${produto.origem}:${produto.idExterno}`
        : `${produto.origem}:${produto.link}`;
}

function criarEstadoPaginacao() {
    return {
        categorias: null,
        categoriaAtual: null,
        categoriaConcluida: false,
        paginasPorCategoria: {},
        proximoIndiceCategoria: 0
    };
}

function selecionarCategoria(categorias, estadoPaginacao) {
    if (!Array.isArray(categorias) || categorias.length === 0) {
        throw new Error('A lista de categorias da Shopee é inválida.');
    }

    if (estadoPaginacao.categoriaAtual) {
        return estadoPaginacao.categoriaAtual;
    }

    const indice = estadoPaginacao.proximoIndiceCategoria % categorias.length;
    estadoPaginacao.categoriaAtual = categorias[indice];
    return estadoPaginacao.categoriaAtual;
}

function concluirCategoria(estadoPaginacao, quantidadeCategorias) {
    estadoPaginacao.proximoIndiceCategoria =
        (estadoPaginacao.proximoIndiceCategoria + 1) % quantidadeCategorias;
    estadoPaginacao.categoriaAtual = null;
}

async function automatizarPagina(listaProdutos, {
    buscarCategoriasImpl = buscarCategorias,
    buscarPaginaImpl = buscarPagina,
    categoriasTentadas = new Set(),
    estadoPaginacao = estadoPaginacaoPadrao,
    limite = LIMITE_PADRAO
} = {}) {
    if (!Array.isArray(listaProdutos)) {
        throw new Error('A fila de produtos da Shopee é inválida.');
    }
    if (!Number.isInteger(limite) || limite <= 0) {
        throw new Error('O limite de produtos da Shopee deve ser um número inteiro positivo.');
    }
    if (!Number.isInteger(estadoPaginacao?.proximoIndiceCategoria)
        || estadoPaginacao.proximoIndiceCategoria < 0
        || typeof estadoPaginacao.categoriaConcluida !== 'boolean'
        || typeof estadoPaginacao.paginasPorCategoria !== 'object') {
        throw new Error('O estado de paginação da Shopee é inválido.');
    }

    let quantidadeShopee = listaProdutos.filter(
        produto => produto?.origem === 'shopee'
    ).length;
    const quantidadeShopeeInicial = quantidadeShopee;

    if (quantidadeShopee >= limite) {
        logger.info(`Cota da Shopee já atingiu o limite de ${limite} itens.`);
        return listaProdutos;
    }

    try {
        obterCredenciais();
        logger.info('Iniciando coleta de produtos na API da Shopee...');

        if (!Array.isArray(estadoPaginacao.categorias) || estadoPaginacao.categorias.length === 0) {
            estadoPaginacao.categorias = await buscarCategoriasImpl();
            logger.info(`Shopee: ${estadoPaginacao.categorias.length} categoria(s) disponível(is).`);
        }

        if (quantidadeShopee === 0 && estadoPaginacao.categoriaConcluida) {
            concluirCategoria(estadoPaginacao, estadoPaginacao.categorias.length);
            estadoPaginacao.categoriaConcluida = false;
        }

        const categoria = selecionarCategoria(estadoPaginacao.categorias, estadoPaginacao);
        categoriasTentadas.add(categoria.id);
        logger.info(`Shopee: coletando a categoria "${categoria.nome}".`);

        const chavesExistentes = new Set(
            listaProdutos
                .filter(produto => produto?.origem === 'shopee')
                .map(gerarChaveProduto)
        );
        let pagina = estadoPaginacao.paginasPorCategoria[categoria.id] || 1;
        let continuar = true;
        let paginasComErroConsecutivas = 0;
        const itensAdicionados = [];

        while (quantidadeShopee < limite && continuar) {
            let resultadoPagina;
            try {
                resultadoPagina = await buscarPaginaImpl(pagina, TAMANHO_PAGINA, categoria.id);
            } catch (error) {
                const erroSistema = Array.isArray(error.codigosApi)
                    && error.codigosApi.length > 0
                    && error.codigosApi.every(codigo => codigo === 10000);
                if (!erroSistema) throw error;

                paginasComErroConsecutivas += 1;
                const paginaComErro = pagina;
                pagina += 1;
                estadoPaginacao.paginasPorCategoria[categoria.id] = pagina;
                logger.error(
                    `Shopee: erro 10000 na categoria "${categoria.nome}" (ID ${categoria.id}), `
                    + `página ${paginaComErro}; próxima página: ${pagina}. `
                    + `Falhas consecutivas: ${paginasComErroConsecutivas}/${MAX_PAGINAS_COM_ERRO_CONSECUTIVAS}. `
                    + `Causa: ${error.message}, stack: ${error.stack}`
                );

                if (paginasComErroConsecutivas >= MAX_PAGINAS_COM_ERRO_CONSECUTIVAS) {
                    logger.warn(
                        `Shopee: limite de ${MAX_PAGINAS_COM_ERRO_CONSECUTIVAS} páginas com erro consecutivas `
                        + `atingido na categoria "${categoria.nome}". Encerrando a tentativa desta categoria.`
                    );
                    break;
                }
                continue;
            }
            paginasComErroConsecutivas = 0;
            const { produtos, temProximaPagina } = resultadoPagina;

            logger.info(`Shopee: página ${pagina} retornou ${produtos.length} produto(s).`);

            estadoPaginacao.paginasPorCategoria[categoria.id] = temProximaPagina
                ? pagina + 1
                : 1;

            for (const produtoBruto of produtos) {
                if (quantidadeShopee >= limite) {
                    break;
                }

                const produto = normalizarProduto(produtoBruto, categoria.nome);
                if (!produto) {
                    logger.warn('Shopee: produto ignorado por não possuir título, preço, link ou imagem válida.');
                    continue;
                }

                const chave = gerarChaveProduto(produto);
                if (chavesExistentes.has(chave)) {
                    logger.warn('Shopee: produto duplicado ignorado durante a coleta.');
                    continue;
                }

                chavesExistentes.add(chave);
                listaProdutos.push(produto);
                itensAdicionados.push(produto);
                quantidadeShopee += 1;
            }

            continuar = temProximaPagina && produtos.length > 0;
            pagina = estadoPaginacao.paginasPorCategoria[categoria.id];
        }

        if (quantidadeShopee < limite) {
            if (quantidadeShopeeInicial === 0) {
                for (const produto of itensAdicionados) {
                    const indice = listaProdutos.lastIndexOf(produto);
                    if (indice !== -1) {
                        listaProdutos.splice(indice, 1);
                    }
                }

                logger.warn(
                    `Shopee: categoria "${categoria.nome}" não completou a cota e será ignorada neste ciclo.`
                );
                estadoPaginacao.categoriaConcluida = true;

                if (categoriasTentadas.size < estadoPaginacao.categorias.length) {
                    return automatizarPagina(listaProdutos, {
                        buscarCategoriasImpl,
                        buscarPaginaImpl,
                        categoriasTentadas,
                        estadoPaginacao,
                        limite
                    });
                }

                throw new Error(
                    `Nenhuma das ${estadoPaginacao.categorias.length} categorias da Shopee `
                    + `completou a cota de ${limite} produto(s).`
                );
            }

            throw new Error(
                `A API da Shopee retornou apenas ${quantidadeShopee}/${limite} produto(s) válidos.`
            );
        }

        estadoPaginacao.categoriaConcluida = true;
        logger.info(`Coleta da Shopee concluída com ${limite} produto(s).`);

        return listaProdutos;
    } catch (error) {
        logger.error(`Coleta da Shopee interrompida: ${error.message}`);
        throw error;
    }
}

module.exports = {
    automatizarPagina,
    buscarCategorias,
    buscarPagina,
    criarEstadoPaginacao,
    formatarPreco,
    gerarHeaders,
    normalizarProduto,
    selecionarCategoria
};

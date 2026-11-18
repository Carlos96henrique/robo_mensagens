const puppeteer = require('puppeteer');
const logger = require('./gerenciador-log');
const { URL_AFILIADOS, opcoesNavegadorMercadoLivre } = require('./navegador-mercado-livre');

const CLASS_NAME = 'coletor';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIMITE_PADRAO = 10;
const DELAY_CLICK = 1000;
const DELAY_CARREGAMENTO_MS = 2000;
const MAX_TENTATIVAS_CARREGAMENTO = 3;
const MAX_TENTATIVAS_FILTROS = 2;
const normalizarTexto = texto => texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const estadoNavegacaoPadrao = criarEstadoNavegacao();

function criarEstadoNavegacao() {
    return {
        categorias: null,
        categoriaAtual: null,
        categoriaConcluida: false,
        proximoIndiceCategoria: 0,
        proximosIndicesPorCategoria: {}
    };
}

function obterProximoCard(cards, estadoNavegacao, categoria) {
    if (!Array.isArray(cards)) {
        throw new Error('A lista de cards do Mercado Livre é inválida.');
    }
    const indiceAtual = estadoNavegacao?.proximosIndicesPorCategoria?.[categoria] ?? 0;
    if (!categoria || !Number.isInteger(indiceAtual) || indiceAtual < 0) {
        throw new Error('O estado de navegação do Mercado Livre é inválido.');
    }

    if (indiceAtual >= cards.length) {
        return null;
    }

    const card = cards[indiceAtual];
    estadoNavegacao.proximosIndicesPorCategoria[categoria] = indiceAtual + 1;
    return card;
}

function selecionarCategoria(categorias, estadoNavegacao) {
    if (!Array.isArray(categorias) || categorias.length === 0) {
        throw new Error('A lista de categorias do Mercado Livre é inválida.');
    }

    // Limita a busca a uma volta se só houver categorias sem produtos.
    for (let tentativa = 0; tentativa < categorias.length; tentativa += 1) {
        const indice = estadoNavegacao.proximoIndiceCategoria % categorias.length;
        const categoria = estadoNavegacao.categoriaAtual || categorias[indice];

        if (!['cupons', 'ingressos'].includes(normalizarTexto(categoria.nome))) {
            estadoNavegacao.categoriaAtual = categoria;
            return categoria;
        }

        logger.info(`Mercado Livre: categoria "${categoria.nome}" ignorada porque não contém produtos.`);
        concluirCategoria(estadoNavegacao, categorias.length);
        estadoNavegacao.categoriaConcluida = false;
    }

    throw new Error('Nenhuma categoria de produtos disponível no Mercado Livre após ignorar "Cupons" e "Ingressos".');
}

function concluirCategoria(estadoNavegacao, quantidadeCategorias) {
    estadoNavegacao.proximoIndiceCategoria =
        (estadoNavegacao.proximoIndiceCategoria + 1) % quantidadeCategorias;
    estadoNavegacao.categoriaAtual = null;
}

function gerarChaveProduto(produto) {
    return produto?.link?.trim() || null;
}

// Executada no navegador tanto para esperar quanto para clicar no mesmo alvo.
function interagirComElementoPorTexto(valor, config, clicar = false) {
    const normalizar = conteudo => conteudo
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const visivel = elemento => {
        const estilos = window.getComputedStyle(elemento);
        const retangulo = elemento.getBoundingClientRect();

        return estilos.visibility !== 'hidden'
            && estilos.display !== 'none'
            && retangulo.width > 0
            && retangulo.height > 0;
    };

    const prioridadeElemento = elemento => {
        if (elemento.matches('button, [role="button"]')) {
            return 0;
        }

        if (elemento.matches('label, [role="option"], [role="menuitemcheckbox"]')) {
            return 1;
        }

        if (elemento.matches('li')) {
            return 2;
        }

        if (elemento.matches('span, div')) {
            return 3;
        }

        return 4;
    };

    const elementos = Array.from(document.querySelectorAll(config.seletores));
    const candidatos = elementos.filter(elemento => {
        const textoElemento = normalizar(elemento.innerText || elemento.textContent || '');
        const deveIgnorar = config.seletorIgnorar && elemento.matches(config.seletorIgnorar);
        const clicavel = elemento.closest('button, [role="button"], label, li, [role="option"], [role="menuitemcheckbox"]') || elemento;

        if (!textoElemento || !visivel(elemento) || deveIgnorar) {
            return false;
        }

        if (clicavel.closest('.poly-card')) {
            return false;
        }

        if (elemento.closest('a') || clicavel.disabled
            || clicavel.getAttribute('aria-disabled') === 'true') {
            return false;
        }

        return config.correspondenciaExata
            ? textoElemento === valor
            : textoElemento.includes(valor);
    });

    if (candidatos.length === 0) {
        return false;
    }

    if (!clicar) return true;

    candidatos.sort((primeiro, segundo) => {
        const prioridadePrimeiro = prioridadeElemento(primeiro);
        const prioridadeSegundo = prioridadeElemento(segundo);

        if (prioridadePrimeiro !== prioridadeSegundo) {
            return prioridadePrimeiro - prioridadeSegundo;
        }

        return primeiro.getBoundingClientRect().top - segundo.getBoundingClientRect().top;
    });

    const alvo = candidatos[0];
    const elementoClicavel = alvo.closest('button, [role="button"], label, li, [role="option"], [role="menuitemcheckbox"]') || alvo;
    elementoClicavel.scrollIntoView({ block: 'center', inline: 'center' });
    elementoClicavel.click();
    return true;
}

async function clicarElementoPorTexto(page, texto, {
    timeout = 15000,
    correspondenciaExata = true,
    seletores = 'button, [role="button"], label, li, span, div',
    seletorIgnorar = '.poly-card, .poly-card *'
} = {}) {
    const textoNormalizado = normalizarTexto(texto);
    const config = { correspondenciaExata, seletores, seletorIgnorar };

    try {
        await page.waitForFunction(interagirComElementoPorTexto, { timeout }, textoNormalizado, config);
        const clicou = await page.evaluate(interagirComElementoPorTexto, textoNormalizado, config, true);
        if (!clicou) {
            const erro = new Error(`O elemento "${texto}" deixou de estar disponível para clique.`);
            erro.code = 'ELEMENTO_INDISPONIVEL';
            throw erro;
        }
    } catch (cause) {
        if (cause.name !== 'TimeoutError' && cause.code !== 'ELEMENTO_INDISPONIVEL') throw cause;
        const erro = new Error(`Não foi possível clicar em "${texto}": elemento visível e habilitado não encontrado (limite de ${timeout} ms).`, { cause });
        erro.code = 'ELEMENTO_INDISPONIVEL';
        throw erro;
    }

    await delay(DELAY_CLICK);
}

async function listarCategoriasVisiveis(page) {
    const categorias = await page.evaluate(() => {
        const seletor = 'label, li, [role="option"], [role="menuitemcheckbox"]';
        const visivel = elemento => {
            const estilos = window.getComputedStyle(elemento);
            const retangulo = elemento.getBoundingClientRect();
            return estilos.visibility !== 'hidden'
                && estilos.display !== 'none'
                && retangulo.width > 0
                && retangulo.height > 0;
        };

        return Array.from(document.querySelectorAll(seletor))
            .filter(elemento => visivel(elemento) && !elemento.querySelector(seletor))
            .map(elemento => (elemento.innerText || elemento.textContent || '').trim())
            .filter(Boolean);
    });
    const categoriasUnicas = [];
    const nomesEncontrados = new Set();

    for (const nomeBruto of categorias) {
        const nome = nomeBruto.replace(/\s+/g, ' ').trim();
        const nomeComparacao = normalizarTexto(nome);

        if (!nome || ['categorias', 'todos', 'todas'].includes(nomeComparacao)
            || nomesEncontrados.has(nomeComparacao)) {
            continue;
        }

        nomesEncontrados.add(nomeComparacao);
        categoriasUnicas.push({ nome });
    }

    if (categoriasUnicas.length === 0) {
        throw new Error('Nenhuma categoria foi encontrada na área de afiliados do Mercado Livre.');
    }

    return categoriasUnicas;
}

async function configurarFiltrosAfiliados(page, estadoNavegacao) {
    logger.info('Aplicando filtro "Mais vendidos"...');
    await clicarElementoPorTexto(page, 'Mais vendidos');

    logger.info('Abrindo menu "Categorias"...');
    await clicarElementoPorTexto(page, 'Categorias', {
        seletores: 'button, [role="button"], label, span, div'
    });

    if (!Array.isArray(estadoNavegacao.categorias) || estadoNavegacao.categorias.length === 0) {
        estadoNavegacao.categorias = await listarCategoriasVisiveis(page);
        logger.info(
            `Mercado Livre: ${estadoNavegacao.categorias.length} categoria(s) disponível(is).`
        );
    }

    const categoria = selecionarCategoria(estadoNavegacao.categorias, estadoNavegacao);
    logger.info(`Selecionando categoria "${categoria.nome}"...`);
    try {
        await clicarElementoPorTexto(page, categoria.nome, {
            seletores: 'label, li, [role="option"], [role="menuitemcheckbox"], button, span, div'
        });
    } catch (error) {
        if (error.code === 'ELEMENTO_INDISPONIVEL') error.categoria = categoria;
        throw error;
    }
    await delay(DELAY_CLICK);

    return categoria;
}

function paginaDeAutenticacao(url) {
    const { hostname, pathname } = new URL(url);
    return /(?:^|\.)mercadoli(?:vre|bre)\.com(?:\.br)?$/.test(hostname)
        && (/^(?:login|auth)\./.test(hostname)
            || /^\/jms\/mlb\/lgz(?:\/|$)/.test(pathname)
            || /\/(?:login|account-verification)(?:\/|$)/.test(pathname));
}

async function abrirAfiliados(page) {
    const opcoesNavegacao = { waitUntil: 'domcontentloaded' };
    await page.goto(URL_AFILIADOS, opcoesNavegacao);
    if (!paginaDeAutenticacao(page.url())) return;

    logger.warn('Mercado Livre: faça login na aba do Chromium. A coleta será retomada quando a área de afiliados abrir. Se necessário, abra Afiliados nessa mesma aba.');
    const { origin, pathname } = new URL(URL_AFILIADOS);
    const caminhosInicio = ['/', '/home', '/home/'];

    do {
        const retorno = await page.waitForFunction((origem, caminho, inicios) => {
            const { origin, pathname } = window.location;
            return origin === origem && (inicios.includes(pathname)
                || pathname === caminho || pathname.startsWith(`${caminho}/`));
        }, { timeout: 0, polling: 500 }, origin, pathname, caminhosInicio);
        await retorno.dispose();

        if (caminhosInicio.includes(new URL(page.url()).pathname)) {
            await page.goto(URL_AFILIADOS, opcoesNavegacao);
        }
    } while (paginaDeAutenticacao(page.url()));
}

async function carregarAfiliadosComFiltros(page, estadoNavegacao) {
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_FILTROS; tentativa += 1) {
        await abrirAfiliados(page);
        logger.info('Página carregada com sucesso!');

        try {
            const categoria = await configurarFiltrosAfiliados(page, estadoNavegacao);
            logger.info('Filtros iniciais aplicados com sucesso!');
            return categoria;
        } catch (error) {
            if (error.code !== 'ELEMENTO_INDISPONIVEL') throw error;
            if (tentativa === MAX_TENTATIVAS_FILTROS) {
                if (error.categoria) error.code = 'CATEGORIA_INDISPONIVEL';
                throw error;
            }
            logger.warn(`Mercado Livre: ${error.message} Recarregando a página para tentar os filtros novamente (${tentativa}/${MAX_TENTATIVAS_FILTROS}).`);
        }
    }
}

async function carregarMaisCards(page, quantidadeAtual, delayImpl = delay) {
    let cards = [];

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CARREGAMENTO; tentativa += 1) {
        await page.evaluate(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        });
        await delayImpl(DELAY_CARREGAMENTO_MS);
        cards = await page.$$('.poly-card');

        if (cards.length > quantidadeAtual) {
            logger.info(
                `Mercado Livre carregou mais resultados: ${quantidadeAtual} -> ${cards.length} cards.`
            );
            return cards;
        }

        logger.info(
            `Aguardando novos cards do Mercado Livre (${tentativa}/${MAX_TENTATIVAS_CARREGAMENTO}).`
        );
    }

    return cards;
}

async function coletarProduto(page, card) {
    const titulo = await card.$eval('.poly-component__title', el => el.innerText);
    const preco = await card.$eval('.poly-price__current', el => el.innerText);
    const imagemUrl = await card.$eval('img', imagem => {
        const candidatos = [
            imagem.currentSrc,
            imagem.src,
            imagem.getAttribute('data-src'),
            imagem.getAttribute('data-lazy'),
            imagem.getAttribute('srcset')?.split(',')[0]?.trim().split(' ')[0]
        ];

        for (const candidato of candidatos) {
            if (!candidato || candidato.startsWith('data:') || candidato.startsWith('blob:')) {
                continue;
            }

            try {
                const url = new URL(candidato, window.location.href);
                if (['http:', 'https:'].includes(url.protocol)) {
                    return url.href;
                }
            } catch {
                // Continua procurando outro atributo de imagem.
            }
        }

        return null;
    }).catch(() => null);
    const botao = await card.$('.andes-button');

    if (!botao || !imagemUrl) {
        return null;
    }

    await delay(5000);
    await botao.click();

    await delay(1000);
    await page.click('#copy_link');
    await delay(1000);

    const link = await page.evaluate(async () => {
        return navigator.clipboard.readText();
    });

    await delay(1000);
    const botaoFecharModal = await page.$('.andes-modal__close-button');
    if (botaoFecharModal) {
        await botaoFecharModal.click();
    }

    return {
        titulo,
        preco,
        link,
        imagemUrl,
        origem: 'mercado-livre'
    };
}

async function prepararPaginaColeta(browser) {
    // Se o navegador abrir ou restaurar abas, mantém apenas a primeira.
    const paginas = await browser.pages();
    const page = paginas[0] || await browser.newPage();

    for (const excedente of paginas.slice(1)) {
        await excedente.close({ runBeforeUnload: false });
    }

    return page;
}

async function encerrarNavegador(browser) {
    try {
        // Fecha as abas antes do navegador para não deixá-las na sessão aberta.
        const paginas = await browser.pages();
        const resultados = await Promise.allSettled(
            paginas.map(page => page.close({ runBeforeUnload: false }))
        );
        if (resultados.some(resultado => resultado.status === 'rejected')) {
            logger.warn('Mercado Livre: falha ao fechar aba; encerrando o navegador completo.');
        }
    } catch (error) {
        logger.warn('Mercado Livre: não foi possível listar as abas ao encerrar.');
    } finally {
        // A falha na limpeza de uma aba não pode impedir o fechamento do processo.
        await browser.close();
    }
}

async function automatizarPagina(listaProdutos, {
    estadoNavegacao = estadoNavegacaoPadrao,
    limite = LIMITE_PADRAO
} = {}) {
    if (!Array.isArray(listaProdutos)) {
        throw new Error('A fila de produtos do Mercado Livre é inválida.');
    }
    if (!Number.isInteger(limite) || limite <= 0) {
        throw new Error('O limite de produtos do Mercado Livre deve ser um número inteiro positivo.');
    }
    if (!Number.isInteger(estadoNavegacao?.proximoIndiceCategoria)
        || estadoNavegacao.proximoIndiceCategoria < 0
        || typeof estadoNavegacao.categoriaConcluida !== 'boolean'
        || typeof estadoNavegacao.proximosIndicesPorCategoria !== 'object') {
        throw new Error('O estado de navegação do Mercado Livre é inválido.');
    }

    logger.info('Iniciando automação da página...');
    const fila = listaProdutos;
    let quantidadeMercadoLivre = fila.filter(
        produto => produto?.origem === 'mercado-livre'
    ).length;
    const chavesExistentes = new Set(
        fila
            .filter(produto => produto?.origem === 'mercado-livre')
            .map(gerarChaveProduto)
            .filter(Boolean)
    );

    if (quantidadeMercadoLivre >= limite) {
        logger.info(`Cota do Mercado Livre já atingiu o limite de ${limite} itens.`);
        return fila;
    }

    let browser;

    try {
        if (quantidadeMercadoLivre === 0 && estadoNavegacao.categoriaConcluida) {
            concluirCategoria(estadoNavegacao, estadoNavegacao.categorias.length);
            estadoNavegacao.categoriaConcluida = false;
        }

        browser = await puppeteer.launch(opcoesNavegadorMercadoLivre());
        const page = await prepararPaginaColeta(browser);
        const categoriasTentadas = new Set();

        while (quantidadeMercadoLivre < limite) {
            let categoria;
            let categoriaIndisponivel = false;
            try {
                categoria = await carregarAfiliadosComFiltros(page, estadoNavegacao);
            } catch (error) {
                if (error.code !== 'CATEGORIA_INDISPONIVEL') throw error;
                categoria = error.categoria;
                categoriaIndisponivel = true;
                logger.warn(`Mercado Livre: ${error.message} Categoria ignorada após ${MAX_TENTATIVAS_FILTROS} tentativas.`);
            }
            categoriasTentadas.add(categoria.nome);
            let cards = categoriaIndisponivel ? [] : await page.$$('.poly-card');

            while (!categoriaIndisponivel && quantidadeMercadoLivre < limite) {
                const card = obterProximoCard(cards, estadoNavegacao, categoria.nome);

                if (!card) {
                    const quantidadeAnterior = cards.length;
                    cards = await carregarMaisCards(page, quantidadeAnterior);

                    if (cards.length <= quantidadeAnterior) {
                        break;
                    }
                    continue;
                }

                try {
                    const produto = await coletarProduto(page, card);
                    if (!produto) {
                        continue;
                    }

                    produto.categoria = categoria.nome;

                    const chave = gerarChaveProduto(produto);
                    if (chave && chavesExistentes.has(chave)) {
                        logger.warn('Mercado Livre: produto duplicado ignorado durante a coleta.');
                        continue;
                    }

                    fila.push(produto);
                    if (chave) {
                        chavesExistentes.add(chave);
                    }
                    quantidadeMercadoLivre += 1;
                    logger.info(
                        `Produto do Mercado Livre coletado. Cota: ${quantidadeMercadoLivre}/${limite}`
                    );
                } catch (error) {
                    logger.warn(`Falha ao coletar card: ${error.message}`);
                }
            }

            if (quantidadeMercadoLivre >= limite) {
                break;
            }

            // Descarta também resíduos desta categoria deixados por ciclos anteriores.
            let descartados = 0;
            for (let indice = fila.length - 1; indice >= 0; indice -= 1) {
                const produto = fila[indice];
                if (produto?.origem === 'mercado-livre'
                    && normalizarTexto(produto.categoria || '') === normalizarTexto(categoria.nome)) {
                    fila.splice(indice, 1);
                    descartados += 1;
                }
            }
            const produtosRestantes = fila.filter(produto => produto?.origem === 'mercado-livre');
            quantidadeMercadoLivre = produtosRestantes.length;
            chavesExistentes.clear();
            for (const produto of produtosRestantes) {
                const chave = gerarChaveProduto(produto);
                if (chave) chavesExistentes.add(chave);
            }

            logger.warn(
                `Mercado Livre: categoria "${categoria.nome}" não completou a cota de ${limite}; `
                + `${descartados} produto(s) descartado(s). Avançando para a próxima categoria.`
            );
            estadoNavegacao.proximosIndicesPorCategoria[categoria.nome] = 0;
            concluirCategoria(estadoNavegacao, estadoNavegacao.categorias.length);
            estadoNavegacao.categoriaConcluida = false;

            const proximaCategoria = selecionarCategoria(estadoNavegacao.categorias, estadoNavegacao);
            if (categoriasTentadas.has(proximaCategoria.nome)) {
                throw new Error(`Nenhuma categoria do Mercado Livre completou a cota de ${limite} produto(s) neste ciclo.`);
            }
        }

        estadoNavegacao.categoriaConcluida = true;
        logger.info(`Cota do Mercado Livre atingida (${limite}). Coleta concluída.`);
    } catch (error) {
        const etapa = browser ? 'preparar a aba ou coletar ofertas' : 'inicializar o navegador';
        logger.error(`Mercado Livre (${CLASS_NAME}): falha ao ${etapa}: ${error.message}, stack: ${error.stack}`);
        throw error;
    } finally {
        if (browser) {
            await encerrarNavegador(browser);
        }
    }

    logger.info(
        `Coleta do Mercado Livre finalizada com ${quantidadeMercadoLivre} produto(s) da origem.`
    );
    return fila;
}

module.exports = {
    automatizarPagina,
    clicarElementoPorTexto,
    carregarMaisCards,
    criarEstadoNavegacao,
    listarCategoriasVisiveis,
    obterProximoCard,
    selecionarCategoria
};

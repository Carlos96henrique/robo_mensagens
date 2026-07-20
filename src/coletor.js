const puppeteer = require('puppeteer');
const logger = require('./gerenciador-log');

const CLASS_NAME = 'coletor';
const URL_AFILIADOS = 'https://www.mercadolivre.com.br/afiliados';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIMITE_FILA = 50;

async function coletarProduto(page, card) {
    const titulo = await card.$eval('.poly-component__title', el => el.innerText);
    const preco = await card.$eval('.poly-price__current', el => el.innerText);
    const botao = await card.$('.andes-button');

    if (!botao) {
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

    return { titulo, preco, link };
}

async function automatizarPagina(listaProdutos) {
    logger.info('Iniciando automação da página...');
    const fila = Array.isArray(listaProdutos) ? listaProdutos : [];
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: false,
            userDataDir: './perfil'
        });
        const page = await browser.newPage();
        await page.goto(URL_AFILIADOS, { waitUntil: 'networkidle2' });

        logger.info('Página carregada com sucesso!');

        while (fila.length < LIMITE_FILA) {
            const cards = await page.$$('.poly-card');
            if (cards.length === 0) {
                logger.warn('Nenhum card encontrado. Recarregando página...');
                await page.reload({ waitUntil: 'networkidle2' });
                continue;
            }

            for (const card of cards) {
                if (fila.length >= LIMITE_FILA) {
                    break;
                }

                try {
                    const produto = await coletarProduto(page, card);
                    if (!produto) {
                        continue;
                    }

                    fila.push(produto);
                    logger.info(`Produto coletado. Itens na fila: ${fila.length}/${LIMITE_FILA}`);
                } catch (error) {
                    logger.warn(`Falha ao coletar card: ${error.message}`);
                }
            }

            if (fila.length < LIMITE_FILA) {
                logger.info('Fim dos elementos da página atual. Recarregando para continuar coleta...');
                await page.reload({ waitUntil: 'networkidle2' });
            }
        }

        logger.info(`Limite da fila atingido (${LIMITE_FILA}). Coleta pausada até a fila zerar.`);
    } catch (error) {
        logger.error(`Ocorreu um erro: ${CLASS_NAME}`);
        logger.error(`Erro ao automatizar ao capturar link: ${error.message}, stack: ${error.stack}`);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }

    logger.info(`Coleta finalizada com ${fila.length} produto(s).`);
    return fila;
}

module.exports = {
    automatizarPagina
}

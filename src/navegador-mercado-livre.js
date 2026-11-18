const { isAbsolute, resolve } = require('node:path');
const puppeteer = require('puppeteer').default;
require('./configuracao-ambiente');

const URL_AFILIADOS = 'https://www.mercadolivre.com.br/afiliados';

async function opcoesNavegadorMercadoLivre() {
    const chrome = process.env.MERCADO_LIVRE_CHROME?.trim();
    const opcoes = {
        headless: false,
        userDataDir: './perfil',
        defaultViewport: null,
        args: ['--window-size=1600,900']
    };
    if (!chrome) return opcoes;

    if (chrome !== 'instalado' && !isAbsolute(chrome)) {
        throw new Error('Configure MERCADO_LIVRE_CHROME como instalado ou informe o caminho absoluto do executável do Chrome.');
    }

    return {
        ...opcoes,
        executablePath: chrome === 'instalado' ? await puppeteer.executablePath('chrome') : chrome,
        userDataDir: resolve(__dirname, '../perfil/chrome-instalado'),
        // O Chrome abre a aba de coleta pelo argumento de linha de comando.
        waitForInitialPage: false,
        args: [...opcoes.args, URL_AFILIADOS],
        // Usa o mesmo armazenamento do sistema nos dois modos para ler a sessão salva pelo Chrome.
        ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain']
    };
}

module.exports = { URL_AFILIADOS, opcoesNavegadorMercadoLivre };

const { isAbsolute, resolve } = require('node:path');
const puppeteer = require('puppeteer');
require('./configuracao-ambiente');

const URL_AFILIADOS = 'https://www.mercadolivre.com.br/afiliados';
const URL_ABA_INICIAL = `data:text/html;charset=utf-8,${encodeURIComponent('<title>Mercado Livre</title><p>Abrindo a área de afiliados…</p>')}`;

function opcoesNavegadorMercadoLivre() {
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
        executablePath: chrome === 'instalado' ? puppeteer.executablePath('chrome') : chrome,
        userDataDir: resolve(__dirname, '../perfil/chrome-instalado'),
        // O Chrome abre a aba de coleta pelo argumento de linha de comando.
        waitForInitialPage: false,
        args: [...opcoes.args, URL_ABA_INICIAL],
        // Usa o mesmo armazenamento do sistema nos dois modos para ler a sessão salva pelo Chrome.
        ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain']
    };
}

module.exports = { URL_AFILIADOS, URL_ABA_INICIAL, opcoesNavegadorMercadoLivre };

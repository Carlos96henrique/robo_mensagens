const { isAbsolute, resolve } = require('node:path');
const puppeteer = require('puppeteer');
require('./configuracao-ambiente');

const URL_AFILIADOS = 'https://www.mercadolivre.com.br/afiliados';

function opcoesNavegadorMercadoLivre() {
    const chrome = process.env.MERCADO_LIVRE_CHROME?.trim();
    if (!chrome) return { userDataDir: './perfil' };

    if (chrome !== 'instalado' && !isAbsolute(chrome)) {
        throw new Error('Configure MERCADO_LIVRE_CHROME como instalado ou informe o caminho absoluto do executável do Chrome.');
    }

    return {
        executablePath: chrome === 'instalado' ? puppeteer.executablePath('chrome') : chrome,
        userDataDir: resolve(__dirname, '../perfil/chrome-instalado'),
        // Usa o mesmo armazenamento do sistema nos dois modos para ler a sessão salva pelo Chrome.
        ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain']
    };
}

module.exports = { URL_AFILIADOS, opcoesNavegadorMercadoLivre };

const { spawnSync } = require('node:child_process');
const { URL_AFILIADOS, opcoesNavegadorMercadoLivre } = require('./navegador-mercado-livre');

try {
    const { executablePath, userDataDir } = opcoesNavegadorMercadoLivre();
    if (!executablePath) {
        throw new Error('Defina MERCADO_LIVRE_CHROME=instalado no .env para usar o perfil de login manual.');
    }

    console.log('Faça login no Mercado Livre e encerre esta instância do Chrome antes de iniciar o robô.');
    const { error, status, signal } = spawnSync(executablePath, [
        `--user-data-dir=${userDataDir}`,
        new URL(URL_AFILIADOS).origin
    ], { stdio: 'inherit' });

    if (error) throw error;
    if (status !== 0) throw new Error(`O Chrome encerrou com ${signal || `código ${status}`}.`);
} catch (error) {
    console.error(`Mercado Livre: ${error.message}`);
    process.exitCode = 1;
}

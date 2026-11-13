const express = require('express');
const disparador = require('./disparador');
const coletorMercadoLivre = require('./coletor');
const coletorShopee = require('./coletor-shopee');
const Embaralhador = require('./embaralhador');
const { LIMITE_POR_LOJA, validarLote } = require('./lote');

const app = express();

app.use(express.json());

const listaMensagens = [];
const INTERVALO_APOS_ERRO_MS = 60000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function iniciarCicloContinuo() {
    while (true) {
        try {
            await coletorShopee.automatizarPagina(listaMensagens, {
                limite: LIMITE_POR_LOJA
            });
            await coletorMercadoLivre.automatizarPagina(listaMensagens, {
                limite: LIMITE_POR_LOJA
            });

            validarLote(listaMensagens);
            const itensEmbaralhados = Embaralhador.embaralhar(listaMensagens);
            listaMensagens.splice(0, listaMensagens.length, ...itensEmbaralhados);

            await disparador.executar(listaMensagens);
        } catch (error) {
            console.error('Erro no ciclo do coletor/disparador:', error);
            console.error(`Nova tentativa em ${INTERVALO_APOS_ERRO_MS / 1000} segundos.`);
            await delay(INTERVALO_APOS_ERRO_MS);
        }
    }
}

iniciarCicloContinuo();

console.log('Aplicação iniciada com sucesso!');

module.exports = app;

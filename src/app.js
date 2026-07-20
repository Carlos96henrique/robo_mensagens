const express = require('express');
const disparador = require('./disparador');
const coletor = require('./coletor');

const app = express();

app.use(express.json());

const listaMensagens = [];

async function iniciarCicloContinuo() {
    while (true) {
        try {
            await coletor.automatizarPagina(listaMensagens);
            await disparador.executar(listaMensagens);
        } catch (error) {
            console.error('Erro no ciclo do coletor/disparador:', error);
        }
    }
}

iniciarCicloContinuo();

console.log('Aplicação iniciada com sucesso!');

module.exports = app;

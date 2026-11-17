const express = require('express');
const { iniciarCicloContinuo } = require('./ciclo');

const app = express();

app.use(express.json());

const listaMensagens = [];
iniciarCicloContinuo(listaMensagens);

console.log('Aplicação iniciada com sucesso!');

module.exports = app;

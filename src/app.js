const express = require('express');
const disparador = require('./disparador');

const app = express();

app.use(express.json());

disparador.executar().then(() => {
      console.log('Disparador finalizado com sucesso.');
      process.exit(0);
  }).catch(error => {
      console.error('Erro no disparador:', error);
      process.exit(1);
  });

console.log('Aplicação iniciada com sucesso!');

module.exports = app;
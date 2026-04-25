const app = require('./src/app');

app.loisten(3000, () => {
    console.log('Servidor rodando na porta 3000');
});
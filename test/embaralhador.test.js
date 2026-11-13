const test = require('node:test');
const assert = require('node:assert/strict');

const Embaralhador = require('../src/embaralhador');

test('embaralha uma cópia da lista sem perder nem duplicar itens', () => {
    const itens = ['a', 'b', 'c', 'd'];
    const resultado = Embaralhador.embaralhar(itens, () => 0);

    assert.deepEqual(resultado, ['b', 'c', 'd', 'a']);
    assert.deepEqual(itens, ['a', 'b', 'c', 'd']);
    assert.deepEqual([...resultado].sort(), [...itens].sort());
});

test('rejeita um valor que não seja uma lista', () => {
    assert.throws(
        () => Embaralhador.embaralhar(null),
        /lista de itens.*inválida/
    );
});

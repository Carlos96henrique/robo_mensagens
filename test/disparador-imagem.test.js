const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageMedia } = require('whatsapp-web.js');
const disparador = require('../src/disparador');

function criarHeaders(valores) {
    return {
        get(nome) {
            return valores[nome.toLowerCase()] ?? null;
        }
    };
}

test('baixa uma imagem e cria mídia real para o WhatsApp', async () => {
    const conteudo = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00
    ]);
    const fetchFalso = async () => ({
        ok: true,
        headers: criarHeaders({
            'content-type': 'application/octet-stream',
            'content-length': String(conteudo.length)
        }),
        async arrayBuffer() {
            return conteudo.buffer.slice(
                conteudo.byteOffset,
                conteudo.byteOffset + conteudo.byteLength
            );
        }
    });

    const media = await disparador.baixarImagem(
        'https://example.invalid/imagem',
        fetchFalso
    );

    assert.ok(media instanceof MessageMedia);
    assert.equal(media.mimetype, 'image/png');
    assert.equal(media.filename, 'produto.png');
    assert.equal(media.data, conteudo.toString('base64'));
});

test('rejeita conteúdo que não é imagem', async () => {
    const conteudo = Buffer.from('conteúdo HTML');
    const fetchFalso = async () => ({
        ok: true,
        headers: criarHeaders({
            'content-type': 'text/html',
            'content-length': String(conteudo.length)
        }),
        async arrayBuffer() {
            return conteudo.buffer.slice(
                conteudo.byteOffset,
                conteudo.byteOffset + conteudo.byteLength
            );
        }
    });

    await assert.rejects(
        disparador.baixarImagem('https://example.invalid/pagina', fetchFalso),
        /não é uma imagem reconhecida/
    );
});

test('rejeita produto sem URL de imagem', async () => {
    await assert.rejects(
        disparador.baixarImagem(null),
        /sem URL de imagem válida/
    );
});

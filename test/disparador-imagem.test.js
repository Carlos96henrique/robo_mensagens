const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageMedia } = require('whatsapp-web.js');
const disparador = require('../src/disparador');
const gerenciador = require('../src/gerenciador-mensagens');
const logger = require('../src/gerenciador-log');

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

for (const isolado of [false, true]) {
    test(`disparador ${isolado ? 'verifica e encerra sua própria sessão' : 'reutiliza sessão e registra a causa de cada envio que falha'}`, async t => {
        const setTimeoutOriginal = global.setTimeout;
        t.mock.method(global, 'setTimeout', (callback, ms) => setTimeoutOriginal(callback, ms >= 60000 ? 0 : ms));
        t.mock.method(logger, 'info', () => {});
        const log = t.mock.method(logger, 'error', () => {});
        const conteudo = Buffer.from([0xff, 0xd8, 0xff]);
        t.mock.method(global, 'fetch', async () => ({
            ok: true,
            headers: criarHeaders({ 'content-type': 'image/jpeg' }),
            async arrayBuffer() { return conteudo; }
        }));
        let envios = 0;
        const client = {
            async sendMessage(destino, media, opcoes) {
                assert.equal(destino, 'grupo-ficticio@g.us');
                assert.ok(media instanceof MessageMedia);
                assert.equal(opcoes.waitUntilMsgSent, true);
                envios += 1;
                if (!isolado && envios === 1) throw new Error('Falha específica do WhatsApp');
            }
        };
        const canal = { client, grupoId: 'grupo-ficticio@g.us' };
        const inicializar = t.mock.method(gerenciador, 'inicializaGerenciador', async () => client);
        const verificar = t.mock.method(gerenciador, 'verificarDisponibilidade', async recebido => {
            assert.equal(recebido, client);
            return canal;
        });
        const encerrar = t.mock.method(gerenciador, 'encerrarGerenciador', async recebido => assert.equal(recebido, client));
        const fila = ['shopee', 'mercado-livre'].flatMap(origem => Array.from({ length: 10 }, () => ({
            origem, titulo: 'Produto fictício', preco: 'R$ 10', link: 'https://example.invalid/produto',
            imagemUrl: 'https://example.invalid/imagem'
        })));
        const primeiroItem = fila[0];
        if (isolado) {
            await disparador.executar(fila);
            assert.equal(fila.length, 0);
        } else {
            await assert.rejects(disparador.executar(fila, canal), /1 de 20 envio/);
            assert.deepEqual(fila, [primeiroItem]);
            assert.match(log.mock.calls[0].arguments[0], /Falha específica do WhatsApp.*stack:/);
        }
        assert.equal(envios, 20);
        assert.equal(inicializar.mock.callCount(), isolado ? 1 : 0);
        assert.equal(verificar.mock.callCount(), isolado ? 1 : 0);
        assert.equal(encerrar.mock.callCount(), isolado ? 1 : 0);
    });
}

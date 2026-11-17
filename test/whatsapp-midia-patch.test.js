const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const caminhoUtils = require.resolve('whatsapp-web.js/src/util/Injected/Utils');

function criarAmbiente() {
    const enviadas = [];
    const conta = { _serialized: 'conta-ficticia@c.us' };
    const grupo = { id: {
        _serialized: 'grupo-ficticio@g.us',
        isLid: () => false, isGroup: () => true, isStatus: () => false
    } };
    class MsgKey {
        constructor(dados) { Object.assign(this, dados); this._serialized = 'mensagem-ficticia'; }
        static async newId() { return 'mensagem-ficticia'; }
    }
    const modulos = {
        WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
        WALinkify: { findLink: () => null },
        WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => conta, getMaybeMePnUser: () => conta },
        WAWebMsgKey: MsgKey,
        WAWebWidFactory: { asUserWidOrThrow: wid => wid },
        WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
        WAWebSendMsgChatAction: {
            addAndSendMsgToChat(chat, mensagem) {
                // O modelo do WhatsApp prioriza o armazenamento privado quando ele existe.
                const id = Object.hasOwn(mensagem, '__x_id') ? mensagem.__x_id : mensagem.id;
                if (!(id instanceof MsgKey)) {
                    throw new Error('Data passed to getter must include an id property but got undefined');
                }
                enviadas.push(mensagem);
                return [Promise.resolve(), Promise.resolve()];
            }
        },
        WAWebCollections: { Msg: { get: () => ({ id: { _serialized: 'mensagem-ficticia' }, ack: 1 }) } }
    };
    const window = { require(nome) {
        if (!(nome in modulos)) throw new Error(`Módulo não simulado: ${nome}`);
        return modulos[nome];
    } };
    const contexto = vm.createContext({ window, exports: {} });
    vm.runInContext(fs.readFileSync(caminhoUtils, 'utf8'), contexto);
    contexto.exports.LoadUtils();
    window.WWebJS.processMediaData = async () => ({
        __x_id: undefined, preview: 'imagem fictícia', clientUrl: 'blob:imagem-ficticia',
        uploadhash: 'hash-ficticio', mediaHandle: 'midia-ficticia',
        toJSON: () => ({ type: 'image', mimetype: 'image/jpeg' })
    });
    return { window, grupo, enviadas };
}

test('patch da biblioteca mantém o identificador da mensagem ao enviar imagem com legenda', async () => {
    const { window, grupo, enviadas } = criarAmbiente();
    const resultado = await window.WWebJS.sendMessage(grupo, '', {
        media: {}, caption: 'Legenda fictícia', waitUntilMsgSent: true
    });
    assert.equal(resultado.ack, 1);
    assert.equal(enviadas.length, 1);
    assert.equal(enviadas[0].caption, 'Legenda fictícia');
    assert.equal(enviadas[0].type, 'image');
    assert.equal(enviadas[0].to, grupo.id);
    assert.equal(enviadas[0].clientUrl, 'blob:imagem-ficticia');
    assert.equal(enviadas[0].uploadhash, 'hash-ficticio');
    assert.equal(enviadas[0].mediaHandle, 'midia-ficticia');
});

test('patch da biblioteca preserva o envio de texto usado na verificação inicial', async () => {
    const { window, grupo, enviadas } = criarAmbiente();
    await window.WWebJS.sendMessage(grupo, 'Texto fictício', { waitUntilMsgSent: true });
    assert.equal(enviadas.length, 1);
    assert.equal(enviadas[0].body, 'Texto fictício');
    assert.equal(enviadas[0].type, 'chat');
});

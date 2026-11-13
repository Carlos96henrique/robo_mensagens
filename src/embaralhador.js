class Embaralhador {
    static embaralhar(itens, random = Math.random) {
        if (!Array.isArray(itens)) {
            throw new Error('A lista de itens para embaralhamento é inválida.');
        }

        const itensEmbaralhados = [...itens];

        for (let indice = itensEmbaralhados.length - 1; indice > 0; indice -= 1) {
            const indiceSorteado = Math.floor(random() * (indice + 1));
            [itensEmbaralhados[indice], itensEmbaralhados[indiceSorteado]] =
                [itensEmbaralhados[indiceSorteado], itensEmbaralhados[indice]];
        }

        return itensEmbaralhados;
    }
}

module.exports = Embaralhador;

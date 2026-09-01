/**
 * Cliente PTAX do Banco Central (API Olinda) — cotações de moedas.
 *
 * ATENÇÃO — incerteza conhecida e tratada em código:
 * duas coisas não puderam ser confirmadas por fonte oficial (as páginas de
 * dados abertos do BCB não trazem exemplo literal e a API não é acessível a
 * partir do ambiente onde este código foi escrito):
 *   1. o formato das datas — fontes secundárias divergem entre MM-DD-AAAA e
 *      DD-MM-AAAA;
 *   2. o nome do parâmetro de data final — `dataFinalCotacao` ou `dataFinal`.
 * Por isso a consulta percorre as quatro combinações, para na primeira que
 * devolver boletins e informa qual funcionou em `variacaoUsada`. A primeira
 * execução real resolve a dúvida — veja o log e fixe a combinação vencedora.
 */

const OLINDA_BASE = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata";

/**
 * @typedef {Object} BoletimPtax
 * @property {number=} cotacaoCompra
 * @property {number=} cotacaoVenda
 * @property {string=} dataHoraCotacao
 * @property {string=} tipoBoletim
 */

/**
 * @typedef {Object} CotacaoMoeda
 * @property {string} moeda
 * @property {number} cotacaoCompra
 * @property {number} cotacaoVenda
 * @property {string} dataHoraCotacao
 * @property {string} tipoBoletim
 * @property {string} variacaoUsada
 */

/**
 * Formata uma data nos dois formatos candidatos aceitos pela API Olinda.
 *
 * @param {Date} data Data a formatar.
 * @returns {{mesPrimeiro: string, diaPrimeiro: string}} Ambas as variantes.
 */
export function formatarDataCandidatos(data) {
    const dia = String(data.getUTCDate()).padStart(2, "0");
    const mes = String(data.getUTCMonth() + 1).padStart(2, "0");
    const ano = String(data.getUTCFullYear());

    return {
        mesPrimeiro: `${mes}-${dia}-${ano}`,
        diaPrimeiro: `${dia}-${mes}-${ano}`,
    };
}

/**
 * Escolhe o boletim mais recente da janela, preferindo o de fechamento.
 *
 * Premissa: para valorar a carteira usamos o boletim de fechamento do último
 * dia útil disponível. Boletins de abertura e intermediários só entram se
 * nenhum fechamento existir na janela.
 *
 * @param {BoletimPtax[]} boletins Registros devolvidos pela API.
 * @returns {BoletimPtax|null} Boletim escolhido, ou null se a lista for vazia.
 */
export function escolherBoletim(boletins) {
    const validos = (boletins ?? []).filter(
        (item) => Number.isFinite(Number(item?.cotacaoVenda)) && item?.dataHoraCotacao,
    );

    if (validos.length === 0) {
        return null;
    }

    const ordenados = [...validos].sort((a, b) =>
        String(a.dataHoraCotacao).localeCompare(String(b.dataHoraCotacao)),
    );

    const fechamentos = ordenados.filter((item) => /fechamento/i.test(String(item.tipoBoletim ?? "")));

    return (fechamentos.length > 0 ? fechamentos : ordenados).at(-1) ?? null;
}

/**
 * Consulta uma janela de boletins PTAX para uma moeda.
 *
 * @param {string} moeda Código da moeda (ex.: USD, EUR).
 * @param {{diasJanela?: number, hoje?: Date, fetchImpl?: typeof fetch}} [opcoes] Ajustes.
 * @returns {Promise<CotacaoMoeda>} Cotação escolhida na janela.
 */
export async function buscarCotacaoPtax(moeda, opcoes = {}) {
    const { diasJanela = 15, hoje = new Date(), fetchImpl = fetch } = opcoes;

    const codigo = String(moeda ?? "").trim().toUpperCase();

    if (!codigo) {
        throw new Error("Nenhuma moeda foi informada à consulta PTAX.");
    }

    const inicio = new Date(hoje.getTime() - diasJanela * 24 * 60 * 60 * 1000);
    const candidatosInicio = formatarDataCandidatos(inicio);
    const candidatosFim = formatarDataCandidatos(hoje);

    // Combinações candidatas: 2 formatos de data x 2 nomes do parâmetro final.
    const tentativas = [];

    for (const nomeParametroFinal of ["dataFinalCotacao", "dataFinal"]) {
        for (const formato of ["MM-DD-AAAA", "DD-MM-AAAA"]) {
            const chave = formato === "MM-DD-AAAA" ? "mesPrimeiro" : "diaPrimeiro";

            tentativas.push({
                rotulo: `${nomeParametroFinal} + ${formato}`,
                nomeParametroFinal,
                inicio: candidatosInicio[chave],
                fim: candidatosFim[chave],
            });
        }
    }

    /** @type {string[]} */
    const diagnostico = [];

    for (const tentativa of tentativas) {
        const p = tentativa.nomeParametroFinal;
        const url =
            `${OLINDA_BASE}/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,${p}=@${p})` +
            `?@moeda='${codigo}'&@dataInicial='${tentativa.inicio}'&@${p}='${tentativa.fim}'&$format=json`;

        /** @type {Response} */
        let response;

        try {
            response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
        } catch {
            throw new Error("Não foi possível estabelecer conexão com a API do Banco Central.");
        }

        const bodyText = await response.text();

        if (!response.ok) {
            diagnostico.push(`${tentativa.rotulo}: HTTP ${response.status}`);
            continue;
        }

        let payload = null;

        try {
            payload = JSON.parse(bodyText);
        } catch {
            diagnostico.push(`${tentativa.rotulo}: resposta não-JSON`);
            continue;
        }

        const boletim = escolherBoletim(payload?.value);

        if (boletim) {
            return {
                moeda: codigo,
                cotacaoCompra: Number(boletim.cotacaoCompra),
                cotacaoVenda: Number(boletim.cotacaoVenda),
                dataHoraCotacao: String(boletim.dataHoraCotacao),
                tipoBoletim: String(boletim.tipoBoletim ?? ""),
                variacaoUsada: tentativa.rotulo,
            };
        }

        diagnostico.push(`${tentativa.rotulo}: janela sem boletim`);
    }

    throw new Error(
        `O Banco Central não retornou cotação para ${codigo} nos últimos ${diasJanela} dias (${diagnostico.join("; ")}).`,
    );
}

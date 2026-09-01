/**
 * Cliente da brapi.dev — cotações de ativos da B3.
 *
 * Documentação: https://brapi.dev/docs.mdx
 * O token é lido de BRAPI_TOKEN (variável de ambiente) e nunca aparece
 * na URL, em log ou em qualquer valor retornado por este módulo.
 */

/**
 * @typedef {Object} BrapiQuoteData
 * @property {string=} shortName
 * @property {string=} currency
 * @property {number|null=} regularMarketPrice
 * @property {number|null=} regularMarketChange
 * @property {number|null=} regularMarketChangePercent
 * @property {number|null=} regularMarketVolume
 * @property {number|null=} marketCap
 */

/**
 * @typedef {Object} BrapiQuoteResult
 * @property {string} requestedSymbol
 * @property {string} symbol
 * @property {boolean} changed
 * @property {BrapiQuoteData} data
 */

/**
 * @typedef {Object} BrapiQuoteResponse
 * @property {BrapiQuoteResult[]} results
 * @property {string=} requestedAt
 * @property {number=} took
 */

const BRAPI_QUOTE_URL = "https://brapi.dev/api/v2/stocks/quote";

/**
 * Normaliza códigos de ativos em uma lista limpa.
 *
 * @param {unknown} entrada Lista ou string separada por vírgula.
 * @returns {string[]} Códigos em maiúsculas, sem vazios e sem repetição.
 */
export function normalizarSimbolos(entrada) {
    const bruto = Array.isArray(entrada) ? entrada : String(entrada ?? "").split(",");

    const limpos = bruto
        .map((item) => String(item ?? "").trim().toUpperCase())
        .filter((item) => item.length > 0);

    return [...new Set(limpos)];
}

/**
 * Busca a cotação de um ou mais ativos da B3 em uma única chamada.
 *
 * @param {string[]} simbolos Códigos de ativos.
 * @param {{token: string, fetchImpl?: typeof fetch}} opcoes Token da brapi e cliente HTTP.
 * @returns {Promise<BrapiQuoteResult[]>} Conteúdo de results[].
 */
export async function buscarCotacoesBrapi(simbolos, { token, fetchImpl = fetch }) {
    if (!Array.isArray(simbolos) || simbolos.length === 0) {
        throw new Error("Nenhum código de ativo foi informado.");
    }

    if (!token) {
        throw new Error("A variável de ambiente BRAPI_TOKEN não está definida.");
    }

    // Vírgula literal de propósito: searchParams a converteria em %2C, e o
    // separador de listas da brapi é documentado como vírgula.
    const url = new URL(BRAPI_QUOTE_URL);
    url.search = `symbols=${simbolos.map(encodeURIComponent).join(",")}`;

    /** @type {Response} */
    let response;

    try {
        response = await fetchImpl(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
        });
    } catch {
        throw new Error("Não foi possível estabelecer conexão com a brapi.");
    }

    let bodyText;

    try {
        bodyText = await response.text();
    } catch {
        throw new Error("Não foi possível ler a resposta recebida da brapi.");
    }

    /** @type {BrapiQuoteResponse | null} */
    let payload = null;

    if (bodyText) {
        try {
            payload = JSON.parse(bodyText);
        } catch {
            throw new Error(`A brapi retornou conteúdo inválido — HTTP ${response.status}.`);
        }
    }

    if (!response.ok) {
        const mensagens = {
            400:
                simbolos.length > 1
                    ? `Os parâmetros enviados à brapi são inválidos — verifique os ${simbolos.length} códigos ou reduza a lista.`
                    : "Os parâmetros enviados à brapi são inválidos.",
            401: "Não foi possível autenticar na brapi.",
            403: "A credencial não possui acesso ao recurso solicitado.",
            404: "Nenhum dos ativos solicitados foi localizado.",
            429: "O limite temporário de consultas da brapi foi atingido.",
        };

        const mensagem =
            mensagens[response.status] ??
            (response.status >= 500
                ? "A brapi está temporariamente indisponível."
                : `A consulta à brapi falhou — HTTP ${response.status}.`);

        throw new Error(mensagem);
    }

    const results = payload?.results;

    if (!Array.isArray(results)) {
        throw new Error("A brapi não retornou a lista de resultados esperada.");
    }

    return results;
}

/**
 * Converte results[] em um mapa código solicitado -> dados da cotação.
 *
 * @param {BrapiQuoteResult[]} results Lista devolvida pela brapi.
 * @returns {Record<string, BrapiQuoteResult>} Mapa por código solicitado.
 */
export function indexarPorSimbolo(results) {
    /** @type {Record<string, BrapiQuoteResult>} */
    const mapa = {};

    for (const item of results ?? []) {
        const chave = String(item?.requestedSymbol ?? item?.symbol ?? "").trim().toUpperCase();

        if (chave && item?.data) {
            mapa[chave] = item;
        }
    }

    return mapa;
}

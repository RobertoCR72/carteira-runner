/**
 * Cliente mínimo da REST API do Airtable, restrito ao que este runner precisa:
 * listar registros de uma tabela e atualizá-los em lote.
 *
 * O Personal Access Token é lido de AIRTABLE_TOKEN e nunca é registrado em log.
 */

const AIRTABLE_API = "https://api.airtable.com/v0";

// A API do Airtable aceita no máximo 10 registros por requisição de escrita.
const MAX_REGISTROS_POR_LOTE = 10;

/**
 * @typedef {Object} RegistroAirtable
 * @property {string} id
 * @property {Record<string, unknown>} fields
 */

/**
 * Pausa a execução.
 *
 * @param {number} ms Milissegundos.
 * @returns {Promise<void>} Promessa resolvida após a pausa.
 */
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executa uma requisição autenticada contra a API do Airtable.
 *
 * @param {string} url URL completa.
 * @param {RequestInit} init Opções da requisição.
 * @param {{token: string, fetchImpl?: typeof fetch}} contexto Credencial e cliente HTTP.
 * @returns {Promise<any>} Corpo da resposta já convertido de JSON.
 */
async function requisitar(url, init, { token, fetchImpl = fetch }) {
    if (!token) {
        throw new Error("A variável de ambiente AIRTABLE_TOKEN não está definida.");
    }

    /** @type {Response} */
    let response;

    try {
        response = await fetchImpl(url, {
            ...init,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
                ...(init?.headers ?? {}),
            },
        });
    } catch {
        throw new Error("Não foi possível estabelecer conexão com o Airtable.");
    }

    const bodyText = await response.text();

    let payload = null;

    if (bodyText) {
        try {
            payload = JSON.parse(bodyText);
        } catch {
            throw new Error(`O Airtable retornou conteúdo inválido — HTTP ${response.status}.`);
        }
    }

    if (!response.ok) {
        const mensagens = {
            401: "Não foi possível autenticar no Airtable — verifique AIRTABLE_TOKEN.",
            403: "O token não tem permissão sobre esta base ou tabela.",
            404: "Base ou tabela não encontrada — verifique AIRTABLE_BASE_ID.",
            422: "O Airtable recusou os dados enviados (campo ou valor inválido).",
            429: "O limite de requisições do Airtable foi atingido.",
        };

        const detalhe = payload?.error?.message ? ` (${payload.error.message})` : "";

        throw new Error(
            (mensagens[response.status] ?? `A chamada ao Airtable falhou — HTTP ${response.status}.`) + detalhe,
        );
    }

    return payload;
}

/**
 * Lista todos os registros de uma tabela, seguindo a paginação.
 *
 * @param {{baseId: string, tableId: string, filterByFormula?: string, token: string, fetchImpl?: typeof fetch}} opcoes Parâmetros da consulta.
 * @returns {Promise<RegistroAirtable[]>} Registros encontrados.
 */
export async function listarRegistros({ baseId, tableId, filterByFormula, token, fetchImpl = fetch }) {
    /** @type {RegistroAirtable[]} */
    const registros = [];

    let offset;

    do {
        const url = new URL(`${AIRTABLE_API}/${baseId}/${tableId}`);

        if (filterByFormula) {
            url.searchParams.set("filterByFormula", filterByFormula);
        }

        url.searchParams.set("pageSize", "100");

        if (offset) {
            url.searchParams.set("offset", offset);
        }

        const payload = await requisitar(url.toString(), { method: "GET" }, { token, fetchImpl });

        registros.push(...(payload?.records ?? []));
        offset = payload?.offset;
    } while (offset);

    return registros;
}

/**
 * Atualiza registros em lotes de até 10, respeitando o limite da API.
 *
 * @param {{baseId: string, tableId: string, atualizacoes: RegistroAirtable[], token: string, fetchImpl?: typeof fetch, pausaMs?: number}} opcoes Parâmetros da escrita.
 * @returns {Promise<number>} Quantidade de registros atualizados.
 */
export async function atualizarRegistros({
    baseId,
    tableId,
    atualizacoes,
    token,
    fetchImpl = fetch,
    pausaMs = 250,
}) {
    if (!Array.isArray(atualizacoes) || atualizacoes.length === 0) {
        return 0;
    }

    let total = 0;

    for (let inicio = 0; inicio < atualizacoes.length; inicio += MAX_REGISTROS_POR_LOTE) {
        const lote = atualizacoes.slice(inicio, inicio + MAX_REGISTROS_POR_LOTE);

        const payload = await requisitar(
            `${AIRTABLE_API}/${baseId}/${tableId}`,
            {
                method: "PATCH",
                // typecast permite gravar opções de singleSelect pelo nome.
                body: JSON.stringify({ records: lote, typecast: true }),
            },
            { token, fetchImpl },
        );

        total += payload?.records?.length ?? 0;

        if (inicio + MAX_REGISTROS_POR_LOTE < atualizacoes.length) {
            await dormir(pausaMs);
        }
    }

    return total;
}

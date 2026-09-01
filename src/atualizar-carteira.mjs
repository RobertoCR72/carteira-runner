/**
 * Runner de atualização da carteira.
 *
 * Lê os ativos marcados como Ativo na tabela Ativos, cota os de Tipo = ACAO na
 * brapi e os de Tipo = MOEDA na PTAX do Banco Central, e grava o resultado de
 * volta no Airtable.
 *
 * Credenciais, todas por variável de ambiente e nunca em log:
 *   AIRTABLE_TOKEN  Personal Access Token com escopos data.records:read e :write
 *   BRAPI_TOKEN     token da brapi.dev
 *   AIRTABLE_BASE_ID   opcional, padrão appQRtll47wtmzBjR
 *   AIRTABLE_TABLE_ID  opcional, padrão tblJI93swMdRzlNG0 (Ativos)
 */

import { buscarCotacoesBrapi, indexarPorSimbolo, normalizarSimbolos } from "./brapi.mjs";
import { buscarCotacaoPtax } from "./ptax.mjs";
import { atualizarRegistros, listarRegistros } from "./airtable.mjs";
import { pathToFileURL } from "node:url";

const BASE_ID_PADRAO = "appQRtll47wtmzBjR";
const TABELA_ATIVOS_PADRAO = "tblJI93swMdRzlNG0";

// Premissa: moedas da carteira são valoradas pela cotação de VENDA do boletim
// de fechamento. Troque para "cotacaoCompra" se a sua convenção for outra.
const CAMPO_COTACAO_MOEDA = "cotacaoVenda";

/**
 * @typedef {import("./airtable.mjs").RegistroAirtable} RegistroAirtable
 */

/**
 * Arredonda para um número fixo de casas, sem depender de formatação.
 *
 * @param {number} valor Número a arredondar.
 * @param {number} [casas=2] Casas decimais.
 * @returns {number} Valor arredondado.
 */
export function arredondar(valor, casas = 2) {
    const fator = 10 ** casas;

    return Math.round((valor + Number.EPSILON) * fator) / fator;
}

/**
 * Monta as atualizações a enviar ao Airtable a partir dos dados já coletados.
 *
 * Função pura: não faz rede, não lê ambiente. É aqui que mora a regra de negócio.
 *
 * @param {RegistroAirtable[]} registros Registros da tabela Ativos.
 * @param {{cotacoesBrapi: Record<string, any>, cotacoesPtax: Record<string, any>, agoraISO: string, requestId: string, erroBrapi?: string|null}} contexto Dados coletados.
 * @returns {{atualizacoes: RegistroAirtable[], falhas: {codigo: string, mensagem: string}[]}} Atualizações e falhas por ativo.
 */
export function montarAtualizacoes(registros, contexto) {
    const { cotacoesBrapi, cotacoesPtax, agoraISO, requestId, erroBrapi = null } = contexto;

    /** @type {RegistroAirtable[]} */
    const atualizacoes = [];

    /** @type {{codigo: string, mensagem: string}[]} */
    const falhas = [];

    for (const registro of registros) {
        const campos = registro.fields ?? {};
        const codigo = String(campos.Codigo ?? "").trim().toUpperCase();
        const tipo = String(campos.Tipo ?? "").trim().toUpperCase();

        if (!codigo) {
            falhas.push({ codigo: `(registro ${registro.id})`, mensagem: "Registro sem Codigo preenchido." });
            continue;
        }

        /** @type {Record<string, unknown>} */
        const novos = {
            UltimaAtualizacao: agoraISO,
            RequestID: requestId,
        };

        let cotacao = null;
        let dataReferencia = null;
        let mensagem = "";
        let fonte = "";
        let codigoResolvido = codigo;
        let nome = null;

        if (tipo === "MOEDA") {
            fonte = "BCB_PTAX";
            const ptax = cotacoesPtax[codigo];

            if (ptax?.erro) {
                mensagem = ptax.erro;
            } else if (ptax) {
                cotacao = Number(ptax[CAMPO_COTACAO_MOEDA]);
                dataReferencia = ptax.dataHoraCotacao ?? null;
            } else {
                mensagem = "Moeda não consultada nesta execução.";
            }
        } else if (tipo === "ACAO") {
            fonte = "BRAPI";
            const item = cotacoesBrapi[codigo];

            if (erroBrapi) {
                mensagem = erroBrapi;
            } else if (item?.data) {
                cotacao = Number(item.data.regularMarketPrice);
                dataReferencia = agoraISO;
                codigoResolvido = String(item.symbol ?? codigo).toUpperCase();
                nome = item.data.shortName ?? null;
            } else {
                mensagem = "A brapi não retornou dados para este ativo.";
            }
        } else {
            mensagem = `Tipo não reconhecido: "${campos.Tipo ?? ""}".`;
        }

        if (fonte) {
            novos.Fonte = fonte;
        }

        if (cotacao !== null && Number.isFinite(cotacao)) {
            novos.CotacaoAtual = cotacao;
            novos.CodigoResolvido = codigoResolvido;

            if (dataReferencia) {
                novos.DataReferencia = dataReferencia;
            }

            if (nome && !campos.NomeAtivo) {
                novos.NomeAtivo = nome;
            }

            const quantidade = Number(campos.Quantidade);

            if (Number.isFinite(quantidade)) {
                novos.ValorAtual = arredondar(quantidade * cotacao, 2);
                novos.StatusAPI = "OK";
                novos.QualidadeDados = "OK";
                novos.MensagemAPI = "";
            } else {
                novos.StatusAPI = "AVISO";
                novos.QualidadeDados = "OK";
                novos.MensagemAPI = "Cotação obtida, mas Quantidade está vazia ou não é numérica.";
                falhas.push({ codigo, mensagem: "Quantidade ausente — ValorAtual não calculado." });
            }
        } else {
            novos.StatusAPI = "ERRO";
            novos.QualidadeDados = "ERRO";
            novos.MensagemAPI = mensagem || "Cotação indisponível.";
            falhas.push({ codigo, mensagem: novos.MensagemAPI });
        }

        atualizacoes.push({ id: registro.id, fields: novos });
    }

    return { atualizacoes, falhas };
}

/**
 * Executa a atualização completa.
 *
 * @returns {Promise<{atualizados: number, falhas: {codigo: string, mensagem: string}[]}>} Resumo da execução.
 */
export async function executar() {
    const airtableToken = process.env.AIRTABLE_TOKEN;
    const brapiToken = process.env.BRAPI_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_PADRAO;
    const tableId = process.env.AIRTABLE_TABLE_ID || TABELA_ATIVOS_PADRAO;

    if (!airtableToken) {
        throw new Error("A variável de ambiente AIRTABLE_TOKEN não está definida.");
    }

    if (!brapiToken) {
        throw new Error("A variável de ambiente BRAPI_TOKEN não está definida.");
    }

    const agoraISO = new Date().toISOString();
    const requestId = `run-${agoraISO.replace(/[:.]/g, "-")}`;

    const registros = await listarRegistros({
        baseId,
        tableId,
        filterByFormula: "{Ativo}",
        token: airtableToken,
    });

    console.log(`Ativos marcados como Ativo: ${registros.length}`);

    const acoes = normalizarSimbolos(
        registros
            .filter((r) => String(r.fields?.Tipo ?? "").toUpperCase() === "ACAO")
            .map((r) => r.fields?.Codigo),
    );

    const moedas = normalizarSimbolos(
        registros
            .filter((r) => String(r.fields?.Tipo ?? "").toUpperCase() === "MOEDA")
            .map((r) => r.fields?.Codigo),
    );

    /** @type {Record<string, any>} */
    let cotacoesBrapi = {};
    /** @type {string|null} */
    let erroBrapi = null;

    if (acoes.length > 0) {
        try {
            cotacoesBrapi = indexarPorSimbolo(await buscarCotacoesBrapi(acoes, { token: brapiToken }));
            console.log(`brapi: ${Object.keys(cotacoesBrapi).length}/${acoes.length} cotações obtidas.`);
        } catch (erro) {
            erroBrapi = erro.message;
            console.error(`brapi falhou: ${erro.message}`);
        }
    }

    /** @type {Record<string, any>} */
    const cotacoesPtax = {};

    for (const moeda of moedas) {
        try {
            const cotacao = await buscarCotacaoPtax(moeda);
            cotacoesPtax[moeda] = cotacao;
            console.log(
                `PTAX ${moeda}: ${cotacao[CAMPO_COTACAO_MOEDA]} (${cotacao.tipoBoletim}, ${cotacao.dataHoraCotacao}) ` +
                    `— combinação aceita pela API: ${cotacao.variacaoUsada}`,
            );
        } catch (erro) {
            cotacoesPtax[moeda] = { erro: erro.message };
            console.error(`PTAX ${moeda} falhou: ${erro.message}`);
        }
    }

    const { atualizacoes, falhas } = montarAtualizacoes(registros, {
        cotacoesBrapi,
        cotacoesPtax,
        agoraISO,
        requestId,
        erroBrapi,
    });

    const atualizados = await atualizarRegistros({
        baseId,
        tableId,
        atualizacoes,
        token: airtableToken,
    });

    console.log(`Registros atualizados no Airtable: ${atualizados}`);

    if (falhas.length > 0) {
        console.error(`Ativos com problema: ${falhas.length}`);

        for (const falha of falhas) {
            console.error(`  ${falha.codigo}: ${falha.mensagem}`);
        }
    }

    return { atualizados, falhas };
}

// Executa apenas quando chamado diretamente, não quando importado por testes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    executar()
        .then(({ falhas }) => {
            process.exit(falhas.length > 0 ? 1 : 0);
        })
        .catch((erro) => {
            console.error(`Execução abortada: ${erro.message}`);
            process.exit(1);
        });
}

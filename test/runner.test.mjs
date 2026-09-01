/**
 * Testes com fetch stubbado — nenhuma chamada de rede real, nenhum token real.
 * Rode com: node --test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buscarCotacoesBrapi, indexarPorSimbolo, normalizarSimbolos } from "../src/brapi.mjs";
import { buscarCotacaoPtax, escolherBoletim, formatarDataCandidatos } from "../src/ptax.mjs";
import { atualizarRegistros, listarRegistros } from "../src/airtable.mjs";
import { arredondar, montarAtualizacoes } from "../src/atualizar-carteira.mjs";

const TOKEN_FALSO = "tok_de_teste_nao_real";

/**
 * Cria um fetch falso que responde sempre igual e guarda as URLs chamadas.
 */
function stubFetch(status, body) {
    const chamadas = [];

    const impl = async (url, init) => {
        chamadas.push({ url: String(url), init });

        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        };
    };

    impl.chamadas = chamadas;

    return impl;
}

const RESPOSTA_BRAPI = {
    results: [
        {
            requestedSymbol: "PETR4",
            symbol: "PETR4",
            changed: false,
            data: { shortName: "PETROBRAS PN", currency: "BRL", regularMarketPrice: 38.5 },
        },
        {
            requestedSymbol: "VALE3",
            symbol: "VALE3",
            changed: false,
            data: { shortName: "VALE ON", currency: "BRL", regularMarketPrice: 61.2 },
        },
    ],
};

test("normalizarSimbolos limpa, padroniza e remove duplicatas", () => {
    assert.deepEqual(normalizarSimbolos([" petr4 ", "VALE3", "PETR4", ""]), ["PETR4", "VALE3"]);
    assert.deepEqual(normalizarSimbolos("petr4, vale3"), ["PETR4", "VALE3"]);
    assert.deepEqual(normalizarSimbolos(null), []);
});

test("brapi monta a URL com vírgula literal e mantém o token fora dela", async () => {
    const fetchImpl = stubFetch(200, RESPOSTA_BRAPI);
    await buscarCotacoesBrapi(["PETR4", "VALE3"], { token: TOKEN_FALSO, fetchImpl });

    const { url, init } = fetchImpl.chamadas[0];
    assert.ok(url.endsWith("?symbols=PETR4,VALE3"), url);
    assert.ok(!url.includes(TOKEN_FALSO));
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN_FALSO}`);
});

test("brapi traduz os erros não-2xx em mensagens específicas", async () => {
    const casos = [
        [401, /autenticar/],
        [403, /acesso ao recurso/],
        [429, /limite tempor/],
        [503, /indispon/],
    ];

    for (const [status, esperado] of casos) {
        await assert.rejects(
            () => buscarCotacoesBrapi(["PETR4"], { token: TOKEN_FALSO, fetchImpl: stubFetch(status, {}) }),
            esperado,
            `status ${status}`,
        );
    }
});

test("brapi rejeita token ausente e lista vazia", async () => {
    await assert.rejects(
        () => buscarCotacoesBrapi(["PETR4"], { token: "", fetchImpl: stubFetch(200, RESPOSTA_BRAPI) }),
        /BRAPI_TOKEN/,
    );
    await assert.rejects(
        () => buscarCotacoesBrapi([], { token: TOKEN_FALSO, fetchImpl: stubFetch(200, RESPOSTA_BRAPI) }),
        /Nenhum código/,
    );
});

test("brapi rejeita corpo não-JSON e queda de conexão", async () => {
    await assert.rejects(
        () => buscarCotacoesBrapi(["PETR4"], { token: TOKEN_FALSO, fetchImpl: stubFetch(200, "<html>") }),
        /conteúdo inválido/,
    );
    await assert.rejects(
        () =>
            buscarCotacoesBrapi(["PETR4"], {
                token: TOKEN_FALSO,
                fetchImpl: async () => {
                    throw new Error("ECONNRESET");
                },
            }),
        /conexão com a brapi/,
    );
});

test("formatarDataCandidatos produz as duas variantes", () => {
    const candidatos = formatarDataCandidatos(new Date(Date.UTC(2026, 7, 3)));
    assert.equal(candidatos.mesPrimeiro, "08-03-2026");
    assert.equal(candidatos.diaPrimeiro, "03-08-2026");
});

test("escolherBoletim prefere o fechamento mais recente", () => {
    const boletins = [
        { cotacaoVenda: 5.1, dataHoraCotacao: "2026-08-27 13:04:00", tipoBoletim: "Fechamento" },
        { cotacaoVenda: 5.3, dataHoraCotacao: "2026-08-28 10:05:00", tipoBoletim: "Abertura" },
        { cotacaoVenda: 5.2, dataHoraCotacao: "2026-08-28 13:03:00", tipoBoletim: "Fechamento" },
    ];

    assert.equal(escolherBoletim(boletins).cotacaoVenda, 5.2);
    assert.equal(escolherBoletim([]), null);
});

test("escolherBoletim cai para o último boletim quando não há fechamento", () => {
    const boletins = [
        { cotacaoVenda: 5.4, dataHoraCotacao: "2026-08-28 10:05:00", tipoBoletim: "Abertura" },
        { cotacaoVenda: 5.5, dataHoraCotacao: "2026-08-28 11:05:00", tipoBoletim: "Intermediário" },
    ];

    assert.equal(escolherBoletim(boletins).cotacaoVenda, 5.5);
});

test("PTAX percorre as combinações e informa a que funcionou", async () => {
    const chamadas = [];

    const fetchImpl = async (url) => {
        chamadas.push(String(url));

        // Só a terceira combinação (dataFinal + MM-DD-AAAA) devolve boletins.
        const vazio = chamadas.length < 3;

        return {
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    value: vazio
                        ? []
                        : [{ cotacaoCompra: 5.39, cotacaoVenda: 5.4, dataHoraCotacao: "2026-08-28 13:03:00", tipoBoletim: "Fechamento" }],
                }),
        };
    };

    const cotacao = await buscarCotacaoPtax("usd", { fetchImpl, hoje: new Date(Date.UTC(2026, 7, 31)) });

    assert.equal(cotacao.moeda, "USD");
    assert.equal(cotacao.cotacaoVenda, 5.4);
    assert.equal(cotacao.variacaoUsada, "dataFinal + MM-DD-AAAA");
    assert.equal(chamadas.length, 3);
});

test("PTAX falha com diagnóstico quando nenhuma combinação retorna", async () => {
    const fetchImpl = stubFetch(200, { value: [] });

    await assert.rejects(
        () => buscarCotacaoPtax("EUR", { fetchImpl, hoje: new Date(Date.UTC(2026, 7, 31)) }),
        /não retornou cotação para EUR/,
    );
    assert.equal(fetchImpl.chamadas.length, 4);
});

test("Airtable segue a paginação por offset", async () => {
    let chamada = 0;

    const fetchImpl = async () => {
        chamada += 1;

        return {
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify(
                    chamada === 1
                        ? { records: [{ id: "rec1", fields: {} }], offset: "off1" }
                        : { records: [{ id: "rec2", fields: {} }] },
                ),
        };
    };

    const registros = await listarRegistros({ baseId: "appX", tableId: "tblY", token: TOKEN_FALSO, fetchImpl });

    assert.equal(registros.length, 2);
    assert.equal(chamada, 2);
});

test("Airtable divide as escritas em lotes de 10", async () => {
    const corpos = [];

    const fetchImpl = async (_url, init) => {
        const body = JSON.parse(init.body);
        corpos.push(body.records.length);

        return { ok: true, status: 200, text: async () => JSON.stringify({ records: body.records }) };
    };

    const atualizacoes = Array.from({ length: 23 }, (_, i) => ({ id: `rec${i}`, fields: { CotacaoAtual: i } }));
    const total = await atualizarRegistros({
        baseId: "appX",
        tableId: "tblY",
        atualizacoes,
        token: TOKEN_FALSO,
        fetchImpl,
        pausaMs: 0,
    });

    assert.deepEqual(corpos, [10, 10, 3]);
    assert.equal(total, 23);
});

test("Airtable traduz 401 e 422", async () => {
    await assert.rejects(
        () => listarRegistros({ baseId: "appX", tableId: "tblY", token: TOKEN_FALSO, fetchImpl: stubFetch(401, {}) }),
        /AIRTABLE_TOKEN/,
    );
    await assert.rejects(
        () =>
            listarRegistros({
                baseId: "appX",
                tableId: "tblY",
                token: TOKEN_FALSO,
                fetchImpl: stubFetch(422, { error: { message: "Field not found" } }),
            }),
        /Field not found/,
    );
});

test("arredondar resolve o caso clássico de ponto flutuante", () => {
    assert.equal(arredondar(1.005, 2), 1.01);
    assert.equal(arredondar(100 * 38.5, 2), 3850);
    assert.equal(arredondar(3 * 0.1, 2), 0.3);
});

test("montarAtualizacoes calcula ValorAtual e marca OK", () => {
    const registros = [
        { id: "rec1", fields: { Codigo: "PETR4", Tipo: "ACAO", Quantidade: 100 } },
        { id: "rec2", fields: { Codigo: "USD", Tipo: "MOEDA", Quantidade: 1000 } },
    ];

    const { atualizacoes, falhas } = montarAtualizacoes(registros, {
        cotacoesBrapi: indexarPorSimbolo(RESPOSTA_BRAPI.results),
        cotacoesPtax: { USD: { cotacaoVenda: 5.4, dataHoraCotacao: "2026-08-28 13:03:00" } },
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
    });

    assert.equal(falhas.length, 0);

    const petr4 = atualizacoes.find((a) => a.id === "rec1").fields;
    assert.equal(petr4.CotacaoAtual, 38.5);
    assert.equal(petr4.ValorAtual, 3850);
    assert.equal(petr4.Fonte, "BRAPI");
    assert.equal(petr4.StatusAPI, "OK");
    assert.equal(petr4.NomeAtivo, "PETROBRAS PN");

    const usd = atualizacoes.find((a) => a.id === "rec2").fields;
    assert.equal(usd.CotacaoAtual, 5.4);
    assert.equal(usd.ValorAtual, 5400);
    assert.equal(usd.Fonte, "BCB_PTAX");
    assert.equal(usd.DataReferencia, "2026-08-28 13:03:00");
});

test("montarAtualizacoes não sobrescreve NomeAtivo já preenchido", () => {
    const registros = [{ id: "rec1", fields: { Codigo: "PETR4", Tipo: "ACAO", Quantidade: 10, NomeAtivo: "Meu nome" } }];

    const { atualizacoes } = montarAtualizacoes(registros, {
        cotacoesBrapi: indexarPorSimbolo(RESPOSTA_BRAPI.results),
        cotacoesPtax: {},
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
    });

    assert.equal("NomeAtivo" in atualizacoes[0].fields, false);
});

test("montarAtualizacoes marca ERRO por ativo sem derrubar os demais", () => {
    const registros = [
        { id: "rec1", fields: { Codigo: "PETR4", Tipo: "ACAO", Quantidade: 100 } },
        { id: "rec2", fields: { Codigo: "B3SA3", Tipo: "ACAO", Quantidade: 50 } },
        { id: "rec3", fields: { Codigo: "EUR", Tipo: "MOEDA", Quantidade: 10 } },
    ];

    const { atualizacoes, falhas } = montarAtualizacoes(registros, {
        cotacoesBrapi: indexarPorSimbolo(RESPOSTA_BRAPI.results),
        cotacoesPtax: { EUR: { erro: "O Banco Central não retornou cotação para EUR." } },
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
    });

    assert.equal(atualizacoes.find((a) => a.id === "rec1").fields.StatusAPI, "OK");
    assert.equal(atualizacoes.find((a) => a.id === "rec2").fields.StatusAPI, "ERRO");
    assert.equal(atualizacoes.find((a) => a.id === "rec3").fields.StatusAPI, "ERRO");
    assert.match(atualizacoes.find((a) => a.id === "rec3").fields.MensagemAPI, /Banco Central/);
    assert.equal(falhas.length, 2);
});

test("montarAtualizacoes avisa quando falta Quantidade", () => {
    const registros = [{ id: "rec1", fields: { Codigo: "PETR4", Tipo: "ACAO" } }];

    const { atualizacoes, falhas } = montarAtualizacoes(registros, {
        cotacoesBrapi: indexarPorSimbolo(RESPOSTA_BRAPI.results),
        cotacoesPtax: {},
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
    });

    assert.equal(atualizacoes[0].fields.StatusAPI, "AVISO");
    assert.equal("ValorAtual" in atualizacoes[0].fields, false);
    assert.equal(falhas.length, 1);
});

test("montarAtualizacoes propaga a falha global da brapi para todas as ações", () => {
    const registros = [
        { id: "rec1", fields: { Codigo: "PETR4", Tipo: "ACAO", Quantidade: 100 } },
        { id: "rec2", fields: { Codigo: "USD", Tipo: "MOEDA", Quantidade: 10 } },
    ];

    const { atualizacoes } = montarAtualizacoes(registros, {
        cotacoesBrapi: {},
        cotacoesPtax: { USD: { cotacaoVenda: 5.4, dataHoraCotacao: "2026-08-28 13:03:00" } },
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
        erroBrapi: "O limite temporário de consultas da brapi foi atingido.",
    });

    assert.match(atualizacoes.find((a) => a.id === "rec1").fields.MensagemAPI, /limite tempor/);
    assert.equal(atualizacoes.find((a) => a.id === "rec2").fields.StatusAPI, "OK");
});

test("montarAtualizacoes rejeita registro sem Codigo e sinaliza Tipo desconhecido", () => {
    const registros = [
        { id: "rec1", fields: { Tipo: "ACAO", Quantidade: 1 } },
        { id: "rec2", fields: { Codigo: "XPTO", Tipo: "CRIPTO", Quantidade: 1 } },
    ];

    const { atualizacoes, falhas } = montarAtualizacoes(registros, {
        cotacoesBrapi: {},
        cotacoesPtax: {},
        agoraISO: "2026-08-31T22:00:00.000Z",
        requestId: "run-teste",
    });

    assert.equal(atualizacoes.length, 1);
    assert.match(atualizacoes[0].fields.MensagemAPI, /Tipo não reconhecido/);
    assert.equal(falhas.length, 2);
});

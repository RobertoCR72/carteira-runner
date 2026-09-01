# Carteira runner

Atualiza a base Airtable **Central Inteligente de Monitoramento de Carteira de Ativos**
com cotações de dois lugares:

- **Ações** (`Tipo = ACAO`) → [brapi.dev](https://brapi.dev/docs.mdx), endpoint
  `GET /api/v2/stocks/quote`, autenticação `Authorization: Bearer`.
- **Moedas** (`Tipo = MOEDA`) → PTAX do Banco Central, API Olinda, boletim de
  fechamento do último dia útil disponível.

Existe porque a ação `Run a script` do Airtable exige o plano Team; este runner
faz o mesmo trabalho de fora, pela REST API do Airtable, sem mudar de plano.

## O que ele grava

Para cada registro de `Ativos` com `Ativo` marcado: `CotacaoAtual`, `ValorAtual`
(`Quantidade × cotação`, arredondado a 2 casas), `DataReferencia`, `Fonte`,
`CodigoResolvido`, `StatusAPI`, `QualidadeDados`, `MensagemAPI`,
`UltimaAtualizacao` e `RequestID`. `NomeAtivo` só é preenchido se estiver vazio.

Um ativo que falha é marcado com `StatusAPI = ERRO` e a mensagem em
`MensagemAPI`; os demais são atualizados normalmente. O processo termina com
código de saída 1 se houve qualquer falha, para o workflow ficar vermelho.

**Fora de escopo nesta versão:** `Participacao`, `MTD`, `YTD`, a tabela
`Snapshots` e os alertas por `LimiteMTD`.

## Configuração

1. **Token do Airtable.** Crie um Personal Access Token em
   https://airtable.com/create/tokens com os escopos `data.records:read` e
   `data.records:write`, com acesso apenas a esta base.
2. **Token da brapi.** Em https://brapi.dev.
3. **Local:** `cp .env.example .env`, preencha, e rode `node --env-file=.env src/atualizar-carteira.mjs`.
4. **GitHub Actions:** em `Settings → Secrets and variables → Actions`, crie os
   secrets `AIRTABLE_TOKEN` e `BRAPI_TOKEN`. O workflow já os consome.

Nenhum token é escrito em log, em URL ou em campo do Airtable.

## Execução

O workflow roda de segunda a sexta às 22:00 UTC (19:00 em Brasília), depois do
fechamento da B3 e da publicação da PTAX de fechamento. Para a primeira
execução use `Actions → Atualizar carteira → Run workflow`, que dispara na hora.

`npm test` roda 20 testes com `fetch` stubbado — nenhuma chamada de rede, nenhum
token real.

## Duas incertezas que a primeira execução resolve

**Parâmetros da PTAX.** Não consegui confirmar por fonte oficial nem o formato
das datas (`MM-DD-AAAA` ou `DD-MM-AAAA`) nem o nome do parâmetro de data final
(`dataFinalCotacao` ou `dataFinal`): as páginas de dados abertos do BCB não
trazem exemplo literal e a API não era acessível do ambiente onde isto foi
escrito. O código percorre as quatro combinações, para na primeira que devolve
boletins e escreve no log qual funcionou (`combinação aceita pela API: ...`).
Depois da primeira execução, vale fixar a combinação vencedora em `src/ptax.mjs`
e apagar as outras — quatro tentativas por moeda é desperdício depois de saber.

**Cobertura do plano da brapi.** A documentação lista PETR4, MGLU3, VALE3 e
ITUB4 como tickers de demonstração. Ativos fora dessa lista dependem do seu
plano; um 401/403 na primeira execução aponta para o plano, não para o token.

## Premissas embutidas

- Moedas são valoradas pela **cotação de venda** do boletim de fechamento
  (`CAMPO_COTACAO_MOEDA` em `src/atualizar-carteira.mjs`).
- A janela de busca da PTAX é de 15 dias corridos para trás, o que cobre
  feriados prolongados.
- Uma única chamada à brapi cobre todas as ações. A brapi não documenta um
  máximo de tickers por requisição; se a carteira crescer e vier um HTTP 400,
  divida a lista.

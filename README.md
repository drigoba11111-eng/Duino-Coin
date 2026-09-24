# Minerador Duino-Coin para GitHub Pages

Página **100% estática** que minera Duino-Coin de verdade, sem servidor nenhum — o tipo de
arquivo que o GitHub Pages aceita.

```
github-pages/
├── index.html              ← a página (HTML + CSS + interface em um arquivo)
├── trabalhador.js          ← Web Worker: núcleo DUCO-S1A + cliente WebSocket
├── teste-githubpages.js    ← teste automatizado (núcleo + ponta a ponta real)
└── README.md               ← este arquivo
```

## Por que isso funciona no GitHub Pages?

Na versão local (`../bridge.js`) o problema era: **o navegador não abre socket TCP cru** e o
protocolo do DUCO é TCP. Aí entra a ponte em Node.

Aqui a solução é outra: o próprio Duino-Coin mantém um **gateway WebSocket oficial** para o
*web miner* — é o que o site oficial `https://server.duinocoin.com/webminer.html` usa:

```
wss://magi.duinocoin.com:8443
```

WebSocket **passa por HTTPS**, e o GitHub Pages serve HTTPS. Logo, uma página estática
consegue minerar. O protocolo é idêntico ao dos nodes TCP:

| Direção | Mensagem |
|---|---|
| servidor → nós | `3.0` (versão do servidor) |
| nós → servidor | `JOB,usuario,dificuldade,miner_key` |
| servidor → nós | `lastBlockHash,hashEsperado,dificuldade` |
| nós → servidor | `nonce,hashrate,identificador,rigid,,wallet_id` |
| servidor → nós | `GOOD,<saldo>` ou `BAD` |

A regra de mineração (DUCO-S1A) é a mesma do `duco-miner.js` do guia: achar o nonce em que
`SHA1(lastBlockHash + nonce)` é igual ao `hashEsperado`, testando de `0` até
`100 × dificuldade + 1`.

## Como publicar

**Opção A — repositório novo (mais simples)**

1. Crie um repositório no GitHub (pode ser público), por exemplo `meu-minerador-duco`.
2. Suba **os dois arquivos**, `index.html` e `trabalhador.js`, para a raiz do repositório.
3. No repositório: `Settings` → `Pages` → *Source*: **Deploy from a branch** →
   branch `main`, pasta `/ (root)` → `Save`.
4. Em ~1 minuto a página estará em `https://SEU-USUARIO.github.io/meu-minerador-duco/`.

**Opção B — pasta `docs/` de um repositório existente**

1. Coloque `index.html` e `trabalhador.js` dentro de `docs/`.
2. `Settings` → `Pages` → branch `main`, pasta `/docs` → `Save`.

**Opção C — dentro de um site Pages que você já tem**

Copie os dois arquivos para uma subpasta (ex.: `/minerador/`) do repositório do site.
Funciona igual: os caminhos são relativos, então serve em qualquer subpasta ou domínio.

> ⚠️ Os **dois arquivos precisam ficar juntos na mesma pasta**: a página cria o Worker com
> `new Worker('trabalhador.js')`, que é resolvido no mesmo diretório. Não precisa de
> `.nojekyll`, build, npm nem bibliotecas — não há nenhuma dependência externa.

## Como usar

1. Abra a página publicada (ou o `index.html` local).
2. Informe o **usuário do DUCO** (criado no wallet oficial) e, se a sua conta exige, a
   **Miner key**. Sem miner key, deixe vazio (o padrão enviado é `None`).
3. Escolha quantos **trabalhadores** (cada um é uma conexão WebSocket/minerador) e clique em
   **⛏️ Iniciar mineração**.
4. Acompanhe *shares* GOOD/BAD, hashrate, dificuldade, latência e o registro.
5. **Deixe a aba aberta e visível**: navegadores estrangulam JavaScript de abas em segundo
   plano. Ao fechar a aba, a mineração para.

## Testes

```bash
node ducoweb/github-pages/teste-githubpages.js
```

O teste (Node.js 22+) usa o `trabalhador.js` **real** — o mesmo arquivo que o navegador
carrega — e um WebSocket de teste que imita o navegador (inclusive mandando o header
`Origin`). Saída real nesta máquina:

```
— 1) Núcleo SHA1 contra o crypto do Node —
✅ vetor conhecido: SHA1("abc")
✅ vetor conhecido: SHA1("")
✅ mensagem de exatamente 1 bloco (64 bytes)
✅ mensagem que exige bloco extra de padding (119 bytes)
✅ 300 mensagens aleatórias (0 a 199 bytes) conferem: 300/300

— 2) Busca de nonce (mesma regra do duco-miner.js) —
✅ 60 jobs gerados aleatoriamente resolvidos: 60/60
✅ job de exemplo: nonce 12345 encontrado (hash 05ca3f006264...)
✅ hash impossível: devolve -1 (nunca inventa nonce)

— 3) Ponta a ponta com wss://magi.duinocoin.com:8443 —
   usuário de teste: duco | Origin enviado: https://painel-de-teste.github.io
   • Trabalhador 1: conectado a wss://magi.duinocoin.com:8443
   • Servidor do DUCO versão 3.0
   • job 1: dificuldade 20000 | nonce 333780 | latência 222 ms | 1371528 H/s
   • share BAD ❌
   • job 2: dificuldade 100000 | nonce 2889900 | latência 254 ms | 1395780 H/s
   • share GOOD ✅

✅ 13/13 verificações passaram — 0 falha(s)
```

## O que aprendi testando (vale para quem for mexer)

- **Sem header `Origin` o gateway devolve `403`.** É proteção anti-bot do Cloudflare na frente
  do `magi.duinocoin.com`. O navegador sempre manda `Origin`, então a página funciona; mas
  scripts "crus" (curl, alguns clientes) tomam 403 — por isso o teste daqui manda
  `Origin: https://painel-de-teste.github.io`, imitando o navegador.
- **Qualquer `Origin` de site serve** (`https://qualquer.github.io` respondeu `101 Switching
  Protocols`), não só `server.duinocoin.com`.
- **O gateway sobe a dificuldade sozinho.** Pedindo `LOW` o primeiro job veio com dificuldade
  `20000` e o seguinte com `100000` (no minerador TCP já tínhamos visto `LOW` virar `135293`).
  O primeiro share pode voltar `BAD` enquanto o ajuste acontece — os seguintes vêm `GOOD`.
- **Hashrate medido:** ~1,4 MH/s nesta máquina (Windows/Node fazendo o papel do navegador). Em
  navegador de verdade o valor varia bastante com o processador.
- **A conta precisa existir** no gateway WebSocket: usuário inexistente recebe
  *This user doesn't exist* e a página para (não fica martelando o servidor).
- A primeira mensagem do servidor é a versão (`3.0`) — é o sinal de que a conexão subiu.

## Limites, segurança e bom senso

- 🔐 **Nada é enviado a terceiros** além dos pacotes de mineração para o gateway oficial do
  Duino-Coin e das consultas de cotação (`server.duinocoin.com` e `economia.awesomeapi.com.br`,
  ambas com CORS liberado). Não há backend, banco de dados nem analítica: o GitHub Pages só
  entrega os arquivos.
- 💾 Usuário, Miner key e preferências ficam no `localStorage` **de quem abre a página** — o
  botão *Limpar dados salvos* apaga. Como a página fica pública, nada de credenciais ficam
  embutidas no código: cada visitante informa os próprios dados.
- ⚠️ **Termos de Uso do DUCO:** proibido usar contas alternativas, VPN/proxy, VPS/cloud grátis
  e emulação de dispositivos; vários trabalhadores na mesma conta são permitidos; a moeda é
  *for-fun*. O minerador oficial continua sendo o recomendado.
- 💸 É uma moeda de brincadeira: o DUCO vale frações de centavo e a conversão em reais é
  simbólica. A página **estima**, não promete.
- 🔌 Se o Duino-Coin mudar/desligar esse gateway, a página mostra o erro e tenta reconectar a
  cada 15 s (mesmo comportamento do web miner oficial). Para usar outro endereço, basta trocar
  o campo *Gateway WebSocket*.

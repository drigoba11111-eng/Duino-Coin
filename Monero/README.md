# ⛏ Monero no navegador — minerador RandomX (WASM) + ponte para pools de verdade

Minerador de **Monero (XMR)** que roda **dentro do navegador** (Web Worker + RandomX compilado
para WebAssembly) e conversa com **pools stratum reais** (MoneroOcean, SupportXMR, …) através de
uma **ponte local** de uma única página, no mesmo espírito do painel web do Duino-Coin.

## Antes de qualquer coisa: seja honesto consigo mesmo

| | |
|---|---|
| Potência | **~5 a 10 H/s por núcleo** no WASM (o xmrig nativo faz ~100× isso no mesmo PC) |
| Tempo para achar 1 share | minutos (dificuldade 10000 do MoneroOcean) |
| Retorno | centavos — isso **não** é uma mina de dinheiro, é estudo de protocolo |
| Carteira | o pool paga **o endereço que você informar**: use a sua própria carteira |
| Uso justo | a página avisa e pede confirmação; ela não se esconde em `<iframe>` de site alheio |

O objetivo aqui é **entender e provar o caminho completo**: blob do bloco → nonce → RandomX →
alvo → submit → `GOOD` do pool. Todas as afirmações deste README foram verificadas com
endereços, jobs e um **share realmente aceito** pelo MoneroOcean (a prova está mais abaixo).

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | o painel: endereço, pool, quantidade de trabalhadores, hashrate, shares, registro |
| `trabalhador.js` | Web Worker: valida o endereço, fala stratum, minera RandomX e compara com o alvo |
| `ponte.js` | ponte local: serve a página e repassa WebSocket ⇄ TCP stratum (sem dependências) |
| `randomx-web.js` | RandomX (modo luz, 256 MB) compilado para WASM — arquivo de terceiros (ver licença) |
| `teste-monero.js` | bateria de testes: núcleo, prova de trabalho, endereços, ponta a ponta local, ao vivo e navegador |

Nada de `npm install`: o projeto usa só o Node (nativo) e o navegador.

## Como usar

```bash
# 1) na pasta do projeto, suba a ponte (ela também serve a página)
node ponte.js                 # http://127.0.0.1:8080   (opcional: node ponte.js 9000)

# 2) abra a página NO endereço que a ponte imprime
#    (o Windows abre sozinho; para servir sem abrir: PONTE_SEM_ABRIR=1 node ponte.js)

# 3) no painel: cole o endereço da sua carteira XMR, escolha o pool, clique em "Iniciar mineração"
```

Por que a ponte é necessária? O navegador não abre conexão TCP crua — só HTTP/WebSocket. O
stratum dos pools é JSON-RPC 2.0 sobre TCP. A ponte faz o "cano" entre os dois: cada mensagem de
texto do Worker vira uma linha no socket TCP do pool e cada linha do pool volta como mensagem de
texto. Ela **não** entende stratum: não reescreve, não valida e não inventa mensagem.

Parâmetros úteis na URL (bom para deixar um link pronto):

```
http://127.0.0.1:8080/?endereco=<SEU_ENDERECO>&pool=gulf.moneroocean.stream:10001&trabalhadores=2&auto=1
```

`auto=1` já começa a minerar; `?pool=` aceita qualquer `host:porta` com rx/0.

### Números reais medidos nesta máquina

| Cenário | Hashrate |
|---|---|
| 1 trabalhador, página do navegador | ~9,9 H/s |
| 4 processos Node simultâneos (teste `--share`) | ~5,3 H/s cada (~21 H/s no total) |

Como o RandomX no modo luz precisa de **256 MB por trabalhador**, comece com 1 ou 2 e só aumente
se a máquina aguentar. O primeiro job de cada trabalhador "trava" ~1 s: é o cache sendo montado
(depois ele é **reaproveitado** quando a epoch troca, em vez de alocar tudo de novo).

## Como funciona (o que foi verificado na prática)

### 1. Stratum (JSON-RPC 2.0, uma mensagem por linha)

```jsonc
// navegador -> pool
{"id":"1","jsonrpc":"2.0","method":"login","params":{"login":"<endereço>","pass":"x","agent":"Panel-Monero-WASM/1"}}

// pool -> navegador (a resposta do login já vem com o primeiro job)
{"id":"1","error":null,"result":{"id":"<sessão>","job":{"blob":"...","job_id":"...","target":"b88d0600",
 "height":3770446,"seed_hash":"5a0b88ac…","algo":"rx/0"},"status":"OK"}}

// pool -> navegador, a cada bloco novo (sem id)
{"jsonrpc":"2.0","method":"job","params":{ /* o mesmo formato de job */ }}

// navegador -> pool (share)
{"id":"2","jsonrpc":"2.0","method":"submit","params":{"job_id":"...","nonce":"e61fa3e0","result":"d45e409a…"}}

// navegador -> pool a cada 60 s, para não cair
{"id":"3","jsonrpc":"2.0","method":"keepalived","params":{"id":"<sessão>"}}
```

### 2. Onde fica o nonce dentro do blob

O blob é a pré-serialização do cabeçalho do bloco: os 4 bytes do nonce ficam **depois** de
`major_version` (varint) + `minor_version` (varint) + `timestamp` (varint) + `prev_id` (32 bytes).
Nos blocos de hoje isso dá **posição 39** — e a posição é **calculada** (parse dos varints), não
chumbada: com um timestamp antigo de 4 bytes o valor vira 38 e o código continua certo.

O nonce vai em **little-endian** nos 4 bytes do blob, e é essa mesma ordem que o pool recebe no
campo `nonce` do `submit`.

### 3. A regra do alvo

O hash do RandomX e o alvo (`target`, tipicamente 4 bytes) são lidos como **inteiro de 256 bits em
little-endian** e o share vale quando:

```
hash_LE256  <  (target_LE  <<  (256 − 8 · bytes_do_target))
```

Exemplo real: `target = b88d0600` → LE = 429496 = 0x68A98 → dificuldade ≈ `4294967295 / 429496` = **10000**,
que é exatamente a dificuldade anunciada pelo MoneroOcean.

### 4. RandomX no navegador

`randomx-web.js` compila o RandomX original (modo luz) para WebAssembly. O trabalhador:

1. monta o cache de 256 MB com o `seed_hash` do job (`randomx_init_cache`);
2. cria uma VM (`randomx_create_vm`) e chama `calculate_hash(blob)` a cada nonce;
3. quando o hash passa do alvo, manda o `submit` e segue minerando (sem parar).

Cuidado de implementação que os testes pegaram: a lib expõe a API em **`globalThis.RandomX`**
(não direto no `globalThis`), e um job novo não pode ser ignorado pelo laço antigo — o laço é
identificado por um **token de geração**, senão a troca de job "desliga" a mineração. Foi
justamente um teste (`parte 4`) que flagrou esse travamento antes de ele chegar no navegador.

## Provas (o que já rodou de verdade)

### Share ACEITO pelo MoneroOcean usando o minerador final (`node teste-monero.js --share`)

Quatro trabalhadores de verdade, cada um com a sua ponte, contra `gulf.moneroocean.stream:10001`:

```
[caçador 3] 6,3 H/s · dificuldade 10000
[caçador 3] deu alvo! nonce 7f23b595 (79 hashes nesta rodada) — enviando ao pool
[caçador 3] *** SHARE ACEITO PELO POOL *** (latência 210 ms)
  ok  um dos 4 mineradores achou um share e o pool aprovou

47 ok, 0 falha(s)
```

Ou seja: o `trabalhador.js` deste repositório calculou RandomX, comparou com o alvo do pool e o
MoneroOcean **aprovou o share** (o único veredito que realmente importa).

### Share aceito pelo MoneroOcean (sondagem inicial, enquanto o protocolo era decifrado)

```
[0] job 62063878 | alvo b88d0600 | offsetNonce=39 | hash=152 hex
[0] cache RandomX (256MB) em 986 ms
[0] >> submit nonce=e61fa3e0 hash=d45e409a2cccb9fe6bc5dc9ca81b63c96c36456e0b83035ecc6682e404d90000 (698 hashes, 107s)
[0] *** SHARE ACEITO (GOOD) *** 700 hashes em 107s
```

Esse share virou fixture permanente do teste: `alvoOK(hash, "b88d0600")` **tem** que dar `true`, e dá.

### Tabela de endereços (o que o pool aceita e o que ele recusa)

| Endereço | Veredito do pool | Veredito do nosso validador |
|---|---|---|
| `845xHUh5…56xbh7V` (subendereço real do tevador, 0x2a) | aceito | aceito |
| `43ufTdD…isVnM8QUa` (gerado, chaves válidas) | aceito | aceito |
| `48p7G7hB…ML3XYSjT4` (gerado com bytes aleatórios) | **recusado** (`Invalid payment address`) | recusado: *chave pública de gasto não é ponto válido na curva ed25519* |

Ou seja: o motivo real das recusas nas sondagens não era "endereço gerado", era **chave que não é
ponto da curva**. O validador local (base58 por blocos + checksum keccak-256 + descompressão
ed25519) reproduz o veredito do pool antes de gastar uma conexão.

### Vetores upstream do RandomX

Os 5 vetores conhecidos do repositório oficial passam no WASM vendored:

```
ok  RandomX: vetores upstream da chave "test key 000" (3/3)
ok  RandomX: cache reaproveitado com a chave "test key 001" (2/2)
```

O segundo caso não é só um vetor: ele reaproveita **o mesmo cache de 256 MB** com outra chave
(`randomx_init_cache(chave, cache)`), que é o que acontece quando a epoch do Monero troca.

## Rodando os testes

```bash
node teste-monero.js --offline     # 1..4: núcleo, prova de trabalho, endereços e E2E local  (sem internet)
node teste-monero.js               # tudo acima + parte 5: login/job/mineração no MoneroOcean
node teste-monero.js --navegador   # + parte 6: abre o Chrome/Edge headless e lê o painel pelo DevTools
node teste-monero.js --share       # caçada: 4 mineradores de verdade até o pool aceitar um share
```

Resultados reais desta máquina:

```
$ node teste-monero.js --offline
...
38 ok, 0 falha(s)
```

```
$ node teste-monero.js --navegador
== 5) Ao vivo: gulf.moneroocean.stream:10001 (RandomX de verdade) ==
  ok  login aceito pelo MoneroOcean
  ok  job real chegou (dificuldade ≈ 10000, altura 3770446)
  ok  o pool está mandando rx/0 (rx/0)
  ok  está minerando mesmo (hashrate > 0) (9,9 H/s)
== 6) Navegador de verdade (Chrome/Edge headless) — caminho do painel ==
  ok  o navegador abriu a página servida pela ponte
  ok  o painel logou o login aceito pelo pool
  ok  o Worker montou o cache de 256 MB do RandomX no navegador
  ok  o painel mostra "conectado"
  ok  o painel mostra hashrate de verdade (2,7 H/s)
  ok  o painel mostra a dificuldade do job real (10.000)
  --- registro dentro do navegador (últimas linhas) ---
  [17:55:25] [-] trabalhador 1: endereço ok — falando com gulf.moneroocean.stream:10001 pela ponte
  [17:55:25] [-] conectado à ponte ws://127.0.0.1:37324/ws
  [17:55:25] [-] login aceito pelo pool (sessão 62219170) — latência 581 ms
  [17:55:27] [-] RandomX pronto em 1875 ms (epoch 5a0b88ac4f99…)
  [17:55:27] [-] job 62219175 — dificuldade ≈ 10000, altura 3770446
52 ok, 0 falha(s)
```

Detalhe importante do desenho dos testes: a **parte 4 não confia no minerador**. Ela sobe a
`ponte.js` de verdade, um **pool stratum falso** e o `trabalhador.js` de verdade; quando chega um
`submit`, o pool falso **reescreve o nonce na posição que ele conhece (39) e recalcula o RandomX
por conta própria**, conferindo à parte com `BigInt` se o hash passa do alvo. Se o minerador
errasse o hash, a posição do nonce, a ordem little-endian ou a regra do alvo, o teste reprovaria —
e já reprovou enquanto o código estava errado (foi assim que o travamento na troca de job apareceu).

Na parte 4 também entram: caminho `BAD` (recusa tratada como recusa), job com algoritmo `cn/r`
(avisar e continuar no job antigo), troca de job no meio da mineração e endereço inválido sendo
barrado antes de qualquer conexão.

## Limites, avisos e o que não está resolvido

* **Não tente minerar sério com isso.** RandomX no WASM em modo luz é ordens de grandeza mais
  lento que o nativo. Para rendimento de verdade use `xmrig`.
* **256 MB de RAM por trabalhador** (cache do RandomX). Abrir 8 abas = 2 GB + CPU no talo.
* A aba precisa ficar aberta; `beforeunload` encerra os Workers. O pool cancela shares velhos
  quando um bloco novo chega (aqui um job novo simplesmente reinicia o laço).
* A ponte sobe em `127.0.0.1` de propósito: ela é um **cano TCP** — com `PONTE_HOST=0.0.0.0`
  qualquer um na rede poderia usá-la como proxy. Nunca exponha na internet.
* O endereço é validado no navegador, mas **o pool é quem manda**: endereço integrado (0x13) e
  carteiras de outras redes são recusados pelo pool, e o painel mostra o erro dele.
* Extra (limitação assumida): minerar na MoneroOcean com `rx/0` funciona, mas a MoneroOcean também
  roteia outros algoritmos por porta — este minerador só sabe `rx/0` (RandomX) e diz isso na tela
  quando o pool pede outra coisa.

## Proveniência e licença do `randomx-web.js`

* `randomx-web.js` é **código de terceiros** (vendored, não escrito aqui): vem do pacote npm
  `randomx.js` (build `dist/web`), que empacota o **RandomX original do tevador** compilado para
  WebAssembly no modo luz. Licença **BSD-3-Clause** (tevador e l-m), com o texto no topo do arquivo.
  Única alteração em relação ao original: nada na lógica — só o cabeçalho de licença/proveniência.
* Confiança: é um binário WASM de terceiros. O que dá para afirmar com os testes é que ele
  **calcula o RandomX correto** — passa nos 5 vetores upstream e reprocessa o mesmo share que um
  pool real aceitou. Se isso não bastar para o seu caso, compile o RandomX você mesmo
  (<https://github.com/tevador/RandomX>) e troque o arquivo; a API usada é só
  `randomx_init_cache` + `randomx_create_vm` + `vm.calculate_hash`.
* Todo o resto (`index.html`, `trabalhador.js`, `ponte.js`, `teste-monero.js`) é código deste
  projeto, sem dependências externas.

## O que este trabalho deixou de aprendizado

1. **Ponto de curva importa**: o pool recusava endereços por chave pública fora da curva, não por
   "endereço gerado". Antes de culpar o protocolo, validar o dado localmente.
2. **Little-endian em três lugares diferentes** (nonce no blob, nonce no submit, hash/target na
   comparação) — cada um deles foi fonte de bug até virar teste.
3. **O nonce não fica em posição mágica**: 39 é consequência dos varints de hoje; calcular é mais
   seguro do que chumbar (o teste cobre os dois casos).
4. **Cuidado com o estado de "estou minerando"**: um booleano simples não sobrevive à troca de job;
   um **token de geração** sobrevive.
5. **Um pool falso que recalcula o hash vale mais que três horas de log**: foi ele que separou "está
   rodando" de "está certo".



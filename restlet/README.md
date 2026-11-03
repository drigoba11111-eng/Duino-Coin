# Restlet do NetSuite — funcionalidades do Duino-Coin

Um **Restlet** (SuiteScript 2.0) que reúne, num único endereço do NetSuite, tudo que o
DUCO oferece: **mineração (busca de nonce DUCO-S1A)**, saldo, mineradores, transações,
estatísticas, preço, pools, loja, autenticação, transferências e um **proxy genérico**
para qualquer endpoint de `server.duinocoin.com`.

```
restlet/
├── duco-restlet.js      ← o Restlet (arquivo único, vai para o NetSuite)
├── teste-restlet.js     ← teste em Node (núcleo SHA1 + roteamento + mineração)
└── README.md            ← este arquivo
```

## Publicar no NetSuite

1. **Customization → Script → New → Script**:
   - *Type*: **Restlet**
   - *ID*: `_duco_restlet` (gera o Script ID `customscript_duco_restlet`)
   - Cole o conteúdo de `duco-restlet.js` (as diretivas `@NApiVersion` / `@NScriptType`
     no topo já definem o tipo).
2. **Save**, depois **Deploy Script** (New Deployment) escolhendo role/subsidiary.
3. Copie a **External URL** do deployment.
   Formato: `https://<conta>.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=<ID>&deploy=<ID>`

## Testes (Node 22+)

```bash
node restlet/teste-restlet.js
```

O teste carrega o **mesmo** `duco-restlet.js` com `define()` e módulos `N/*` falsos —
não toca no NetSuite. Valida o SHA1 contra o `crypto` do Node, resolve 60 jobs reais,
exercita o roteamento e a mineração fatiada (39 verificações).

## Ações

| Método | Ação | O que faz |
|---|---|---|
| GET | `acao=ajuda` | lista todas as ações |
| GET | `acao=saldo&usuario=X` | saldo (`/balances/X`) |
| GET | `acao=usuarios&usuario=X[&limite=N]` | saldo + mineradores + transações (`/users/X`) |
| GET | `acao=mineradores&usuario=X` | rigs registrados (`/miners/X`) |
| GET | `acao=transacoes&usuario=X[&limite=N]` | transações (`/user_transactions/X`) |
| GET | `acao=transacoes&hash=H` | transação por hash (`/transactions/H`) |
| GET | `acao=estatisticas` | estatísticas do servidor (`/statistics`) |
| GET | `acao=preco` | preço do DUCO em US$ |
| GET | `acao=pools` | pools (`/all_pools`) |
| GET | `acao=loja` | itens da loja (`/shop_items`) |
| GET | `acao=autenticar&usuario&senha` | checa a senha (`/auth/X`) |
| GET | `acao=verificar&lastBlockHash&hashEsperado&nonce` | valida um nonce (local) |
| GET | `acao=converter&duco&preco&cambio&taxa` | DUCO → US$ → R$ (local) |
| GET/POST | `acao=minerar&lastBlockHash&hashEsperado&dificuldade[&inicio&maxMs]` | **busca o nonce** (local) |
| GET/POST | `acao=proxy&caminho=/statistics[&metodo=POST]` | proxy de qualquer endpoint oficial |
| POST | `acao=transferir&usuario&senha&destinatario&valor[&memo]` | envia DUCO (`/transaction`) |
| POST | `acao=trocar_chave&u&k&senha` | troca a mining key (`/mining_key`) |
| POST | `acao=comprar_item&usuario&senha&item` | compra item (`/shop_buy/X`) |
| POST | `acao=trocar_senha&usuario&senha&novasenha` | troca a senha (`/changepass/X`) |

## Exemplos

```bash
# Saldo
curl "https://CONTA.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=ID&deploy=ID&acao=saldo&usuario=duco"

# Preço do DUCO
curl "...&acao=preco"

# Mineração (fatiada): primeiro pedaço
curl "...&acao=minerar&lastBlockHash=8a1d...&hashEsperado=05ca...&dificuldade=200"
# Resposta: { "encontrado": false, "esgotado": "tempo", "proximo": 84312, ... }
# Continua de onde parou:
curl "...&acao=minerar&lastBlockHash=8a1d...&hashEsperado=05ca...&dificuldade=200&inicio=84312"
```

POST com corpo JSON também funciona (útil para clientes REST):

```bash
curl -X POST "...restlet.nl?script=ID&deploy=ID" \
  -H "Content-Type: application/json" \
  -d '{"acao":"minerar","lastBlockHash":"8a1d...","hashEsperado":"05ca...","dificuldade":200}'
```

## Como a mineração funciona (e os limites)

- **Regra DUCO-S1A**: achar o `nonce` em que `SHA1(lastBlockHash + nonce)` é igual ao
  hash esperado, testando de `0` até `100 × dificuldade + 1` — a mesma regra do
  `duco-miner.js` validado e do `trabalhador.js` deste repositório. O núcleo SHA1 aqui
  é uma portagem em arrays comuns do núcleo de `trabalhador.js`.
- **O Restlet NÃO busca job sozinho.** O protocolo do DUCO é TCP/WebSocket
  (`wss://magi.duinocoin.com:8443`) e o SuiteScript só fala HTTP. Quem chama manda o job
  (`lastBlockHash`, `hashEsperado`, `dificuldade`) — por exemplo, obtido pelo web miner
  oficial ou pela página daqui — e o Restlet resolve o nonce.
- **Fatiamento por governança.** Restlet tem limite de tempo e de unidades; cada chamada
  trava no `maxMs` (padrão 4 s, teto 30 s) ou quando as unidades sobram menos de 60,
  devolvendo `esgotado: "tempo" | "unidades"` e o campo **`proximo`** para retomar.
- **Cuidado com os Termos de Uso do DUCO**: sem VPN, sem VPS grátis, uma conta só.
  Isto é um projeto didático — o minerador oficial continua sendo o recomendado.

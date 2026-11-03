/**
 * =============================================================
 * duco-restlet.js — Restlet do NetSuite com as funcionalidades do Duino-Coin
 * -------------------------------------------------------------
 * SuiteScript 2.0 (tipo Restlet). Publica num único endereço:
 *
 *   GET  ?acao=ajuda                     -> lista todas as ações
 *   GET  ?acao=saldo&usuario=X           -> saldo da conta
 *   GET  ?acao=usuarios&usuario=X        -> saldo + mineradores + transações
 *   GET  ?acao=mineradores&usuario=X     -> rigs registrados
 *   GET  ?acao=transacoes&usuario=X      -> transações (ou &hash=...)
 *   GET  ?acao=estatisticas              -> estatísticas do servidor
 *   GET  ?acao=preco                     -> preço do DUCO em US$
 *   GET  ?acao=pools                     -> pools de mineração
 *   GET  ?acao=loja                      -> itens da loja
 *   GET  ?acao=autenticar&usuario&senha  -> checa a senha da conta
 *   GET  ?acao=verificar&lastBlockHash&hashEsperado&nonce
 *                                        -> valida um nonce (DUCO-S1A)
 *   GET  ?acao=converter&duco&preco&cambio&taxa -> DUCO -> US$ -> R$
 *   GET  ?acao=minerar&lastBlockHash&hashEsperado&dificuldade[&inicio&maxMs]
 *   POST acao=minerar (mesmos campos, corpo JSON) -> procura o nonce
 *   POST acao=proxy&caminho=/statistics   -> repassa QUALQUER caminho da
 *                                            API oficial (server.duinocoin.com)
 *   POST acao=transferir&usuario&senha&destinatario&valor[&memo]
 *   POST acao=trocar_chave&u&k&senha     -> troca a mining key
 *   POST acao=comprar_item&usuario&senha&item
 *   POST acao=trocar_senha&usuario&senha&novasenha
 *
 * MINERAÇÃO EM RESTLET — o que dá e o que não dá:
 * • O protocolo do DUCO é TCP/WebSocket, e o SuiteScript só fala HTTP.
 *   Então o Restlet NÃO busca job sozinho: quem chama manda o job
 *   (lastBlockHash, hashEsperado, dificuldade) — por exemplo obtido pelo
 *   gateway WebSocket — e o Restlet resolve o nonce aqui.
 * • Restlet tem limite de tempo e de unidades de governança: a busca é
 *   fatiada por "maxMs" (padrão 4 s, teto 30 s) e devolve "proximo" para
 *   o chamador retomar de onde parou, sem estourar limite.
 * • O núcleo SHA1 (DUCO-S1A) é o MESMO do trabalhador.js (puro JS) —
 *   validado por restlet/teste-restlet.js contra o crypto do Node.
 *
 * Para testar em Node o teste injeta um define() falso e módulos N/*
 * falsos — este arquivo não chama require().
 * =============================================================
 */

/**
 * @NApiVersion 2.x
 * @NScriptType restlet
 * @NModuleScope SameAccount
 */
define(['N/log', 'N/http', 'N/runtime'], function (log, http, runtime) {
  'use strict';

  // =============================================================
  // Constantes
  // =============================================================
  var API_OFICIAL = 'https://server.duinocoin.com';
  var USER_AGENT = 'DuinoCoin-Restlet/1.0 (SuiteScript 2.0)';
  var MAX_MS_PADRAO = 4000;      // orçamento padrão de mineração por chamada
  var MAX_MS_TETO = 30000;       // teto absoluto por chamada
  var UNIDADES_RESERVADAS = 60;  // para quando a governança está acabando
  var HEX40 = /^[0-9a-fA-F]{40}$/;

  // =============================================================
  // Utilidades
  // =============================================================
  function texto(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function erro(mensagem) {
    log.error({ title: 'duco-restlet', details: mensagem });
    return { sucesso: false, erro: mensagem };
  }

  /** JSON vindo do corpo do POST pode chegar como string. */
  function comoObjeto(valor) {
    if (valor && typeof valor === 'object') return valor;
    if (typeof valor === 'string' && valor.charAt(0) === '{') {
      try { return JSON.parse(valor); } catch (e) { return null; }
    }
    return null;
  }

  /** Funde corpo JSON e parâmetros de query num único mapa de parâmetros. */
  function parametrosDe(context) {
    var params = {};
    var corpo = comoObjeto(context.body) || comoObjeto(context.requestBody);
    if (corpo) {
      for (var c in corpo) {
        if (Object.prototype.hasOwnProperty.call(corpo, c)) params[c] = corpo[c];
      }
    }
    for (var k in context) {
      if (!Object.prototype.hasOwnProperty.call(context, k)) continue;
      if (k === 'body' || k === 'requestBody') continue;
      var v = context[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;          // arquivos/binários: ignora
      params[k] = v;
    }
    return params;
  }

  /** Monta URL da API oficial: caminho + query string (valores codificados). */
  function montarUrl(caminho, params) {
    var url = API_OFICIAL + caminho;
    var partes = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v === null || v === undefined || typeof v === 'object') continue;
      partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(texto(v)));
    }
    if (partes.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + partes.join('&');
    return url;
  }

  /** GET na API oficial; devolve { http, dados }. */
  function getOficial(caminho, params) {
    var resposta = http.get({
      url: montarUrl(caminho, params || {}),
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    return interpretarResposta(resposta);
  }

  function interpretarResposta(resposta) {
    var corpo = resposta ? resposta.body : null;
    try {
      return { http: resposta.code, dados: JSON.parse(corpo) };
    } catch (e) {
      return {
        http: resposta ? resposta.code : 0,
        dados: { sucesso: false, erro: 'resposta inesperada da API oficial (' +
          (resposta ? resposta.code : 'sem resposta') + ')' },
      };
    }
  }
  /**
   * Proxy genérico: repassa QUALQUER endpoint da API oficial.
   * caminho: ex. "/statistics" | método: GET/POST.
   */
  function proxy(caminho, metodo, params) {
    if (!caminho) return erro('proxy precisa de "caminho" (ex.: /statistics)');
    if (caminho.charAt(0) !== '/' && caminho.charAt(0) !== '?') {
      caminho = '/' + caminho;
    }
    // remove os parâmetros de roteamento do restlet do que vai ao upstream
    var upstream = {};
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      if (k === 'acao' || k === 'action' || k === 'caminho' || k === 'metodo') continue;
      upstream[k] = params[k];
    }

    if (texto(metodo).toUpperCase() === 'POST') {
      var respostaPost = http.post({
        url: montarUrl(caminho, {}),
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json',
                   'Accept': 'application/json' },
        body: JSON.stringify(upstream),
      });
      return interpretarResposta(respostaPost).dados;
    }
    return getOficial(caminho, upstream).dados;
  }

  // =============================================================
  // Núcleo DUCO-S1A — SHA1 em JS puro (MESMO algoritmo do trabalhador.js)
  // Arrays comuns (sem Uint8Array) para rodar em qualquer engine do
  // NetSuite; a mensagem do job tem no máximo ~52 bytes, cabe em um bloco.
  // =============================================================
  var H0 = 0x67452301;
  var H1 = 0xefcdab89 | 0;
  var H2 = 0x98badcfe | 0;
  var H3 = 0x10325476;
  var H4 = 0xc3d2e1f0 | 0;

  function rotl(x, n) {
    return ((x << n) | (x >>> (32 - n))) | 0;
  }

  /** Uma compressão SHA1 (80 rodadas) -> 5 palavras do digest. */
  function comprimir(bloco, W, a, b, c, d, e) {
    var a0 = a; var b0 = b; var c0 = c; var d0 = d; var e0 = e;
    var i; var t;
    for (i = 0; i < 16; i++) {
      W[i] = (bloco[i * 4] << 24) | (bloco[i * 4 + 1] << 16) |
              (bloco[i * 4 + 2] << 8) | bloco[i * 4 + 3];
    }
    for (i = 16; i < 80; i++) {
      var x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
      W[i] = (x << 1) | (x >>> 31);
    }
    for (i = 0; i < 20; i++) {
      t = (rotl(a, 5) + ((b & c) | (~b & d)) + e + W[i] + 0x5a827999) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    for (i = 20; i < 40; i++) {
      t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0x6ed9eba1) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    for (i = 40; i < 60; i++) {
      t = (rotl(a, 5) + ((b & c) | (b & d) | (c & d)) + e + W[i] + 0x8f1bbcdc) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    for (i = 60; i < 80; i++) {
      t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0xca62c1d6) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    a = (a + a0) | 0; b = (b + b0) | 0; c = (c + c0) | 0;
    d = (d + d0) | 0; e = (e + e0) | 0;
    return [a, b, c, d, e];
  }

  function hex8(v) {
    var s = (v >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  /** SHA1 completo em hex de um texto ASCII (validação de nonce). */
  function sha1Hex(textoAscii) {
    var total = textoAscii.length;
    var blocos = Math.ceil((total + 9) / 64);
    var a = H0; var b = H1; var c = H2; var d = H3; var e = H4;
    var W = new Array(80);

    for (var i = 0; i < blocos; i++) {
      var bloco = new Array(64);
      var inicio = i * 64;
      var j;
      for (j = 0; j < 64; j++) {
        var idx = inicio + j;
        bloco[j] = idx < total ? textoAscii.charCodeAt(idx) & 0xff : 0;
      }
      var posTermo = total - inicio;                 // 0x80 logo após a mensagem
      if (posTermo >= 0 && posTermo < 64) bloco[posTermo] = 0x80;

      if (i === blocos - 1) {
        var bits = total * 8;
        bloco[60] = (bits >>> 24) & 0xff;
        bloco[61] = (bits >>> 16) & 0xff;
        bloco[62] = (bits >>> 8) & 0xff;
        bloco[63] = bits & 0xff;
      }
      var h = comprimir(bloco, W, a, b, c, d, e);
      a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4];
    }
    return hex8(a) + hex8(b) + hex8(c) + hex8(d) + hex8(e);
  }

  /** "aabbcc..." (40 chars hex) -> 5 palavras de 32 bits do digest. */
  function palavrasDoHex(hex) {
    if (typeof hex !== 'string' || !HEX40.test(hex)) return null;
    var p = new Array(5);
    for (var i = 0; i < 5; i++) {
      p[i] = parseInt(hex.substr(i * 8, 8), 16) | 0;
    }
    return p;
  }
  /**
   * Buscador de nonce: SHA1(lastBlockHash + nonce) == hashEsperado.
   * @param {string} prefixoHex lastBlockHash do job (40 caracteres hex)
   */
  function criarBuscador(prefixoHex) {
    if (!HEX40.test(texto(prefixoHex))) {
      throw new Error('lastBlockHash inválido no job (esperado 40 caracteres hex)');
    }
    var bloco = new Array(64);
    var i;
    for (i = 0; i < 64; i++) bloco[i] = 0;
    // O DUCO hasheia o TEXTO do job: 40 caracteres ASCII do lastBlockHash
    // seguidos dos dígitos do nonce (igual ao duco-miner.js validado).
    for (i = 0; i < 40; i++) bloco[i] = prefixoHex.charCodeAt(i);
    var W = new Array(80);
    var digitos = 0;                     // dígitos do último nonce escrito

    /** Escreve o nonce em decimal a partir do byte 40; devolve nº de dígitos. */
    function escreverNonce(n) {
      var q = n;
      var feitos = 0;
      if (q === 0) { bloco[40] = 48; return 1; }
      while (q > 0) {
        bloco[40 + feitos] = 48 + (q % 10);
        q = (q / 10) | 0;
        feitos++;
      }
      for (var x = 0, y = feitos - 1; x < y; x++, y--) {
        var t = bloco[40 + x];
        bloco[40 + x] = bloco[40 + y];
        bloco[40 + y] = t;
      }
      return feitos;
    }

    /**
     * Procura em [inicio, fim) o nonce tal que SHA1(prefixo + nonce) = alvo.
     * @param {Array} alvo 5 palavras do hash esperado
     * @param {number} inicio primeiro nonce testado
     * @param {number} fim limite EXCLUSIVO de nonces
     * @param {Object} limites { maxMs, unidadesMinimas } — cedo para não
     *        estourar o tempo nem a governança do Restlet.
     * @returns {Object} { nonce, testados, esgotado: null|'tempo'|'unidades'|'nonce' }
     */
    function procurar(alvo, inicio, fim, limites) {
      var t0 = Date.now();
      var maxMs = limites && limites.maxMs ? limites.maxMs : MAX_MS_PADRAO;
      var unidadesMinimas = limites && typeof limites.unidadesMinimas === 'number'
        ? limites.unidadesMinimas : UNIDADES_RESERVADAS;
      function unidadesOk() {
        try {
          return runtime.getCurrentScript().getRemainingUsage() > unidadesMinimas;
        } catch (e) {
          return true;                     // fora do NetSuite (teste) segue sempre
        }
      }

      var esgotado = null;
      var testados = 0;
      var n;
      for (n = inicio; n < fim; n++) {
        var d = escreverNonce(n);
        bloco[40 + d] = 0x80;                     // terminador logo após os dígitos
        if (d !== digitos) {                      // mudou a quantidade de dígitos
          digitos = d;
          var bits = (40 + d) * 8;                // tamanho da mensagem em bits
          bloco[60] = (bits >>> 24) & 0xff;
          bloco[61] = (bits >>> 16) & 0xff;
          bloco[62] = (bits >>> 8) & 0xff;
          bloco[63] = bits & 0xff;
        }
        var h = comprimir(bloco, W, H0, H1, H2, H3, H4);
        testados++;
        if (h[0] === alvo[0] && h[1] === alvo[1] && h[2] === alvo[2] &&
            h[3] === alvo[3] && h[4] === alvo[4]) {
          return { nonce: n, testados: testados, esgotado: null };
        }
        if ((n & 1023) === 0) {            // checa limites a cada 1024 nonces
          if (Date.now() - t0 >= maxMs) { esgotado = 'tempo'; break; }
          if (!unidadesOk()) { esgotado = 'unidades'; break; }
        }
      }
      if (!esgotado && n >= fim) esgotado = 'nonce';   // varreu o intervalo todo
      return { nonce: -1, testados: testados, esgotado: esgotado };
    }

    return { procurar: procurar };
  }
  /**
   * Mineração fatiada: valida o job, define o intervalo e chama o buscador.
   * Parâmetros: lastBlockHash, hashEsperado, dificuldade,
   *             inicio (opcional), maxMs (opcional).
   */
  function minerar(p) {
    var prefixo = texto(p.lastBlockHash).trim();
    var hashEsperado = texto(p.hashEsperado || p.hash).trim();
    if (!HEX40.test(prefixo)) return erro('lastBlockHash inválido (40 hex esperado)');
    if (!HEX40.test(hashEsperado)) return erro('hashEsperado inválido (40 hex esperado)');

    var dificuldade = Number(p.dificuldade);
    if (!isFinite(dificuldade) || dificuldade <= 0) {
      return erro('dificuldade inválida');
    }
    var limite = 100 * dificuldade + 1;              // regra oficial do minerador
    var inicio = Number(p.inicio);
    if (!isFinite(inicio) || inicio < 0) inicio = 0;
    if (inicio >= limite) return erro('inicio maior que o limite do job (100 × dificuldade + 1)');

    var maxMs = Number(p.maxMs);
    if (!isFinite(maxMs) || maxMs <= 0) maxMs = MAX_MS_PADRAO;
    if (maxMs > MAX_MS_TETO) maxMs = MAX_MS_TETO;

    var alvo = palavrasDoHex(hashEsperado);
    if (!alvo) return erro('hashEsperado inválido (40 hex esperado)');

    var t0 = Date.now();
    var resultado;
    try {
      resultado = criarBuscador(prefixo).procurar(alvo, inicio, limite, { maxMs: maxMs });
    } catch (e) {
      return erro('falha ao buscar nonce: ' + (e.message || e));
    }
    var ms = Math.max(1, Date.now() - t0);
    var testados = resultado.testados;

    var saida = {
      sucesso: true,
      encontrado: resultado.nonce >= 0,
      nonce: resultado.nonce,
      hash: resultado.nonce >= 0 ? sha1Hex(prefixo + resultado.nonce) : null,
      dificuldade: dificuldade,
      limite: limite,
      inicio: inicio,
      testados: testados,
      proximo: resultado.nonce >= 0 ? null : inicio + testados,
      esgotado: resultado.esgotado,        // null | 'tempo' | 'unidades' | 'nonce'
      tempoMs: ms,
      hashrate: Math.round(testados / (ms / 1000)),
    };
    if (saida.esgotado === 'nonce') saida.encontrado = false;   // intervalo varrido sem solução
    log.debug({ title: 'duco-restlet:minerar', details: JSON.stringify(saida) });
    return saida;
  }

  /** Valida um nonce candidato contra o job (sem procurar). */
  function verificar(p) {
    var prefixo = texto(p.lastBlockHash).trim();
    var hashEsperado = texto(p.hashEsperado || p.hash).trim();
    var nonce = texto(p.nonce).trim();
    if (!HEX40.test(prefixo)) return erro('lastBlockHash inválido (40 hex esperado)');
    if (!HEX40.test(hashEsperado)) return erro('hashEsperado inválido (40 hex esperado)');
    if (!/^\d+$/.test(nonce)) return erro('nonce deve ser um inteiro decimal');
    var hash = sha1Hex(prefixo + nonce);
    return {
      sucesso: true,
      valido: hash.toLowerCase() === hashEsperado.toLowerCase(),
      hash: hash,
      esperado: hashEsperado,
    };
  }

  /** Conversão DUCO -> US$ -> R$, mesma fórmula da página do GitHub Pages. */
  function converter(p) {
    var duco = Number(p.duco);
    var preco = Number(p.preco);
    var cambio = Number(p.cambio);
    var taxa = Number(p.taxa);
    if (!isFinite(duco) || duco < 0) return erro('duco inválido');
    if (!isFinite(preco) || preco < 0) return erro('preco inválido');
    if (!isFinite(cambio) || cambio < 0) return erro('cambio inválido');
    if (!isFinite(taxa) || taxa < 0 || taxa > 100) return erro('taxa inválida (0 a 100)');

    var brutoUsd = duco * preco;
    var liquidoUsd = brutoUsd * (1 - taxa / 100);
    return {
      sucesso: true,
      duco: duco,
      precoUsd: preco,
      brutoUsd: brutoUsd,
      liquidoUsd: liquidoUsd,
      liquidoBrl: liquidoUsd * cambio,
      cambioUsdBrl: cambio,
      taxaPercentual: taxa,
    };
  }
  // =============================================================
  // Roteador: todas as funcionalidades do DUCO em um único Restlet
  // =============================================================
  var AJUDA = {
    sucesso: true,
    acoes: {
      'GET ajuda': 'esta lista',
      'GET saldo&usuario': 'saldo da conta (/balances/<u>)',
      'GET usuarios&usuario[&limite]': 'saldo + mineradores + transações (/users/<u>)',
      'GET mineradores&usuario': 'rigs registrados (/miners/<u>)',
      'GET transacoes&usuario[&limite]': 'transações do usuário (/user_transactions/<u>)',
      'GET transacoes&hash': 'transação por hash (/transactions/<hash>)',
      'GET estatisticas': 'estatísticas do servidor (/statistics)',
      'GET preco': 'preço do DUCO em US$ (campo "Duco price" de /statistics)',
      'GET pools': 'pools de mineração (/all_pools)',
      'GET loja': 'itens da loja (/shop_items)',
      'GET autenticar&usuario&senha': 'checa a senha (/auth/<u>)',
      'GET verificar&lastBlockHash&hashEsperado&nonce': 'valida um nonce (DUCO-S1A local)',
      'GET converter&duco&preco&cambio&taxa': 'DUCO -> US$ -> R$ (cálculo local)',
      'GET|POST minerar&lastBlockHash&hashEsperado&dificuldade[&inicio&maxMs]':
        'busca o nonce do job (local, fatiada por maxMs; use "proximo" para retomar)',
      'GET|POST proxy&caminho': 'repassa QUALQUER endpoint de server.duinocoin.com',
      'POST transferir&usuario&senha&destinatario&valor[&memo]': 'envia DUCO (/transaction)',
      'POST trocar_chave&u&k&senha': 'troca a mining key (/mining_key)',
      'POST comprar_item&usuario&senha&item': 'compra item da loja (/shop_buy/<u>)',
      'POST trocar_senha&usuario&senha&novasenha': 'troca a senha (/changepass/<u>)',
    },
    apiOficial: API_OFICIAL,
    aviso: 'A mineração local NÃO busca job: o protocolo DUCO é TCP/WebSocket e o '
      + 'SuiteScript só fala HTTP. Passe lastBlockHash/hashEsperado/dificuldade '
      + 'obtidos no gateway e use "proximo" para fatiar a busca.',
  };

  function exigir(p, nomes) {
    for (var i = 0; i < nomes.length; i++) {
      if (texto(p[nomes[i]]).trim() === '') {
        return 'parâmetro obrigatório ausente: ' + nomes[i];
      }
    }
    return null;
  }

  /** GET — roteia pela ação. */
  function rotearGet(context) {
    var p = parametrosDe(context);
    var acao = texto(p.acao || p.action || 'ajuda').toLowerCase();

    switch (acao) {
      case 'ajuda':
      case 'help':
        return AJUDA;

      case 'saldo':
      case 'balance': {
        var faltou = exigir(p, ['usuario']);
        if (faltou) return erro(faltou);
        return getOficial('/balances/' + encodeURIComponent(texto(p.usuario).trim()), {}).dados;
      }

      case 'usuarios':
      case 'user': {
        faltou = exigir(p, ['usuario']);
        if (faltou) return erro(faltou);
        var q = {};
        if (p.limite) q.limit = p.limite;
        return getOficial('/users/' + encodeURIComponent(texto(p.usuario).trim()), q).dados;
      }

      case 'mineradores':
      case 'miners': {
        faltou = exigir(p, ['usuario']);
        if (faltou) return erro(faltou);
        return getOficial('/miners/' + encodeURIComponent(texto(p.usuario).trim()), {}).dados;
      }

      case 'transacoes':
      case 'transactions': {
        if (texto(p.hash).trim()) {
          return getOficial('/transactions/' + encodeURIComponent(texto(p.hash).trim()), {}).dados;
        }
        faltou = exigir(p, ['usuario']);
        if (faltou) return erro(faltou);
        var qt = {};
        if (p.limite) qt.limit = p.limite;
        return getOficial('/user_transactions/' + encodeURIComponent(texto(p.usuario).trim()), qt).dados;
      }

      case 'estatisticas':
      case 'statistics':
        return getOficial('/statistics', {}).dados;

      case 'preco':
      case 'price': {
        var stats = getOficial('/statistics', {}).dados;
        var preco = stats ? stats['Duco price'] : undefined;
        if (preco === undefined) return erro('não consegui ler o preço em /statistics');
        return { sucesso: true, precoUsd: preco };
      }
      case 'pools':
        return getOficial('/all_pools', {}).dados;

      case 'loja':
      case 'shop':
        return getOficial('/shop_items', {}).dados;

      case 'autenticar':
      case 'auth': {
        faltou = exigir(p, ['usuario', 'senha']);
        if (faltou) return erro(faltou);
        return getOficial('/auth/' + encodeURIComponent(texto(p.usuario).trim()),
          { password: p.senha }).dados;
      }

      case 'verificar':
        return verificar(p);

      case 'converter':
        return converter(p);

      case 'minerar':
        return minerar(p);

      case 'proxy':
        return proxy(texto(p.caminho), p.metodo || 'GET', p);

      default:
        return erro('ação desconhecida: "' + acao + '" — consulte ?acao=ajuda');
    }
  }

  /** POST — o corpo JSON é mesclado aos parâmetros de query. */
  function rotearPost(context) {
    var p = parametrosDe(context);
    var acao = texto(p.acao || p.action || '').toLowerCase();

    switch (acao) {
      case 'minerar':
        return minerar(p);

      case 'verificar':
        return verificar(p);

      case 'converter':
        return converter(p);

      case 'proxy':
        return proxy(texto(p.caminho), p.metodo || 'POST', p);

      case 'transferir': {
        var faltou = exigir(p, ['usuario', 'senha', 'destinatario', 'valor']);
        if (faltou) return erro(faltou);
        return getOficial('/transaction', {
          username: p.usuario,
          password: p.senha,
          recipient: p.destinatario,
          amount: p.valor,
          memo: p.memo || 'None',
        }).dados;
      }

      case 'trocar_chave': {
        faltou = exigir(p, ['u', 'k', 'senha']);
        if (faltou) return erro(faltou);
        // /mining_key: POST com u, k e password
        return proxy('/mining_key', 'POST', { u: p.u, k: p.k, password: p.senha });
      }

      case 'comprar_item': {
        faltou = exigir(p, ['usuario', 'senha', 'item']);
        if (faltou) return erro(faltou);
        return getOficial('/shop_buy/' + encodeURIComponent(texto(p.usuario).trim()),
          { item: p.item, password: p.senha }).dados;
      }

      case 'trocar_senha': {
        faltou = exigir(p, ['usuario', 'senha', 'novasenha']);
        if (faltou) return erro(faltou);
        return getOficial('/changepass/' + encodeURIComponent(texto(p.usuario).trim()),
          { password: p.senha, newpassword: p.novasenha }).dados;
      }

      case 'ajuda':
      case 'help':
        return AJUDA;

      default:
        // Sem ação explícita: se veio um job completo, minera (POST confortável);
        // senão, explica o que falta — nunca um erro surpresa mudo.
        if (texto(p.lastBlockHash).trim() && texto(p.hashEsperado || p.hash).trim()) {
          return minerar(p);
        }
        return erro('POST sem "acao" — envie acao=minerar|proxy|transferir|trocar_chave|'
          + 'comprar_item|trocar_senha (veja GET ?acao=ajuda)');
    }
  }

  // =============================================================
  // Entradas do Restlet
  // =============================================================
  function get(context) {
    try {
      return rotearGet(context || {});
    } catch (e) {
      return erro('GET falhou: ' + (e.message || e));
    }
  }

  function post(context) {
    try {
      return rotearPost(context || {});
    } catch (e) {
      return erro('POST falhou: ' + (e.message || e));
    }
  }

  function del(context) {
    return erro('DELETE não faz sentido no DUCO — veja GET ?acao=ajuda');
  }

  function put(context) {
    // PUT é aceito como sinônimo de POST para clientes REST genéricos.
    return post(context);
  }

  // Exposto também para o teste em Node (valida o núcleo contra o crypto).
  return {
    get: get,
    post: post,
    put: put,
    delete: del,
    _interno: {
      sha1Hex: sha1Hex,
      criarBuscador: criarBuscador,
      palavrasDoHex: palavrasDoHex,
      montarUrl: montarUrl,
      parametrosDe: parametrosDe,
      minerar: minerar,
      verificar: verificar,
      converter: converter,
    },
  };
});






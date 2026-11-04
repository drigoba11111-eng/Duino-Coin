# Alerta do Dólar (Expo)

App em JavaScript (sem TypeScript) feito com Expo SDK 58. Ele monitora a cotação do dólar em segundo plano e notifica quando ela atinge um valor configurado.

## Estrutura

```
duco-dolar-alert/
├── index.js            # entrada: registra a tarefa de background e o App
├── App.js              # só a interface
├── app.json            # config do Expo (nome, package, plugins)
├── jsconfig.json       # checagem de tipos via JSDoc (// @ts-check)
└── src/
    ├── cotacao.js      # busca na AwesomeAPI, parse e formatação
    ├── storage.js      # config persistida (AsyncStorage)
    ├── notificacoes.js # permissão, canal Android e disparo
    └── tarefa.js       # tarefa de background + verificarCotacao()
```

As pastas `android/` e `ios/` **não são versionadas**. O Expo gera essas pastas a partir do `app.json`.

## Como rodar

Requisitos: Node 20+, Android Studio com SDK e um emulador ou aparelho com depuração USB.

```powershell
npm install
npx expo run:android
```

O `run:android` gera a pasta `android/`, compila um build de desenvolvimento e instala no aparelho. Depois disso, basta `npx expo start` para editar o código com hot reload.

> **Expo Go não serve** para testar o background. Tarefas em segundo plano exigem um build próprio, seja o `expo run:android` ou um build EAS.

### Gerar APK para instalar

```powershell
npm install -g eas-cli
eas build -p android --profile preview
```

## Como funciona

1. Digite o limite (ex.: `5,50`) e toque em **Ativar alerta**. O app pede permissão de notificação, exigida no Android 13+.
2. A tarefa `verificar-dolar` é registrada no sistema (WorkManager no Android) com intervalo mínimo de 15 min. Ela roda mesmo com o app fechado e depois de reiniciar o aparelho.
3. Quando a cotação atinge o limite, chega **uma** notificação. O app só volta a avisar depois que a cotação cair abaixo do limite e subir de novo.
4. Ao abrir o app, ou tocar na cotação, ele atualiza na hora.

Em modo dev aparece o botão **[dev] Rodar tarefa de background agora**, que força a execução para teste.

## Observações

- O intervalo de 15 min é **mínimo**. O Android adia a tarefa conforme bateria e uso, e alguns fabricantes (Xiaomi, Samsung etc.) são agressivos. Desative a otimização de bateria do app para melhorar.
- API: `https://economia.awesomeapi.com.br/last/USD-BRL` (gratuita, sem chave).

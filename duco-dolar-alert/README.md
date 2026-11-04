# DucoDolarAlert

App React Native (JavaScript puro, sem TypeScript) que monitora a cotação do dólar em segundo plano no Android e dispara alerta quando atinge um valor configurado.

## Estrutura

```
duco-dolar-alert/
├── App.js
├── index.js
├── babel.config.js
├── package.json
├── README.md
└── android/   (estrutura mínima do Android)
```

## Como rodar

### 1. Gerar a estrutura Android completa

Como esta pasta não contém o boilerplate completo do Android (Gradle wrapper, etc.), rode dentro da pasta `duco-dolar-alert`:

```powershell
npx react-native init DucoDolarAlert --skip-install
```

Isso criará a subpasta `DucoDolarAlert/` com todo o projeto Android. **Copie o arquivo `App.js` desta pasta para dentro de `duco-dolar-alert/DucoDolarAlert/App.js`**, substituindo o gerado.

> Se preferir, mova todo o conteúdo desta pasta para dentro da pasta `DucoDolarAlert` gerada pelo init.

### 2. Instalar dependências

```powershell
npm install
```

### 3. Rodar no Android

```powershell
npx react-native run-android
```

Certifique-se de ter o Android SDK configurado e um emulador ou dispositivo conectado com depuração USB ativada.

## Funcionamento

1. Abra o app e digite um valor em reais (ex.: `5,50`).
2. Toque em **✅ Ativar alerta em segundo plano**.
3. O app consulta a AwesomeAPI a cada 15 minutos, mesmo com a tela desligada ou o app fechado.
4. Quando a cotação atingir o valor configurado, uma notificação local é disparada.

## Observações importantes

- **Otimização de bateria:** No Android, vá em Configurações > Apps > DucoDolarAlert > Bateria e desative a otimização para este app. Caso contrário, o Android pode encerrar o serviço em segundo plano.
- **API usada:** `https://economia.awesomeapi.com.br/last/USD-BRL` (gratuita, sem chave, CORS liberado).
- **Segundo plano:** Utiliza `react-native-background-fetch`. O intervalo mínimo real depende do fabricante do aparelho (geralmente 15 min ou mais).

## Requisitos

- Node.js instalado
- Android Studio com SDK e emulador (ou dispositivo físico)
- Variáveis de ambiente `ANDROID_HOME` e `JAVA_HOME` configuradas

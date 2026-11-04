import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, Alert, Platform, StatusBar,
  PushNotificationIOS,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundFetch from 'react-native-background-fetch';
import PushNotification from 'react-native-push-notification';

const URL_DOLAR = 'https://economia.awesomeapi.com.br/last/USD-BRL';
const CHAVE_LIMITE = 'alertaDolarLimite';
const CHAVE_ATIVO = 'alertaDolarAtivo';
const INTERVALO_MINUTOS = 15;

export default function App() {
  const [cotacao, setCotacao] = useState(null);
  const [limite, setLimite] = useState('');
  const [alertaAtivo, setAlertaAtivo] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState('--');
  const bgConfigurado = useRef(false);

  useEffect(() => {
    PushNotification.configure({
      onNotification: (n) => {
        try { n.finish(PushNotificationIOS?.FetchResult?.NoData ?? 0); }
        catch (e) { console.log('finish err', e); }
      },
      onRegister: (t) => console.log('TOKEN:', t),
      popInitialNotification: true,
      requestPermissions: Platform.OS === 'ios',
    });
    if (Platform.OS === 'android') {
      PushNotification.createChannel({
        channelId: 'alerta-dolar',
        channelName: 'Alerta do Dólar',
        channelDescription: 'Notificações de cotação',
        playSound: true,
        soundName: 'default',
        importance: 4,
        vibrate: true,
      });
    }
  }, []);

  useEffect(() => {
    const carregar = async () => {
      try {
        const salvo = await AsyncStorage.getItem(CHAVE_LIMITE);
        const ativo = await AsyncStorage.getItem(CHAVE_ATIVO);
        if (salvo) setLimite(salvo);
        if (ativo !== null) setAlertaAtivo(ativo === 'true');
      } catch (e) { console.log(e); }
    };
    carregar();
  }, []);

  const consultarDolar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await fetch(URL_DOLAR);
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const dados = await resposta.json();
      const c = dados && dados.USDBRL;
      if (!c) throw new Error('Dados inválidos');

      const valor = Number(c.bid);
      setCotacao(valor);
      setUltimaAtualizacao(new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit',
      }));

      if (alertaAtivo && limite) {
        const valorLimite = Number(String(limite).replace(',', '.'));
        if (!isNaN(valorLimite) && valor >= valorLimite) {
          PushNotification.localNotification({
            channelId: 'alerta-dolar',
            title: '🚨 Alerta do Dólar',
            message: `O dólar atingiu R$ ${valor.toFixed(2)}`,
            playSound: true,
            soundName: 'default',
            vibrate: true,
            importance: 'high',
          });
        }
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [alertaAtivo, limite]);

  const configurarAlerta = async () => {
    const valorLimite = Number(String(limite).replace(',', '.'));
    if (!valorLimite || valorLimite <= 0) {
      Alert.alert('Valor inválido', 'Digite um valor maior que zero.');
      return;
    }
    await AsyncStorage.setItem(CHAVE_LIMITE, String(valorLimite));
    await AsyncStorage.setItem(CHAVE_ATIVO, 'true');
    setAlertaAtivo(true);
    Alert.alert('Alerta ativado', `Avisarei quando o dólar atingir R$ ${valorLimite.toFixed(2)}`);
  };

  const desativarAlerta = async () => {
    await AsyncStorage.setItem(CHAVE_ATIVO, 'false');
    setAlertaAtivo(false);
    setLimite('');
     await pararMonitoramento();
    Alert.alert('Alerta desativado', 'Monitoramento parado.');
  };

  const iniciarMonitoramento = useCallback(async () => {
    try {
      if (bgConfigurado.current) return;
      bgConfigurado.current = true;
      await BackgroundFetch.configure({
        minimumFetchInterval: INTERVALO_MINUTOS,
        delay: 60 * 1000,
        periodic: true,
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
        requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
      }, async (taskId) => {
        await consultarDolar();
        BackgroundFetch.finish(taskId);
      }, (error) => console.log('Erro BG:', error));
      console.log('BackgroundFetch OK');
    } catch (e) { console.log('Erro BG:', e); }
  }, [consultarDolar]);

  const pararMonitoramento = useCallback(async () => {
    try { await BackgroundFetch.stop(); } catch (e) { console.log(e); }
     bgConfigurado.current = false;
  }, []);

  useEffect(() => {
    if (alertaAtivo && limite) {
      iniciarMonitoramento();
      consultarDolar();
    }
  }, [alertaAtivo, limite, iniciarMonitoramento, consultarDolar]);
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.titulo}>💵 Alerta do Dólar</Text>
          <Text style={styles.subtitulo}>
            Monitoramento em segundo plano (Android)
          </Text>

          <View style={styles.infoBloco}>
            <Text style={styles.rotulo}>Cotação atual (USD → BRL)</Text>
            {carregando ? (
              <Text style={styles.valor}>Consultando...</Text>
            ) : cotacao ? (
              <Text style={styles.valor}>R$ {cotacao.toFixed(4)}</Text>
            ) : (
              <Text style={styles.valor}>--</Text>
            )}
            {ultimaAtualizacao !== '--' && (
              <Text style={styles.hora}>Atualizado às {ultimaAtualizacao}</Text>
            )}
          </View>

          {erro && (
            <View style={styles.erroBloco}>
              <Text style={styles.erroTexto}>{erro}</Text>
            </View>
          )}

          <View style={styles.inputBloco}>
            <Text style={styles.rotulo}>Limite para alerta (R$)</Text>
            <TextInput
              style={styles.input}
              placeholder="Ex: 5,50"
              value={limite}
              onChangeText={setLimite}
              keyboardType="numeric"
              placeholderTextColor="#94a3b8"
            />
          </View>

          {alertaAtivo ? (
            <TouchableOpacity style={styles.btnDesativar} onPress={desativarAlerta}>
              <Text style={styles.btnTextoDesativar}>❌ Desativar alerta</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.btnAtivar} onPress={configurarAlerta}>
              <Text style={styles.btnTextoAtivar}>✅ Ativar alerta em segundo plano</Text>
            </TouchableOpacity>
          )}

          <View style={styles.rodape}>
            <Text style={styles.textoPequeno}>
              Fonte: AwesomeAPI — atualização a cada {INTERVALO_MINUTOS} min em background.
            </Text>
            <Text style={styles.textoPequeno}>
              Desative a otimização de bateria para este app nas configurações do Android.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
    alignItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
  },
  titulo: { fontSize: 26, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  subtitulo: {
    fontSize: 14, color: '#94a3b8', marginBottom: 20, textAlign: 'center',
  },
  infoBloco: { alignItems: 'center', marginBottom: 24 },
  rotulo: {
    fontSize: 13, color: '#94a3b8', marginBottom: 8, textAlign: 'center',
  },
  valor: {
    fontSize: 34, fontWeight: 'bold', color: '#22d3ee',
    fontFamily: 'monospace',
  },
  hora: { fontSize: 12, color: '#64748b', marginTop: 6 },
  erroBloco: {
    backgroundColor: '#7f1d1d', borderRadius: 8,
    padding: 12, width: '100%', marginBottom: 20,
  },
  erroTexto: { color: '#fecaca', fontSize: 13, textAlign: 'center' },
  inputBloco: { width: '100%', alignItems: 'center', marginBottom: 16 },
  input: {
    width: '100%', borderBottomWidth: 1, borderColor: '#475569',
    color: '#fff', fontSize: 18, paddingVertical: 8,
    textAlign: 'center', borderRadius: 4,
  },
  btnAtivar: {
    width: '100%', backgroundColor: '#22c55e', borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', marginBottom: 12,
  },
  btnTextoAtivar: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  btnDesativar: {
    width: '100%', backgroundColor: '#ef4444', borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  btnTextoDesativar: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  rodape: { width: '100%', marginTop: 24 },
  textoPequeno: {
    fontSize: 11, color: '#64748b', textAlign: 'center', marginTop: 4,
  },
});

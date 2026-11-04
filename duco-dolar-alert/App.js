// @ts-check
import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ScrollView,
  Alert, AppState, Linking, ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { parseValor, formatarReais } from './src/cotacao';
import { lerConfig, salvarConfig } from './src/storage';
import { pedirPermissao } from './src/notificacoes';
import {
  verificarCotacao, iniciarMonitoramento, pararMonitoramento,
  testarTarefaAgora, INTERVALO_MINUTOS,
} from './src/tarefa';

/** @typedef {import('./src/storage').Config} Config */

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Tela />
    </SafeAreaProvider>
  );
}

function Tela() {
  const [config, setConfig] = useState(/** @type {Config | null} */ (null));
  const [texto, setTexto] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(/** @type {string | null} */ (null));

  const atualizar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      await verificarCotacao();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      // Relê do storage: pega a cotação nova e mudanças feitas pela tarefa em background.
      setConfig(await lerConfig());
      setCarregando(false);
    }
  }, []);

  // Ao abrir: carrega config salva e consulta a cotação.
  useEffect(() => {
    lerConfig().then((c) => {
      setConfig(c);
      if (c.limite) setTexto(String(c.limite).replace('.', ','));
    });
    atualizar();
  }, [atualizar]);

  // Ao voltar para o app: atualiza.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') atualizar();
    });
    return () => sub.remove();
  }, [atualizar]);

  async function ativar() {
    const limite = parseValor(texto);
    if (!limite) {
      Alert.alert('Valor inválido', 'Digite um valor maior que zero, ex.: 5,50');
      return;
    }
    if (!(await pedirPermissao())) {
      Alert.alert(
        'Notificações bloqueadas',
        'Sem permissão de notificação o alerta não aparece. Libere nas configurações do app.',
        [{ text: 'Cancelar' }, { text: 'Abrir configurações', onPress: () => Linking.openSettings() }],
      );
      return;
    }
    try {
      await iniciarMonitoramento();
    } catch (e) {
      Alert.alert('Erro', e instanceof Error ? e.message : String(e));
      return;
    }
    setConfig(await salvarConfig({ limite, ativo: true, jaNotificado: false }));
    await atualizar(); // já avisa se a cotação atual estiver acima do limite
  }

  async function desativar() {
    await pararMonitoramento();
    setConfig(await salvarConfig({ ativo: false, jaNotificado: false }));
  }

  const ativo = !!config?.ativo;
  const cotacao = config?.ultimaCotacao ?? null;
  const hora = config?.ultimaConsulta
    ? new Date(config.ultimaConsulta).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.titulo}>💵 Alerta do Dólar</Text>
          <Text style={styles.subtitulo}>Monitoramento em segundo plano</Text>

          <Pressable style={styles.infoBloco} onPress={atualizar} disabled={carregando}>
            <Text style={styles.rotulo}>Cotação atual (USD → BRL)</Text>
            {carregando && cotacao === null ? (
              <ActivityIndicator color="#22d3ee" style={styles.loader} />
            ) : (
              <Text style={styles.valor}>{cotacao !== null ? formatarReais(cotacao, 4) : '--'}</Text>
            )}
            <Text style={styles.hora}>
              {carregando ? 'Atualizando…' : hora ? `Atualizado às ${hora} · toque para atualizar` : 'Toque para atualizar'}
            </Text>
          </Pressable>

          {erro && (
            <View style={styles.erroBloco}>
              <Text style={styles.erroTexto}>{erro}</Text>
            </View>
          )}

          <View style={styles.inputBloco}>
            <Text style={styles.rotulo}>Avisar quando o dólar chegar a (R$)</Text>
            <TextInput
              style={[styles.input, ativo && styles.inputBloqueado]}
              placeholder="Ex: 5,50"
              placeholderTextColor="#94a3b8"
              value={texto}
              onChangeText={setTexto}
              keyboardType="decimal-pad"
              editable={!ativo}
              returnKeyType="done"
              onSubmitEditing={ativo ? undefined : ativar}
            />
          </View>

          {ativo ? (
            <>
              <Text style={styles.status}>
                ✅ Ativo — {config?.jaNotificado ? 'limite atingido, aviso enviado' : 'aguardando o limite'}
              </Text>
              <Pressable style={[styles.btn, styles.btnDesativar]} onPress={desativar}>
                <Text style={styles.btnTexto}>Desativar alerta</Text>
              </Pressable>
            </>
          ) : (
            <Pressable style={[styles.btn, styles.btnAtivar]} onPress={ativar}>
              <Text style={styles.btnTexto}>Ativar alerta</Text>
            </Pressable>
          )}

          {__DEV__ && ativo && (
            <Pressable style={styles.btnDev} onPress={() => testarTarefaAgora()}>
              <Text style={styles.textoPequeno}>[dev] Rodar tarefa de background agora</Text>
            </Pressable>
          )}

          <View style={styles.rodape}>
            <Text style={styles.textoPequeno}>
              Fonte: AwesomeAPI. Verificação a cada ~{INTERVALO_MINUTOS} min (o sistema pode atrasar).
            </Text>
            <Text style={styles.textoPequeno}>
              Para mais confiabilidade, desative a otimização de bateria deste app.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 20, paddingBottom: 40, alignItems: 'center' },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: '#1e293b',
    borderRadius: 16, padding: 24, alignItems: 'center',
  },
  titulo: { fontSize: 26, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  subtitulo: { fontSize: 14, color: '#94a3b8', marginBottom: 20, textAlign: 'center' },
  infoBloco: { alignItems: 'center', marginBottom: 24 },
  rotulo: { fontSize: 13, color: '#94a3b8', marginBottom: 8, textAlign: 'center' },
  valor: { fontSize: 34, fontWeight: 'bold', color: '#22d3ee', fontVariant: ['tabular-nums'] },
  loader: { height: 41 },
  hora: { fontSize: 12, color: '#64748b', marginTop: 6 },
  erroBloco: { backgroundColor: '#7f1d1d', borderRadius: 8, padding: 12, width: '100%', marginBottom: 20 },
  erroTexto: { color: '#fecaca', fontSize: 13, textAlign: 'center' },
  inputBloco: { width: '100%', alignItems: 'center', marginBottom: 16 },
  input: {
    width: '100%', borderBottomWidth: 1, borderColor: '#475569', color: '#fff',
    fontSize: 18, paddingVertical: 8, textAlign: 'center',
  },
  inputBloqueado: { color: '#94a3b8', borderColor: '#334155' },
  status: { color: '#86efac', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  btn: { width: '100%', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  btnAtivar: { backgroundColor: '#22c55e' },
  btnDesativar: { backgroundColor: '#ef4444' },
  btnTexto: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  btnDev: { marginTop: 12, padding: 8 },
  rodape: { width: '100%', marginTop: 24 },
  textoPequeno: { fontSize: 11, color: '#64748b', textAlign: 'center', marginTop: 4 },
});

// @ts-check
import { registerRootComponent } from 'expo';

// Precisa ser importado no ponto de entrada: a tarefa de background
// tem que estar definida antes de o sistema tentar executá-la,
// inclusive quando o app é iniciado só para rodar a tarefa (sem UI).
import './src/tarefa';
import App from './App';

registerRootComponent(App);

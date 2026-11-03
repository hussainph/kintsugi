import { router } from 'expo-router';
import { Keyboard } from 'react-native';

import { editorSessions } from './editor-session';

export function openAppearance() {
  editorSessions.commands?.blur();
  Keyboard.dismiss();
  router.push('/appearance');
}

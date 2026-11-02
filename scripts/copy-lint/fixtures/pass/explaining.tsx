// Short, plain copy that lets the components talk. Nothing here may be reported.
import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function Screen({ empty, note }: { empty: boolean; note: string }) {
  return (
    <View>
      <Stack.Title>Inspiration</Stack.Title>
      <Text style={styles.status}>Your Mac is offline. Your writing is on this phone.</Text>
      <Pressable onPress={() => {}}>
        <Text>Save to Inspiration</Text>
      </Pressable>
      <List empty="Nothing saved yet. Share a link from Safari to add one." />
      {empty && (
        <View style={styles.empty}>
          <Text>No ideas yet.</Text>
          <Pressable onPress={() => {}}><Text>Ask for more</Text></Pressable>
        </View>
      )}
      <Text style={styles.subtitle}>{note}</Text>
      <Text style={styles.hint}>Uses about 2¢ of your monthly AI budget per idea.</Text> {/* copy-lint-allow: a cost the control can't show */}
    </View>
  );
}

function List(_: { empty: string }) { return null; }

const styles = StyleSheet.create({ subtitle: {}, hint: {}, empty: {}, status: {} });

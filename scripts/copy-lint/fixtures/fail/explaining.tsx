// The over-explaining rule (docs/voice.md › Let the components do the talking).
import { Stack } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export function Screen({ empty }: { empty: boolean }) {
  return (
    <View>
      <Stack.Title>Inspiration</Stack.Title>
      <Text style={styles.subtitle}>Links and quotes.</Text> {/* expect: over-explaining */}
      <TextInput placeholder="Find a clip" />
      <Text style={[styles.hint, { color: 'red' }]}>Search titles.</Text> {/* expect: over-explaining */}
      <Text>This lets you keep every link you save.</Text> {/* expect: over-explaining */}
      <Text>Saved. Tap to open it.</Text> {/* expect: over-explaining */}
      <Pressable onPress={() => {}}>
        <Text>Save this clip to your library now</Text> {/* expect: over-explaining */}
      </Pressable>
      <Row description="Shows the clips you saved most recently, newest first, from every source you follow." /> {/* expect: over-explaining over-explaining */}
      <List empty="Nothing saved yet. Share a link, a post or a picture to Kintsugi to add one." /> {/* expect: over-explaining */}
      {empty && (
        <View style={styles.empty}> {/* expect: over-explaining */}
          <Text>No ideas yet.</Text>
          <Text>Kin suggests a few each day.</Text>
        </View>
      )}
      <Pressable onPress={() => Alert.alert('Unpair', 'You can pair this phone again later from Kintsugi on your Mac, any time.')}> {/* expect: over-explaining */}
        <Text>Unpair</Text>
      </Pressable>
    </View>
  );
}

function Row(_: { description: string }) { return null; }
function List(_: { empty: string }) { return null; }

const styles = StyleSheet.create({ subtitle: {}, hint: {}, empty: {} });

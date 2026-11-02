import { StyleSheet, Text } from 'react-native';
export const Label = () => <Text style={styles.label}>What Kin noticed</Text>;
const styles = StyleSheet.create({
  label: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 }, // expect: eyebrow-uppercase eyebrow-tracking
  heading: { fontSize: 13, letterSpacing: 1 }, // expect: eyebrow-tracking
});

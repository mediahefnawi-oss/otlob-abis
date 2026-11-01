import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';

/**
 * Catches a crash in any screen: the customer sees a friendly page with a retry button instead of the app closing,
 * and the technical line (small, selectable) can be sent to the developer.
 */
export let lastCrash = '';
export const rememberCrash = (e: any) => { lastCrash = String((e && (e.stack || e.message)) || e).slice(0, 1200); };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: any }> {
  state = { err: null as any };
  static getDerivedStateFromError(err: any) { return { err }; }
  componentDidCatch(err: any) { rememberCrash(err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: C.dark, padding: 24, justifyContent: 'center', gap: 14 }}>
        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center' }}>حصلت مشكلة مؤقتة</Text>
        <Text style={{ color: '#9FB5AC', fontSize: 14, textAlign: 'center' }}>اضغط «إعادة المحاولة» للرجوع للتطبيق. لو اتكررت، ابعت لنا الصورة دي.</Text>
        <Pressable onPress={() => this.setState({ err: null })} style={{ backgroundColor: C.gold, borderRadius: 16, paddingVertical: 14 }}>
          <Text style={{ color: C.dark, fontSize: 16, fontWeight: '800', textAlign: 'center' }}>إعادة المحاولة</Text>
        </Pressable>
        <ScrollView style={{ maxHeight: 160 }}>
          <Text selectable style={{ color: '#6f8a80', fontSize: 11, textAlign: 'left', writingDirection: 'ltr' }}>{String((this.state.err && (this.state.err.message || this.state.err)) || '').slice(0, 600)}</Text>
        </ScrollView>
      </View>
    );
  }
}

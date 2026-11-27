import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Sheet, Btn } from './ui';
import { useInstallVisible, promptInstall, isIOS } from '../lib/installApp';

/** Steps shown when the browser cannot install by itself (iPhone, Firefox, ...). */
function HowSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const ios = isIOS();
  const steps = ios ? ['اضغط زر المشاركة ⬆️ في أسفل سفاري', 'اختار «إضافة إلى الشاشة الرئيسية» ثم «إضافة»'] : ['افتح قائمة المتصفح ⋮', 'اختار «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»'];
  return (
    <Sheet visible={visible} onClose={onClose} title="تثبيت على الشاشة الرئيسية">
      <View style={{ gap: 12 }}>
        {steps.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}><T w="black" size={13} color={C.dark}>{i + 1}</T></View>
            <T w="bold" size={13.5} style={{ flex: 1 }}>{s}</T>
          </View>
        ))}
        {ios && <T size={11.5} color={C.sub}>على الآيفون الإشعارات بتشتغل بعد التثبيت وفتح التطبيق من الأيقونة.</T>}
        <Btn title="تمام" onPress={onClose} />
      </View>
    </Sheet>
  );
}

/** Starts the install (or explains it). Returns the press handler and the sheet to render. */
export function useInstall() {
  const [how, setHow] = useState(false);
  const press = async () => { if (!(await promptInstall())) setHow(true); };
  return { press, sheet: <HowSheet visible={how} onClose={() => setHow(false)} /> };
}

/** Side menu button (computer). */
export function InstallSideButton() {
  const show = useInstallVisible();
  const { press, sheet } = useInstall();
  if (!show) return null;
  return (
    <>
      <Pressable onPress={press} style={{ backgroundColor: C.gold, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Icon name="phone-portrait" size={18} color={C.dark} />
        <T w="black" size={13} color={C.dark} style={{ flex: 1 }}>تثبيت على الشاشة الرئيسية</T>
      </Pressable>
      {sheet}
    </>
  );
}

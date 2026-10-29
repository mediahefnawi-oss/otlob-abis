import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, toast } from './ui';
import { PushState, pushState, enablePush, disablePush } from '../lib/push';
import { enableSound } from '../lib/alerts';

/** Turn phone notifications on or off for this device (works even when the app is closed). */
export function PushCard() {
  const [st, setSt] = useState<PushState | null>(null);
  const refresh = useCallback(() => { pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  useEffect(refresh, [refresh]);
  if (!st) return null;

  const on = async () => {
    await enableSound();
    const r = await enablePush();
    if (!r.ok) toast(r.error || 'تعذر تفعيل الإشعارات', 'err');
    else toast('تم تفعيل الإشعارات على هذا الجهاز 🔔');
    refresh();
  };
  const off = async () => { await disablePush(); toast('تم إيقاف الإشعارات على هذا الجهاز', 'info'); refresh(); };

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="notifications" size={22} color={st === 'on' ? C.green : C.goldDeep} />
        <View style={{ flex: 1 }}>
          <T w="black" size={14.5}>إشعارات الطلبات على هذا الجهاز</T>
          <T size={12} color={C.sub}>
            {st === 'on' ? 'مفعّلة: ستصلك الإشعارات حتى لو التطبيق مقفول.'
              : st === 'denied' ? 'محظورة. فعّلها من إعدادات المتصفح لهذا الموقع ثم أعد المحاولة.'
              : st === 'unsupported' ? 'هذا المتصفح لا يدعمها. على الآيفون: أضف الموقع للشاشة الرئيسية ثم افتحه من الأيقونة.'
              : 'اضغط لتصلك إشعارات فورية بالطلبات الجديدة وحالتها.'}
          </T>
        </View>
      </View>
      {st === 'off' && <Btn small icon="notifications" title="تفعيل الإشعارات" onPress={on} />}
      {st === 'on' && <Btn small variant="soft" icon="notifications-off" title="إيقاف الإشعارات" onPress={off} />}
    </Card>
  );
}

import React, { useEffect, useState } from 'react';
import { useStore, refresh } from '../lib/store';
import { CenterNotice } from './CenterNotice';

/** When the app could not refresh from the server: a clear message in the middle (never technical details), so stale data is not mistaken for live data. */
export function SyncBanner() {
  const { syncError, userId } = useStore();
  const [hidden, setHidden] = useState(false);
  useEffect(() => { if (!syncError) setHidden(false); }, [syncError]);
  const show = !!syncError && !!userId && !hidden;
  return (
    <CenterNotice
      visible={show}
      icon="cloud-offline"
      title="مشكلة في الاتصال"
      message="تأكد من الإنترنت"
      primary={{ label: 'حاول تاني', onPress: () => { setHidden(true); refresh(); } }}
      onClose={() => setHidden(true)}
    />
  );
}

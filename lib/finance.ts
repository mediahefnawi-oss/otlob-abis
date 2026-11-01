import { useEffect, useState } from 'react';
import { apiRequest } from './api';

/** Commission / counter data comes straight from the central server (reset-aware), never from the local copy. */
export type CounterVals = { sales: number; orders: number; done: number; commission: number; courierCut: number; profit: number };
export type ProviderCounters = CounterVals & { net: number; type: string; name: string; since: { sales: number; orders: number; profit: number } };
export type Counters = { providers: Record<string, ProviderCounters>; types: Record<string, CounterVals>; totals: CounterVals; custom: { orders: number; courierCut: number }; now: number };

export const apiJson = <T,>(path: string, method = 'GET', body?: unknown) =>
  apiRequest<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

let cache: Counters | null = null;
let cacheRole = '';
const subs = new Set<() => void>();
export async function refreshCounters() {
  try {
    cache = await apiJson<Counters>('/api/counters');
    subs.forEach((f) => f());
  } catch {}
}
/** Live counters for the owner (all providers) or a provider (own). Refreshes every few seconds while a screen shows them. */
export function useCounters(role: string, every = 10000): Counters | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (role !== 'admin' && role !== 'provider') return;
    if (cacheRole !== role) { cache = null; cacheRole = role; }
    const f = () => force((x) => x + 1);
    subs.add(f);
    refreshCounters();
    const t = setInterval(refreshCounters, every);
    return () => { subs.delete(f); clearInterval(t); };
  }, [role, every]);
  return cacheRole === role ? cache : null;
}

export type MyCommission = {
  due: number; settled: number; month: number;
  rules: { providerId?: string; name?: string; kind: 'percent' | 'fixed'; value: number; minAmount: number }[];
  entries: { id: string; type: 'accrual' | 'adjustment'; kind: string; base: number; amount: number; note: string; status: string; createdAt: number; orderId?: string; appointmentId?: string }[];
};
export function useMyCommission(role: string, every = 15000): MyCommission | null {
  const [data, setData] = useState<MyCommission | null>(null);
  useEffect(() => {
    if (role !== 'provider' && role !== 'courier') return;
    let live = true;
    const load = () => apiJson<MyCommission>('/api/my/commissions').then((d) => live && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [role, every]);
  return data;
}

export const ruleSummary = (kind: string, value: number, minAmount = 0, target: 'provider' | 'courier' = 'provider') =>
  kind === 'percent'
    ? `${value}% من قيمة المنتجات${minAmount ? ` (للطلبات من ${minAmount} ج.م)` : ''}`
    : `${value} ج.م ${target === 'courier' ? 'تُخصم عن كل طلب توصيل' : 'لكل طلب أو حجز مكتمل'}${minAmount ? ` (للطلبات من ${minAmount} ج.م)` : ''}`;

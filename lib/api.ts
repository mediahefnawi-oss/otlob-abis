import type { HomeBlock, PremiumPublic } from './types';
import { storage } from './storage';
import type { Hours } from './hours';
import * as SecureStore from 'expo-secure-store';

/**
 * Central API transport for the migration from local-only storage to the shared server.
 * Set EXPO_PUBLIC_API_URL to the deployed API origin, e.g. https://api.example.com.
 * Do not put secrets in EXPO_PUBLIC_* variables; they are bundled into the client.
 */
const API_BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');
// Optional standby server (same code, same database): used automatically while the main one does not answer.
const API_BACKUP = (process.env.EXPO_PUBLIC_API_URL_BACKUP || '').replace(/\/$/, '');
let mainDownUntil = 0;
const TOKEN_KEY = 'otlob_abis_api_token_v1';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}

async function getToken(): Promise<string | null> {
  try { const token = await SecureStore.getItemAsync(TOKEN_KEY); if (token) return token; } catch {}
  try { return await storage.getItem(TOKEN_KEY); } catch { return null; }
}

export async function hasApiToken(): Promise<boolean> { return !!(await getToken()); }

export async function saveApiToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(TOKEN_KEY, token); return; } catch {}
  await storage.setItem(TOKEN_KEY, token);
}

export async function clearApiToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch {}
  try { await storage.removeItem(TOKEN_KEY); } catch {}
}

/**
 * Instant pokes from the server ("something changed for you"): one long-lived request that the server writes a line to.
 * XMLHttpRequest is used on purpose: it can read a response while it is still arriving on the phone as well as in the browser.
 * It reopens by itself (3 s, then slower while the server is away) and every 10 minutes to keep memory flat. Returns a stop function.
 */
export function openLive(onPoke: (tag: string) => void): () => void {
  if (!API_BASE || typeof XMLHttpRequest === 'undefined') return () => {};
  let stopped = false, xhr: XMLHttpRequest | null = null, retry: any = null, fails = 0;
  const connect = async () => {
    if (stopped) return;
    const token = await getToken();
    if (!token || stopped) return;
    const x = new XMLHttpRequest();
    xhr = x;
    let seen = 0, opened = false, cut: any = null;
    const next = (ms: number) => { if (cut) clearTimeout(cut); if (!stopped) retry = setTimeout(connect, ms); };
    x.open('GET', `${API_BASE}/api/live`);
    x.setRequestHeader('Authorization', `Bearer ${token}`);
    x.setRequestHeader('Accept', 'text/event-stream');
    x.onprogress = () => {
      const t = x.responseText || '';
      if (!opened) { opened = true; fails = 0; }
      const chunk = t.slice(seen); seen = t.length;
      if (chunk.includes('event: poke')) { const m = /"tag":"([^"]*)"/.exec(chunk); try { onPoke(m ? m[1] : ''); } catch { /* ignore */ } }
    };
    x.onloadend = () => { xhr = null; if (x.status === 401 || x.status === 403) { fails = 6; } else if (!opened) fails++; next(Math.min(60000, 3000 * 2 ** Math.min(fails, 5))); };
    cut = setTimeout(() => { try { x.abort(); } catch { /* ignore */ } }, 10 * 60 * 1000);
    x.send();
  };
  connect();
  return () => { stopped = true; if (retry) clearTimeout(retry); try { xhr?.abort(); } catch { /* ignore */ } };
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, authenticated = true): Promise<T> {
  if (!API_BASE) throw new ApiError('لم يتم ضبط عنوان خادم API. أضف EXPO_PUBLIC_API_URL ثم أعد بناء التطبيق.', 0);
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (authenticated) {
    const token = await getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  let response: Response;
  // a request that never answers must not freeze the whole app (sync and saves wait for each other)
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
  const rel = path.startsWith('/') ? path : `/${path}`;
  const isRead = !options.method || options.method.toUpperCase() === 'GET';
  const useBackup = !!API_BACKUP && Date.now() < mainDownUntil;
  const t0 = Date.now();
  try {
    try { response = await fetch(`${useBackup ? API_BACKUP : API_BASE}${rel}`, { ...options, headers, signal: ctl?.signal }); }
    catch (err) {
      // Main server unreachable: try the standby. Writes are retried only when the failure was instant (refused / no route),
      // never after a long wait, so an order that may already have reached the main server is not sent twice.
      if (!API_BACKUP || useBackup || !(isRead || Date.now() - t0 < 3000)) throw err;
      mainDownUntil = Date.now() + 30000;
      response = await fetch(`${API_BACKUP}${rel}`, { ...options, headers, signal: ctl?.signal });
    }
    if (API_BACKUP && !useBackup && [502, 503, 504].includes(response.status) && isRead) {
      mainDownUntil = Date.now() + 30000;
      try { response = await fetch(`${API_BACKUP}${rel}`, { ...options, headers, signal: ctl?.signal }); } catch {}
    }
  }
  catch { throw new ApiError('الإنترنت ضعيف دلوقتي. جرّب تاني بعد لحظات.', 0); }
  finally { if (timer) clearTimeout(timer); }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || 'حدث خطأ أثناء الاتصال بالخادم', response.status);
  return payload as T;
}

export async function apiLogin(input: { phone?: string; password: string; username?: string }) {
  const result = await apiRequest<{ token: string; user: { id: string; name: string; phone: string; role: string; address: string; status: string } }>(
    '/api/auth/login', { method: 'POST', body: JSON.stringify(input) }, false,
  );
  await saveApiToken(result.token);
  return result;
}

/** A shop owner uses the same account as a customer ('customer') or goes back to the shop view ('main'). */
export async function apiSwitch(to: 'customer' | 'main') {
  const result = await apiRequest<{ token: string; user: ServerUser }>('/api/auth/switch', { method: 'POST', body: JSON.stringify({ to }) });
  await saveApiToken(result.token);
  return result;
}

export async function apiRegister(input: { name: string; phone: string; phone2?: string; password: string; address?: string; role?: string; regionId?: string; vehicle?: string; provider?: Record<string, unknown> }) {
  const result = await apiRequest<{ token: string; user: { id: string; name: string; phone: string; role: string; address: string; status: string } }>(
    '/api/auth/register', { method: 'POST', body: JSON.stringify(input) }, false,
  );
  await saveApiToken(result.token);
  return result;
}

// Central domain endpoints. These wrappers intentionally surface server failures to
// callers; UI actions must not report success until the request resolves.
export type CentralSettings = {
  appEnabled: boolean;
  maintenanceMessage: string;
  announcement: string;
  autoAssign: boolean;
  supportPhone: string;
  supportName: string;
  loginImageV?: number;
  appIconV?: number;
  homeCoverV?: number;
  homeBlocks?: HomeBlock[];
  homeLayout?: Record<string, any>;
  premium?: PremiumPublic | null;
  catIconV?: Record<string, number>;
  apkUrl?: string;
  update?: { version: string; message: string; required: boolean };
  welcomeLogoV?: number;
  credits?: { a: string; b: string; c: string; d: string } | null;
  hours?: Hours;
  tzOffsetMin?: number;
  theme?: string;
  features?: Record<string, boolean>;
  privacy?: { on: boolean; minutes: number };
  ui?: { phone: number; desktop: number };
  map?: { enabled: boolean; required: boolean };
  delivery?: { mode: 'region' | 'km'; perKm: number; min: number; max: number; factor: number };
  serverNow?: number;
  updatedAt?: string;
};

export async function apiGetSettings() {
  return apiRequest<{ settings: CentralSettings }>('/api/settings', {}, false);
}

export async function apiUpdateNotice(body: { version?: string; message?: string; required?: boolean; clear?: boolean }) {
  return apiRequest<{ settings: CentralSettings }>('/api/admin/update-notice', { method: 'PATCH', body: JSON.stringify(body) });
}
export async function apiUpdateSettings(patch: Partial<CentralSettings>) {
  return apiRequest<{ settings: CentralSettings }>('/api/admin/settings', {
    method: 'PATCH', body: JSON.stringify(patch),
  });
}

export async function apiSetUserStatus(id: string | number, status: 'active' | 'pending' | 'rejected' | 'suspended') {
  return apiRequest<{ user: { id: string; name: string; role: string; status: string } }>(
    `/api/admin/users/${encodeURIComponent(String(id))}/status`,
    { method: 'PATCH', body: JSON.stringify({ status }) },
  );
}

export async function apiDeleteCourier(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/couriers/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

export async function apiDeleteCustomer(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/customers/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

export async function apiSetUserFlag(id: string | number, flag: string, note: string) {
  return apiRequest<{ ok: boolean; flag: string; note: string }>(`/api/admin/users/${encodeURIComponent(String(id))}/flag`, { method: 'PATCH', body: JSON.stringify({ flag, note }) });
}

/** Catalog and order endpoints used by the central-store migration. */
export async function apiHealth() {
  return apiRequest<{ ok: boolean; service: string; database: string }>('/api/health', {}, false);
}

export async function apiListProviders<T = Record<string, unknown>>(type?: string) {
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return apiRequest<{ providers: T[] }>(`/api/providers${query}`, {}, true);
}

export async function apiListProducts<T = Record<string, unknown>>(providerId?: string | number) {
  const query = providerId === undefined ? '' : `?providerId=${encodeURIComponent(String(providerId))}`;
  return apiRequest<{ products: T[] }>(`/api/products${query}`, {}, true);
}

export async function apiCreateProduct(input: {
  providerId: string | number; name: string; price: number; data?: Record<string, unknown>;
}) {
  return apiRequest<{ product: Record<string, unknown> }>('/api/products', {
    method: 'POST', body: JSON.stringify(input),
  });
}

export async function apiUpdateProduct(id: string | number, patch: {
  name?: string; price?: number; available?: boolean; data?: Record<string, unknown>;
}) {
  return apiRequest<{ product: Record<string, unknown> }>(`/api/products/${encodeURIComponent(String(id))}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
}

export async function apiDeleteProduct(id: string | number) {
  return apiRequest<void>(`/api/products/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

export async function apiListPendingProviders<T = Record<string, unknown>>() {
  return apiRequest<{ providers: T[] }>('/api/admin/providers/pending');
}

export async function apiDecideProvider(id: string | number, status: 'active' | 'rejected' | 'suspended') {
  return apiRequest<{ ok: boolean; providerId: string; status: string }>(`/api/admin/providers/${encodeURIComponent(String(id))}/decision`, {
    method: 'PATCH', body: JSON.stringify({ status }),
  });
}

/** Session, profile and owner-account endpoints (phase 1). */
export type ServerUser = { baseRole?: string; premiumUntil?: number; id: string; name: string; phone: string; phone2?: string; role: string; address: string; status: string; createdAt?: string; regionId?: string | null; homeLat?: number; homeLng?: number; vehicle?: string; available?: boolean; availableSince?: number; accountFlag?: string; flagNote?: string; supRegions?: string[]; supportChat?: boolean; manager?: boolean; mgrPerms?: string[] };

export async function apiMe() {
  return apiRequest<{ user: ServerUser }>('/api/me');
}
export async function apiUpdateProfile(patch: { name?: string; address?: string; regionId?: string | null; available?: boolean; phone2?: string | null }) {
  return apiRequest<{ user: ServerUser }>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function apiChangePassword(oldPassword: string, newPassword: string) {
  return apiRequest<{ ok: boolean }>('/api/me/password', { method: 'PATCH', body: JSON.stringify({ oldPassword, newPassword }) });
}
export async function apiListUsers(filter: { role?: string; status?: string } = {}) {
  const q = new URLSearchParams();
  if (filter.role) q.set('role', filter.role);
  if (filter.status) q.set('status', filter.status);
  const qs = q.toString();
  return apiRequest<{ users: ServerUser[] }>(`/api/admin/users${qs ? `?${qs}` : ''}`);
}
export async function apiAdminResetPassword(id: string | number, password: string) {
  return apiRequest<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(String(id))}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
}
export async function apiAdminCreateProvider(input: {
  type: string; name: string; desc?: string; address?: string; phone?: string; deliveryFee?: number;
  specialty?: string; emoji?: string; managerName?: string; managerPhone: string; managerPass: string;
}) {
  return apiRequest<{ user: ServerUser; providerId: string }>('/api/admin/providers', { method: 'POST', body: JSON.stringify(input) });
}

/** Phase 3: service details and removal. */
export async function apiUpdateProvider(id: string | number, patch: {
  name?: string; desc?: string; address?: string; phone?: string; deliveryFee?: number; open?: boolean;
  specialty?: string; emoji?: string; eta?: string;
}) {
  return apiRequest<{ provider: Record<string, unknown> }>(`/api/providers/${encodeURIComponent(String(id))}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
}
export async function apiAdminDeleteProvider(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/providers/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

/** Phase 4: delivery areas. */
export type ServerRegion = { id: string; name: string; deliveryFee: number; active: boolean; closed?: boolean; closedMessage?: string; closedUntil?: number | null; closedRaw?: boolean; closedText?: string; closedUntilRaw?: number | null };
export async function apiListRegions() {
  return apiRequest<{ regions: ServerRegion[] }>('/api/regions', {}, true);
}
export async function apiAdminCreateRegion(input: { name: string }) {
  return apiRequest<{ region: ServerRegion }>('/api/admin/regions', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiAdminUpdateRegion(id: string | number, patch: { name?: string; deliveryFee?: number; active?: boolean; closed?: boolean; closedMessage?: string; closedUntil?: number | null; notify?: boolean }) {
  return apiRequest<{ region: ServerRegion }>(`/api/admin/regions/${encodeURIComponent(String(id))}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function apiAdminDeleteRegion(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/regions/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

/** Phase 4 (part B): orders, invoices, bookings and chat are central. */
export type SyncPayload = { unchanged?: boolean; tag?: string; warnings?: string[]; couriersOnline?: number; settings: CentralSettings; user: ServerUser | null; orders: any[]; invoices: any[]; appointments: any[]; messages: any[]; bookedSlots: { doctorId: string; date: string; time: string }[] };
export async function apiSync(tag?: string | null) {
  return apiRequest<SyncPayload>(tag ? `/api/sync?tag=${encodeURIComponent(tag)}` : '/api/sync');
}
export async function apiCheckout(input: { name: string; phone: string; address: string; notes: string; lines: { productId: string; qty: number }[]; coupon?: string; scheduledFor?: number; pool?: boolean; destMode?: string; destLat?: number; destLng?: number }) {
  return apiRequest<{ invoice: any; orders: any[]; address: string }>('/api/orders/checkout', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiCustomOrder(input: { text: string; voice?: { audio: string; seconds: number } | null; phone: string; address: string; destMode?: string; destLat?: number; destLng?: number }) {
  return apiRequest<{ invoice: any; orders: any[] }>('/api/orders/custom', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiOrderAction(id: string | number, action: string, reason?: string, extra?: { ready?: boolean; readyDate?: string; readyTime?: string; gift?: { kind: 'amount' | 'percent'; value: number; days: number } }) {
  return apiRequest<{ order: any }>(`/api/orders/${encodeURIComponent(String(id))}/action`, { method: 'POST', body: JSON.stringify({ action, reason, ...(extra || {}) }) });
}
export async function apiSendMessage(orderId: string | number, text: string) {
  return apiRequest<{ message: any }>(`/api/orders/${encodeURIComponent(String(orderId))}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
}
export async function apiBookAppointment(input: { doctorId: string; date: string; time: string; patientName: string; phone: string; notes: string }) {
  return apiRequest<{ appointment: any }>('/api/appointments/book', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiLabRequest(input: { providerId: string; reason: string; rx?: string | null; patientName: string; phone: string }) {
  return apiRequest<{ appointment: any }>('/api/lab/request', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiLabAction(id: string | number, body: { action: string; date?: string; time?: string; fee?: number; note?: string; file?: string; name?: string }) {
  return apiRequest<{ appointment: any }>(`/api/lab/${encodeURIComponent(String(id))}/action`, { method: 'POST', body: JSON.stringify(body) });
}
export async function apiLabFile(id: string | number, kind: 'rx' | 'report') {
  return apiRequest<{ file: { data: string; mime: string; name: string } | null }>(`/api/lab/${encodeURIComponent(String(id))}/file/${kind}`);
}
export async function apiLabLink(id: string | number, kind: 'rx' | 'report') {
  return apiRequest<{ url: string }>(`/api/lab/${encodeURIComponent(String(id))}/link/${kind}`);
}
export async function apiApptAction(id: string | number, action: string) {
  return apiRequest<{ appointment: any }>(`/api/appointments/${encodeURIComponent(String(id))}/action`, { method: 'POST', body: JSON.stringify({ action }) });
}

/** Providers + products + delivery areas in one request. */
export async function apiCatalog<T = any>() {
  return apiRequest<{ providers: T[]; products: T[]; regions: ServerRegion[]; ads?: ServerAd[]; routePrices?: Record<string, number>; services?: any[] }>('/api/catalog', {}, true);
}

/** Free-text requests to supermarkets / pharmacies, priced by the shop. */
export async function apiPlaceRequest(input: { providerId: string; text: string; image?: string | null; voice?: { audio: string; seconds: number } | null; phone: string; address: string; destMode?: string; destLat?: number; destLng?: number }) {
  return apiRequest<{ order: any }>('/api/orders/request', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiQuote(orderId: string | number, input: { items?: { name: string; price: number; qty: number }[]; price?: number; unavailable?: boolean; note?: string; readyDate?: string; readyTime?: string }) {
  return apiRequest<{ order: any; invoice: any }>(`/api/orders/${encodeURIComponent(String(orderId))}/quote`, { method: 'POST', body: JSON.stringify(input) });
}
export async function apiErrandQuote(orderId: string | number, subtotal: number, fee: number) {
  return apiRequest<{ order: any }>(`/api/orders/${encodeURIComponent(String(orderId))}/errand-quote`, { method: 'POST', body: JSON.stringify({ subtotal, fee }) });
}
export async function apiOrderImage(orderId: string | number) {
  return apiRequest<{ image: string | null }>(`/api/orders/${encodeURIComponent(String(orderId))}/image`);
}

/** Announcements board (the owner manages it; everybody sees the active ones). */
export type ServerAd = { id: string; title: string; link: string; active: boolean; sortOrder: number; v: number };
export const appIconUrl = (v: number) => `${API_BASE}/api/app-icon?v=${v}`;
export const catIconUrl = (type: string, v: number) => `${API_BASE}/api/cat-icon/${encodeURIComponent(type)}?v=${v}`;
export const homeCoverUrl = (v: number) => `${API_BASE}/api/home-cover?v=${v}`;
export const providerCoverUrl = (p: { id: string; coverV?: number }) => (p.coverV ? `${API_BASE}/api/provider-cover/${encodeURIComponent(p.id)}?v=${p.coverV}` : '');
export const homeBlockImageUrl = (b: { id: string; imgV?: number }) => (b.imgV ? `${API_BASE}/api/home-block-image/${encodeURIComponent(b.id)}?v=${b.imgV}` : '');
export const welcomeLogoUrl = (v: number) => `${API_BASE}/api/welcome-logo?v=${v}`;
export const loginImageUrl = (v: number) => `${API_BASE}/api/login-image?v=${v}`;
export const adImageUrl = (ad: { id: string; v: number }) => `${API_BASE}/api/ads/${encodeURIComponent(ad.id)}/image?v=${ad.v}`;
export async function apiAdminCreateAd(input: { title: string; link: string; image: string }) {
  return apiRequest<{ ad: ServerAd }>('/api/admin/ads', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiAdminUpdateAd(id: string | number, patch: { title?: string; link?: string; active?: boolean; sortOrder?: number; image?: string }) {
  return apiRequest<{ ad: ServerAd }>(`/api/admin/ads/${encodeURIComponent(String(id))}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function apiAdminDeleteAd(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/ads/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

/** Provider logos and product pictures (separate files, versioned by ?v= so the browser caches them). */
export const providerLogoUrl = (p: { id: string; logoV?: number }) => (p.logoV ? `${API_BASE}/api/providers/${encodeURIComponent(p.id)}/logo?v=${p.logoV}` : '');
export const productImageUrl = (p: { id: string; imageV?: number }) => (p.imageV ? `${API_BASE}/api/products/${encodeURIComponent(p.id)}/image?v=${p.imageV}` : '');
export async function apiSetProviderLogo(id: string | number, image: string | null) {
  const path = `/api/providers/${encodeURIComponent(String(id))}/logo`;
  return image ? apiRequest<{ logoV: number }>(path, { method: 'PUT', body: JSON.stringify({ image }) }) : apiRequest<{ logoV: number }>(path, { method: 'DELETE' });
}
export async function apiSetProductImage(id: string | number, image: string | null) {
  const path = `/api/products/${encodeURIComponent(String(id))}/image`;
  return image ? apiRequest<{ imageV: number }>(path, { method: 'PUT', body: JSON.stringify({ image }) }) : apiRequest<{ imageV: number }>(path, { method: 'DELETE' });
}

/** Web Push subscriptions. */
export async function apiPushKey() {
  return apiRequest<{ key: string | null }>('/api/push/key', {}, false);
}
export async function apiPushSubscribe(subscription: unknown) {
  return apiRequest<{ ok: boolean }>('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
}
export async function apiPushSubscribeDevice(token: string) {
  return apiRequest<{ ok: boolean }>('/api/push/subscribe-device', { method: 'POST', body: JSON.stringify({ token }) });
}
export async function apiPushUnsubscribe(endpoint: string) {
  return apiRequest<{ ok: boolean }>('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
}

/* ---------------- support chat ---------------- */
export type SupportMsg = { id: string; threadId: string; senderId: string; senderName: string; senderRole: string; text: string; at: number };
export type SupportThread = { id: string; userId: string; status: 'open' | 'closed'; lastMessage: string; lastAt: number; unread: number; userName: string; userPhone: string; userRole: string };
export const apiSupportMine = (after = 0) => apiRequest<{ thread: { id: string; status: string } | null; messages: SupportMsg[] }>(`/api/support/mine?after=${after}`);
export const apiSupportSend = (text: string) => apiRequest<{ message: SupportMsg; reply?: SupportMsg }>('/api/support/mine/messages', { method: 'POST', body: JSON.stringify({ text }) });
export const apiSupportUnread = () => apiRequest<{ unread: number }>('/api/support/unread');
export const apiSupportThreads = (status: 'open' | 'closed') => apiRequest<{ threads: SupportThread[] }>(`/api/support/threads?status=${status}`);
export const apiSupportThread = (id: string, after = 0) => apiRequest<{ thread: SupportThread; messages: SupportMsg[] }>(`/api/support/threads/${id}?after=${after}`);
export const apiSupportReply = (id: string, text: string) => apiRequest<{ message: SupportMsg }>(`/api/support/threads/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
export const apiSupportStart = (userId: string, text: string) => apiRequest<{ message: SupportMsg; thread: { id: string; status: string } }>('/api/support/start', { method: 'POST', body: JSON.stringify({ userId, text }) });
export const apiSupportStatus = (id: string, status: 'open' | 'closed') => apiRequest<{ ok: boolean }>(`/api/support/threads/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export const apiSupervisorSupport = (id: string, enabled: boolean) => apiRequest<{ enabled: boolean }>(`/api/admin/supervisors/${id}/support`, { method: 'PATCH', body: JSON.stringify({ enabled }) });

/* ---------------- live location ---------------- */
export type GeoPoint = { lat: number; lng: number };
export type CourierPos = GeoPoint & { at: number; fresh: boolean; heading?: number };
export type OrderTracking = { status: string; courier: CourierPos | null; shop: GeoPoint | null; dest: GeoPoint | null; distanceKm: number | null; etaMin: number | null };
export type StaffCourierPos = CourierPos & { id: string; name: string; phone: string; vehicle: string; available: boolean; busy: number; order?: { id: string; status: string; shop: string; address: string; dest: GeoPoint | null } | null };
export const apiMyLocation = () => apiRequest<{ location: GeoPoint | null }>('/api/me/location');
export const apiSetMyLocation = (p: GeoPoint | null) => apiRequest<{ location: GeoPoint | null }>('/api/me/location', { method: 'PUT', body: JSON.stringify(p ? p : { clear: true }) });
export const apiSetShopLocation = (p: GeoPoint | null) => apiRequest<{ location: GeoPoint | null }>('/api/provider/location', { method: 'PUT', body: JSON.stringify(p ? p : { clear: true }) });
export const apiCourierPing = (p: GeoPoint & { accuracy?: number; heading?: number }) => apiRequest<{ ok: boolean }>('/api/courier/location', { method: 'POST', body: JSON.stringify(p) });
export const apiCourierStop = () => apiRequest<{ ok: boolean }>('/api/courier/location', { method: 'DELETE' });
export const apiOrderTracking = (id: string) => apiRequest<OrderTracking>(`/api/orders/${encodeURIComponent(id)}/tracking`);
export const apiStaffCourierLocations = () => apiRequest<{ couriers: StaffCourierPos[] }>('/api/staff/courier-locations');
export const apiSetUiScale = (b: { phone?: number; desktop?: number }) => apiRequest<{ settings: CentralSettings }>('/api/admin/ui-scale', { method: 'PATCH', body: JSON.stringify(b) });
export const apiSetTheme = (theme: string) => apiRequest<{ settings: CentralSettings }>('/api/admin/theme', { method: 'PATCH', body: JSON.stringify({ theme }) });

/* ---------------- offers (owner only) ---------------- */
export type AdminOffer = { id: string; title: string; percent: number; color: string; providerId: string | null; providerName: string | null; endsAt: number | null; startsAt: number; active: boolean };
export const apiOffers = () => apiRequest<{ offers: AdminOffer[] }>('/api/admin/offers');
export const apiOfferCreate = (b: { title: string; percent: number; color: string; providerId?: string; hours?: number }) => apiRequest<{ offers: AdminOffer[] }>('/api/admin/offers', { method: 'POST', body: JSON.stringify(b) });
export const apiOfferActive = (id: string, active: boolean) => apiRequest<{ offers: AdminOffer[] }>(`/api/admin/offers/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const apiOfferDelete = (id: string) => apiRequest<{ offers: AdminOffer[] }>(`/api/admin/offers/${id}`, { method: 'DELETE' });
export const apiSetDeliveryMode = (b: { mode: 'region' | 'km'; perKm: number; min: number; max: number; factor: number }) => apiRequest<{ ok: boolean }>('/api/admin/delivery-mode', { method: 'PATCH', body: JSON.stringify(b) });
export const apiSetMapMode = (b: { enabled: boolean; required: boolean }) => apiRequest<{ ok: boolean }>('/api/admin/map-mode', { method: 'PATCH', body: JSON.stringify(b) });

/* ---------------- ratings ---------------- */
export type MyRating = { id: string; orderId: string; providerStars: number | null; courierStars: number | null; comment: string; createdAt: number; canEdit: boolean };
export type ShopRatings = { count: number; avg: number; dist: Record<string, number>; comments: { stars: number; comment: string; who: string; at: number }[] };
export type StaffRating = MyRating & { orderNumber: number; providerName: string; customerName: string; courierName: string; hidden: boolean };
export const apiMyRating = (orderId: string) => apiRequest<{ rating: MyRating | null }>(`/api/orders/${encodeURIComponent(orderId)}/rating`);
export const apiRateOrder = (orderId: string, b: { providerStars: number; courierStars?: number; comment?: string }) => apiRequest<{ rating: MyRating }>(`/api/orders/${encodeURIComponent(orderId)}/rating`, { method: 'POST', body: JSON.stringify(b) });
export const apiShopRatings = (providerId: string) => apiRequest<ShopRatings>(`/api/providers/${encodeURIComponent(providerId)}/ratings`);
export const apiStaffRatings = () => apiRequest<{ ratings: StaffRating[]; couriers: Record<string, { avg: number; count: number }> }>('/api/staff/ratings');
export const apiHideRating = (id: string, hidden: boolean) => apiRequest<{ id: string; hidden: boolean }>(`/api/admin/ratings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ hidden }) });

export const apiSetPrivacy = (b: { on?: boolean; minutes?: number }) => apiRequest<{ settings: CentralSettings }>('/api/admin/privacy', { method: 'PATCH', body: JSON.stringify(b) });

/* ---------------- discount codes ---------------- */
export type Coupon = {
  id: string; code: string; kind: 'amount' | 'percent'; value: number; maxDiscount: number | null; startsAt: number; endsAt: number;
  providerIds: string[] | null; userId: string | null; userName: string | null; perUser: number | null; maxUses: number | null; uses: number; given: number; active: boolean; source: string; premiumOnly?: boolean;
};
export type CouponInput = { code?: string; kind: 'amount' | 'percent'; value: number; maxDiscount?: number; days: number; startDate?: string; providerIds?: string[]; perUser?: number | null; maxUses?: number; premiumOnly?: boolean };
export const apiCoupons = () => apiRequest<{ coupons: Coupon[] }>('/api/admin/coupons');
export const apiCouponCreate = (b: CouponInput) => apiRequest<{ coupons: Coupon[] }>('/api/admin/coupons', { method: 'POST', body: JSON.stringify(b) });
export const apiCouponActive = (id: string, active: boolean) => apiRequest<{ coupons: Coupon[] }>(`/api/admin/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const apiCouponDelete = (id: string) => apiRequest<{ coupons: Coupon[] }>(`/api/admin/coupons/${id}`, { method: 'DELETE' });
export const apiCouponCheck = (code: string, lines: { productId: string; qty: number }[]) => apiRequest<{ code: string; discount: number; kind: string; value: number }>('/api/coupons/check', { method: 'POST', body: JSON.stringify({ code, lines }) });
export const apiMyCoupons = () => apiRequest<{ coupons: Coupon[] }>('/api/coupons/mine');

/* ---- feature switches, section / order mode, menu pictures ---- */
export type LogEntry = { id: string; at: number; admin: string; label: string; summary: string; details: string; canUndo: boolean; undone: boolean };
export const apiAdminLog = () => apiRequest<{ entries: LogEntry[] }>('/api/admin/log?limit=100');
export const apiUndoLog = (id: string) => apiRequest<{ ok: boolean }>(`/api/admin/log/${encodeURIComponent(id)}/undo`, { method: 'POST', body: '{}' });
export type FeatureRow = { key: string; label: string; on: boolean };
export const apiFeatures = () => apiRequest<{ features: FeatureRow[] }>('/api/admin/features');
export const apiSetFeature = (key: string, on: boolean) => apiRequest<{ features: FeatureRow[] }>('/api/admin/features', { method: 'PATCH', body: JSON.stringify({ key, on }) });
export const apiMoveProvider = (id: string, type: string) => apiRequest<{ id: string; type: string }>(`/api/admin/providers/${encodeURIComponent(id)}/type`, { method: 'PATCH', body: JSON.stringify({ type }) });
export const apiProviderMode = (id: string, mode: '' | 'cart' | 'request' | 'menu') => apiRequest<{ id: string; mode: string }>(`/api/admin/providers/${encodeURIComponent(id)}/order-mode`, { method: 'PATCH', body: JSON.stringify({ mode }) });
export const apiMenuList = (providerId: string) => apiRequest<{ images: string[] }>(`/api/providers/${encodeURIComponent(providerId)}/menu`, {}, true);
export const apiMenuAdd = (providerId: string, image: string) => apiRequest<{ id: string }>(`/api/providers/${encodeURIComponent(providerId)}/menu`, { method: 'POST', body: JSON.stringify({ image }) });
export const apiMenuDelete = (imgId: string) => apiRequest<{ ok: boolean }>(`/api/menu/${encodeURIComponent(imgId)}`, { method: 'DELETE' });
export const menuImageUrl = (imgId: string) => `${API_BASE}/api/menu/${encodeURIComponent(imgId)}`;

/** Courier's own picture: the courier uploads, the owner approves, customers see only approved ones. */
export const apiCourierPhoto = () => apiRequest<{ enabled: boolean; status: 'none' | 'pending' | 'approved' | 'rejected'; approved: boolean }>('/api/courier/photo');
export const apiCourierPhotoUpload = (image: string) => apiRequest<{ ok: boolean }>('/api/courier/photo', { method: 'POST', body: JSON.stringify({ image }) });
export const apiPendingCourierPhotos = () => apiRequest<{ photos: { userId: string; name: string; image: string }[] }>('/api/admin/courier-photos');
export const apiReviewCourierPhoto = (userId: string, approve: boolean) => apiRequest<{ ok: boolean }>(`/api/admin/courier-photos/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ approve }) });
export const courierPhotoUrl = (userId: string, v = 0) => `${API_BASE}/api/courier-photo/${encodeURIComponent(userId)}?v=${v}`;

/** Chat between a customer and a shop before an order. */
export type ChatMsg = { id: string; mine: boolean; fromCustomer: boolean; text: string; at: number };
export const apiShopChat = (providerId: string) => apiRequest<{ enabled: boolean; messages: ChatMsg[] }>(`/api/providers/${encodeURIComponent(providerId)}/chat`);
export const apiShopChatSend = (providerId: string, text: string) => apiRequest<{ message: ChatMsg }>(`/api/providers/${encodeURIComponent(providerId)}/chat`, { method: 'POST', body: JSON.stringify({ text }) });
export const apiChatThreads = () => apiRequest<{ enabled: boolean; unread?: number; threads: { id: string; name: string; last: string; at: number; unread: number }[] }>('/api/chat/threads');
export const apiChatThread = (id: string) => apiRequest<{ name: string; messages: ChatMsg[] }>(`/api/chat/threads/${encodeURIComponent(id)}`);
export const apiChatThreadSend = (id: string, text: string) => apiRequest<{ message: ChatMsg }>(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ text }) });
export const apiChatReport = (msgId: string) => apiRequest<{ ok: boolean }>(`/api/chat/messages/${encodeURIComponent(msgId)}/report`, { method: 'POST' });
export const apiChatReports = () => apiRequest<{ reports: { id: string; at: number; text: string; from: string; reporter: string; providerId: string; providerName: string }[] }>('/api/admin/chat-reports');
export const apiProviderChatOff = (providerId: string, disabled: boolean) => apiRequest<{ ok: boolean }>(`/api/admin/providers/${encodeURIComponent(providerId)}/chat`, { method: 'PATCH', body: JSON.stringify({ disabled }) });

/** Clinics that set the visit time themselves: the customer asks, the clinic writes the day and time, the customer accepts. */
export const apiApptRequest = (input: { doctorId: string; patientName: string; phone: string; notes: string }) => apiRequest<{ appointment: any }>('/api/appointments/request', { method: 'POST', body: JSON.stringify(input) });
export const apiApptPropose = (id: string, date: string, time: string) => apiRequest<{ appointment: any }>(`/api/appointments/${encodeURIComponent(id)}/propose`, { method: 'POST', body: JSON.stringify({ date, time }) });
export const apiApptAccept = (id: string) => apiRequest<{ appointment: any }>(`/api/appointments/${encodeURIComponent(id)}/accept`, { method: 'POST', body: '{}' });
export const apiBookMode = (providerId: string, mode: 'customer' | 'clinic') => apiRequest<{ ok: boolean }>(`/api/providers/${encodeURIComponent(providerId)}/book-mode`, { method: 'PATCH', body: JSON.stringify({ mode }) });

/** Prescription forwarding (clinic -> patient -> pharmacy). */
export type RxRow = { id: string; number: string; patientName: string; clinicName: string; pharmacyId: string; pharmacyName: string; meds: string; price?: number | null; hasImage: boolean; status: 'issued' | 'sent' | 'ready' | 'picked_up' | 'delivery' | 'cancelled' | 'expired'; expiresAt: number; createdAt: number; role: string; needsAction?: boolean };
export const apiRxList = () => apiRequest<{ enabled: boolean; list: RxRow[] }>('/api/rx');
export const apiRxPharmacies = (appointmentId: string) => apiRequest<{ pharmacies: { id: string; name: string; region: string; suggested: boolean }[] }>(`/api/rx/pharmacies/${encodeURIComponent(appointmentId)}`);
export const apiRxCreate = (input: { appointmentId: string; meds: string; image?: string | null; pharmacyId?: string }) => apiRequest<{ rx: RxRow }>('/api/rx', { method: 'POST', body: JSON.stringify(input) });
export const apiRxPhoto = (id: string) => apiRequest<{ image: string | null }>(`/api/rx/${encodeURIComponent(id)}/photo`);
export const apiRxStep = (id: string, step: 'choose' | 'ready' | 'pickup' | 'delivery' | 'cancel' | 'price', body: any = {}) => apiRequest<{ rx: RxRow; orderText?: string; pharmacyId?: string }>(`/api/rx/${encodeURIComponent(id)}/${step}`, { method: 'POST', body: JSON.stringify(body) });
/** Owner: wipe trial data (switch "dataWipe"). Needs the owner's password and the word «مسح». */
export type WipeCounts = { orders: number; openOrders: number; bookings: number; rx: number; invoices: number; messages: number; commissions: number };
export const apiWipePreview = () => apiRequest<{ enabled: boolean; counts: WipeCounts; word: string }>('/api/admin/wipe/preview');
export const apiWipe = (input: { password: string; confirm: string; what: string[]; renumber: boolean }) => apiRequest<{ ok: boolean; before: WipeCounts; after: WipeCounts }>('/api/admin/wipe', { method: 'POST', body: JSON.stringify(input) });
export const apiRxCommission = () => apiRequest<{ enabled: boolean; percent: number }>('/api/admin/rx-commission');
export const apiSetRxCommission = (percent: number) => apiRequest<{ enabled: boolean; percent: number }>('/api/admin/rx-commission', { method: 'PATCH', body: JSON.stringify({ percent }) });

/** Favorites (hearts on shops and products, kept on the server). */
export const apiFavorites = () => apiRequest<{ enabled: boolean; providers: string[]; products: string[] }>('/api/favorites');
export const apiFavoriteSet = (kind: 'provider' | 'product', id: string, on: boolean) => apiRequest<{ ok: boolean }>(`/api/favorites/${kind}/${encodeURIComponent(id)}`, { method: on ? 'PUT' : 'DELETE' });
export const apiDailyReport = () => apiRequest<{ stats: any; text: string }>('/api/admin/daily-report');

/** Saved delivery addresses. */
export type SavedAddress = { id: string; label: string; address: string };
export const apiAddresses = () => apiRequest<{ enabled: boolean; addresses: SavedAddress[] }>('/api/addresses');
export const apiAddressAdd = (label: string, address: string) => apiRequest<{ address: SavedAddress }>('/api/addresses', { method: 'POST', body: JSON.stringify({ label, address }) });
export const apiAddressDelete = (id: string) => apiRequest<{ ok: boolean }>(`/api/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const apiPinProvider = (providerId: string, rank: number | null) => apiRequest<{ ok: boolean }>(`/api/admin/providers/${encodeURIComponent(providerId)}/pin`, { method: 'PATCH', body: JSON.stringify({ rank }) });

/** "شير اللقمة": how many neighbours already wait for the same shop (anonymous). */
export async function apiPoolSuggest(providerId: string) {
  return apiRequest<{ on: boolean; waiting: number; max?: number; minutes?: number }>(`/api/pool/suggest?providerId=${encodeURIComponent(providerId)}`);
}

/* ---------------- "أبيس بريميم" (owner) ---------------- */
export type PremiumCfg = { price: number; days: number; discountPct: number; freeAbove: number; transfer: string; promo: string; lines: string[] };
export type PremiumSub = { id: string; name: string; phone: string; until: number; active: boolean; daysLeft: number };
export type PremiumView = { cfg: PremiumCfg; subscribers: PremiumSub[]; activeCount: number; cost30: { freeDelivery: number; discount: number; orders: number }; activated?: { name: string; until: number } };
export const apiPremium = () => apiRequest<PremiumView>('/api/admin/premium');
export const apiPremiumSave = (cfg: PremiumCfg) => apiRequest<PremiumView>('/api/admin/premium', { method: 'PUT', body: JSON.stringify(cfg) });
export const apiPremiumActivate = (phone: string, days: number) => apiRequest<PremiumView>('/api/admin/premium/activate', { method: 'POST', body: JSON.stringify({ phone, days }) });
export const apiPremiumCancel = (phone: string) => apiRequest<PremiumView>('/api/admin/premium/cancel', { method: 'POST', body: JSON.stringify({ phone }) });

/* ---------------- group order, market, rides (all behind the owner's switches) ---------------- */
export type GroupItem = { id: number; productId: number; name: string; emoji: string; price: number; qty: number; line: number; available: boolean; canRemove: boolean };
export type GroupMember = { userId: number; name: string; isOwner: boolean; items: GroupItem[]; subtotal: number };
export type GroupCart = { code: string; status: 'open' | 'ordered' | 'cancelled'; providerId: number; providerName: string; isOwner: boolean; expiresAt: string; members: GroupMember[]; total: number; lines?: { productId: string; qty: number }[] };
export const apiGroupOpen = (providerId: string) => apiRequest<{ code: string; reused: boolean }>('/api/group-carts', { method: 'POST', body: JSON.stringify({ providerId: Number(providerId) }) });
export const apiGroupGet = (code: string) => apiRequest<{ cart: GroupCart }>(`/api/group-carts/${encodeURIComponent(code)}`);
export const apiGroupSet = (code: string, productId: string | number, qty: number) => apiRequest<{ cart: GroupCart }>(`/api/group-carts/${encodeURIComponent(code)}/items`, { method: 'PUT', body: JSON.stringify({ productId: Number(productId), qty }) });
export const apiGroupRemove = (code: string, itemId: number) => apiRequest<{ cart: GroupCart }>(`/api/group-carts/${encodeURIComponent(code)}/items/${itemId}`, { method: 'DELETE' });
export const apiGroupDone = (code: string) => apiRequest<{ ok: boolean }>(`/api/group-carts/${encodeURIComponent(code)}/done`, { method: 'POST' });
export const apiGroupCancel = (code: string) => apiRequest<{ ok: boolean }>(`/api/group-carts/${encodeURIComponent(code)}/cancel`, { method: 'POST' });

export type MarketSize = { label: string; price: number | null; salePrice?: number | null };
export type MarketOption = { label: string; price: number };
export type MarketProduct = { id: number; name: string; category: string; description?: string; sizes?: MarketSize[]; options?: MarketOption[]; soldOut?: boolean; price: number | null; discountPct?: number | null; offerText?: string; offerUntil?: string | null; salePrice?: number | null; onOffer?: boolean; emoji: string; available: boolean; sort: number; image: string | null };
export const apiMarketProducts = () => apiRequest<{ products: MarketProduct[]; fee: number; offerText?: string }>('/api/market-products');
export const apiMarketOrder = (input: { lines: { productId: string; qty: number; size?: string; opts?: string[] }[]; phone: string; address: string; notes?: string; destMode?: string; destLat?: number; destLng?: number }) =>
  apiRequest<{ orders: any[]; invoice: any }>('/api/orders/market', { method: 'POST', body: JSON.stringify(input) });
export const marketImageUrl = (p: { image: string | null }) => (p.image ? `${API_BASE}${p.image}` : '');
export const apiAdminMarketList = () => apiRequest<{ products: MarketProduct[] }>('/api/admin/market-products');
export const apiAdminMarketImportDefaults = () => apiRequest<{ ok: boolean; added: number; total: number }>('/api/admin/market-products/import-defaults', { method: 'POST' });
export const apiAdminMarketAdd = (b: { name: string; price: number | null; sizes?: { label: string; price: number | null }[]; options?: MarketOption[]; soldOut?: boolean; description?: string; category?: string; emoji?: string; discountPct?: number | null; offerText?: string; offerUntil?: string | null }) => apiRequest<{ product: MarketProduct }>('/api/admin/market-products', { method: 'POST', body: JSON.stringify(b) });
export const apiAdminMarketEdit = (id: number, b: Partial<{ name: string; price: number | null; sizes: { label: string; price: number | null }[]; options: MarketOption[]; soldOut: boolean; description: string; category: string; emoji: string; available: boolean; discountPct: number | null; offerText: string; offerUntil: string | null }>) => apiRequest<{ product: MarketProduct }>(`/api/admin/market-products/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminMarketDelete = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/market-products/${id}`, { method: 'DELETE' });
export const apiAdminMarketImage = (id: number, image: string) => apiRequest<{ product: MarketProduct }>(`/api/admin/market-products/${id}/image`, { method: 'PUT', body: JSON.stringify({ image }) });
export const apiAdminMarketFee = () => apiRequest<{ fee: number; offerText?: string }>('/api/admin/market-settings');
export const apiAdminMarketSetOfferText = (offerText: string) => apiRequest<{ ok: boolean }>('/api/admin/market-settings', { method: 'PATCH', body: JSON.stringify({ offerText }) });
export const apiAdminMarketSetFee = (fee: number) => apiRequest<{ ok: boolean }>('/api/admin/market-settings', { method: 'PATCH', body: JSON.stringify({ fee }) });

export type RidePricingMode = 'km' | 'zones' | 'captain';
export type RideType = { id: number; name: string; baseFee: number; perKm: number; minFee: number; adjPct: number; sort: number; active: boolean; image: string | null; pricingMode?: RidePricingMode | null; maxFee?: number | null; tripsEnabled?: boolean };
export type RidePoint = { lat: number; lng: number; text?: string };
export type RideOffer = { id: number; price: number; status: string; driver: { id: number; name: string; model: string; color: string; plate: string } };
export type Ride = { id: number; status: string; typeId: number; from: RidePoint; to: RidePoint; km: number; minutes: number; suggested: number; offered: number; finalPrice: number | null; driverId: number | null; expiresAt: string; bidding?: boolean; textDest?: boolean; byRegion?: boolean; fromPin?: boolean; pricing?: RidePricingMode; maxFee?: number | null };
export const rideImageUrl = (t: { image: string | null }) => (t.image ? `${API_BASE}${t.image}` : '');
export const apiPublicRideTypes = () => apiRequest<{ types: { id: number; name: string; image: string | null }[] }>('/api/public/ride-types', {}, false);
export const apiRideTypes = () => apiRequest<{ types: RideType[] }>('/api/ride-types');
export type RideEstimate = { mode?: RidePricingMode; textDest?: boolean; zoneMissing?: boolean; km: number; minutes: number; source: string; route?: [number, number][] | null; bidding?: boolean; price: number; lo: number; hi: number; maxFee?: number | null };
export type RideExtra = { textDest?: boolean; byRegion?: boolean; fromRegionId?: number; toRegionId?: number };
export const apiRideEstimate = (from: RidePoint | null, to: RidePoint | null, typeId: number, extra: RideExtra = {}) => apiRequest<RideEstimate>('/api/rides/estimate', { method: 'POST', body: JSON.stringify({ ...(from ? { from } : {}), ...(to ? { to } : {}), typeId, ...extra }) });
export const apiRideCreate = (from: RidePoint, to: RidePoint, typeId: number, price: number, extra: RideExtra = {}) => apiRequest<{ ride: Ride; notified: number }>('/api/rides', { method: 'POST', body: JSON.stringify({ from, to, typeId, price, ...extra }) });
/** fixed price between two areas: no map; the notes (and the pin, if he shares it) are optional */
export const apiRideCreateByRegion = (b: { typeId: number; fromRegionId: number; toRegionId: number; fromNote: string; toNote: string; pin?: { lat: number; lng: number } | null }) => apiRequest<{ ride: Ride; notified: number }>('/api/rides', { method: 'POST', body: JSON.stringify({ typeId: b.typeId, byRegion: true, fromRegionId: b.fromRegionId, toRegionId: b.toRegionId, from: { ...(b.pin || {}), text: b.fromNote }, to: { text: b.toNote } }) });
export type RideDriver = { id: number; name: string; phone: string; model: string; color: string; plate: string; photos?: string[] };
export type RideLeg = { km: number; minutes: number; route: [number, number][] };
/** the map of a trip in progress: where the captain is and the ways to draw */
export type RideLive = { active: boolean; status: string; driver?: { lat: number; lng: number; heading: number | null; ageSec: number } | null; pickup?: RideLeg | null; trip?: RideLeg | null; dest?: RideLeg | null; textDest?: boolean };
export const apiRideLive = (id: number) => apiRequest<RideLive>(`/api/rides/${id}/live`);
export const apiRideCurrent = () => apiRequest<{ ride: Ride | null; driver?: RideDriver | null; offers: RideOffer[] }>('/api/rides/current');
export const apiRideAcceptOffer = (id: number, offerId: number) => apiRequest<{ ok: boolean }>(`/api/rides/${id}/accept-offer`, { method: 'POST', body: JSON.stringify({ offerId }) });
export const apiRideCancel = (id: number) => apiRequest<{ ok: boolean }>(`/api/rides/${id}/cancel`, { method: 'POST' });
// the captain
export type CaptainMe = { status: string; note: string; typeId: number; typeName: string; model: string; color: string; plate: string; balance: number; photos: string[]; pending?: string[]; autoReceive: boolean; canReceive: boolean; tripsAllowed?: boolean };
export const apiCaptainMe = () => apiRequest<{ profile: CaptainMe | null }>('/api/captain/me');
export const apiCaptainProfile = (b: { typeId: number; model: string; color: string; plate: string; nationalId?: string }) => apiRequest<{ ok: boolean; status?: string; pending?: boolean }>('/api/captain/profile', { method: 'PUT', body: JSON.stringify(b) });
export const apiCaptainPhoto = (kind: 'car' | 'license' | 'driver' | 'selfie', image: string) => apiRequest<{ ok: boolean; pending?: boolean }>(`/api/captain/photos/${kind}`, { method: 'PUT', body: JSON.stringify({ image }) });
export type CaptainReq = Ride & { myOffer: number | null; pickupKm: number | null };
export const apiCaptainRequests = () => apiRequest<{ requests: CaptainReq[]; offerSecs: number }>('/api/captain/requests');
export const apiCaptainOffer = (id: number, price?: number) => apiRequest<{ ok: boolean; accepted: boolean }>(`/api/captain/requests/${id}/offer`, { method: 'POST', body: JSON.stringify(price === undefined ? {} : { price }) });
export const apiCaptainStatus = (id: number, status: 'arrived' | 'started' | 'completed') => apiRequest<{ ok: boolean; commission: number | null }>(`/api/captain/rides/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export type CaptainRide = Ride & { customer: { name: string; phone: string } };
export const apiCaptainCurrent = () => apiRequest<{ ride: CaptainRide | null }>('/api/captain/current');
// the owner
export const apiAdminRideTypes = () => apiRequest<{ types: RideType[] }>('/api/admin/ride-types');
export const apiAdminRideTypeSave = (id: number | null, b: any) => apiRequest<{ type: RideType }>(id ? `/api/admin/ride-types/${id}` : '/api/admin/ride-types', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(b) });
export const apiAdminRideTypeDelete = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/ride-types/${id}`, { method: 'DELETE' });
export const apiAdminRideTypeImage = (id: number, image: string) => apiRequest<{ type: RideType }>(`/api/admin/ride-types/${id}/image`, { method: 'PUT', body: JSON.stringify({ image }) });
export const apiAdminRideTypeCommission = (id: number, commissionPct: number | null) => apiRequest<{ ok: boolean }>(`/api/admin/ride-types/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionPct }) });
export type AdminCaptain = { typeId?: number | null; ordersOff?: boolean; mode?: 'both' | 'captain' | 'courier' | 'none'; id: number; name: string; phone: string; status: string; note: string; typeName: string; model: string; color: string; plate: string; balance: number; commissionPct: number | null; autoReceive: boolean; tripsMode: string; tripsMax: number | null; photos: string[] };
export const apiAdminCaptains = (status?: string) => apiRequest<{ captains: AdminCaptain[] }>(`/api/admin/captains${status ? `?status=${status}` : ''}`);
export const apiAdminCaptainSet = (id: number, b: any) => apiRequest<{ ok: boolean }>(`/api/admin/captains/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminCaptainBalance = (id: number, amount: number, note?: string) => apiRequest<{ ok: boolean; balance: number }>(`/api/admin/captains/${id}/balance`, { method: 'POST', body: JSON.stringify({ amount, note }) });
export const apiAdminRideSettings = () => apiRequest<{ commissionPct: number; commissionMin: number; minBalance: number; autoDispatch: boolean; offerSecs: number; radiusKm: number; pricing: 'fixed' | 'bidding' }>('/api/admin/rides/settings');
export const apiAdminRideSettingsSave = (b: any) => apiRequest<{ ok: boolean }>('/api/admin/rides/settings', { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminRides = (status = '') => apiRequest<{ rides: (Ride & { customer: string; driver: string | null })[] }>(`/api/admin/rides${status ? `?status=${status}` : ''}`);
export const apiAdminRideCancel = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/rides/${id}/cancel`, { method: 'POST' });
export const apiAdminRideComplete = (id: number) => apiRequest<{ ok: boolean; commission: number }>(`/api/admin/rides/${id}/complete`, { method: 'POST' });
export const apiAdminCaptainAdd = (b: { name: string; phone: string; password: string; typeId: number; model?: string; color?: string; plate?: string }) => apiRequest<{ ok: boolean; id: number }>('/api/admin/captains', { method: 'POST', body: JSON.stringify(b) });
export const apiAdminRideAssign = (id: number, driverId: number) => apiRequest<{ ok: boolean }>(`/api/admin/rides/${id}/assign`, { method: 'POST', body: JSON.stringify({ driverId }) });
export type RideCaptainPick = { id: number; name: string; phone: string; model: string; color: string; plate: string; balance: number; type: string; online: boolean; busy: boolean };
export type RideOfferRow = { id: number; rideId: number; price: number; driverId: number; name: string; model: string; plate: string };
export type RideDetails = {
  ride: { id: number; status: string; typeName: string; from: { lat: number; lng: number; text: string }; to: { lat: number; lng: number; text: string }; textDest: boolean; byRegion: boolean; km: number; minutes: number; suggested: number; offered: number; finalPrice: number | null; commission: number | null; bidding: boolean; createdAt: number; updatedAt: number };
  customer: { id: number; name: string; phone: string; rides: number; completed: number };
  driver: { id: number; name: string; phone: string; model: string; color: string; plate: string; lat: number | null; lng: number | null; ageSec: number | null } | null;
  offers: { id: number; price: number; status: string; driverId: number; name: string }[];
  timeline: { key: string; label: string; at: number }[];
};
export const apiAdminRideDetails = (id: number) => apiRequest<RideDetails>(`/api/admin/rides/${id}/details`);
export const apiAdminRideSummary = () => apiRequest<{ searching: number; active: number; openTrips: number }>('/api/admin/rides/summary');
export const apiAdminRideCaptains = () => apiRequest<{ captains: RideCaptainPick[] }>('/api/admin/ride-captains');
export const apiAdminRideOffers = () => apiRequest<{ offers: RideOfferRow[] }>('/api/admin/rides/offers');
export const apiAdminRidePrice = (id: number, price: number) => apiRequest<{ ok: boolean }>(`/api/admin/rides/${id}/price`, { method: 'PATCH', body: JSON.stringify({ price }) });
export const apiAdminRideAcceptOffer = (id: number, offerId: number) => apiRequest<{ ok: boolean }>(`/api/admin/rides/${id}/accept-offer`, { method: 'POST', body: JSON.stringify({ offerId }) });
export const apiAdminRideReopen = (id: number) => apiRequest<{ ok: boolean; notified: number }>(`/api/admin/rides/${id}/reopen`, { method: 'POST' });
export const apiAdminTripEdit = (id: number, b: { price?: number; seats?: number; departAt?: string; dest?: string; driverId?: number }) => apiRequest<{ ok: boolean }>(`/api/admin/trips/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminTripBook = (id: number, customerId: number, count = 1) => apiRequest<{ ok: boolean; seats: number[] }>(`/api/admin/trips/${id}/book`, { method: 'POST', body: JSON.stringify({ customerId, count }) });
export const apiAdminTripUnbook = (id: number, customerId: number) => apiRequest<{ ok: boolean }>(`/api/admin/trips/${id}/unbook`, { method: 'POST', body: JSON.stringify({ customerId }) });
export const apiAdminCaptainPhotoSet = (id: number, kind: string, image: string) => apiRequest<{ ok: boolean }>(`/api/admin/captains/${id}/photos/${kind}`, { method: 'PUT', body: JSON.stringify({ image }) });
export const apiAdminCaptainPhotoDelete = (id: number, kind: string) => apiRequest<{ ok: boolean }>(`/api/admin/captains/${id}/photos/${kind}`, { method: 'DELETE' });
export const apiAdminCaptainPassword = (id: number, password: string) => apiRequest<{ ok: boolean }>(`/api/admin/captains/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
/** a protected photo (needs the sign-in header, so an <Image uri> can't load it): returns a data URI, or '' if there is none */
export async function apiAdminCaptainPhotoData(id: number, kind: string): Promise<string> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}/api/admin/captains/${id}/photo/${kind}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return '';
  const blob = await res.blob();
  return await new Promise<string>((ok) => { const fr = new FileReader(); fr.onloadend = () => ok(String(fr.result || '')); fr.onerror = () => ok(''); fr.readAsDataURL(blob); });
}
/** any protected image (needs the sign-in header): a data URI, or '' */
export async function apiAuthImage(path: string): Promise<string> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return '';
  const blob = await res.blob();
  return await new Promise<string>((ok) => { const fr = new FileReader(); fr.onloadend = () => ok(String(fr.result || '')); fr.onerror = () => ok(''); fr.readAsDataURL(blob); });
}
export type CaptainRequest = { id: number; captainId: number; name: string; phone: string; kind: 'profile' | 'photo'; photoKind: string; photoLabel: string; createdAt: number; current: { typeName: string; model: string; color: string; plate: string; nationalId: string }; next: { typeName: string; model: string; color: string; plate: string; nationalId: string } | null };
export const apiAdminCaptainRequests = () => apiRequest<{ requests: CaptainRequest[] }>('/api/admin/captain-requests');
export const apiAdminCaptainRequestApprove = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/captain-requests/${id}/approve`, { method: 'POST' });
export const apiAdminCaptainRequestReject = (id: number, note?: string) => apiRequest<{ ok: boolean }>(`/api/admin/captain-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
export const captainPhotoUrl = (id: number, kind: string) => `${API_BASE}/api/admin/captains/${id}/photo/${kind}`;

/* zones: the owner's fixed price between two areas, per vehicle */
export type RideZone = { fromRegionId: number; toRegionId: number; price: number };
export const apiAdminRideZones = (typeId: number) => apiRequest<{ zones: RideZone[] }>(`/api/admin/ride-types/${typeId}/zones`);
export const apiAdminRideZonesSave = (typeId: number, zones: RideZone[]) => apiRequest<{ ok: boolean; count: number }>(`/api/admin/ride-types/${typeId}/zones`, { method: 'PUT', body: JSON.stringify({ zones }) });

/* open / close of new orders (the whole app, or one service) */
export type GateRow = { key: string; label: string; closed: boolean; rawClosed: boolean; message: string; until: number | null };
export const apiGates = () => apiRequest<{ closed: Record<string, { message: string; until: number | null }> }>('/api/gates');
export const apiAdminGates = () => apiRequest<{ gates: GateRow[] }>('/api/admin/gates');
export const apiAdminGateSave = (key: string, b: { closed: boolean; message?: string; until?: string | null }) => apiRequest<{ ok: boolean }>(`/api/admin/gates/${key}`, { method: 'PUT', body: JSON.stringify(b) });

/* intercity trips with seats */
export type TripDriver = { name: string; model: string; color: string; plate: string };
export type Trip = { id: number; dest: string; fromText: string; departAt: number; seats: number; price: number; note: string; status: string; booked: number[]; free: number; mine?: number[]; driver?: TripDriver; passengers?: { seat: number; name: string; phone: string }[]; vehicle?: { id: number; name: string } | null; maxPersons?: number };
export type MyTrip = { id: number; dest: string; fromText: string; departAt: number; price: number; status: string; mySeats: number[]; driver: TripDriver & { phone: string } };
export const apiTrips = () => apiRequest<{ trips: Trip[]; maxPersons?: number }>('/api/trips');
export const apiMyTrips = () => apiRequest<{ trips: MyTrip[] }>('/api/trips/mine');
export const apiTripBook = (id: number, count: number) => apiRequest<{ ok: boolean; seats: number[] }>(`/api/trips/${id}/book`, { method: 'POST', body: JSON.stringify({ count }) });
export const apiAdminTripsSettings = () => apiRequest<{ maxPersons: number }>('/api/admin/trips-settings');
export const apiAdminTripsSettingsSave = (maxPersons: number) => apiRequest<{ ok: boolean; maxPersons: number }>('/api/admin/trips-settings', { method: 'POST', body: JSON.stringify({ maxPersons }) });
export const apiTripCancelBooking = (id: number) => apiRequest<{ ok: boolean }>(`/api/trips/${id}/cancel-booking`, { method: 'POST' });
export const apiCaptainTrips = () => apiRequest<{ trips: Trip[]; allowed?: boolean }>('/api/captain/trips');
export const apiCaptainTripCreate = (b: { dest: string; fromText?: string; departAt: string; seats: number; price: number; note?: string }) => apiRequest<{ trip: Trip; notified: number }>('/api/captain/trips', { method: 'POST', body: JSON.stringify(b) });
export const apiCaptainTripStatus = (id: number, status: 'started' | 'done') => apiRequest<{ ok: boolean }>(`/api/captain/trips/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export const apiCaptainTripCancel = (id: number) => apiRequest<{ ok: boolean }>(`/api/captain/trips/${id}/cancel`, { method: 'POST' });
export const apiAdminTrips = () => apiRequest<{ trips: (Trip & { driver: any; driverId?: number; plate: string; passengers?: { seat: number; customerId?: number; name: string; phone: string }[] })[] }>('/api/admin/trips');
export const apiAdminTripCancel = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/trips/${id}/cancel`, { method: 'POST' });

/* the owner turns an account into a supervisor / manager / customer; staff link 1-3 orders to one courier */
export const apiAdminSetRole = (id: string, b: { role: 'customer' | 'supervisor' | 'manager'; regions?: string[]; perms?: string[] }) => apiRequest<{ user: any }>(`/api/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify(b) });
export const apiStaffDispatch = (orderIds: string[], courierId: string) => apiRequest<{ ok: boolean; batchId: string; orders: any[] }>('/api/staff/dispatch', { method: 'POST', body: JSON.stringify({ orderIds, courierId }) });

/* the owner's design of the customer home */
export type HomeShape = 'tile' | 'rect' | 'wide' | 'round' | 'text';
export type HomeLayout = { order?: string[]; hidden?: string[]; mode?: 'grid' | 'row'; svc?: Record<string, { shape: HomeShape }> };
export const apiAdminHomeLayout = () => apiRequest<{ layout: HomeLayout }>('/api/admin/home-layout');
export const apiAdminHomeLayoutSave = (layout: HomeLayout) => apiRequest<{ layout: HomeLayout }>('/api/admin/home-layout', { method: 'PUT', body: JSON.stringify({ layout }) });

/* look of the new services (market, rides): icon picture, cover picture, description */
export type SvcKey = 'market' | 'rides' | 'errand';
export type SvcCoverKind = 'cover' | 'cover2' | 'cover3';
export type SvcImgKind = 'icon' | SvcCoverKind;
export type SvcMeta = Record<SvcKey, { sub: string; title: string; sort: number; icon: number; cover: number; cover2: number; cover3: number }>;
export const apiSvcMeta = () => apiRequest<SvcMeta>('/api/svc-meta');
export const svcImageUrl = (key: SvcKey, kind: SvcImgKind, v: number) => `${API_BASE}/api/svc-image/${key}/${kind}?v=${v}`;
export const apiAdminSvcImage = (key: SvcKey, kind: SvcImgKind, image: string | null) =>
  apiRequest<{ ok: boolean }>(`/api/admin/svc-image/${key}/${kind}`, { method: image ? 'PUT' : 'DELETE', ...(image ? { body: JSON.stringify({ image }) } : {}) });
export const apiAdminSvcMeta = (key: SvcKey, b: { sub?: string; title?: string; sort?: number }) => apiRequest<{ ok: boolean }>(`/api/admin/svc-meta/${key}`, { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminSvcSub = (key: SvcKey, sub: string) => apiRequest<{ ok: boolean }>(`/api/admin/svc-meta/${key}`, { method: 'PATCH', body: JSON.stringify({ sub }) });

/* ---- owner broadcasts: a phone push plus a message inside the app ---- */
export type BroadcastAud = 'all' | 'customer' | 'courier' | 'provider' | 'captain';
export type Broadcast = { id: number; title: string; body: string; audience: BroadcastAud; audienceAr: string; sentTo: number; createdAt: number };
export const apiAdminBroadcasts = () => apiRequest<{ broadcasts: Broadcast[]; counts: Record<BroadcastAud, number>; pushUsers: number }>('/api/admin/broadcasts');
export const apiAdminBroadcastSend = (b: { title: string; body: string; audience: BroadcastAud }) => apiRequest<{ broadcast: Broadcast; broadcasts: Broadcast[] }>('/api/admin/broadcasts', { method: 'POST', body: JSON.stringify(b) });
export type SupportBroadcast = { id: number; text: string; audience: BroadcastAud; audienceAr: string; sentTo: number; createdAt: number };
export const apiAdminSupportBroadcasts = () => apiRequest<{ broadcasts: SupportBroadcast[]; counts: Record<BroadcastAud, number> }>('/api/admin/support-broadcasts');
export const apiAdminSupportBroadcastSend = (b: { text: string; audience: BroadcastAud }) => apiRequest<{ broadcast: SupportBroadcast; broadcasts: SupportBroadcast[] }>('/api/admin/support-broadcasts', { method: 'POST', body: JSON.stringify(b) });
export const apiAdminBroadcastDelete = (id: number) => apiRequest<{ broadcasts: Broadcast[] }>(`/api/admin/broadcasts/${id}`, { method: 'DELETE' });
export const apiBroadcastsUnread = () => apiRequest<{ broadcasts: Broadcast[] }>('/api/broadcasts/unread');
export const apiBroadcastSeen = (id: number) => apiRequest<{ ok: boolean }>(`/api/broadcasts/${id}/seen`, { method: 'POST' });

/** Silent error report to the server (never throws, never waits for an answer). */
export async function apiClientError(body: { message: string; where: string; stack?: string; platform?: string; version?: string }): Promise<void> {
  try {
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(`${API_BASE}/api/client-errors`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch { /* reporting must never cause a new error */ }
}
export type ClientErrorRow = { id: string; where: string; message: string; stack: string; platform: string; version: string; userId: string | null; count: number; first: number; last: number };
export const apiAdminClientErrors = () => apiRequest<{ errors: ClientErrorRow[] }>('/api/admin/client-errors');
export const apiAdminClientErrorsClear = () => apiRequest<{ ok: boolean }>('/api/admin/client-errors', { method: 'DELETE' });

/* delivery means a courier picks when signing up (the owner manages them from the panel) */
export type CourierVehicle = { id: number; name: string; sort: number; active: boolean; image: string | null; couriers?: number };
export const apiPublicCourierVehicles = () => apiRequest<{ vehicles: { id: number; name: string; image: string | null }[] }>('/api/public/courier-vehicles', {}, false);
export const courierVehicleImageUrl = (v: { image: string | null }) => (v.image ? `${API_BASE}${v.image}` : '');
export const apiAdminCourierVehicles = () => apiRequest<{ vehicles: CourierVehicle[] }>('/api/admin/courier-vehicles');
export const apiAdminCourierVehicleAdd = (name: string) => apiRequest<{ vehicle: CourierVehicle }>('/api/admin/courier-vehicles', { method: 'POST', body: JSON.stringify({ name }) });
export const apiAdminCourierVehicleSave = (id: number, b: { name?: string; active?: boolean; sort?: number }) => apiRequest<{ vehicle: CourierVehicle }>(`/api/admin/courier-vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
export const apiAdminCourierVehicleDelete = (id: number) => apiRequest<{ ok: boolean }>(`/api/admin/courier-vehicles/${id}`, { method: 'DELETE' });
export const apiAdminCourierVehicleImage = (id: number, image: string) => apiRequest<{ vehicle: CourierVehicle }>(`/api/admin/courier-vehicles/${id}/image`, { method: 'PUT', body: JSON.stringify({ image }) });

/* ---------- الجرس (الإدارة ترنّ على مندوب/مقدّم خدمة لحد ما يرد) ---------- */
export type BellInfo = { id: number; orderId: number; targetId: number; role: 'courier' | 'shop'; status: string; startedAt: number; sends: number; name?: string; reason?: string };
export type MyBell = BellInfo & { order: { id: number; number: number | string; status: string; shop: string; address: string; region: string; total: number; customer: string; mine: boolean } };
export const apiBellStart = (orderId: string | number, role: 'courier' | 'shop', targetId: string | number) =>
  apiRequest<{ bell: BellInfo; already?: boolean }>(`/api/admin/orders/${encodeURIComponent(String(orderId))}/bell`, { method: 'POST', body: JSON.stringify({ role, targetId: Number(targetId) }) });
export const apiBellStop = (orderId: string | number) =>
  apiRequest<{ ok: boolean; stopped: number }>(`/api/admin/orders/${encodeURIComponent(String(orderId))}/bell`, { method: 'DELETE' });
export const apiBellList = (orderId: string | number) =>
  apiRequest<{ bells: BellInfo[] }>(`/api/admin/orders/${encodeURIComponent(String(orderId))}/bells`);
export const apiMyBells = () => apiRequest<{ bells: MyBell[] }>('/api/me/bells');
export const apiBellRespond = (orderId: string | number, decision: 'accept' | 'reject') =>
  apiRequest<{ ok: boolean }>(`/api/orders/${encodeURIComponent(String(orderId))}/bell/respond`, { method: 'POST', body: JSON.stringify({ decision }) });

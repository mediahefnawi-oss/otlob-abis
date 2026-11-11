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
  catch { throw new ApiError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.', 0); }
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
export type ServerUser = { id: string; name: string; phone: string; phone2?: string; role: string; address: string; status: string; createdAt?: string; regionId?: string | null; homeLat?: number; homeLng?: number; vehicle?: string; available?: boolean; availableSince?: number; accountFlag?: string; flagNote?: string; supRegions?: string[]; supportChat?: boolean };

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
export type ServerRegion = { id: string; name: string; deliveryFee: number; active: boolean };
export async function apiListRegions() {
  return apiRequest<{ regions: ServerRegion[] }>('/api/regions', {}, true);
}
export async function apiAdminCreateRegion(input: { name: string }) {
  return apiRequest<{ region: ServerRegion }>('/api/admin/regions', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiAdminUpdateRegion(id: string | number, patch: { name?: string; deliveryFee?: number; active?: boolean }) {
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
export async function apiCheckout(input: { name: string; phone: string; address: string; notes: string; lines: { productId: string; qty: number }[]; coupon?: string; destMode?: string; destLat?: number; destLng?: number }) {
  return apiRequest<{ invoice: any; orders: any[]; address: string }>('/api/orders/checkout', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiCustomOrder(input: { text: string; phone: string; address: string; destMode?: string; destLat?: number; destLng?: number }) {
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
export async function apiPlaceRequest(input: { providerId: string; text: string; image?: string | null; phone: string; address: string; destMode?: string; destLat?: number; destLng?: number }) {
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
export type StaffCourierPos = CourierPos & { id: string; name: string; phone: string; vehicle: string; available: boolean; busy: number };
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
  providerIds: string[] | null; userId: string | null; userName: string | null; perUser: number | null; maxUses: number | null; uses: number; given: number; active: boolean; source: string;
};
export type CouponInput = { code?: string; kind: 'amount' | 'percent'; value: number; maxDiscount?: number; days: number; startDate?: string; providerIds?: string[]; perUser?: number | null; maxUses?: number };
export const apiCoupons = () => apiRequest<{ coupons: Coupon[] }>('/api/admin/coupons');
export const apiCouponCreate = (b: CouponInput) => apiRequest<{ coupons: Coupon[] }>('/api/admin/coupons', { method: 'POST', body: JSON.stringify(b) });
export const apiCouponActive = (id: string, active: boolean) => apiRequest<{ coupons: Coupon[] }>(`/api/admin/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const apiCouponDelete = (id: string) => apiRequest<{ coupons: Coupon[] }>(`/api/admin/coupons/${id}`, { method: 'DELETE' });
export const apiCouponCheck = (code: string, lines: { productId: string; qty: number }[]) => apiRequest<{ code: string; discount: number; kind: string; value: number }>('/api/coupons/check', { method: 'POST', body: JSON.stringify({ code, lines }) });
export const apiMyCoupons = () => apiRequest<{ coupons: Coupon[] }>('/api/coupons/mine');

/* ---- feature switches, section / order mode, menu pictures ---- */
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

import { storage } from './storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Central API transport for the migration from local-only storage to the shared server.
 * Set EXPO_PUBLIC_API_URL to the deployed API origin, e.g. https://api.example.com.
 * Do not put secrets in EXPO_PUBLIC_* variables; they are bundled into the client.
 */
const API_BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');
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
  try { response = await fetch(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`, { ...options, headers }); }
  catch { throw new ApiError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.', 0); }
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

export async function apiRegister(input: { name: string; phone: string; password: string; address?: string; role?: string; regionId?: string; vehicle?: string; provider?: Record<string, unknown> }) {
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
  updatedAt?: string;
};

export async function apiGetSettings() {
  return apiRequest<{ settings: CentralSettings }>('/api/settings', {}, false);
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
export type ServerUser = { id: string; name: string; phone: string; role: string; address: string; status: string; createdAt?: string; regionId?: string | null; vehicle?: string; available?: boolean; availableSince?: number };

export async function apiMe() {
  return apiRequest<{ user: ServerUser }>('/api/me');
}
export async function apiUpdateProfile(patch: { name?: string; address?: string; regionId?: string | null; available?: boolean }) {
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
export async function apiAdminCreateRegion(input: { name: string; deliveryFee: number }) {
  return apiRequest<{ region: ServerRegion }>('/api/admin/regions', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiAdminUpdateRegion(id: string | number, patch: { name?: string; deliveryFee?: number; active?: boolean }) {
  return apiRequest<{ region: ServerRegion }>(`/api/admin/regions/${encodeURIComponent(String(id))}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function apiAdminDeleteRegion(id: string | number) {
  return apiRequest<{ ok: boolean }>(`/api/admin/regions/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

/** Phase 4 (part B): orders, invoices, bookings and chat are central. */
export type SyncPayload = { orders: any[]; invoices: any[]; appointments: any[]; messages: any[]; bookedSlots: { doctorId: string; date: string; time: string }[] };
export async function apiSync() {
  return apiRequest<SyncPayload>('/api/sync');
}
export async function apiCheckout(input: { name: string; phone: string; address: string; notes: string; lines: { productId: string; qty: number }[] }) {
  return apiRequest<{ invoice: any; orders: any[]; address: string }>('/api/orders/checkout', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiCustomOrder(input: { text: string; phone: string; address: string }) {
  return apiRequest<{ invoice: any; orders: any[] }>('/api/orders/custom', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiOrderAction(id: string | number, action: string, reason?: string) {
  return apiRequest<{ order: any }>(`/api/orders/${encodeURIComponent(String(id))}/action`, { method: 'POST', body: JSON.stringify({ action, reason }) });
}
export async function apiSendMessage(orderId: string | number, text: string) {
  return apiRequest<{ message: any }>(`/api/orders/${encodeURIComponent(String(orderId))}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
}
export async function apiBookAppointment(input: { doctorId: string; date: string; time: string; patientName: string; phone: string; notes: string }) {
  return apiRequest<{ appointment: any }>('/api/appointments/book', { method: 'POST', body: JSON.stringify(input) });
}
export async function apiApptAction(id: string | number, action: string) {
  return apiRequest<{ appointment: any }>(`/api/appointments/${encodeURIComponent(String(id))}/action`, { method: 'POST', body: JSON.stringify({ action }) });
}

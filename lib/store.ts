import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  ApiError, ServerUser, apiLogin, apiRegister, apiMe, apiGetSettings, apiUpdateSettings, apiSetUserStatus,
  apiDecideProvider, apiListUsers, apiListPendingProviders, apiUpdateProfile, apiChangePassword,
  apiAdminResetPassword, apiAdminCreateProvider, clearApiToken, hasApiToken, CentralSettings,
  apiListProviders, apiListProducts, apiCreateProduct, apiUpdateProduct, apiDeleteProduct, apiUpdateProvider, apiAdminDeleteProvider,
  apiListRegions, apiAdminCreateRegion, apiAdminUpdateRegion, apiAdminDeleteRegion,
  apiSync, apiCheckout, apiCustomOrder, apiOrderAction, apiSendMessage, apiBookAppointment, apiApptAction,
} from './api';
import {
  DB, User, Role, Provider, Product, Order, OrderStatus, Appointment, Invoice, Message,
  Settings, CartLine, AccountStatus, ProviderType, OrderItem, Region,
} from './types';
import { buildSeed } from './seed';
import { hash, normPhone } from './format';

const DB_KEY = 'abis_db_v3';
const SESSION_KEY = 'abis_session_v3';
const CART_KEY = 'abis_cart_v3';

// Session token is kept in the OS secure keystore (Keychain/Keystore); falls back to app storage on web
const secure = {
  async get(k: string) {
    try {
      const v = await SecureStore.getItemAsync(k);
      if (v !== null && v !== undefined) return v;
    } catch {}
    return AsyncStorage.getItem(k);
  },
  async set(k: string, v: string) {
    try {
      await SecureStore.setItemAsync(k, v);
      return;
    } catch {}
    await AsyncStorage.setItem(k, v).catch(() => {});
  },
  async del(k: string) {
    try {
      await SecureStore.deleteItemAsync(k);
    } catch {}
    await AsyncStorage.removeItem(k).catch(() => {});
  },
};

export interface State {
  db: DB;
  userId: string | null;
  cart: CartLine[];
  ready: boolean;
}

let state: State = { db: buildSeed(), userId: null, cart: [], ready: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const setState = (p: Partial<State>) => {
  state = { ...state, ...p };
  emit();
};

export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getState = () => state;
export const useStore = () => useSyncExternalStore(subscribe, getState, getState);

export const useMe = (): User | null => {
  const s = useStore();
  return s.userId ? s.db.users.find((u) => u.id === s.userId) || null : null;
};

let writeTimer: any = null;
const persist = () => {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    AsyncStorage.setItem(DB_KEY, JSON.stringify(state.db)).catch(() => {});
  }, 60);
};

function mutate(fn: (db: DB) => void) {
  const db: DB = { ...state.db, rev: state.db.rev + 1 };
  fn(db);
  setState({ db });
  persist();
}

const uid = (db: DB, p: string) => `${p}${++db.seq}`;

/* ---------- central sync helpers ---------- */
const isServerId = (id: string) => /^\d+$/.test(id);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'حدث خطأ غير متوقع. حاول مرة أخرى');

const fromServer = (s: ServerUser, old?: User): User => ({
  vehicle: s.vehicle || old?.vehicle,
  available: !!s.available,
  availableSince: s.availableSince,
  id: s.id,
  name: s.name,
  phone: s.phone,
  pass: '', // password hashes never leave the server
  role: s.role as Role,
  address: s.address || '',
  status: s.status as AccountStatus,
  regionId: s.regionId ?? null,
  createdAt: s.createdAt ? Date.parse(s.createdAt) || Date.now() : old?.createdAt ?? Date.now(),
});

function mirrorUser(s: ServerUser) {
  const old = state.db.users.find((u) => u.id === s.id);
  const next = fromServer(s, old);
  const same = old && old.name === next.name && old.phone === next.phone && old.role === next.role
    && old.address === next.address && old.status === next.status && (old.regionId ?? null) === (next.regionId ?? null)
    && old.available === next.available && old.vehicle === next.vehicle;
  if (same) return;
  mutate((db) => {
    db.users = old ? db.users.map((u) => (u.id === s.id ? next : u)) : [...db.users, next];
    if (next.role === 'provider') {
      db.providers = db.providers.map((p) => (p.ownerId === next.id
        ? { ...p, status: next.status, open: next.status === 'active' ? p.open : false } : p));
    }
  });
}

const settingsKey = (x: Partial<Settings>) =>
  JSON.stringify([x.appEnabled, x.maintenanceMessage, x.announcement, x.autoAssign, x.supportPhone, x.supportName]);

function applySettings(c: CentralSettings) {
  const next: Settings = {
    appEnabled: c.appEnabled,
    maintenanceMessage: c.maintenanceMessage,
    announcement: c.announcement,
    autoAssign: c.autoAssign,
    supportPhone: c.supportPhone,
    supportName: c.supportName,
  };
  if (settingsKey(next) === settingsKey(state.db.settings)) return;
  mutate((db) => {
    db.settings = next;
  });
}

const EMOJI: Record<ProviderType, string> = { restaurant: '🍽️', supermarket: '🛒', pharmacy: '💊', clinic: '🩺' };

// Owner device: bring pending couriers / providers registered from other devices into the review queues.
async function syncAdminQueues() {
  const { users } = await apiListUsers({});
  const byId = new Map(state.db.users.map((u) => [u.id, u]));
  let changed = false;
  const next = [...state.db.users];
  for (const su of users) {
    const old = byId.get(su.id);
    const nu = fromServer(su, old);
    if (!old) { next.push(nu); changed = true; }
    else if (JSON.stringify(old) !== JSON.stringify(nu)) { next[next.indexOf(old)] = nu; changed = true; }
  }
  if (changed) mutate((db) => { db.users = next; });
}

/** Delivery price for the signed-in customer: the price of their area, falling back to the service's own price. */
export function feeFor(p: Provider): number {
  if (p.type === 'clinic') return 0;
  const me = state.db.users.find((u) => u.id === state.userId);
  const region = me?.regionId ? state.db.regions.find((r) => r.id === me.regionId) : undefined;
  return region ? region.deliveryFee : p.deliveryFee;
}

/* ---------- central catalog (providers + products) ---------- */
let storeErrorHandler: (msg: string) => void = () => {};
/** The UI registers a toast here so background saves can report a failure. */
export function setStoreErrorHandler(fn: (msg: string) => void) { storeErrorHandler = fn; }

let pendingWrites = 0; // while >0 a background catalog refresh would overwrite an unsaved optimistic edit

const toProvider = (x: any): Provider => ({
  id: String(x.id), ownerId: String(x.ownerId), type: x.type, name: x.name, desc: x.desc || '', address: x.address || '',
  phone: x.phone || '', emoji: x.emoji || EMOJI[x.type as ProviderType] || '🏪', rating: Number(x.rating) || 0,
  eta: x.eta ?? (x.type === 'clinic' ? '' : '30-45'), deliveryFee: Number(x.deliveryFee) || 0, status: x.status,
  open: !!x.open, specialty: x.specialty || undefined, createdAt: Number(x.createdAt) || Date.now(),
});
const toProduct = (x: any): Product => ({
  id: String(x.id), providerId: String(x.providerId), kind: x.kind === 'doctor' ? 'doctor' : 'item', name: x.name,
  price: Number(x.price) || 0, emoji: x.emoji || (x.kind === 'doctor' ? '👨‍⚕️' : '📦'), category: x.category || 'عام',
  desc: x.desc || '', available: !!x.available, slots: Array.isArray(x.slots) ? x.slots : undefined,
});

/** Removes the built-in demo data (sample shops, users, orders). Only central (numeric-id) records survive. */
function stripDemo(db: DB): DB {
  return {
    ...db,
    regions: db.regions || [],
    bookedSlots: db.bookedSlots || [],
    users: db.users.filter((u) => isServerId(u.id)),
    providers: db.providers.filter((p) => isServerId(p.id)),
    products: db.products.filter((p) => isServerId(p.providerId) && isServerId(p.id)),
    orders: db.orders.filter((o) => isServerId(o.id)),
    appointments: db.appointments.filter((a) => isServerId(a.id)),
    invoices: db.invoices.filter((i) => isServerId(i.id)),
    messages: db.messages.filter((m) => isServerId(m.id)),
  };
}

const upsertById = <T extends { id: string }>(list: T[], items: T[]): T[] => {
  const ids = new Set(items.map((i) => i.id));
  return [...list.filter((x) => !ids.has(x.id)), ...items];
};

/** Orders, invoices, bookings and chat: the server's copy replaces the local one. */
async function syncOrders() {
  if (pendingWrites > 0 || !state.userId) return;
  const x = await apiSync();
  if (pendingWrites > 0) return;
  const same = JSON.stringify([x.orders, x.invoices, x.appointments, x.messages, x.bookedSlots])
    === JSON.stringify([state.db.orders, state.db.invoices, state.db.appointments, state.db.messages, state.db.bookedSlots || []]);
  if (same) return;
  mutate((db) => {
    db.orders = x.orders as Order[];
    db.invoices = x.invoices as Invoice[];
    db.appointments = x.appointments as Appointment[];
    db.messages = x.messages as Message[];
    db.bookedSlots = x.bookedSlots;
  });
}

async function syncCatalog() {
  if (pendingWrites > 0) return;
  const [{ providers }, { products }, { regions }] = await Promise.all([apiListProviders<any>(), apiListProducts<any>(), apiListRegions()]);
  if (pendingWrites > 0) return;
  const P = providers.map(toProvider);
  const I = products.map(toProduct);
  const R: Region[] = regions.map((r) => ({ id: r.id, name: r.name, deliveryFee: Number(r.deliveryFee) || 0, active: r.active }));
  const same = JSON.stringify(P) === JSON.stringify(state.db.providers) && JSON.stringify(I) === JSON.stringify(state.db.products)
    && JSON.stringify(R) === JSON.stringify(state.db.regions);
  if (same) return;
  mutate((db) => {
    const clean = stripDemo(db);
    db.users = clean.users; db.orders = clean.orders; db.appointments = clean.appointments;
    db.invoices = clean.invoices; db.messages = clean.messages;
    db.providers = P;
    db.products = I;
    db.regions = R;
  });
  const ids = new Set(I.map((p) => p.id));
  if (state.cart.some((l) => !ids.has(l.productId))) saveCart(state.cart.filter((l) => ids.has(l.productId)));
}

let syncing = false;
let syncTick = 0;
/** Pull the central settings (maintenance/announcement) and refresh the signed-in account. */
export async function syncRemote(withCatalog = true) {
  if (syncing) return;
  syncing = true;
  try {
    try {
      const { settings } = await apiGetSettings();
      applySettings(settings);
    } catch {}
    if (withCatalog) {
      try { await syncCatalog(); } catch {}
    }
    if (state.userId && (await hasApiToken())) {
      try {
        const { user } = await apiMe();
        mirrorUser(user);
        if (user.role === 'admin') await syncAdminQueues();
        await syncOrders();
      } catch (e) {
        // Token expired / account deleted → sign out. Network failures keep the cached session.
        if (e instanceof ApiError && e.status === 401) {
          await clearApiToken();
          setState({ userId: null });
          secure.del(SESSION_KEY);
        }
      }
    }
  } finally {
    syncing = false;
  }
}

export async function initStore() {
  try {
    const raw = await AsyncStorage.getItem(DB_KEY);
    let db: DB = raw ? JSON.parse(raw) : buildSeed();
    // Owner/admin accounts only exist on the server now; drop any locally-stored admin from older builds.
    db = stripDemo(db);
    if (!raw) await AsyncStorage.setItem(DB_KEY, JSON.stringify(db));
    const sid = await secure.get(SESSION_KEY);
    const cartRaw = await AsyncStorage.getItem(CART_KEY);
    const hasToken = await hasApiToken();
    const cached = sid && hasToken ? db.users.find((u) => u.id === sid) : undefined;
    setState({ db, userId: cached ? cached.id : null, cart: cartRaw ? JSON.parse(cartRaw) : [] });
    if (hasToken) {
      try {
        const { user } = await apiMe();
        mirrorUser(user);
        setState({ userId: user.id });
        secure.set(SESSION_KEY, user.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await clearApiToken();
          setState({ userId: null });
          secure.del(SESSION_KEY);
        }
      }
    }
  } catch {}
  // Fetch maintenance state before the first screen, but never hang the splash if the server is slow.
  await Promise.race([syncRemote(), new Promise((r) => setTimeout(r, 4000))]);
  setState({ ready: true });

  // Live sync: central settings + account status every 10s and whenever the app returns to the foreground
  setInterval(() => { syncRemote(++syncTick % 2 === 0); }, 10000);
  AppState.addEventListener('change', (st) => { if (st === 'active') syncRemote(); });
  // Same-device multi-tab sync of local data (orders/products stay local until they are migrated)
  setInterval(async () => {
    try {
      const raw = await AsyncStorage.getItem(DB_KEY);
      if (!raw) return;
      const parsed: DB = JSON.parse(raw);
      if (parsed.rev > state.db.rev) setState({ db: parsed });
    } catch {}
  }, 2000);
}

/* ---------- session (server-authoritative) ---------- */
export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export async function login(phone: string, pass: string): Promise<Result<{ user: User }>> {
  const ph = normPhone(phone);
  try {
    const { user: su } = await apiLogin({ phone: ph, password: pass });
    mirrorUser(su);
    const user = state.db.users.find((u) => u.id === su.id)!;
    setState({ userId: user.id });
    secure.set(SESSION_KEY, user.id);
    syncRemote();
    return { ok: true, user };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export function logout() {
  clearApiToken();
  setState({ userId: null });
  secure.del(SESSION_KEY);
}

export interface RegisterInput {
  name: string;
  phone: string;
  pass: string;
  role: Exclude<Role, 'admin'>;
  address: string;
  vehicle?: string;
  provider?: { type: ProviderType; name: string; desc: string; specialty?: string; deliveryFee: number };
  regionId?: string;
}

export async function register(inp: RegisterInput): Promise<Result<{ user: User }>> {
  const phone = normPhone(inp.phone);
  if (inp.name.trim().length < 3) return { ok: false, error: 'اكتب الاسم بالكامل' };
  if (!/^01[0-9]{9}$/.test(phone)) return { ok: false, error: 'رقم الهاتف غير صحيح (مثال: 01012345678)' };
  if (inp.pass.length < 8) return { ok: false, error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' };
  if (inp.role === 'customer' && !inp.regionId) return { ok: false, error: 'اختر منطقتك' };
  if (inp.role === 'provider' && (!inp.provider || inp.provider.name.trim().length < 2))
    return { ok: false, error: 'اكتب اسم النشاط التجاري' };
  try {
    const { user: su } = await apiRegister({
      name: inp.name.trim(), phone, password: inp.pass, address: inp.address.trim(), role: inp.role, regionId: inp.regionId, vehicle: inp.vehicle,
      provider: inp.role === 'provider' && inp.provider ? { ...inp.provider } : undefined,
    });
    mirrorUser(su);
    // Local-only courier field (vehicle); the shop record itself comes from the server catalog
    mutate((db) => {
      db.users = db.users.map((u) => (u.id === su.id && inp.role === 'courier' ? { ...u, vehicle: inp.vehicle || 'موتوسيكل', available: false } : u));
        });
    const user = state.db.users.find((u) => u.id === su.id)!;
    setState({ userId: user.id });
    secure.set(SESSION_KEY, user.id);
    if (inp.role === 'provider') await syncCatalog().catch(() => {});
    return { ok: true, user };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Local-only fields (courier availability, etc.). Name/address go through updateProfile. */
export function updateUser(id: string, patch: Partial<User>) {
  mutate((db) => {
    db.users = db.users.map((u) => (u.id === id ? { ...u, ...patch } : u));
  });
}

export async function updateProfile(patch: { name?: string; address?: string; regionId?: string | null }): Promise<Result> {
  try {
    const { user } = await apiUpdateProfile(patch);
    mirrorUser(user);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function changePassword(_id: string, oldP: string, newP: string): Promise<Result> {
  if (newP.length < 8) return { ok: false, error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف' };
  try {
    await apiChangePassword(oldP, newP);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/* ---------- cart ---------- */
const saveCart = (cart: CartLine[]) => {
  setState({ cart });
  AsyncStorage.setItem(CART_KEY, JSON.stringify(cart)).catch(() => {});
};
export function cartAdd(productId: string, delta: number) {
  const cur = state.cart.find((l) => l.productId === productId);
  let next: CartLine[];
  if (!cur) next = delta > 0 ? [...state.cart, { productId, qty: delta }] : state.cart;
  else {
    const q = cur.qty + delta;
    next = q <= 0 ? state.cart.filter((l) => l.productId !== productId) : state.cart.map((l) => (l.productId === productId ? { ...l, qty: q } : l));
  }
  saveCart(next);
}
export const cartClear = () => saveCart([]);

/* ---------- helpers ---------- */
export const availableCouriers = (db: DB) =>
  db.users.filter((u) => u.role === 'courier' && u.status === 'active' && u.available);

const ACTIVE: OrderStatus[] = ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'];

function sysMsg(db: DB, orderId: string, text: string) {
  const m: Message = { id: uid(db, 'm'), orderId, senderId: 'system', senderName: 'النظام', senderRole: 'system', text, createdAt: Date.now() };
  db.messages = [...db.messages, m];
}

const setStatus = (db: DB, id: string, status: OrderStatus, extra: Partial<Order> = {}) => {
  db.orders = db.orders.map((o) =>
    o.id === id ? { ...o, ...extra, status, updatedAt: Date.now(), history: [...o.history, { status, at: Date.now() }] } : o
  );
};

/* ---------- ordering ---------- */
export function cartDetails(db: DB, cart: CartLine[]) {
  const groups: Record<string, { provider: Provider; items: OrderItem[]; subtotal: number }> = {};
  cart.forEach((l) => {
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) return;
    const prov = db.providers.find((x) => x.id === p.providerId);
    if (!prov) return;
    if (!groups[prov.id]) groups[prov.id] = { provider: { ...prov, deliveryFee: feeFor(prov) }, items: [], subtotal: 0 };
    groups[prov.id].items.push({ productId: p.id, name: p.name, price: p.price, qty: l.qty, emoji: p.emoji });
    groups[prov.id].subtotal += p.price * l.qty;
  });
  const list = Object.values(groups);
  const delivery = list.reduce((s, g) => s + g.provider.deliveryFee, 0);
  const subtotal = list.reduce((s, g) => s + g.subtotal, 0);
  return { groups: list, delivery, subtotal, total: subtotal + delivery };
}

export async function placeOrder(me: User, info: { name: string; phone: string; address: string; notes: string }): Promise<Result<{ invoiceId: string }>> {
  if (!state.db.settings.appEnabled) return { ok: false, error: 'التطبيق متوقف حالياً' };
  const det = cartDetails(state.db, state.cart);
  if (!det.groups.length) return { ok: false, error: 'السلة فارغة' };
  if (info.address.trim().length < 6) return { ok: false, error: 'اكتب العنوان بالتفصيل' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  const closed = det.groups.find((g) => !g.provider.open || g.provider.status !== 'active');
  if (closed) return { ok: false, error: `${closed.provider.name} مغلق حالياً` };
  pendingWrites++;
  try {
    const r = await apiCheckout({
      name: info.name.trim(), phone: normPhone(info.phone), address: info.address.trim(), notes: info.notes.trim(),
      lines: state.cart.map((l) => ({ productId: l.productId, qty: l.qty })),
    });
    mutate((db) => {
      db.orders = upsertById(db.orders, r.orders as Order[]);
      db.invoices = upsertById(db.invoices, [r.invoice as Invoice]);
      db.users = db.users.map((u) => (u.id === me.id ? { ...u, address: r.address } : u));
    });
    saveCart([]);
    return { ok: true, invoiceId: String(r.invoice.id) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

export const CUSTOM_FEE = 20;
/** Price of the errand service: the customer's area price (set by the owner), or this fallback. */
export function customFee(): number {
  const me = state.db.users.find((u) => u.id === state.userId);
  const region = me?.regionId ? state.db.regions.find((r) => r.id === me.regionId) : undefined;
  return region ? region.deliveryFee : CUSTOM_FEE;
}
export async function placeCustomOrder(me: User, info: { text: string; phone: string; address: string }): Promise<Result<{ orderId: string }>> {
  if (!state.db.settings.appEnabled) return { ok: false, error: 'التطبيق متوقف حالياً' };
  if (info.text.trim().length < 3) return { ok: false, error: 'اكتب ما تريد طلبه' };
  if (info.address.trim().length < 6) return { ok: false, error: 'اكتب العنوان بالتفصيل' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  pendingWrites++;
  try {
    const r = await apiCustomOrder({ text: info.text.trim(), phone: normPhone(info.phone), address: info.address.trim() });
    mutate((db) => {
      db.orders = upsertById(db.orders, r.orders as Order[]);
      db.invoices = upsertById(db.invoices, [r.invoice as Invoice]);
    });
    return { ok: true, orderId: String(r.orders[0].id) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

export type OrderAction = 'accept' | 'reject' | 'ready' | 'cancel' | 'courier_accept' | 'pickup' | 'go' | 'arrive' | 'deliver';

export function orderAction(orderId: string, action: OrderAction, by: User, reason?: string): Result {
  const o = state.db.orders.find((x) => x.id === orderId);
  if (!o) return { ok: false, error: 'الطلب غير موجود' };
  if (action === 'cancel' && ['picked_up', 'on_the_way', 'arrived', 'delivered'].includes(o.status)) return { ok: false, error: 'لا يمكن إلغاء الطلب الآن' };
  if (action === 'courier_accept') {
    if (!by.available) return { ok: false, error: 'فعّل حالتك إلى "متاح" أولاً لقبول الطلبات' };
    if (o.courierId && o.courierId !== by.id) return { ok: false, error: 'تم قبول الطلب بواسطة مندوب آخر' };
  }
  // optimistic: show the result at once; the server then confirms (or corrects) it
  mutate((db) => {
    switch (action) {
      case 'accept':
        setStatus(db, orderId, 'accepted');
        sysMsg(db, orderId, 'تم قبول طلبك وجاري التحضير 👨‍🍳');
        break;
      case 'reject':
        setStatus(db, orderId, 'rejected', { rejectReason: reason || 'غير متاح حالياً' });
        break;
      case 'ready':
        setStatus(db, orderId, 'ready');
        sysMsg(db, orderId, 'الطلب جاهز للاستلام من المندوب ✅');
        break;
      case 'cancel':
        setStatus(db, orderId, 'cancelled', { rejectReason: by.role === 'admin' ? 'ألغاه المدير' : by.role === 'provider' ? 'ألغاه المتجر' : 'ألغاه العميل' });
        break;
      case 'courier_accept':
        db.orders = db.orders.map((x) => (x.id === orderId ? { ...x, courierId: by.id, courierName: by.name, updatedAt: Date.now() } : x));
        sysMsg(db, orderId, `المندوب ${by.name} قبل طلبك وسيتولى التوصيل 🛵`);
        break;
      case 'pickup':
        setStatus(db, orderId, 'picked_up');
        sysMsg(db, orderId, 'استلم المندوب طلبك 📦');
        break;
      case 'go':
        setStatus(db, orderId, 'on_the_way');
        sysMsg(db, orderId, 'المندوب في الطريق إليك الآن 🚀');
        break;
      case 'arrive':
        setStatus(db, orderId, 'arrived');
        sysMsg(db, orderId, 'وصل المندوب إلى مكانك 📍');
        break;
      case 'deliver':
        setStatus(db, orderId, 'delivered');
        sysMsg(db, orderId, 'تم تسليم الطلب بنجاح. بالهناء والشفاء 💚');
        break;
    }
  });
  if (isServerId(orderId)) backgroundWrite(async () => { await apiOrderAction(orderId, action, reason); });
  return { ok: true };
}

export function sendMessage(orderId: string, text: string, by: User) {
  const t = text.trim();
  if (!t) return;
  mutate((db) => {
    db.messages = [
      ...db.messages,
      { id: uid(db, 'm'), orderId, senderId: by.id, senderName: by.name, senderRole: by.role, text: t, createdAt: Date.now() },
    ];
  });
  if (isServerId(orderId)) backgroundWrite(async () => { await apiSendMessage(orderId, t); });
}

/* ---------- appointments ---------- */
export function slotTaken(db: DB, doctorId: string, date: string, time: string) {
  return (
    db.appointments.some((a) => a.doctorId === doctorId && a.date === date && a.time === time && ['pending', 'confirmed'].includes(a.status))
    || (db.bookedSlots || []).some((x) => x.doctorId === doctorId && x.date === date && x.time === time)
  );
}

export async function bookAppointment(
  me: User,
  info: { doctor: Product; date: string; time: string; patientName: string; phone: string; notes: string }
): Promise<Result<{ id: string }>> {
  if (!state.db.settings.appEnabled) return { ok: false, error: 'التطبيق متوقف حالياً' };
  const prov = state.db.providers.find((p) => p.id === info.doctor.providerId);
  if (!prov || prov.status !== 'active' || !prov.open) return { ok: false, error: 'العيادة لا تستقبل حجوزات حالياً' };
  if (info.patientName.trim().length < 3) return { ok: false, error: 'اكتب اسم المريض' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  if (slotTaken(state.db, info.doctor.id, info.date, info.time)) return { ok: false, error: 'هذا الموعد محجوز، اختر موعداً آخر' };
  pendingWrites++;
  try {
    const { appointment } = await apiBookAppointment({
      doctorId: info.doctor.id, date: info.date, time: info.time, patientName: info.patientName.trim(), phone: normPhone(info.phone), notes: info.notes.trim(),
    });
    mutate((db) => {
      db.appointments = upsertById(db.appointments, [appointment as Appointment]);
      db.bookedSlots = [...(db.bookedSlots || []), { doctorId: info.doctor.id, date: info.date, time: info.time }];
    });
    return { ok: true, id: String(appointment.id) };
  } catch (e) {
    syncOrders().catch(() => {});
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

export function apptAction(id: string, action: 'confirm' | 'reject' | 'complete' | 'cancel') {
  if (isServerId(id)) backgroundWrite(async () => { await apiApptAction(id, action); });
  mutate((db) => {
    const a = db.appointments.find((x) => x.id === id);
    if (!a) return;
    const now = Date.now();
    let patch: Partial<Appointment> = {};
    if (action === 'confirm') {
      const invId = uid(db, 'inv');
      patch = { status: 'confirmed', invoiceId: invId };
      const inv: Invoice = {
        id: invId,
        number: `BK-${a.number}`,
        kind: 'booking',
        customerId: a.customerId,
        customerName: a.patientName,
        phone: a.phone,
        address: a.clinicAddress,
        createdAt: now,
        parts: [],
        total: a.fee,
        appointmentId: a.id,
        ownerId: a.clinicOwnerId,
        clinicName: a.clinicName,
        doctorName: a.doctorName,
        specialty: a.specialty,
        date: a.date,
        time: a.time,
        fee: a.fee,
      };
      db.invoices = [...db.invoices, inv];
    } else if (action === 'reject') patch = { status: 'rejected' };
    else if (action === 'complete') patch = { status: 'completed' };
    else patch = { status: 'cancelled' };
    db.appointments = db.appointments.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: now } : x));
  });
}

/* ---------- provider catalog ---------- */
const productData = (p: Partial<Product>) => ({ kind: p.kind, emoji: p.emoji, category: p.category, desc: p.desc, slots: p.slots });

/** Optimistic: the screen updates at once, the server write runs behind it; a failure reverts to the server's truth. */
async function backgroundWrite(job: () => Promise<void>) {
  pendingWrites++;
  try {
    await job();
  } catch (e) {
    storeErrorHandler(errMsg(e));
  } finally {
    pendingWrites--;
    syncCatalog().catch(() => {});
    syncOrders().catch(() => {});
  }
}

export function saveProduct(p: Omit<Product, 'id'> & { id?: string }) {
  const existing = p.id && isServerId(p.id) ? state.db.products.find((x) => x.id === p.id) : undefined;
  const tempId = existing ? p.id! : uid(state.db, p.kind === 'doctor' ? 'd' : 'i');
  mutate((db) => {
    const next = { ...(existing || {}), ...p, id: tempId } as Product;
    db.products = db.products.some((x) => x.id === tempId) ? db.products.map((x) => (x.id === tempId ? next : x)) : [...db.products, next];
  });
  if (!isServerId(p.providerId)) return;
  backgroundWrite(async () => {
    if (existing) {
      await apiUpdateProduct(tempId, { name: p.name, price: p.price, available: p.available, data: productData(p) });
    } else {
      const { product } = await apiCreateProduct({ providerId: p.providerId, name: p.name, price: p.price, data: productData(p) });
      mutate((db) => {
        db.products = db.products.map((x) => (x.id === tempId ? toProduct(product) : x));
      });
    }
  });
}
export function deleteProduct(id: string) {
  mutate((db) => {
    db.products = db.products.filter((x) => x.id !== id);
  });
  if (!isServerId(id)) return;
  backgroundWrite(async () => { await apiDeleteProduct(id); });
}
export function updateProvider(id: string, patch: Partial<Provider>) {
  mutate((db) => {
    db.providers = db.providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
  });
  if (!isServerId(id)) return;
  backgroundWrite(async () => {
    await apiUpdateProvider(id, {
      name: patch.name, desc: patch.desc, address: patch.address, phone: patch.phone,
      deliveryFee: patch.deliveryFee, open: patch.open, specialty: patch.specialty, emoji: patch.emoji, eta: patch.eta,
    });
  });
}

/* ---------- courier ---------- */
export function setAvailable(userId: string, available: boolean) {
  updateUser(userId, { available, availableSince: available ? Date.now() : undefined });
  if (!isServerId(userId)) return;
  backgroundWrite(async () => {
    try {
      const { user } = await apiUpdateProfile({ available });
      mirrorUser(user);
    } catch (e) {
      syncRemote(false).catch(() => {});
      throw e;
    }
  });
}

/* ---------- admin ---------- */
export async function setProviderStatus(providerId: string, status: AccountStatus): Promise<Result> {
  const p = state.db.providers.find((x) => x.id === providerId);
  if (!p) return { ok: false, error: 'الخدمة غير موجودة' };
  if (isServerId(providerId) && status !== 'pending') {
    try { await apiDecideProvider(providerId, status as 'active' | 'rejected' | 'suspended'); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  } else if (isServerId(p.ownerId) && status !== 'pending') {
    try { await apiSetUserStatus(p.ownerId, status); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, status, open: status === 'active' ? x.open || true : false } : x));
    db.users = db.users.map((u) => (u.id === p.ownerId ? { ...u, status } : u));
  });
  return { ok: true };
}
export async function setUserStatus(userId: string, status: AccountStatus): Promise<Result> {
  if (isServerId(userId)) {
    try { await apiSetUserStatus(userId, status); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.users = db.users.map((u) => (u.id === userId ? { ...u, status, available: status === 'active' ? u.available : false } : u));
  });
  return { ok: true };
}
/** Owner-only. Saved on the server first, so every user sees the change on their next sync. */
export async function updateSettings(patch: Partial<Settings>): Promise<Result> {
  try {
    const { settings } = await apiUpdateSettings(patch);
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
export async function resetAll() {
  const db = buildSeed();
  db.rev = state.db.rev + 1;
  db.settings = state.db.settings; // maintenance/announcement belong to the server, not the demo data
  setState({ db, userId: null, cart: [] });
  logout();
  AsyncStorage.removeItem(CART_KEY).catch(() => {});
  AsyncStorage.setItem(DB_KEY, JSON.stringify(db)).catch(() => {});
}

export async function refresh() {
  await syncRemote();
  try {
    const raw = await AsyncStorage.getItem(DB_KEY);
    if (!raw) return;
    const parsed: DB = JSON.parse(raw);
    if (parsed.rev > state.db.rev) setState({ db: parsed });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

/* ---------- owner (admin): full control over services ---------- */
export interface NewProviderInput {
  type: ProviderType;
  name: string;
  desc: string;
  address: string;
  phone: string;
  deliveryFee: number;
  specialty?: string;
  emoji?: string;
  managerName?: string;
  managerPhone?: string;
  managerPass?: string;
}

export async function adminCreateProvider(admin: User, inp: NewProviderInput): Promise<Result<{ id: string }>> {
  if (admin.role !== 'admin') return { ok: false, error: 'غير مصرح' };
  if (inp.name.trim().length < 2) return { ok: false, error: 'اكتب اسم الخدمة' };
  const mPhone = normPhone(inp.managerPhone || '');
  if (!/^01[0-9]{9}$/.test(mPhone)) return { ok: false, error: 'اكتب رقم هاتف المسؤول (حساب دخول الخدمة)' };
  if ((inp.managerPass || '').length < 8) return { ok: false, error: 'كلمة مرور المسؤول 8 أحرف على الأقل' };
  try {
    const r = await apiAdminCreateProvider({
      type: inp.type, name: inp.name.trim(), desc: inp.desc.trim(), address: inp.address.trim() || 'أبيس',
      phone: normPhone(inp.phone) || mPhone, deliveryFee: inp.deliveryFee, specialty: inp.specialty,
      emoji: inp.emoji, managerName: (inp.managerName || inp.name).trim(), managerPhone: mPhone, managerPass: inp.managerPass!,
    });
    mutate((db) => {
      db.users = [...db.users.filter((u) => u.id !== r.user.id), fromServer(r.user)];
      db.providers = [...db.providers, {
        id: r.providerId, ownerId: r.user.id, type: inp.type, name: inp.name.trim(), desc: inp.desc.trim(),
        address: inp.address.trim() || 'أبيس', phone: normPhone(inp.phone) || mPhone, emoji: inp.emoji || TYPES_EMOJI[inp.type],
        rating: 0, eta: inp.type === 'clinic' ? '' : '30-45', deliveryFee: inp.type === 'clinic' ? 0 : inp.deliveryFee,
        status: 'active', open: true, specialty: inp.type === 'clinic' ? inp.specialty : undefined, createdAt: Date.now(),
      }];
    });
    return { ok: true, id: r.providerId };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
const TYPES_EMOJI: Record<ProviderType, string> = { restaurant: '🍽️', supermarket: '🛒', pharmacy: '💊', clinic: '🩺' };

export async function adminDeleteProvider(providerId: string): Promise<Result> {
  const p = state.db.providers.find((x) => x.id === providerId);
  if (!p) return { ok: true };
  if (isServerId(providerId)) {
    try { await apiAdminDeleteProvider(providerId); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.providers = db.providers.filter((x) => x.id !== providerId);
    db.products = db.products.filter((x) => x.providerId !== providerId);
    const owner = db.users.find((u) => u.id === p.ownerId);
    if (owner && owner.role === 'provider' && !db.providers.some((x) => x.ownerId === owner.id)) {
      db.users = db.users.filter((u) => u.id !== owner.id);
    }
  });
  return { ok: true };
}

export async function adminDeleteCourier(userId: string): Promise<Result> {
  if (isServerId(userId)) {
    try { await apiSetUserStatus(userId, 'suspended'); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.users = db.users.filter((u) => u.id !== userId || u.role !== 'courier');
  });
  return { ok: true };
}

export async function adminResetPassword(userId: string, newPass: string): Promise<Result> {
  if (newPass.length < 8) return { ok: false, error: 'كلمة المرور 8 أحرف على الأقل' };
  if (!isServerId(userId)) return { ok: false, error: 'هذا حساب تجريبي محلي ولا يمكن تعيين كلمة مرور له' };
  try {
    await apiAdminResetPassword(userId, newPass);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/* ---------- delivery areas (owner) ---------- */
const toRegion = (r: { id: string; name: string; deliveryFee: number; active: boolean }): Region => ({ id: r.id, name: r.name, deliveryFee: Number(r.deliveryFee) || 0, active: r.active });

export async function addRegion(name: string, deliveryFee: number): Promise<Result> {
  try {
    const { region } = await apiAdminCreateRegion({ name: name.trim(), deliveryFee });
    mutate((db) => { db.regions = [...db.regions, toRegion(region)]; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function updateRegion(id: string, patch: { name?: string; deliveryFee?: number; active?: boolean }): Promise<Result> {
  try {
    const { region } = await apiAdminUpdateRegion(id, patch);
    mutate((db) => { db.regions = db.regions.map((r) => (r.id === id ? toRegion(region) : r)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function deleteRegion(id: string): Promise<Result> {
  try {
    await apiAdminDeleteRegion(id);
    mutate((db) => { db.regions = db.regions.filter((r) => r.id !== id); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

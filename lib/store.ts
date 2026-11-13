import { storage } from './storage';
import { alertNewOrder, setAlarm } from './alerts';
import { syncPushSubscription, forgetPushSubscription } from './push';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { phaseAt, allowedIn, renderMessage, type HoursPhase, type NextOpen } from './hours';
import { AppState } from 'react-native';
import {
  ApiError, ServerUser, apiDeleteCourier, apiDeleteCustomer, apiLabRequest, apiLabAction, apiLabFile, apiLogin, apiSetUserFlag, apiRegister, apiUpdateNotice, apiSetTheme, apiSetUiScale, apiSetPrivacy, apiSetDeliveryMode, apiSetMapMode, apiMe, apiGetSettings, apiUpdateSettings, apiSetUserStatus,
  apiDecideProvider, apiListUsers, apiListPendingProviders, apiUpdateProfile, apiChangePassword,
  apiAdminResetPassword, apiAdminCreateProvider, clearApiToken, hasApiToken, CentralSettings,
  apiListProviders, apiListProducts, apiCreateProduct, apiUpdateProduct, apiDeleteProduct, apiSetProviderLogo, apiSetProductImage, apiUpdateProvider, apiAdminDeleteProvider,
  apiListRegions, apiAdminCreateRegion, apiAdminUpdateRegion, apiAdminDeleteRegion,
  apiAdminCreateAd, apiAdminUpdateAd, apiAdminDeleteAd, ServerAd, apiPlaceRequest, apiQuote, apiErrandQuote, apiOrderImage, apiSync, apiCatalog, apiMoveProvider, apiProviderMode, apiProviderChatOff, apiPinProvider, apiApptRequest, apiApptPropose, apiApptAccept, apiBookMode, SyncPayload, apiCheckout, apiCustomOrder, apiOrderAction, apiSendMessage, apiBookAppointment, apiApptAction,
} from './api';
import {
  DB, User, Role, Provider, Product, Order, OrderStatus, Appointment, Invoice, Message,
  Settings, CartLine, AccountStatus, ProviderType, OrderItem, Region, Ad, ServiceDef, HomeBlock,
} from './types';
import { buildSeed } from './seed';
import { applyTheme } from './theme';
import { kmFee } from './geo';
import { apiJson } from './finance';
import { hash, normPhone, isBooking, applyServices } from './format';

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
    return storage.getItem(k);
  },
  async set(k: string, v: string) {
    try {
      await SecureStore.setItemAsync(k, v);
      return;
    } catch {}
    await storage.setItem(k, v).catch(() => {});
  },
  async del(k: string) {
    try {
      await SecureStore.deleteItemAsync(k);
    } catch {}
    await storage.removeItem(k).catch(() => {});
  },
};

export interface State {
  db: DB;
  userId: string | null;
  cart: CartLine[];
  cartDest: CartDest; // where the order being made goes: the saved spot, or another address (optionally with its own pin)
  syncError: string | null; // shown as a banner when the app could not refresh from the server
  ready: boolean;
}

export type CartDest = { pin?: { lat: number; lng: number } };
let state: State = { db: buildSeed(), userId: null, cart: [], cartDest: {}, ready: false, syncError: null };
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
export function setCartDest(d: CartDest) { setState({ cartDest: d }); }
/** The owner's switch for maps and live location (on unless the owner switched it off). */
export const mapOn = () => state.db.settings.map?.enabled !== false;
export const mapRequired = () => mapOn() && state.db.settings.map?.required !== false;
export const useMapOn = () => { const s = useStore(); return s.db.settings.map?.enabled !== false; };
/** Sent with an order: the pin chosen for THIS order ('none' when there is no pin and none is required). Nothing when maps are off. */
const destBody = () => (!mapOn() ? {} : state.cartDest.pin ? { destMode: 'pin', destLat: state.cartDest.pin.lat, destLng: state.cartDest.pin.lng } : { destMode: 'none' });
/** A new order needs a delivery pin when the owner requires it. */
const pinError = (): string | null => (mapRequired() && !state.cartDest.pin ? 'حدد موقع التوصيل على الخريطة أولاً' : null);
export const useStore = () => useSyncExternalStore(subscribe, getState, getState);

export const useMe = (): User | null => {
  const s = useStore();
  return s.userId ? s.db.users.find((u) => u.id === s.userId) || null : null;
};

/* ---------- guest browsing (the owner's switch "guestBrowse"): a visitor looks around without an account ---------- */
export const GUEST_ID = 'guest';
export const isGuestId = (id?: string | null) => id === GUEST_ID;
const GUEST_ADDR_KEY = 'abis_guest_addr';
export function enterGuest() {
  if (state.userId) return;
  const open = (addr: string | null) => {
    if (state.userId) return;
    const g: User = { id: GUEST_ID, name: 'ضيف', phone: '', pass: '', role: 'customer', address: addr || '', status: 'active', regionId: null, createdAt: Date.now() } as User;
    setState({ db: { ...state.db, users: [...state.db.users.filter((u) => u.id !== GUEST_ID), g] }, userId: GUEST_ID });
  };
  // a saved address is a nicety: if reading it fails the visitor still gets in
  storage.getItem(GUEST_ADDR_KEY).then(open, () => open(null));
}
export function exitGuest() { if (state.userId === GUEST_ID) setState({ userId: null }); }
/** what the guest wanted to do when the sign-in sheet opened (an item to add to the cart), done right after he signs in */
export type GuestPending = { productId: string; delta: number } | null;
let guestListener: ((pending: GuestPending) => void) | null = null;
export function onGuestPrompt(fn: ((pending: GuestPending) => void) | null) { guestListener = fn; }
export function requireLogin(pending: GuestPending = null) { if (guestListener) guestListener(pending); }
const guestStop = (): Result<never> | null => {
  if (state.userId !== GUEST_ID) return null;
  requireLogin();
  return { ok: false, error: 'سجّل دخولك الأول عشان تكمل' };
};

let writeTimer: any = null;
const persist = () => {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    storage.setItem(DB_KEY, JSON.stringify(state.db)).catch(() => {});
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
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : `حدث خطأ غير متوقع. حاول مرة أخرى${e && (e as any).message ? ` (${String((e as any).message).slice(0, 80)})` : ''}`);

const fromServer = (s: ServerUser, old?: User): User => ({
  premiumUntil: Number(s.premiumUntil) || 0,
  vehicle: s.vehicle || old?.vehicle,
  available: !!s.available,
  availableSince: s.availableSince,
  id: s.id,
  name: s.name,
  phone: s.phone,
  phone2: s.phone2 || '',
  pass: '', // password hashes never leave the server
  role: s.role as Role,
  address: s.address || '',
  status: s.status as AccountStatus,
  regionId: s.regionId ?? null,
  homeLat: s.homeLat, homeLng: s.homeLng,
  accountFlag: s.accountFlag || '',
  flagNote: s.flagNote || '',
  supRegions: s.supRegions,
  supportChat: !!s.supportChat,
  createdAt: s.createdAt ? Date.parse(s.createdAt) || Date.now() : old?.createdAt ?? Date.now(),
});

function mirrorUser(s: ServerUser) {
  const old = state.db.users.find((u) => u.id === s.id);
  const next = fromServer(s, old);
  const same = old && (old.premiumUntil || 0) === (next.premiumUntil || 0) && old.name === next.name && old.phone === next.phone && (old.phone2 || '') === (next.phone2 || '') && old.role === next.role
    && old.address === next.address && old.status === next.status && (old.regionId ?? null) === (next.regionId ?? null)
    && old.available === next.available && old.vehicle === next.vehicle && (old.accountFlag || '') === (next.accountFlag || '') && (old.flagNote || '') === (next.flagNote || '') && !!old.supportChat === !!next.supportChat;
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
  JSON.stringify([x.appEnabled, x.maintenanceMessage, x.announcement, x.autoAssign, x.supportPhone, x.supportName, x.loginImageV || 0, x.appIconV || 0, x.apkUrl || '', x.update || null, x.catIconV || {}, x.homeCoverV || 0, x.homeBlocks || null, x.premium || null, x.welcomeLogoV || 0, x.credits || null, x.hours || null, x.tzOffsetMin || 0, x.theme || 'default', x.delivery || null, x.map || null, x.ui || null, x.privacy || null, x.features || null]);

let clockSkewMs = 0; // server clock minus this phone's clock, so a wrong phone clock cannot open or close the app by itself
function applySettings(c: CentralSettings) {
  if (typeof c.serverNow === 'number') clockSkewMs = c.serverNow - Date.now();
  const next: Settings = {
    appEnabled: c.appEnabled,
    maintenanceMessage: c.maintenanceMessage,
    announcement: c.announcement,
    autoAssign: c.autoAssign,
    supportPhone: c.supportPhone,
    supportName: c.supportName,
    loginImageV: c.loginImageV || 0,
    appIconV: c.appIconV || 0,
    catIconV: c.catIconV || {},
    homeCoverV: c.homeCoverV || 0,
    homeBlocks: Array.isArray(c.homeBlocks) ? c.homeBlocks : [],
    premium: c.premium || null,
    apkUrl: c.apkUrl || '',
    update: c.update || { version: '', message: '', required: false },
    welcomeLogoV: c.welcomeLogoV || 0,
    credits: c.credits || null,
    hours: c.hours,
    tzOffsetMin: c.tzOffsetMin,
    theme: c.theme || 'default',
    ui: c.ui,
    privacy: c.privacy,
    features: c.features,
    delivery: c.delivery,
    map: c.map,
  };
  if (settingsKey(next) === settingsKey(state.db.settings)) return;
  applyTheme(next.theme); // the palette changes before the screens re-render
  mutate((db) => {
    db.settings = next;
  });
}

/** Is the app closed for this role right now? A manual stop by the owner and the opening hours both close it; the owner is never blocked. */
export function appGate(role?: string | null): { blocked: boolean; message: string; byHours: boolean; phase: HoursPhase; next: NextOpen | null } {
  const s = state.db.settings;
  if (!s.appEnabled) return { blocked: role !== 'admin', message: s.maintenanceMessage, byHours: false, phase: 'open', next: null };
  const { phase, next } = phaseAt(s.hours, Date.now() + clockSkewMs, s.tzOffsetMin || 120);
  const blocked = !allowedIn(phase, role);
  return { blocked, message: blocked ? renderMessage(s.hours, next) : '', byHours: blocked, phase, next };
}
/** the same, as a hook: re-checks every few seconds so the screen closes and opens by itself at the set times */
export function useAppGate(role?: string | null) {
  useStore();
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 15000); return () => clearInterval(t); }, []);
  return appGate(role);
}
/** closed by the opening hours (not a manual stop): the app stops asking the server, so the database can rest */
function closedByHoursNow(role?: string | null) {
  const g = appGate(role);
  return g.blocked && g.byHours;
}

const EMOJI: Record<ProviderType, string> = { restaurant: '🍽️', supermarket: '🛒', pharmacy: '💊', clinic: '🩺', store: '🏬', maker: '🧵' };

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

/** The owner's price for delivering from this shop's area to the signed-in customer's area (undefined = no price set: no delivery on that route). */
function routePriceFor(p: Provider): number | undefined {
  const me = state.db.users.find((u) => u.id === state.userId);
  return p.regionId && me?.regionId ? (state.db.routePrices || {})[`${p.regionId}:${me.regionId}`] : undefined;
}
/** Can this shop deliver to the signed-in customer? Only on a route the owner priced (a customer with no area keeps the shop's own price). */
export function deliveryOpen(p: Provider): boolean {
  if (isBooking(p.type)) return true;
  if (kmInfoFor(p)) return true; // priced by distance: no area route needed
  const me = state.db.users.find((u) => u.id === state.userId);
  if (!me || me.role !== 'customer' || !me.regionId) return true;
  return routePriceFor(p) !== undefined;
}
/** Delivery price for the signed-in customer: the owner's price for the route from the shop's area to the customer's area. */
/** The owner's "by kilometre" price for this shop and the signed-in customer (null = switch off or a spot is missing, so the area price applies). */
export function kmInfoFor(p: Provider): { fee: number; km: number } | null {
  if (isBooking(p.type)) return null;
  const me = state.db.users.find((u) => u.id === state.userId);
  if (!me || me.role !== 'customer') return null;
  if (!mapOn()) return null;
  return state.cartDest.pin ? kmFee(state.db.settings.delivery, p, state.cartDest.pin) : null; // no pin yet: the area price
}
export function feeFor(p: Provider): number {
  if (isBooking(p.type)) return 0;
  const k = kmInfoFor(p);
  if (k) return k.fee;
  const route = routePriceFor(p);
  return route !== undefined ? route : p.deliveryFee;
}

/* ---------- central catalog (providers + products) ---------- */
let storeErrorHandler: (msg: string) => void = () => {};
/** The UI registers a toast here so background saves can report a failure. */
export function setStoreErrorHandler(fn: (msg: string) => void) { storeErrorHandler = fn; }

let pendingWrites = 0; // while >0 a background catalog refresh would overwrite an unsaved optimistic edit

const toAd = (a: ServerAd): Ad => ({ id: a.id, title: a.title, link: a.link, active: a.active, sortOrder: a.sortOrder, v: a.v });
const toProvider = (x: any): Provider => ({
  id: String(x.id), ownerId: String(x.ownerId), type: x.type, name: x.name, desc: x.desc || '', address: x.address || '',
  phone: x.phone || '', emoji: x.emoji || EMOJI[x.type as ProviderType] || '🏪', rating: Number(x.rating) || 0, ratingCount: Number(x.ratingCount) || 0,
  eta: x.eta ?? (isBooking(x.type) ? '' : '30-45'), deliveryFee: Number(x.deliveryFee) || 0, status: x.status,
  open: !!x.open, specialty: x.specialty || undefined, logoV: Number(x.logoV) || 0, coverV: Number(x.coverV) || 0, regionId: x.regionId ? String(x.regionId) : undefined, regionName: x.regionName || undefined, featured: !!x.featured, orderMode: ['cart', 'request', 'menu'].includes(x.orderMode) ? x.orderMode : '', chatOff: !!x.chatOff, pinRank: x.pinRank == null ? null : Number(x.pinRank), bookMode: x.bookMode === 'clinic' ? 'clinic' : undefined, menuCount: Number(x.menuCount) || 0, lat: x.lat != null ? Number(x.lat) : undefined, lng: x.lng != null ? Number(x.lng) : undefined, createdAt: Number(x.createdAt) || Date.now(),
});
const toProduct = (x: any): Product => ({
  id: String(x.id), providerId: String(x.providerId), kind: x.kind === 'doctor' ? 'doctor' : 'item', name: x.name,
  price: Number(x.price) || 0, emoji: x.emoji || (x.kind === 'doctor' ? '👨‍⚕️' : '📦'), category: x.category || 'عام',
  desc: x.desc || '', available: !!x.available, slots: Array.isArray(x.slots) ? x.slots : undefined, imageV: Number(x.imageV) || 0,
  oldPrice: x.oldPrice ? Number(x.oldPrice) : undefined, offer: x.offer && x.offer.percent ? x.offer : undefined,
});

/** Removes the built-in demo data (sample shops, users, orders). Only central (numeric-id) records survive. */
function stripDemo(db: DB): DB {
  return {
    ...db,
    regions: db.regions || [],
    ads: db.ads || [],
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

/* ---------- new-order alerts (shops and couriers) ---------- */
const OPENED_KEY = 'abis_opened_orders_v1';
const SEEN_KEY = 'abis_seen_orders_v1';
let seenOrders = new Set<string>();
let openedOrders = new Set<string>(); // orders a shop has opened (the alarm stops for them)
let noticeHandler: (msg: string) => void = () => {};
/** The UI registers a banner/toast here so an alert is also visible, not only audible. */
export function setStoreNoticeHandler(fn: (msg: string) => void) { noticeHandler = fn; }
async function loadSeen() {
  try {
    const raw = await storage.getItem(SEEN_KEY);
    seenOrders = new Set<string>(raw ? JSON.parse(raw) : []);
    const op = await storage.getItem(OPENED_KEY);
    openedOrders = new Set<string>(op ? JSON.parse(op) : []);
  } catch {}
}
const saveOpened = () => { storage.setItem(OPENED_KEY, JSON.stringify([...openedOrders].slice(-500))).catch(() => {}); };
const saveSeen = () => { storage.setItem(SEEN_KEY, JSON.stringify([...seenOrders].slice(-500))).catch(() => {}); };

/** Orders a shop has been told about but has not opened yet. The alarm rings while this list is not empty. */
export function unopenedOrders(db: DB, me?: User | null): Order[] {
  if (!me || me.role !== 'provider') return [];
  return db.orders.filter((o) => o.providerOwnerId === me.id && ['pending', 'accepted'].includes(o.status) && !openedOrders.has(o.id) && Date.now() - o.createdAt < 3 * 3600 * 1000);
}
export function updateAlarm() {
  const me = state.db.users.find((u) => u.id === state.userId);
  setAlarm(unopenedOrders(state.db, me).length > 0);
}
/** Called when a shop opens an order: that order no longer rings. */
export function markOrderOpened(id: string) {
  if (openedOrders.has(id)) return;
  openedOrders.add(id);
  saveOpened();
  setState({});
  updateAlarm();
}

function checkNewOrderAlerts(orders: Order[], appts: Appointment[]) {
  const me = state.db.users.find((u) => u.id === state.userId);
  if (!me) return;
  let fresh: { key: string; line: string }[] = [];
  const recent = (t: number) => Date.now() - t < 30 * 60 * 1000; // never replay old orders as "new"
  if (me.role === 'provider') {
    fresh = [
      ...orders.filter((o) => ['pending', 'accepted'].includes(o.status) && o.providerOwnerId === me.id && !seenOrders.has(o.id) && recent(o.createdAt))
        .map((o) => ({ key: o.id, line: o.request ? `${o.customerName} — طلب مكتوب يحتاج تسعير` : `${o.customerName} — ${o.total} ج.م` })),
      ...appts.filter((a) => a.status === 'pending' && a.clinicOwnerId === me.id && !seenOrders.has(`a${a.id}`) && recent(a.createdAt))
        .map((a) => ({ key: `a${a.id}`, line: `حجز جديد من ${a.patientName}` })),
    ];
  } else if (me.role === 'customer') {
    // the shop priced (or could not supply) a written request
    fresh = orders.filter((o) => ['quoted', 'unavailable'].includes(o.status) && o.customerId === me.id && !seenOrders.has(`${o.status[0]}${o.id}`) && recent(o.updatedAt))
      .map((o) => ({ key: `${o.status[0]}${o.id}`, line: o.status === 'quoted' ? `${o.providerName}: ${o.total} ج.م — راجع الفاتورة ووافق` : `${o.providerName}: الأصناف غير متوفرة` }));
  } else if (me.role === 'courier' && me.available) {
    // open offers, or an order the system just assigned to this courier automatically
    fresh = orders.filter((o) => (!o.courierId || o.courierId === me.id) && ['pending', 'accepted', 'ready'].includes(o.status) && !seenOrders.has(o.id) && recent(o.createdAt))
      .map((o) => ({ key: o.id, line: `${o.regionName ? `منطقة ${o.regionName}` : o.address} — ${o.providerName}` }));
  }
  if (!fresh.length) return;
  fresh.forEach((f) => seenOrders.add(f.key));
  saveSeen();
  const title = me.role === 'provider'
    ? (fresh.length > 1 ? `${fresh.length} طلبات جديدة` : 'طلب جديد')
    : me.role === 'customer'
      ? 'رد المتجر على طلبك'
      : (fresh.length > 1 ? `${fresh.length} طلبات توصيل جديدة` : 'طلب توصيل جديد');
  alertNewOrder(title, fresh[0].line);
  noticeHandler(`🔔 ${title}: ${fresh[0].line}`);
}

let pushLinkedFor: string | null = null;
let loginEpoch = 0;
/** One /api/sync answer: the app settings, my account, orders, invoices, bookings and chat. */
function applySync(x: SyncPayload) {
  applySettings(x.settings);
  if (x.user) mirrorUser(x.user);
  if (pendingWrites > 0) return;
  const same = JSON.stringify([x.orders, x.invoices, x.appointments, x.messages, x.bookedSlots, x.couriersOnline ?? 0])
    === JSON.stringify([state.db.orders, state.db.invoices, state.db.appointments, state.db.messages, state.db.bookedSlots || [], state.db.couriersOnline ?? 0]);
  if (!same) {
    mutate((db) => {
      db.orders = x.orders as Order[];
      db.invoices = x.invoices as Invoice[];
      db.appointments = x.appointments as Appointment[];
      db.messages = x.messages as Message[];
      db.bookedSlots = x.bookedSlots;
      db.couriersOnline = x.couriersOnline ?? 0;
    });
  }
  checkNewOrderAlerts(x.orders as Order[], x.appointments as Appointment[]);
  updateAlarm();
  if (x.user && pushLinkedFor !== x.user.id) {
    pushLinkedFor = x.user.id;
    syncPushSubscription().catch(() => {});
  }
}
// Fingerprint of the last full answer: while it is unchanged the server replies with a few bytes and we skip all the work.
let lastSyncTag: { uid: string; tag: string } | null = null;
async function syncOrders() {
  if (pendingWrites > 0 || !state.userId) return;
  const x = await apiSync();
  lastSyncTag = x.tag && state.userId ? { uid: state.userId, tag: x.tag } : null;
  applySync(x);
}

async function syncCatalog() {
  if (pendingWrites > 0) return;
  const { providers, products, regions, ads, routePrices, services } = await apiCatalog<any>();
  if (Array.isArray(services) && services.length) applyServices(services);
  if (pendingWrites > 0) return;
  const P = providers.map(toProvider);
  const I = products.map(toProduct);
  const R: Region[] = regions.map((r) => toRegion(r));
  const A: Ad[] = (ads || []).map(toAd);
  const same = JSON.stringify(P) === JSON.stringify(state.db.providers) && JSON.stringify(I) === JSON.stringify(state.db.products)
    && JSON.stringify(R) === JSON.stringify(state.db.regions) && JSON.stringify(A) === JSON.stringify(state.db.ads || []) && JSON.stringify(routePrices || {}) === JSON.stringify(state.db.routePrices || {}) && JSON.stringify(services || []) === JSON.stringify(state.db.services || []);
  if (same) return;
  mutate((db) => {
    const clean = stripDemo(db);
    db.users = clean.users; db.orders = clean.orders; db.appointments = clean.appointments;
    db.invoices = clean.invoices; db.messages = clean.messages;
    db.providers = P;
    db.products = I;
    db.regions = R;
    db.ads = A;
    db.routePrices = routePrices || {};
    db.services = Array.isArray(services) ? services : db.services;
  });
  const ids = new Set(I.map((p) => p.id));
  if (state.cart.some((l) => !ids.has(l.productId))) saveCart(state.cart.filter((l) => ids.has(l.productId)));
}

let syncing = false;
let syncTick = 0;
let adminTick = 0;
let syncFails = 0;
/** One request per cycle: settings + my account + orders. The catalog follows on its own, slower, schedule. */
export async function syncRemote(withCatalog = true) {
  if (syncing) return;
  syncing = true;
  try {
    if (state.userId && (await hasApiToken())) {
      try {
        if (pendingWrites === 0) {
          const known = lastSyncTag && lastSyncTag.uid === state.userId ? lastSyncTag.tag : null;
          const x = await apiSync(known);
          syncFails = 0;
          if (x.unchanged) {
            if (state.syncError) setState({ syncError: null });
            if (state.userId) lastSyncTag = { uid: state.userId, tag: x.tag || known || '' };
          } else {
          lastSyncTag = x.tag && state.userId ? { uid: state.userId, tag: x.tag } : null;
          applySync(x);
          const warn = x.warnings && x.warnings.length ? `بعض البيانات لم تُحمَّل (${x.warnings.join('، ')})` : null;
          if (state.syncError !== warn) setState({ syncError: warn });
          }
          const me = state.db.users.find((u) => u.id === state.userId);
          if (me?.role === 'admin' && adminTick++ % 5 === 0) await syncAdminQueues();
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401) && ++syncFails >= 2) {
          const why = e instanceof ApiError ? (e.status ? `${e.status} — ${e.message}` : e.message) : `خطأ في التطبيق: ${String((e as any)?.message || e)}`;
          if (state.syncError !== why) setState({ syncError: why });
        }
        // Token expired / account deleted → sign out. Network failures keep the cached session.
        if (e instanceof ApiError && e.status === 401) {
          await clearApiToken();
          setState({ userId: null });
          secure.del(SESSION_KEY);
        }
      }
    } else {
      try {
        const { settings } = await apiGetSettings();
        applySettings(settings);
      } catch {}
    }
    if (withCatalog) {
      try { await syncCatalog(); } catch {}
    }
  } finally {
    syncing = false;
  }
}

export async function initStore() {
  let meCheck: Promise<unknown> = Promise.resolve();
  let firstRun = false; // nothing saved yet: wait a little longer so the first screen is not empty
  await loadSeen();
  try {
    const raw = await storage.getItem(DB_KEY);
    let db: DB = raw ? JSON.parse(raw) : buildSeed();
    // Owner/admin accounts only exist on the server now; drop any locally-stored admin from older builds.
    db = stripDemo(db);
    if (!raw) { firstRun = true; await storage.setItem(DB_KEY, JSON.stringify(db)); }
    const sid = await secure.get(SESSION_KEY);
    const cartRaw = await storage.getItem(CART_KEY);
    const hasToken = await hasApiToken();
    const cached = sid && hasToken ? db.users.find((u) => u.id === sid) : undefined;
    setState({ db, userId: cached ? cached.id : null, cart: cartRaw ? JSON.parse(cartRaw) : [] });
    if (hasToken) {
      // asked at the same time as the first sync below (before, one waited for the other)
      meCheck = (async () => {
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
      })();
    }
  } catch {}
  // Fetch maintenance state before the first screen, but never hang the splash if the server is slow: the screen opens from the saved copy after 1.5 s and the news arrives behind it.
  const first = closedByHoursNow(state.db.users.find((u) => u.id === state.userId)?.role) ? meCheck : Promise.all([meCheck, syncRemote()]);
  await Promise.race([first.catch(() => {}), new Promise((r) => setTimeout(r, firstRun ? 4000 : 1500))]);
  setState({ ready: true });

  // Live sync. Shops and couriers must hear about new orders right away (every ~4s); customers can wait (~8s),
  // and a customer in a background tab hardly polls at all. The catalog changes slowly (every ~32s).
  setInterval(() => {
    syncTick++;
    if (closedByHoursNow(state.db.users.find((u) => u.id === state.userId)?.role)) return; // closed by the opening hours: stay silent until opening time
    // After repeated failures back off (4s, 8s, 16s, 32s) instead of hammering a struggling server.
    if (syncFails >= 3 && syncTick % Math.min(8, 2 ** (syncFails - 2)) !== 0) return;
    const me = state.db.users.find((u) => u.id === state.userId);
    const fast = !!me && (me.role === 'provider' || me.role === 'courier' || me.role === 'supervisor');
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!fast && (syncTick % 2 !== 0 || (hidden && syncTick % 8 !== 0))) return;
    // A little random delay so thousands of phones do not all ask at the same instant.
    const withCatalog = syncTick % 8 === 0;
    setTimeout(() => syncRemote(withCatalog), Math.floor(Math.random() * 1500));
  }, 4000);
  AppState.addEventListener('change', (st) => { if (st === 'active') syncRemote(); });
}

/* ---------- session (server-authoritative) ---------- */
export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export async function login(phone: string, pass: string): Promise<Result<{ user: User }>> {
  const ph = normPhone(phone);
  try {
    loginEpoch++;
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
  setAlarm(false);
  pushLinkedFor = null;
  const epoch = ++loginEpoch;
  Promise.race([forgetPushSubscription(), new Promise((r) => setTimeout(r, 3000))]).finally(() => {
    if (epoch === loginEpoch) clearApiToken();
  });
  setState({ userId: null });
  secure.del(SESSION_KEY);
}

export interface RegisterInput {
  name: string;
  phone: string;
  phone2?: string;
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
  const phone2 = normPhone(inp.phone2 || '');
  if (phone2 && !/^01[0-9]{9}$/.test(phone2)) return { ok: false, error: 'رقم الهاتف الآخر غير صحيح' };
  if (phone2 && phone2 === phone) return { ok: false, error: 'الرقم الآخر يجب أن يختلف عن رقمك الأساسي' };
  if (inp.pass.length < 8) return { ok: false, error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' };
  if (inp.role === 'customer' && !inp.regionId) return { ok: false, error: 'اختر منطقتك' };
  if (inp.role === 'provider' && (!inp.provider || inp.provider.name.trim().length < 2))
    return { ok: false, error: 'اكتب اسم النشاط التجاري' };
  try {
    loginEpoch++;
    const { user: su } = await apiRegister({
      name: inp.name.trim(), phone, phone2: phone2 || undefined, password: inp.pass, address: inp.address.trim(), role: inp.role, regionId: inp.regionId, vehicle: inp.vehicle,
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

export async function updateProfile(patch: { name?: string; address?: string; regionId?: string | null; phone2?: string | null }): Promise<Result> {
  if (state.userId === GUEST_ID) {
    // a guest keeps his address on this phone only
    if (typeof patch.address === 'string') storage.setItem(GUEST_ADDR_KEY, patch.address).catch(() => {});
    setState({ db: { ...state.db, users: state.db.users.map((u) => (u.id === GUEST_ID ? { ...u, ...(typeof patch.address === 'string' ? { address: patch.address } : {}), ...(patch.regionId !== undefined ? { regionId: patch.regionId } : {}) } : u)) } });
    return { ok: true };
  }
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
  storage.setItem(CART_KEY, JSON.stringify(cart)).catch(() => {});
};
export function cartAdd(productId: string, delta: number) {
  if (state.userId === GUEST_ID && delta > 0) { requireLogin({ productId, delta }); return; }
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

/** Is this customer a subscriber right now (the owner's master switch is on and the subscription has not ended)? */
export const isMember = (db: DB, me?: User | null) => !!(db.settings.premium?.on && me && (me.premiumUntil || 0) > Date.now());
/**
 * What a subscriber's cart looks like: the same rules the server applies (it alone decides the real price): free delivery for a shop whose products reach the amount,
 * a percent off a shop that has no offer when no discount code is used, and no free delivery for a shared "شير اللقمة" delivery.
 */
export function premiumEstimate(db: DB, me: User | null | undefined, det: ReturnType<typeof cartDetails>, couponOff: number, pooled: boolean) {
  const pm = db.settings.premium;
  if (!pm || !isMember(db, me)) return { member: false, discount: 0, delivery: det.delivery, freeCount: 0 };
  let discount = 0, delivery = 0, freeCount = 0;
  det.groups.forEach((g) => {
    let fee = g.provider.deliveryFee;
    const hasOffer = g.items.some((it) => !!db.products.find((p) => p.id === it.productId)?.offer);
    if (pm.discountPct > 0 && !hasOffer && !(couponOff > 0)) discount += Math.min(g.subtotal, Math.round(g.subtotal * pm.discountPct) / 100);
    if (pm.freeAbove != null && fee > 0 && !pooled && g.subtotal >= pm.freeAbove) { fee = 0; freeCount++; }
    delivery += fee;
  });
  return { member: true, discount: Math.round(discount * 100) / 100, delivery, freeCount };
}

export async function placeOrder(me: User, info: { name: string; phone: string; address: string; notes: string; coupon?: string; scheduledFor?: number; pool?: boolean }): Promise<Result<{ invoiceId: string; orderIds: string[] }>> {
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
  const det = cartDetails(state.db, state.cart);
  if (!det.groups.length) return { ok: false, error: 'السلة فارغة' };
  { const pe = pinError(); if (pe) return { ok: false, error: pe }; }
  if (info.address.trim().length < 6) return { ok: false, error: 'اكتب العنوان بالتفصيل' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  const closed = det.groups.find((g) => !g.provider.open || g.provider.status !== 'active');
  if (closed) return { ok: false, error: `${closed.provider.name} مغلق حالياً` };
  const noRoute = det.groups.find((g) => !deliveryOpen(g.provider));
  if (noRoute) return { ok: false, error: `التوصيل من منطقة ${noRoute.provider.name} إلى منطقتك غير متاح حالياً` };
  pendingWrites++;
  try {
    const r = await apiCheckout({
      name: info.name.trim(), phone: normPhone(info.phone), address: info.address.trim(), notes: info.notes.trim(),
      lines: state.cart.map((l) => ({ productId: l.productId, qty: l.qty })), ...(info.coupon ? { coupon: info.coupon } : {}), ...(info.scheduledFor ? { scheduledFor: info.scheduledFor } : {}), ...(info.pool ? { pool: true } : {}), ...destBody(),
    });
    mutate((db) => {
      db.orders = upsertById(db.orders, r.orders as Order[]);
      db.invoices = upsertById(db.invoices, [r.invoice as Invoice]);
      db.users = db.users.map((u) => (u.id === me.id ? { ...u, address: r.address } : u));
    });
    saveCart([]);
    setCartDest({});
    return { ok: true, invoiceId: String(r.invoice.id), orderIds: (r.orders as Order[]).map((x) => String(x.id)) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

/** «اطلب إيه نجيبهولك»: the courier who took the errand writes the price of the goods and his delivery fee; the customer then approves. */
export async function courierQuote(orderId: string, subtotal: number, fee: number): Promise<Result> {
  if (!(subtotal > 0)) return { ok: false, error: 'اكتب سعر المشتريات' };
  if (!(fee >= 0)) return { ok: false, error: 'اكتب رسوم التوصيل' };
  pendingWrites++;
  try {
    const r = await apiErrandQuote(orderId, subtotal, fee);
    mutate((db) => { db.orders = upsertById(db.orders, [r.order as Order]); });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}
export async function placeCustomOrder(me: User, info: { text: string; phone: string; address: string; voice?: { audio: string; seconds: number } | null }): Promise<Result<{ orderId: string }>> {
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
  if (info.text.trim().length < 3 && !info.voice) return { ok: false, error: 'اكتب ما تريد طلبه' };
  { const pe = pinError(); if (pe) return { ok: false, error: pe }; }
  if (info.address.trim().length < 6) return { ok: false, error: 'اكتب العنوان بالتفصيل' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  pendingWrites++;
  try {
    const r = await apiCustomOrder({ text: info.text.trim(), ...(info.voice ? { voice: info.voice } : {}), phone: normPhone(info.phone), address: info.address.trim(), ...destBody() });
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

/* ---------- supervisors (owner-created staff who run the orders of their areas) ---------- */
export async function createSupervisor(i: { name: string; phone: string; password: string; regionIds: string[] }): Promise<Result> {
  try {
    const r = await apiJson<{ user: ServerUser }>('/api/admin/supervisors', 'POST', i);
    mutate((db) => { db.users = [...db.users.filter((u) => u.id !== r.user.id), fromServer(r.user)]; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function updateSupervisor(id: string, patch: { name?: string; regionIds?: string[] }): Promise<Result> {
  try {
    const r = await apiJson<{ user: ServerUser }>(`/api/admin/supervisors/${encodeURIComponent(id)}`, 'PATCH', patch);
    mutate((db) => { db.users = db.users.map((u) => (u.id === id ? fromServer(r.user, u) : u)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function deleteSupervisor(id: string): Promise<Result> {
  try {
    await apiJson(`/api/admin/supervisors/${encodeURIComponent(id)}`, 'DELETE');
    mutate((db) => { db.users = db.users.filter((u) => u.id !== id); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export type StaffCourier = { id: string; name: string; phone: string; vehicle: string; available: boolean; regionId: string; busy: number };
export async function listStaffCouriers(): Promise<StaffCourier[]> {
  try { return (await apiJson<{ couriers: StaffCourier[] }>('/api/staff/couriers')).couriers; } catch { return []; }
}
/** Owner / supervisor: link an order to a chosen courier (the order must be accepted and not yet picked up). */
export async function assignCourier(orderId: string, courierId: string, breakdown = false): Promise<Result> {
  try {
    const r = await apiJson<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}/assign`, 'POST', breakdown ? { courierId, breakdown: true } : { courierId });
    mutate((db) => { db.orders = upsertById(db.orders, [r.order]); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Courier: he opened the order the system gave him (otherwise it moves on to the next courier after 2 minutes). */
export async function ackOrder(orderId: string): Promise<void> {
  try {
    const r = await apiJson<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}/ack`, 'POST', {});
    mutate((db) => { db.orders = upsertById(db.orders, [r.order]); });
  } catch { /* the next sync tells the truth */ }
}
/** Owner / supervisor: send a written request nobody has priced yet to another shop / pharmacy / maker. */
export async function transferOrder(orderId: string, providerId: string): Promise<Result> {
  try {
    const r = await apiJson<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}/transfer`, 'POST', { providerId });
    mutate((db) => { db.orders = upsertById(db.orders, [r.order]); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner / supervisor on an order the shop refused: end it for good (the customer is told the reason), or mark it "handled" so it leaves the needs-attention list. */
export async function staffOrderAction(orderId: string, action: 'cancel' | 'dismiss', reason?: string, gift?: { kind: 'amount' | 'percent'; value: number; days: number }): Promise<Result> {
  try {
    const r = await apiOrderAction(orderId, action, reason, gift ? { gift } : undefined);
    mutate((db) => { db.orders = upsertById(db.orders, [r.order]); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

export type OrderAction = 'accept' | 'reject' | 'ready' | 'cancel' | 'courier_accept' | 'pickup' | 'go' | 'arrive' | 'deliver' | 'approve_quote' | 'decline_quote';

export function orderAction(orderId: string, action: OrderAction, by: User, reason?: string, extra?: { ready?: boolean; readyDate?: string; readyTime?: string }): Result {
  const o = state.db.orders.find((x) => x.id === orderId);
  if (!o) return { ok: false, error: 'الطلب غير موجود' };
  if (action === 'cancel' && ['picked_up', 'on_the_way', 'arrived', 'delivered'].includes(o.status)) return { ok: false, error: 'لا يمكن إلغاء الطلب الآن' };
  if (action === 'pickup' && o.providerType === 'custom' && o.errandQuote !== 'approved') return { ok: false, error: 'سعّر الطلب وانتظر موافقة العميل على الفاتورة أولاً' };
  if (action === 'courier_accept') {
    if (o.status === 'pending') return { ok: false, error: 'بانتظار قبول المتجر للطلب أولاً' };
    if (!by.available) return { ok: false, error: 'فعّل حالتك إلى "متاح" أولاً لقبول الطلبات' };
    if (o.courierId && o.courierId !== by.id) return { ok: false, error: 'تم قبول الطلب بواسطة مندوب آخر' };
  }
  // optimistic: show the result at once; the server then confirms (or corrects) it
  mutate((db) => {
    switch (action) {
      case 'approve_quote':
        if (o.providerType === 'custom') {
          setStatus(db, orderId, 'accepted', { errandQuote: 'approved' });
          sysMsg(db, orderId, 'وافق العميل على فاتورة المندوب، ويمكنه شراء الطلب الآن 🛒');
          break;
        }
        setStatus(db, orderId, 'accepted');
        sysMsg(db, orderId, 'وافق العميل على الفاتورة وجاري تجهيز الطلب 👨‍🍳');
        break;
      case 'decline_quote':
        if (o.providerType === 'custom') {
          // the customer refused this courier's price: back to all couriers, with no price and no courier
          setStatus(db, orderId, 'accepted', { errandQuote: 'open', subtotal: 0, deliveryFee: 0, total: 0, courierId: undefined, courierName: undefined, courierPhone: undefined, courierVehicle: undefined });
          sysMsg(db, orderId, 'رفض العميل سعر المندوب، وتم إرجاع الطلب للمناديب ليسعّره مندوب آخر 🔁');
          break;
        }
        setStatus(db, orderId, 'cancelled', { rejectReason: 'رفض العميل الفاتورة' });
        break;
      case 'accept':
        setStatus(db, orderId, extra?.ready ? 'ready' : 'accepted', extra?.readyDate ? { readyDate: extra.readyDate, readyTime: extra.readyTime } : {});
        sysMsg(db, orderId, extra?.ready ? 'الصانع قبل طلبك وهو جاهز للتسليم الآن 🧵' : extra?.readyDate ? `الصانع قبل طلبك، ويكون جاهزاً للتسليم ${extra.readyDate} الساعة ${extra.readyTime} 🧵` : 'تم قبول طلبك وجاري التحضير 👨‍🍳');
        break;
      case 'reject':
        setStatus(db, orderId, 'rejected', { rejectReason: reason || 'غير متاح حالياً' });
        break;
      case 'ready':
        setStatus(db, orderId, 'ready');
        sysMsg(db, orderId, 'الطلب جاهز للاستلام من المندوب ✅');
        break;
      case 'cancel':
        setStatus(db, orderId, 'cancelled', { rejectReason: by.role === 'admin' ? 'ألغاه المدير' : by.role === 'supervisor' ? 'ألغاه المشرف' : by.role === 'provider' ? 'ألغاه المتجر' : 'ألغاه العميل' });
        break;
      case 'courier_accept':
        db.orders = db.orders.map((x) => (x.id === orderId ? { ...x, courierId: by.id, courierName: by.name, courierPhone: by.phone, courierVehicle: by.vehicle, updatedAt: Date.now() } : x));
        sysMsg(db, orderId, o.providerType === 'custom' ? `المندوب ${by.name} قبل طلبك، وسيرسل لك فاتورة بسعر المشتريات ورسوم التوصيل لتوافق عليها 🧾` : `المندوب ${by.name} قبل طلبك وسيتولى التوصيل 🛵`);
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
  if (isServerId(orderId)) backgroundWrite(async () => { await apiOrderAction(orderId, action, reason, extra); });
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
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
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

/* ---------- clinics that set the time themselves ---------- */
export async function requestClinicSlot(me: User, info: { doctor: Product; patientName: string; phone: string; notes: string }): Promise<Result<{ id: string }>> {
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
  if (info.patientName.trim().length < 3) return { ok: false, error: 'اكتب اسم المريض' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  pendingWrites++;
  try {
    const { appointment } = await apiApptRequest({ doctorId: info.doctor.id, patientName: info.patientName.trim(), phone: normPhone(info.phone), notes: info.notes.trim() });
    mutate((db) => { db.appointments = upsertById(db.appointments, [appointment as Appointment]); });
    return { ok: true, id: String(appointment.id) };
  } catch (e) { return { ok: false, error: errMsg(e) }; } finally { pendingWrites--; }
}
async function clinicStep(f: () => Promise<{ appointment: any }>): Promise<Result> {
  pendingWrites++;
  try {
    const { appointment } = await f();
    mutate((db) => { db.appointments = upsertById(db.appointments, [appointment as Appointment]); });
    syncOrders().catch(() => {});
    return { ok: true };
  } catch (e) { syncOrders().catch(() => {}); return { ok: false, error: errMsg(e) }; } finally { pendingWrites--; }
}
export const proposeApptTime = (id: string, date: string, time: string) => clinicStep(() => apiApptPropose(id, date, time));
export const acceptApptTime = (id: string) => clinicStep(() => apiApptAccept(id));
export async function setClinicBookMode(providerId: string, mode: 'customer' | 'clinic'): Promise<Result> {
  try { await apiBookMode(providerId, mode); } catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => { db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, bookMode: mode === 'clinic' ? 'clinic' : undefined } : x)); });
  return { ok: true };
}

/* ---------- medical labs ---------- */
export async function labRequest(
  me: User,
  info: { provider: Provider; reason: string; rx?: string | null; patientName: string; phone: string }
): Promise<Result<{ id: string }>> {
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
  if (!info.provider.open || info.provider.status !== 'active') return { ok: false, error: 'المعمل لا يستقبل طلبات حالياً' };
  if (info.reason.trim().length < 3 && !info.rx) return { ok: false, error: 'اكتب سبب الكشف أو ارفع الروشتة' };
  if (info.patientName.trim().length < 3) return { ok: false, error: 'اكتب اسم المريض' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  pendingWrites++;
  try {
    const { appointment } = await apiLabRequest({ providerId: info.provider.id, reason: info.reason.trim(), rx: info.rx || null, patientName: info.patientName.trim(), phone: normPhone(info.phone) });
    if (info.rx) labFileCache.set(`${appointment.id}:rx`, { data: info.rx, mime: 'image', name: 'روشتة' });
    mutate((db) => { db.appointments = upsertById(db.appointments, [appointment as Appointment]); });
    return { ok: true, id: String(appointment.id) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}
/** quote / reject / confirm / cancel / visit / report: the server decides, then the screen shows what it answered */
export async function labAction(id: string, body: { action: 'quote' | 'reject' | 'confirm' | 'cancel' | 'visit' | 'report'; date?: string; time?: string; fee?: number; note?: string; file?: string; name?: string }): Promise<Result> {
  pendingWrites++;
  try {
    const { appointment } = await apiLabAction(id, body);
    if (body.file) labFileCache.set(`${id}:report`, { data: body.file, mime: body.file.startsWith('data:application/pdf') ? 'pdf' : 'image', name: body.name || '' });
    mutate((db) => { db.appointments = upsertById(db.appointments, [appointment as Appointment]); });
    if (body.action === 'confirm') syncOrders().catch(() => {}); // brings the booking invoice
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}
export type LabFile = { data: string; mime: string; name: string };
const labFileCache = new Map<string, LabFile>();
export async function fetchLabFile(id: string, kind: 'rx' | 'report'): Promise<LabFile | null> {
  const key = `${id}:${kind}`;
  const hit = labFileCache.get(key);
  if (hit) return hit;
  try {
    const { file } = await apiLabFile(id, kind);
    if (file) labFileCache.set(key, file);
    return file;
  } catch { return null; }
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
let writeChain: Promise<void> = Promise.resolve();
/** Saves run strictly one after another, so "received" always reaches the server before "on the way". */
function backgroundWrite(job: () => Promise<void>): Promise<void> {
  pendingWrites++;
  writeChain = writeChain.then(async () => {
    try {
      await job();
    } catch (e) {
      storeErrorHandler(errMsg(e));
    } finally {
      pendingWrites--;
      if (pendingWrites === 0) {
        syncCatalog().catch(() => {});
        syncOrders().catch(() => {});
      }
    }
  });
  return writeChain;
}

/** `image`: undefined = leave the picture alone, a data URL = new picture, null = remove it. */
export function saveProduct(p: Omit<Product, 'id'> & { id?: string }, image?: string | null) {
  const existing = p.id && isServerId(p.id) ? state.db.products.find((x) => x.id === p.id) : undefined;
  const tempId = existing ? p.id! : uid(state.db, p.kind === 'doctor' ? 'd' : 'i');
  mutate((db) => {
    const next = { ...(existing || {}), ...p, id: tempId } as Product;
    db.products = db.products.some((x) => x.id === tempId) ? db.products.map((x) => (x.id === tempId ? next : x)) : [...db.products, next];
  });
  if (!isServerId(p.providerId)) return;
  const setImage = async (id: string) => {
    if (image === undefined || (image === null && !(existing && existing.imageV))) return;
    const { imageV } = await apiSetProductImage(id, image);
    mutate((db) => { db.products = db.products.map((x) => (x.id === id ? { ...x, imageV } : x)); });
  };
  backgroundWrite(async () => {
    if (existing) {
      await apiUpdateProduct(tempId, { name: p.name, price: p.price, available: p.available, data: productData(p) });
      await setImage(tempId);
    } else {
      const { product } = await apiCreateProduct({ providerId: p.providerId, name: p.name, price: p.price, data: productData(p) });
      mutate((db) => {
        db.products = db.products.map((x) => (x.id === tempId ? toProduct(product) : x));
      });
      await setImage(String(product.id));
    }
  });
}
/** Uploads (or removes, with null) a provider's logo right away. */
export async function setProviderLogo(providerId: string, image: string | null): Promise<Result> {
  if (!isServerId(providerId)) return { ok: false, error: 'احفظ الخدمة أولاً' };
  try {
    const { logoV } = await apiSetProviderLogo(providerId, image);
    mutate((db) => { db.providers = db.providers.map((p) => (p.id === providerId ? { ...p, logoV } : p)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Owner: put a place in / take it out of the customers' "الأعلى تقييماً" row. */
export async function setProviderFeatured(providerId: string, featured: boolean): Promise<Result> {
  try {
    await apiJson(`/api/admin/providers/${encodeURIComponent(providerId)}/featured`, 'PATCH', { featured });
    mutate((db) => { db.providers = db.providers.map((p) => (p.id === providerId ? { ...p, featured } : p)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Owner: set the area a place is in. */
export async function setProviderRegion(providerId: string, regionId: string): Promise<Result> {
  try {
    await apiJson(`/api/admin/providers/${encodeURIComponent(providerId)}/region`, 'PATCH', { regionId });
    const name = state.db.regions.find((r) => r.id === regionId)?.name;
    mutate((db) => { db.providers = db.providers.map((p) => (p.id === providerId ? { ...p, regionId, regionName: name } : p)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
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
export async function adminMoveProvider(providerId: string, type: string): Promise<Result> {
  try { await apiMoveProvider(providerId, type); } catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => { db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, type: type as ProviderType } : x)); });
  return { ok: true };
}
export async function adminSetOrderMode(providerId: string, mode: '' | 'cart' | 'request' | 'menu'): Promise<Result> {
  try { await apiProviderMode(providerId, mode); } catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => { db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, orderMode: mode } : x)); });
  return { ok: true };
}
export async function adminPinProvider(providerId: string, rank: number | null): Promise<Result> {
  try { await apiPinProvider(providerId, rank); } catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => { db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, pinRank: rank } : x)); });
  return { ok: true };
}
export async function adminSetChatOff(providerId: string, off: boolean): Promise<Result> {
  try { await apiProviderChatOff(providerId, off); } catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => { db.providers = db.providers.map((x) => (x.id === providerId ? { ...x, chatOff: off } : x)); });
  return { ok: true };
}
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
/** Owner: label a customer account (trusted / watch / fraud, '' = none). Shops and couriers then see it on that customer's orders. */
export async function setCustomerFlag(userId: string, flag: string, note: string): Promise<Result> {
  try { await apiSetUserFlag(userId, flag, note); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
  mutate((db) => {
    db.users = db.users.map((u) => (u.id === userId ? { ...u, accountFlag: flag, flagNote: flag ? note : '' } : u));
    db.orders = db.orders.map((o) => (o.customerId === userId && !['delivered', 'cancelled', 'rejected', 'unavailable'].includes(o.status) ? { ...o, customerFlag: flag || undefined, customerFlagNote: flag ? note : undefined } : o));
  });
  return { ok: true };
}
/** Owner-only: switch maps + live location on or off, and whether a delivery pin is required. */
export async function setMapMode(b: { enabled: boolean; required: boolean }): Promise<Result> {
  try {
    await apiSetMapMode(b);
    const { settings } = await apiGetSettings();
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
/** Owner-only: delivery price by area (as before) or by kilometre. */
export async function setDeliveryMode(b: { mode: 'region' | 'km'; perKm: number; min: number; max: number; factor: number }): Promise<Result> {
  try {
    await apiSetDeliveryMode(b);
    const { settings } = await apiGetSettings();
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
/** The customer saved (or removed) his spot: the delivery price by distance follows at once. */
export function setMyHome(p: { lat: number; lng: number } | null) {
  mutate((db) => { const u = db.users.find((x) => x.id === state.userId); if (u) { u.homeLat = p ? p.lat : undefined; u.homeLng = p ? p.lng : undefined; } });
}

/** Owner-only: hide the customer's data from shops / couriers some minutes after delivery. */
export async function setPrivacy(b: { on?: boolean; minutes?: number }): Promise<Result> {
  try { const { settings } = await apiSetPrivacy(b); applySettings(settings); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner-only: how big the interface is on phones / computers (1 = the original size). */
export async function setUiSize(b: { phone?: number; desktop?: number }): Promise<Result> {
  try {
    const { settings } = await apiSetUiScale(b);
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Owner-only: the colour theme of the whole app. */
export async function setTheme(id: string): Promise<Result> {
  try {
    const { settings } = await apiSetTheme(id);
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
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
/** the owner announces a new app version (or withdraws the notice with clear) */
export async function publishUpdateNotice(body: { version?: string; message?: string; required?: boolean; clear?: boolean }): Promise<Result> {
  try {
    const { settings } = await apiUpdateNotice(body);
    applySettings(settings);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
/** the owner's opening hours; sent to the server in its own field names */
export async function updateHours(p: { hoursEnabled?: boolean; openTime?: string; closeTime?: string; openDays?: number[]; graceMin?: number; closedMessage?: string }): Promise<Result> {
  try {
    const { settings } = await apiUpdateSettings(p as any);
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
  storage.removeItem(CART_KEY).catch(() => {});
  storage.setItem(DB_KEY, JSON.stringify(db)).catch(() => {});
}

export async function refresh() {
  await syncRemote();
  try {
    const raw = await storage.getItem(DB_KEY);
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
        rating: 0, eta: isBooking(inp.type) ? '' : '30-45', deliveryFee: isBooking(inp.type) ? 0 : inp.deliveryFee,
        status: 'active', open: true, specialty: isBooking(inp.type) ? inp.specialty : undefined, createdAt: Date.now(),
      }];
    });
    return { ok: true, id: r.providerId };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
const TYPES_EMOJI: Record<ProviderType, string> = { restaurant: '🍽️', supermarket: '🛒', pharmacy: '💊', clinic: '🩺', store: '🏬', maker: '🧵' };

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
    try { await apiDeleteCourier(userId); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.users = db.users.filter((u) => u.id !== userId || u.role !== 'courier');
  });
  return { ok: true };
}

/** Owner: delete a customer. His orders, bookings, invoices and chats are deleted with him; his number can register again (pending). */
export async function adminDeleteCustomer(userId: string): Promise<Result> {
  if (isServerId(userId)) {
    try { await apiDeleteCustomer(userId); }
    catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  mutate((db) => {
    db.users = db.users.filter((u) => u.id !== userId || u.role !== 'customer');
    db.orders = db.orders.filter((o) => o.customerId !== userId);
    db.appointments = db.appointments.filter((a) => a.customerId !== userId);
    db.invoices = db.invoices.filter((i) => i.customerId !== userId);
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
function toRegion(r: any): Region {
  return { id: r.id, name: r.name, deliveryFee: Number(r.deliveryFee) || 0, active: r.active, ...(r.closed ? { closed: true, closedMessage: r.closedMessage || '', closedUntil: r.closedUntil || null } : {}), ...(r.closedRaw !== undefined ? { closedRaw: !!r.closedRaw, closedText: r.closedText || '', closedUntilRaw: r.closedUntilRaw || null } : {}) };
}

/** Owner: the delivery price from one shop area to each customer area (an empty price removes it: that route then uses the customer area's normal price). */
export async function saveRoutePrices(fromId: string, prices: { toId: string; price: number | null }[]): Promise<Result> {
  try {
    const r = await apiJson<{ routePrices: Record<string, number> }>('/api/admin/route-prices', 'PUT', { fromId, prices });
    mutate((db) => { db.routePrices = r.routePrices || {}; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function addRegion(name: string): Promise<Result> {
  try {
    const { region } = await apiAdminCreateRegion({ name: name.trim() });
    mutate((db) => { db.regions = [...db.regions, toRegion(region)]; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function updateRegion(id: string, patch: { name?: string; active?: boolean; closed?: boolean; closedMessage?: string; closedUntil?: number | null; notify?: boolean }): Promise<Result> {
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

/* ---------- free-text requests (supermarket / pharmacy) ---------- */
export async function placeRequestOrder(
  me: User,
  info: { provider: Provider; text: string; image?: string | null; voice?: { audio: string; seconds: number } | null; phone: string; address: string }
): Promise<Result<{ orderId: string }>> {
  { const g = guestStop(); if (g) return g as any; }
  { const g = appGate('customer'); if (g.blocked) return { ok: false, error: g.message || 'التطبيق متوقف حالياً' }; }
  if (!info.provider.open || info.provider.status !== 'active') return { ok: false, error: 'المتجر مغلق حالياً' };
  { const pe = pinError(); if (pe) return { ok: false, error: pe }; }
  if (!deliveryOpen(info.provider)) return { ok: false, error: 'التوصيل من منطقة هذا المتجر إلى منطقتك غير متاح حالياً' };
  if (info.text.trim().length < 3 && !info.image && !info.voice) return { ok: false, error: 'اكتب طلبك أو ارفع صورة أو سجّل رسالة صوتية' };
  if (info.address.trim().length < 6) return { ok: false, error: 'اكتب العنوان بالتفصيل' };
  if (!/^01[0-9]{9}$/.test(normPhone(info.phone))) return { ok: false, error: 'رقم الهاتف غير صحيح' };
  pendingWrites++;
  try {
    const { order } = await apiPlaceRequest({
      providerId: info.provider.id, text: info.text.trim(), image: info.image || null, ...(info.voice ? { voice: info.voice } : {}), phone: normPhone(info.phone), address: info.address.trim(), ...destBody(),
    });
    setCartDest({});
    if (info.image) imageCache.set(String(order.id), info.image);
    mutate((db) => {
      db.orders = upsertById(db.orders, [order as Order]);
      db.users = db.users.map((u) => (u.id === me.id ? { ...u, address: info.address.trim() } : u));
    });
    return { ok: true, orderId: String(order.id) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

/** The shop prices a written request (lines), or answers that the items are not available. */
export async function quoteOrder(
  orderId: string,
  input: { items?: { name: string; price: number; qty: number }[]; price?: number; unavailable?: boolean; note?: string; readyDate?: string; readyTime?: string }
): Promise<Result> {
  pendingWrites++;
  try {
    const r = await apiQuote(orderId, input);
    mutate((db) => {
      db.orders = upsertById(db.orders, [r.order as Order]);
      db.invoices = upsertById(db.invoices, [r.invoice as Invoice]);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    pendingWrites--;
  }
}

const imageCache = new Map<string, string>();
/** The photo of a request order (downloaded once, then kept). */
export async function orderImage(orderId: string): Promise<string | null> {
  const hit = imageCache.get(orderId);
  if (hit) return hit;
  try {
    const { image } = await apiOrderImage(orderId);
    if (image) imageCache.set(orderId, image);
    return image;
  } catch {
    return null;
  }
}

/** Owner: set (data URL) or remove (null) the picture of the first / login screen. */
export async function setLoginImage(image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ loginImageV: number }>('/api/admin/login-image', image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, loginImageV: r.loginImageV }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner: set (data URL) or remove (null) the logo shown on the first screen. */
export async function setWelcomeLogo(image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ welcomeLogoV: number }>('/api/admin/welcome-logo', image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, welcomeLogoV: r.welcomeLogoV }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/* ---------- services (owner): names, order, sizes, on/off, new services ---------- */
const takeServices = (list: ServiceDef[]) => { applyServices(list); mutate((db) => { db.services = list; }); };
export async function createService(inp: { label: string; single?: string; emoji: string; template: string; size: string; canProducts: boolean; showHome: boolean }): Promise<Result> {
  try { const r = await apiJson<{ services: ServiceDef[] }>('/api/admin/services', 'POST', inp); takeServices(r.services); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function updateService(key: string, patch: Partial<Pick<ServiceDef, 'label' | 'single' | 'emoji' | 'tagline' | 'size' | 'active' | 'showHome' | 'canProducts'>>): Promise<Result> {
  try { const r = await apiJson<{ services: ServiceDef[] }>(`/api/admin/services/${encodeURIComponent(key)}`, 'PATCH', patch); takeServices(r.services); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function reorderServices(keys: string[]): Promise<Result> {
  try { const r = await apiJson<{ services: ServiceDef[] }>('/api/admin/services-order', 'PUT', { keys }); takeServices(r.services); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function deleteService(key: string): Promise<Result> {
  try { const r = await apiJson<{ services: ServiceDef[] }>(`/api/admin/services/${encodeURIComponent(key)}`, 'DELETE'); takeServices(r.services); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner: the picture (logo) of one service icon on the home screen; null puts the original icon back. */
export async function setCatIcon(type: string, image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ type: string; v: number }>(`/api/admin/cat-icon/${encodeURIComponent(type)}`, image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, catIconV: { ...(db.settings.catIconV || {}), [type]: r.v } }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner: the one fixed cover picture behind the home header (same for everyone); null removes it. */
export async function setHomeCover(image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ v: number }>('/api/admin/home-cover', image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, homeCoverV: r.v }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Owner: save the whole arrangement of home blocks (order, names, shops, links). */
export async function saveHomeBlocks(blocks: HomeBlock[]): Promise<Result> {
  try {
    const r = await apiJson<{ blocks: HomeBlock[] }>('/api/admin/home-blocks', 'PUT', { blocks });
    mutate((db) => { db.settings = { ...db.settings, homeBlocks: r.blocks }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Owner: the picture of one banner block (the arrangement must be saved first); null removes it. */
export async function setBlockImage(id: string, image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ v: number }>(`/api/admin/home-blocks/${encodeURIComponent(id)}/image`, image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, homeBlocks: (db.settings.homeBlocks || []).map((b) => (b.id === id ? { ...b, imgV: r.v } : b)) }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
/** Owner: the cover picture of one provider's page; null removes it. */
export async function setProviderCover(providerId: string, image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ v: number }>(`/api/admin/provider-cover/${encodeURIComponent(providerId)}`, image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.providers = db.providers.map((p) => (p.id === providerId ? { ...p, coverV: r.v } : p)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Owner: set (data URL) or remove (null) the app icon used for the next Android build. */
export async function setAppIcon(image: string | null): Promise<Result> {
  try {
    const r = await apiJson<{ appIconV: number }>('/api/admin/app-icon', image ? 'PUT' : 'DELETE', image ? { image } : undefined);
    mutate((db) => { db.settings = { ...db.settings, appIconV: r.appIconV }; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/* ---------- announcements board (owner) ---------- */
export async function addAd(title: string, link: string, image: string): Promise<Result> {
  try {
    const { ad } = await apiAdminCreateAd({ title: title.trim(), link: link.trim(), image });
    mutate((db) => { db.ads = [...(db.ads || []), toAd(ad)]; });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function updateAd(id: string, patch: { title?: string; link?: string; active?: boolean; image?: string }): Promise<Result> {
  try {
    const { ad } = await apiAdminUpdateAd(id, patch);
    mutate((db) => { db.ads = (db.ads || []).map((a) => (a.id === id ? toAd(ad) : a)); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
export async function deleteAd(id: string): Promise<Result> {
  try {
    await apiAdminDeleteAd(id);
    mutate((db) => { db.ads = (db.ads || []).filter((a) => a.id !== id); });
    return { ok: true };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

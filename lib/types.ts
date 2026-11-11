import type { Hours } from './hours';
export type Role = 'customer' | 'provider' | 'courier' | 'admin' | 'supervisor';
/** the key of a service (restaurant, pharmacy... or one the owner added). */
export type ProviderType = string;
/** how a service works: basket / written request / appointments / products + requests. */
export type ServiceTemplate = 'cart' | 'request' | 'booking' | 'maker' | 'lab';
export interface ServiceDef {
  key: string; label: string; single: string; emoji: string; template: ServiceTemplate | 'errand'; order: number;
  size: 'small' | 'medium' | 'large'; tagline?: string; active: boolean; showHome: boolean; canProducts: boolean; builtin: boolean;
}
export type AccountStatus = 'active' | 'pending' | 'rejected' | 'suspended';

export interface User {
  id: string;
  name: string;
  phone: string;
  phone2?: string; // optional second number (no code confirmation)
  pass: string;
  role: Role;
  address: string;
  status: AccountStatus;
  createdAt: number;
  // courier
  vehicle?: string;
  available?: boolean;
  availableSince?: number;
  // delivery area: the customer's area, or the courier's current area
  regionId?: string | null;
  homeLat?: number; // the customer's saved spot
  homeLng?: number;
  // owner's label on a customer account (only the owner's app receives these)
  accountFlag?: string;
  flagNote?: string;
  // supervisor: the areas (region ids) whose orders he runs
  supRegions?: string[];
  // supervisor: the owner allowed him to work the support chat
  supportChat?: boolean;
}

export interface Ad {
  id: string;
  title: string;
  link: string;
  active: boolean;
  sortOrder: number;
  v: number; // changes when the picture changes (so the browser fetches the new one)
}

export interface Region {
  id: string;
  name: string;
  deliveryFee: number;
  active: boolean;
}

export interface Provider {
  id: string;
  ownerId: string;
  type: ProviderType;
  name: string;
  desc: string;
  address: string;
  phone: string;
  emoji: string;
  rating: number;
  ratingCount?: number; // how many customers rated this place
  eta: string;
  deliveryFee: number;
  status: AccountStatus;
  open: boolean;
  specialty?: string;
  logoV?: number; // 0 / missing = no logo; changes whenever the logo changes
  regionId?: string; // the area the place registered in (its owner's area)
  regionName?: string; // the customer's area
  providerRegionName?: string; // the shop's area (courier: from area X to area Y)
  featured?: boolean; // the owner put it in the customers' "الأعلى تقييماً" row
  orderMode?: '' | 'cart' | 'request' | 'menu'; // how this one place takes orders when the owner overrides its section (empty = by section)
  menuCount?: number;
  chatOff?: boolean;
  bookMode?: 'customer' | 'clinic'; // pages of its picture menu
  lat?: number; // the shop's spot on the map
  lng?: number;
  createdAt: number;
}

export interface Product {
  id: string;
  providerId: string;
  kind: 'item' | 'doctor';
  name: string;
  price: number;
  emoji: string;
  category: string;
  desc: string;
  available: boolean;
  slots?: string[];
  imageV?: number; // 0 / missing = no picture
  oldPrice?: number; // normal price while an offer lowers `price` (customers only)
  offer?: { id: string; title: string; percent: number; color: string; endsAt: number | null };
}

export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'ready'
  | 'picked_up'
  | 'on_the_way'
  | 'arrived'
  | 'delivered'
  | 'rejected'
  | 'cancelled'
  | 'quoted'
  | 'unavailable';

export interface OrderItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
  emoji: string;
}

export interface Order {
  staffHandled?: boolean; // a supervisor took the order over (the shop left it stuck)
  cancelledBy?: string; // who cancelled it: customer / provider / admin / supervisor
  staffDismissed?: boolean; // the owner marked this refused/stuck order as handled
  privacyMasked?: boolean; // the customer's data was hidden from this shop/courier after delivery
  autoPending?: boolean; // the owner's auto-assign gave it to this courier and he has not opened it yet (the app opens it for him)
  errandQuote?: 'open' | 'quoted' | 'approved'; // «اطلب إيه نجيبهولك»: waiting for the courier's price / waiting for the customer / agreed
  id: string;
  number: number;
  groupId: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  phone: string;
  phone2?: string;
  address: string;
  notes: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType | 'custom';
  providerOwnerId: string;
  items: OrderItem[];
  customText?: string;
  request?: { text: string; hasImage?: boolean }; // the photo is fetched separately (see orderImage)
  regionId?: string;
  regionName?: string;
  subtotal: number;
  discount?: number; // taken off by a discount code
  couponCode?: string;
  giftCode?: string; // a gift code the owner gave with a cancellation (customer/admin only)
  deliveryFee: number;
  total: number;
  status: OrderStatus;
  courierId?: string;
  courierName?: string;
  courierPhone?: string;
  courierVehicle?: string;
  rejectReason?: string;
  customerFlag?: string; // the owner's label on the customer (shops and couriers only): trusted / watch / fraud
  customerFlagNote?: string;
  readyDate?: string; // maker orders: the day (YYYY-MM-DD) and hour (HH:mm) the order will be ready
  readyTime?: string;
  createdAt: number;
  updatedAt: number;
  history: { status: OrderStatus; at: number }[];
}

export type ApptStatus = 'pending' | 'confirmed' | 'rejected' | 'completed' | 'cancelled';

/** a medical-lab case (stored as an appointment): request -> the lab sets day + price -> the customer confirms -> visit -> report */
export interface LabInfo { stage: 'new' | 'quoted' | 'confirmed' | 'visited' | 'done' | 'rejected' | 'cancelled'; reason: string; hasRx: boolean; hasReport: boolean; reportName: string; note: string }

export interface Appointment {
  lab?: LabInfo;
  clinicSet?: { stage: 'awaiting' | 'proposed' | 'accepted' };
  customerFlag?: string;
  customerFlagNote?: string;
  id: string;
  number: number;
  customerId: string;
  patientName: string;
  phone: string;
  providerId: string;
  clinicName: string;
  clinicOwnerId: string;
  clinicAddress: string;
  doctorId: string;
  doctorName: string;
  specialty: string;
  date: string; // yyyy-mm-dd
  time: string;
  fee: number;
  notes: string;
  status: ApptStatus;
  invoiceId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InvoicePart {
  orderId: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType | 'custom';
  items: OrderItem[];
  customText?: string;
  requestText?: string; // what the customer wrote when the shop priced a free-text request
  readyDate?: string;
  readyTime?: string;
  subtotal: number;
  discount?: number;
  couponCode?: string;
  deliveryFee: number;
}

export interface Invoice {
  id: string;
  number: string;
  kind: 'delivery' | 'booking';
  customerId: string;
  customerName: string;
  phone: string;
  address: string;
  createdAt: number;
  parts: InvoicePart[];
  total: number;
  unavailable?: boolean; // the shop could not supply the requested items
  note?: string;
  // booking
  appointmentId?: string;
  ownerId?: string;
  clinicName?: string;
  doctorName?: string;
  specialty?: string;
  date?: string;
  time?: string;
  fee?: number;
}

export interface Message {
  id: string;
  orderId: string;
  senderId: string;
  senderName: string;
  senderRole: Role | 'system';
  text: string;
  createdAt: number;
}

export interface Settings {
  appEnabled: boolean;
  maintenanceMessage: string;
  announcement: string;
  autoAssign: boolean;
  supportPhone: string;
  supportName: string;
  loginImageV?: number; // 0 / missing = the original picture
  appIconV?: number; // 0 / missing = the built-in icon
  catIconV?: Record<string, number>; // the owner's picture for each service icon on the home screen (type -> version)
  apkUrl?: string; // download link of the Android app
  update?: { version: string; message: string; required: boolean }; // a newer app version the owner announced
  welcomeLogoV?: number; // 0 / missing = the built-in logo on the first screen
  credits?: Credits | null; // the developer lines at the bottom of the first screen (null = the defaults)
  hours?: Hours; // opening hours (Cairo time); outside them customers see the closed screen
  delivery?: { mode: 'region' | 'km'; perKm: number; min: number; max: number; factor: number }; // delivery price by area or by kilometre
  map?: { enabled: boolean; required: boolean }; // owner switch: maps + live location, and whether a delivery pin is required
  theme?: string; // colour theme picked by the owner
  features?: Record<string, boolean>; // the owner's feature switches
  privacy?: { on: boolean; minutes: number }; // shops/couriers lose the customer's data this long after delivery
  ui?: { phone: number; desktop: number }; // interface size picked by the owner (1 = original)
  tzOffsetMin?: number; // Cairo's offset from UTC when the settings were fetched (120 or 180)
}
export interface Credits { a: string; b: string; c: string; d: string }

export interface DB {
  rev: number;
  seq: number;
  users: User[];
  providers: Provider[];
  products: Product[];
  regions: Region[];
  routePrices?: Record<string, number>; // "shopAreaId:customerAreaId" -> delivery price
  services?: ServiceDef[]; // the services the owner arranged (name, order, size, on/off)
  ads?: Ad[];
  couriersOnline?: number; // couriers who are switched on right now (the server counts them)
  bookedSlots: { doctorId: string; date: string; time: string }[];
  orders: Order[];
  appointments: Appointment[];
  invoices: Invoice[];
  messages: Message[];
  settings: Settings;
}

export interface CartLine {
  productId: string;
  qty: number;
}

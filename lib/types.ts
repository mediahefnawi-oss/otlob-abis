export type Role = 'customer' | 'provider' | 'courier' | 'admin' | 'supervisor';
export type ProviderType = 'restaurant' | 'supermarket' | 'pharmacy' | 'clinic' | 'store' | 'maker';
export type AccountStatus = 'active' | 'pending' | 'rejected' | 'suspended';

export interface User {
  id: string;
  name: string;
  phone: string;
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
  // owner's label on a customer account (only the owner's app receives these)
  accountFlag?: string;
  flagNote?: string;
  // supervisor: the areas (region ids) whose orders he runs
  supRegions?: string[];
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
  id: string;
  number: number;
  groupId: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  phone: string;
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

export interface Appointment {
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
  welcomeLogoV?: number; // 0 / missing = the built-in logo on the first screen
  credits?: Credits | null; // the developer lines at the bottom of the first screen (null = the defaults)
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

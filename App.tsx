import React, { useEffect } from 'react';
import { View, Platform, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,
} from '@expo-google-fonts/cairo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { C } from './lib/theme';
import { initStore, useStore, useMe, useAppGate, availableCouriers, setStoreErrorHandler, setStoreNoticeHandler } from './lib/store';
import { Overlays, Logo, toast } from './components/ui';
import { SoundGate } from './components/SoundGate';
import { LocationGate } from './components/LocationGate';
import { SyncBanner } from './components/SyncBanner';
import { OrderAlarmBar } from './components/OrderAlarmBar';
import { UpdateBanner } from './components/UpdateBanner';
import { InstallBanner } from './components/InstallBanner';
import { navigationRef } from './lib/nav';
import { SideNav } from './components/SideNav';
import { useWide, useNav } from './lib/wide';
import { setUiScale, setScaleConfig } from './lib/scale';
import { TabHost, TabDef } from './components/Tabs';
import { WelcomeScreen, LoginScreen, RegisterScreen, PendingScreen, MaintenanceScreen } from './screens/auth';
import {
  HomeScreen, CategoryScreen, ProviderScreen, CartScreen, CustomOrderScreen, RequestOrderScreen, LabRequestScreen, BookingScreen, CustomerOrdersScreen,
} from './screens/customer';
import { OrderDetailScreen, ApptDetailScreen, InvoiceScreen, ChatScreen, SupportScreen, ProfileScreen } from './screens/shared';
import { ProviderOrdersScreen, ProviderCatalogScreen, ProviderInvoicesScreen, ProviderProfileScreen } from './screens/provider';
import { CourierWorkScreen, CourierOrdersScreen, CourierProfileScreen } from './screens/courier';
import {
  AdminDashboardScreen, AdminProvidersScreen, AdminCouriersScreen, AdminOrdersScreen, AdminDetailScreen, AdminSettingsScreen, AdminCustomersScreen, AdminCustomerScreen, AdminSupervisorsScreen, AdminSupportScreen, SupervisorOrdersScreen,
} from './screens/admin';
import { AdminFinanceScreen } from './components/Finance';
import { SupportInbox, useSupportUnread } from './components/SupportChat';
import { AdminOffersScreen } from './components/Offers';
import { AdminRatingsScreen } from './components/Ratings';
import { CouriersMapScreen, useCourierTracking } from './components/Location';
import { inStaffQueue, isBooking, isLab, isRequestOnly } from './lib/format';
import { ErrorBoundary, rememberCrash } from './components/ErrorBoundary';

// the phone app must not close because of one failing action: show a message instead (a crash in a screen is caught by ErrorBoundary)
if (Platform.OS !== 'web') {
  const EU = (globalThis as any).ErrorUtils;
  if (EU && EU.setGlobalHandler) EU.setGlobalHandler((e: any) => { rememberCrash(e); try { toast('حصل خطأ غير متوقع، حاول مرة أخرى', 'err'); } catch {} });
}

setStoreErrorHandler((msg) => toast(msg, 'err'));
setStoreNoticeHandler((msg) => toast(msg, 'ok'));

const Stack = createNativeStackNavigator();

const navTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.bg, primary: C.gold } };

function Main({ navigation }: any) {
  const me = useMe()!;
  const { db } = useStore();
  useCourierTracking(me.role === 'courier', db.settings.map?.enabled !== false && (!!me.available || db.orders.some((o) => o.courierId === me.id && ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status))));
  // the system gave this courier an order: open it for him right away (opening it confirms it, see ackOrder)
  const gift = me.role === 'courier' ? db.orders.find((o) => o.courierId === me.id && o.autoPending) : undefined;
  useEffect(() => {
    if (!gift) return;
    toast('طلب جديد معيّن لك 🛵', 'ok');
    if (navigationRef.isReady()) navigationRef.navigate('OrderDetail', { id: gift.id });
  }, [gift?.id]);
  const supUnread = useSupportUnread(me.role !== 'admin' && (me.role !== 'supervisor' || !!me.supportChat));

  let tabs: TabDef[] = [];
  if (me.role === 'customer') {
    const active = db.orders.filter((o) => o.customerId === me.id && ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status)).length;
    tabs = [
      { key: 'home', label: 'الرئيسية', icon: 'home', render: () => <HomeScreen navigation={navigation} /> },
      { key: 'orders', label: 'طلباتي', icon: 'receipt', badge: active, render: () => <CustomerOrdersScreen navigation={navigation} /> },
      { key: 'support', label: 'الدعم', icon: 'headset', badge: supUnread, render: () => <SupportScreen navigation={{ canGoBack: () => false }} /> },
      { key: 'profile', label: 'حسابي', icon: 'person', render: () => <ProfileScreen navigation={navigation} /> },
    ];
  } else if (me.role === 'provider') {
    const prov = db.providers.find((p) => p.ownerId === me.id);
    const pending = prov ? (isBooking(prov.type) ? db.appointments.filter((a) => a.providerId === prov.id && (a.lab ? a.lab.stage === 'new' || a.lab.stage === 'confirmed' : a.status === 'pending')).length : db.orders.filter((o) => o.providerId === prov.id && ['pending', 'accepted'].includes(o.status)).length) : 0;
    const clinic = isBooking(prov?.type);
    const noCatalog = isRequestOnly(prov?.type) || isLab(prov?.type); // these have no menu: written requests only / a medical lab
    tabs = [
      { key: 'orders', label: clinic ? 'الحجوزات' : 'الطلبات', icon: clinic ? 'calendar' : 'receipt', badge: pending, render: () => <ProviderOrdersScreen navigation={navigation} /> },
      ...(noCatalog ? [] : [{ key: 'catalog', label: clinic ? 'الأطباء' : 'المنتجات', icon: clinic ? 'people' : 'pricetags', render: () => <ProviderCatalogScreen /> }]),
      { key: 'invoices', label: 'الفواتير', icon: 'document-text', render: () => <ProviderInvoicesScreen navigation={navigation} /> },
      { key: 'support', label: 'الدعم', icon: 'headset', badge: supUnread, render: () => <SupportScreen navigation={{ canGoBack: () => false }} /> },
      { key: 'profile', label: 'حسابي', icon: 'person', render: () => <ProviderProfileScreen navigation={navigation} /> },
    ];
  } else if (me.role === 'courier') {
    const offers = me.available ? db.orders.filter((o) => !o.courierId && ['pending', 'accepted', 'ready'].includes(o.status)).length : 0;
    tabs = [
      { key: 'work', label: 'العمل', icon: 'bicycle', render: (go) => <CourierWorkScreen navigation={navigation} go={go} /> },
      { key: 'orders', label: 'الطلبات', icon: 'receipt', badge: offers, render: () => <CourierOrdersScreen navigation={navigation} /> },
      { key: 'support', label: 'الدعم', icon: 'headset', badge: supUnread, render: () => <SupportScreen navigation={{ canGoBack: () => false }} /> },
      { key: 'profile', label: 'حسابي', icon: 'person', render: () => <CourierProfileScreen navigation={navigation} /> },
    ];
  } else if (me.role === 'supervisor') {
    const fresh = db.orders.filter((o) => inStaffQueue(o)).length;
    tabs = [
      { key: 'orders', label: 'الطلبات', icon: 'receipt', badge: fresh, render: () => <SupervisorOrdersScreen navigation={navigation} /> },
      { key: 'support', label: 'الدعم', icon: 'headset', badge: supUnread, render: () => (me.supportChat ? <SupportInbox /> : <SupportScreen navigation={{ canGoBack: () => false }} />) },
      { key: 'profile', label: 'حسابي', icon: 'person', render: () => <ProfileScreen navigation={navigation} /> },
    ];
  } else {
    const pend = db.providers.filter((p) => p.status === 'pending').length;
    const pendC = db.users.filter((u) => u.role === 'courier' && u.status === 'pending').length;
    tabs = [
      { key: 'dash', label: 'الرئيسية', icon: 'stats-chart', render: (go) => <AdminDashboardScreen navigation={navigation} go={go} /> },
      { key: 'orders', label: 'الطلبات', icon: 'receipt', render: () => <AdminOrdersScreen navigation={navigation} /> },
      { key: 'finance', label: 'المالية', icon: 'cash', render: () => <AdminFinanceScreen /> },
      { key: 'providers', label: 'الخدمات', icon: 'storefront', badge: pend, render: () => <AdminProvidersScreen navigation={navigation} /> },
      { key: 'couriers', label: 'المناديب', icon: 'bicycle', badge: pendC, render: () => <AdminCouriersScreen navigation={navigation} /> },
      { key: 'settings', label: 'الإعدادات', icon: 'settings', render: () => <AdminSettingsScreen navigation={navigation} /> },
    ];
  }
  return <TabHost tabs={tabs} />;
}

function Root() {
  const { db, ready } = useStore();
  const me = useMe();
  const gate = useAppGate(me?.role ?? null); // manual stop or opening hours; the owner is never blocked
  const isAdmin = me?.role === 'admin';

  let screens: React.ReactNode;
  if (gate.blocked) {
    screens = (
      <>
        <Stack.Screen name="Maintenance">{(p) => <MaintenanceScreen {...p} canLogin />}</Stack.Screen>
        {!me && <Stack.Screen name="Login" component={LoginScreen} />}
      </>
    );
  } else if (!me) {
    screens = (
      <>
        <Stack.Screen name="Welcome" component={WelcomeScreen} />
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Register" component={RegisterScreen} />
      </>
    );
  } else if (me.status !== 'active') {
    screens = <Stack.Screen name="Pending" component={PendingScreen} />;
  } else {
    screens = (
      <>
        <Stack.Screen name="Main" component={Main} />
        <Stack.Screen name="Category" component={CategoryScreen} />
        <Stack.Screen name="Provider" component={ProviderScreen} />
        <Stack.Screen name="Cart" component={CartScreen} />
        <Stack.Screen name="CustomOrder" component={CustomOrderScreen} />
        <Stack.Screen name="RequestOrder" component={RequestOrderScreen} />
        <Stack.Screen name="LabRequest" component={LabRequestScreen} />
        <Stack.Screen name="Booking" component={BookingScreen} />
        <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
        <Stack.Screen name="ApptDetail" component={ApptDetailScreen} />
        <Stack.Screen name="Invoice" component={InvoiceScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="AdminDetail" component={AdminDetailScreen} />
        <Stack.Screen name="AdminCustomers" component={AdminCustomersScreen} />
        <Stack.Screen name="AdminCustomer" component={AdminCustomerScreen} />
        <Stack.Screen name="AdminSupervisors" component={AdminSupervisorsScreen} />
        <Stack.Screen name="AdminSupport" component={AdminSupportScreen} />
        <Stack.Screen name="CouriersMap" component={CouriersMapScreen} />
        <Stack.Screen name="AdminOffers" component={AdminOffersScreen} />
        <Stack.Screen name="AdminRatings" component={AdminRatingsScreen} />
      </>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} direction="rtl">
      <Stack.Navigator key={`${me?.id || 'guest'}-${!gate.blocked}-${me?.status}-${db.settings.theme || 'default'}`} screenOptions={{ headerShown: false, animation: 'slide_from_left', contentStyle: { backgroundColor: C.bg } }}>
        {screens}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    ...Ionicons.font,
    Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,
  });
  const { ready, db: appDb } = useStore();
  const wide = useWide();
  setScaleConfig(appDb.settings.ui?.phone, appDb.settings.ui?.desktop); // the owner's size choice
  setUiScale(wide); // text/icons/buttons a little smaller (see lib/scale.ts)
  const navState = useNav();
  const side = wide && !!navState; // computer view with a signed-in user: side menu + wider content

  useEffect(() => {
    initStore();
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.setAttribute('dir', 'rtl');
      document.documentElement.setAttribute('lang', 'ar');
      document.title = 'أطلب أبيس';
      document.body.style.backgroundColor = C.dark;
    }
  }, []);

  if (!fontsLoaded || !ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <Logo width={240} />
        <ActivityIndicator color={C.gold} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: C.dark, direction: 'rtl' }}>
        {wide && <SideNav />}
        <View style={{ flex: 1, backgroundColor: side ? C.bg : C.dark }}>
        <View style={{ flex: 1, width: '100%', maxWidth: side ? 940 : 520, alignSelf: 'center', backgroundColor: C.bg, overflow: 'hidden' }}>
          <SoundGate />
          <LocationGate />
          <SyncBanner />
          <UpdateBanner />
          <InstallBanner />
          <OrderAlarmBar />
          <View style={{ flex: 1 }}><ErrorBoundary><Root key={wide ? 'wide' : 'narrow'} /></ErrorBoundary></View>
          <Overlays />
        </View>
        </View>
      </View>
    </SafeAreaProvider>
  );
}

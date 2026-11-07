export const C = {
  bg: '#F3F4EE',
  dark: '#00211A',
  dark2: '#04302A',
  dark3: '#0B4136',
  green: '#0E7A4F',
  greenSoft: '#E2F3EA',
  gold: '#F2B51D',
  goldDeep: '#C98F0A',
  goldSoft: '#FFF3CF',
  card: '#FFFFFF',
  text: '#0B1F1A',
  sub: '#6B7A74',
  line: '#E4E8E2',
  red: '#D64545',
  redSoft: '#FDE8E8',
  blue: '#2F7DD1',
  blueSoft: '#E4F0FC',
  orange: '#EE8A2B',
  orangeSoft: '#FFEBD6',
  white: '#FFFFFF',
};

export const R = { sm: 10, md: 16, lg: 22, xl: 28 };

export const shadow = {
  shadowColor: '#00211A',
  shadowOpacity: 0.1,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};

export const FONT = {
  regular: 'Cairo_400Regular',
  semi: 'Cairo_600SemiBold',
  bold: 'Cairo_700Bold',
  black: 'Cairo_800ExtraBold',
};

/**
 * Colour themes chosen by the OWNER only (control panel). Every theme keeps the text readable: dark brand colours with a bright accent.
 * Meaning colours (green = done, red = problem, orange/blue) never change, so statuses stay recognisable.
 */
export type ThemeDef = { id: string; name: string; dark: string; dark2: string; dark3: string; gold: string; goldDeep: string; goldSoft: string };
export const THEMES: ThemeDef[] = [
  { id: 'default', name: 'الأخضر الأصلي', dark: '#00211A', dark2: '#04302A', dark3: '#0B4136', gold: '#F2B51D', goldDeep: '#C98F0A', goldSoft: '#FFF3CF' },
  { id: 'ocean', name: 'أزرق بحري', dark: '#0A2540', dark2: '#0F3357', dark3: '#164570', gold: '#F2B51D', goldDeep: '#C98F0A', goldSoft: '#FFF3CF' },
  { id: 'royal', name: 'بنفسجي ملكي', dark: '#2A0F45', dark2: '#3A1860', dark3: '#4C2480', gold: '#F5C542', goldDeep: '#C99A12', goldSoft: '#FFF4D1' },
  { id: 'maroon', name: 'عنابي', dark: '#3B0A14', dark2: '#52101E', dark3: '#6B1828', gold: '#F2B51D', goldDeep: '#C98F0A', goldSoft: '#FFF3CF' },
  { id: 'charcoal', name: 'أسود فحمي', dark: '#15191C', dark2: '#1F252A', dark3: '#2B333A', gold: '#F2B51D', goldDeep: '#C98F0A', goldSoft: '#FFF3CF' },
  { id: 'teal', name: 'تركواز', dark: '#00363A', dark2: '#064A4F', dark3: '#0B6068', gold: '#FFB703', goldDeep: '#CC8F00', goldSoft: '#FFF0C7' },
  { id: 'sunset', name: 'كحلي وبرتقالي', dark: '#12203A', dark2: '#1B2E52', dark3: '#254072', gold: '#FF8A2B', goldDeep: '#D96A0B', goldSoft: '#FFE9D6' },
  { id: 'rose', name: 'توت ووردي', dark: '#3B0A2E', dark2: '#531144', dark3: '#6D1A5A', gold: '#FF7AAE', goldDeep: '#D9497F', goldSoft: '#FFE3EE' },
];
export let themeId = 'default';
/** Changes the shared palette in place. Screens read C when they render, so a re-render (the navigator is keyed on the theme) picks it up. */
export function applyTheme(id?: string) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  themeId = t.id;
  Object.assign(C, { dark: t.dark, dark2: t.dark2, dark3: t.dark3, gold: t.gold, goldDeep: t.goldDeep, goldSoft: t.goldSoft });
}

/** Colours an offer badge can have (the owner picks one). */
export const OFFER_COLORS: Record<string, { name: string; bg: string; fg: string }> = {
  red: { name: 'أحمر', bg: '#D64545', fg: '#fff' },
  green: { name: 'أخضر', bg: '#0E7A4F', fg: '#fff' },
  orange: { name: 'برتقالي', bg: '#EE8A2B', fg: '#fff' },
  purple: { name: 'بنفسجي', bg: '#7A3CC4', fg: '#fff' },
  blue: { name: 'أزرق', bg: '#2F7DD1', fg: '#fff' },
  gold: { name: 'ذهبي', bg: '#F2B51D', fg: '#00211A' },
};

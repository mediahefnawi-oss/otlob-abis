import React from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useStore } from '../lib/store';

/** Switch "ratingStars": the rating shows as five stars with the number of customers who rated, instead of one star and a number. */
export const useRatingStars = () => !!useStore().db.settings.features?.ratingStars;

export function StarRow({ rating, size = 12 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name={rating >= i - 0.25 ? 'star' : rating >= i - 0.75 ? 'star-half' : 'star-outline'} size={size} color={rating >= i - 0.75 ? C.gold : '#CFC9B2'} />
      ))}
    </View>
  );
}

/** Stars + average + (count). A place nobody rated yet shows "جديد". */
export function RatingLine({ p, size = 12, light }: { p: { rating: number; ratingCount?: number }; size?: number; light?: boolean }) {
  const n = p.ratingCount || 0;
  const col = light ? '#fff' : C.text;
  if (!p.rating) return <T w="bold" size={size} color={light ? '#fff' : C.text}>جديد</T>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <StarRow rating={p.rating} size={size + 1} />
      <T w="bold" size={size} color={col}>{p.rating.toFixed(1)}</T>
      {n > 0 && <T size={size - 0.5} color={light ? '#D6E2DC' : C.sub}>({n})</T>}
    </View>
  );
}

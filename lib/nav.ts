import { createNavigationContainerRef } from '@react-navigation/native';

/** Lets components outside the navigator (the alarm bar) open a screen. */
export const navigationRef = createNavigationContainerRef<any>();

import { create } from 'zustand';
export const useUiPreferences = create<{ theme: 'light' | 'dark' }>(() => ({ theme: 'light' }));

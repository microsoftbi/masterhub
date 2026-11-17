import { defineStore } from 'pinia';
import { authApi } from '../api';

export const useAuth = defineStore('auth', {
  state: () => ({
    user: null as any,
    token: localStorage.getItem('mh_token') || '',
    loaded: false,
  }),
  getters: {
    perms: (s) => (s.user?.perms || []) as string[],
    domains: (s) => (s.user?.domains || []) as string[],
    has: (s) => (p: string) => (s.user?.perms || []).includes(p),
  },
  actions: {
    async login(username: string, password: string) {
      const data = await authApi.login({ username, password });
      this.token = data.token;
      localStorage.setItem('mh_token', data.token);
      this.user = data.user;
      this.loaded = true;
      return data;
    },
    async load() {
      if (this.loaded || !this.token) return;
      this.user = await authApi.me();
      this.loaded = true;
    },
    logout() {
      this.token = '';
      this.user = null;
      this.loaded = false;
      localStorage.removeItem('mh_token');
    },
  },
});
